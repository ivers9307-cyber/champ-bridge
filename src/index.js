// champ-bridge entry point. Wires up:
//   1. Strap source (ANT+ primary + BLE fallback) → strap-sample events
//   2. Sample buffer → batches + flushes to /api/bridge/samples
//   3. Scan loop → posts current visible straps to /api/bridge/scan
//   4. Heartbeat loop → /api/bridge/heartbeat when otherwise idle
//   5. InBody poll loop → pulls scan data from Lookin'Body, relays to CRM
//      (only when INBODY_API_KEY + INBODY_ACCOUNT are configured)
//
// The bridge stays running even if the API is offline; we buffer
// samples (bounded, oldest-dropped) and retry. When the API comes
// back, the buffer drains.

import { config } from './config.js'
import { logInfo, logWarn, logError } from './log.js'
import { createStrapSource } from './strap-source.js'
import { pushSample, startFlushLoop, pendingCount, drainSamples } from './buffer.js'
import { postHeartbeat, postScan } from './api.js'
import { runInbodyCycle, runInbodyBackfillCycle, loadInbodyState } from './inbody.js'
import { notifyReady, notifyWatchdog, notifyStopping, watchdogPingMs, notifyStats } from './sd-notify.js'
import { shouldPingWatchdog, stallReason } from './watchdog.js'
import {
  runBoundedShutdown, SHUTDOWN_BUDGET_MS, HARD_EXIT_GRACE_MS,
} from './shutdown.js'

/**
 * Arm an unconditional `process.exit`. This is the guarantee that makes every
 * exit path in this file incapable of hanging: whatever else is pending —
 * a parked libusb write, a bluez call that never answers, an HTTPS request
 * with no response — this timer fires and the process is gone.
 *
 * Deliberately NOT unref'd: a ref'd timer keeps the loop alive precisely long
 * enough to fire. Cancel it on the normal path.
 *
 * (The one thing it cannot save us from is a SYNCHRONOUSLY blocked event loop,
 * which no in-process mechanism can. `TimeoutStopSec=15` in the unit is the
 * backstop for that.)
 */
function armHardExit(ms, code, why) {
  const t = setTimeout(() => {
    logError('bridge', `${why} — forcing exit(${code})`)
    process.exit(code)
  }, ms)
  return () => clearTimeout(t)
}

// Crash safety net. Without these an uncaught exception / unhandled
// rejection tears the process down immediately and silently — the
// in-memory sample buffer is lost with no journal breadcrumb. We log
// structured, attempt one last flush so buffered samples aren't lost,
// then exit non-zero so systemd restarts cleanly.
//
// The final flush is best-effort and BOUNDED — it must never be able to keep a
// crashing process alive.
const FATAL_FLUSH_MS = 3_000
let crashing = false
async function fatalExit(kind, err) {
  if (crashing) return
  crashing = true
  logError('bridge', `fatal: ${kind}`, { err })
  const cancel = armHardExit(FATAL_FLUSH_MS + HARD_EXIT_GRACE_MS, 1, 'fatal exit budget exceeded')
  await runBoundedShutdown(
    [{ name: 'final-flush', budgetMs: FATAL_FLUSH_MS, run: () => drainSamples() }],
    { budgetMs: FATAL_FLUSH_MS, onStep: (r) => logInfo('bridge', 'fatal shutdown step', r) },
  )
  cancel()
  process.exit(1)
}
process.on('uncaughtException', (err) => { fatalExit('uncaughtException', err) })
process.on('unhandledRejection', (reason) => { fatalExit('unhandledRejection', reason) })

async function main() {
  logInfo('bridge', 'champ-bridge starting', {
    apiUrl: config.apiUrl,
    fakeStraps: config.fakeStraps,
    ant: config.enableAnt,
    ble: config.enableBle,
    version: config.softwareVersion,
  })

  const straps = createStrapSource()

  // Operational telemetry attached to every heartbeat so the CRM can detect an
  // "online but blind" bridge — process up, but reading nothing (stick
  // unplugged, BLE radio down) or drowning in an un-drainable buffer.
  const buildTelemetry = () => ({
    pending_samples: pendingCount(),
    adapters: straps.getAdapterStatus(),
    uptime_s: Math.round(process.uptime()),
    // sd_notify transport health. Under Type=simple this is
    // {armed:false,sent:0,failed:0} — that's the signal that the watchdog is
    // NOT arming anything. Once Type=notify is flipped, `failed > 0` here is
    // the early warning that the ping transport is broken and the watchdog
    // will eventually kill a perfectly healthy bridge.
    watchdog: notifyStats(),
  })

  straps.on('strap-sample', (s) => {
    pushSample({ device_key: s.device_key, recorded_at: s.recorded_at, bpm: s.bpm })
  })

  straps.on('strap-seen', (info) => {
    logInfo('bridge', 'strap seen', info)
  })

  straps.on('strap-lost', (deviceKey) => {
    logInfo('bridge', 'strap lost', { device_key: deviceKey })
  })

  await straps.start()

  // Tell systemd we're up. NO-OP unless launched under a Type=notify unit (see
  // sd-notify.js) — safe to call unconditionally on dev / non-systemd.
  notifyReady()

  // Initial heartbeat tells the server "I'm online with this version".
  await postHeartbeat({ status: 'online', telemetry: buildTelemetry() }).catch((err) => {
    logWarn('bridge', 'initial heartbeat failed (will retry)', { err })
  })

  const flushTimer = startFlushLoop()

  // systemd watchdog keep-alive. When WatchdogSec is set, systemd exports
  // WATCHDOG_USEC; we ping at half that. NO-OP when not under a watchdog unit.
  //
  // The ping is GATED on a real liveness signal (watchdog.js), not on the timer
  // firing. A timer-only ping would have sailed straight through the
  // 2026-08-12 wedge — the loop was alive the whole time, it was the ANT+
  // supervisor that had died. Read watchdog.js before changing the predicate;
  // it is deliberately strap-INDEPENDENT and fails open.
  let watchdogTimer = null
  const pingMs = watchdogPingMs()
  if (pingMs) {
    logInfo('bridge', 'systemd watchdog active', { pingMs })
    notifyWatchdog() // one immediate ping so the first deadline is armed
    watchdogTimer = setInterval(() => {
      let ping = true
      let adapters = null
      try {
        adapters = straps.getAdapterStatus()
        ping = shouldPingWatchdog(adapters, Date.now(), { uptimeMs: process.uptime() * 1000 })
      } catch (err) {
        // Anything unexpected in the predicate must not kill a healthy bridge.
        logWarn('bridge', 'watchdog predicate threw — pinging anyway', { err })
        ping = true
      }
      if (ping) { notifyWatchdog(); return }
      logError('bridge', 'watchdog ping WITHHELD — ANT+ supervisor stalled; systemd will restart', {
        ...stallReason(adapters, Date.now()),
      })
    }, pingMs)
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  }

  const scanTimer = setInterval(async () => {
    try {
      await postScan(straps.getCurrentStraps())
    } catch (err) {
      logWarn('bridge', 'scan post threw', { err })
    }
  }, config.scanIntervalMs)

  const heartbeatTimer = setInterval(async () => {
    try {
      // ALWAYS heartbeat. This used to be gated on `pendingCount() === 0`
      // to skip a call that /samples already made (it also touches
      // last_seen_at) — but that saved one request per 30s at the cost of a
      // real blind spot: the heartbeat is the ONLY carrier of telemetry
      // (adapter status + pending_samples), so gating it on an empty queue
      // meant the CRM could never see a BACKLOG. Worse, when delivery is
      // failing the queue never drains, so heartbeats were suppressed
      // precisely when they mattered most, and the CRM mislabelled a
      // delivery failure as service_down (last_seen_at going stale) instead
      // of the undelivered grade that names it. One request per 30s is not
      // a cost worth a blind spot.
      await postHeartbeat({ status: 'online', telemetry: buildTelemetry() })
    } catch (err) {
      logWarn('bridge', 'heartbeat threw', { err })
    }
  }, config.heartbeatMs)

  // InBody enrichment loop — only when configured. The Pi is the
  // whitelisted-IP fetcher: poll the CRM for scans needing data, pull each
  // from Lookin'Body, relay back. State carries the per-UTC-day call counter.
  let inbodyTimer = null
  if (config.inbodyEnabled) {
    logInfo('inbody', 'InBody enrichment enabled', {
      apiUrl: config.inbodyApiUrl,
      account: config.inbodyAccount,
      pollMs: config.inbodyPollMs,
      dailyCap: config.inbodyDailyCap,
    })
    // One shared daily-cap counter for both the go-forward enrich and the
    // on-demand backfill. Enrich first (time-sensitive new scans), then drain
    // any backfill requests with whatever call headroom is left. Loaded from
    // disk so a restart doesn't reset `sent` to 0 and risk breaching the cap.
    const inbodyState = loadInbodyState()
    logInfo('inbody', 'loaded daily-cap counter', { day: inbodyState.day, sent: inbodyState.sent })
    const inbodyTick = async () => {
      await runInbodyCycle(inbodyState).catch((err) => logWarn('inbody', 'cycle threw', { err }))
      await runInbodyBackfillCycle(inbodyState).catch((err) => logWarn('inbody', 'backfill threw', { err }))
    }
    inbodyTick() // kick once on boot, then on the poll interval
    inbodyTimer = setInterval(inbodyTick, config.inbodyPollMs)
  }

  // ── Graceful shutdown, hard-bounded ────────────────────────────────────────
  // systemd sends SIGTERM on stop; we still want to disconnect from straps
  // cleanly, drain the buffer, and post the `offline` heartbeat. What changed
  // after 2026-08-12 is that NONE of those can prevent the exit any more.
  //
  // Before: three bare awaits in a row. `straps.stop()` parked forever inside
  // the ANT+ teardown, `process.exit(0)` was never reached, systemd sat in
  // `deactivating` for 90s and SIGKILLed us — a 90-second outage window on
  // every restart that hit the bug.
  //
  // Now: a 6s total budget, each step given its own slice out of what's left
  // (2s / 2.5s / 1.5s), a hung step abandoned rather than awaited, and a ref'd
  // hard-exit timer armed up front that fires at 7.5s no matter what. Intent is
  // unchanged — best-effort flush + offline heartbeat still happen whenever
  // they fit in the budget.
  //
  // A once-guard stops a double signal (e.g. SIGINT then SIGTERM) running
  // shutdown twice.
  let shuttingDown = false
  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    logInfo('bridge', `received ${signal}, shutting down`, { budgetMs: SHUTDOWN_BUDGET_MS })

    // Armed FIRST, before any await, so even a step that ignores its slice
    // (e.g. a synchronous stall inside a native binding's callback) still ends
    // with a dead process well inside TimeoutStopSec.
    const cancelHardExit = armHardExit(
      SHUTDOWN_BUDGET_MS + HARD_EXIT_GRACE_MS, 0, 'shutdown budget exceeded',
    )

    // Stop the watchdog clock so systemd doesn't kill us mid-drain.
    notifyStopping()
    if (watchdogTimer) clearInterval(watchdogTimer)
    clearInterval(flushTimer)
    clearInterval(scanTimer)
    clearInterval(heartbeatTimer)
    if (inbodyTimer) clearInterval(inbodyTimer)

    const results = await runBoundedShutdown([
      // Straps first: releases the USB stick + GATT connections so the next
      // start isn't fighting lingering handles. Bounded internally too.
      { name: 'straps.stop', budgetMs: 2_000, run: () => straps.stop() },
      // Drain the buffer one last time so a clean restart/deploy doesn't drop
      // the samples collected since the last flush tick. drainSamples (NOT
      // flushSamples) because the periodic flush may be mid-request right now:
      // flushSamples would no-op on the in-flight guard and report 'ok' while
      // silently dropping everything buffered since the last successful flush.
      { name: 'final-flush', budgetMs: 2_500, run: () => drainSamples() },
      // A clean stop is 'offline', NOT 'error' — every deploy/restart used to
      // post status:'error' and spam monitoring. 'error' now means a real
      // crash (via fatalExit), which keeps the signal meaningful.
      { name: 'offline-heartbeat', budgetMs: 1_500, run: () => postHeartbeat({ status: 'offline' }) },
    ], {
      budgetMs: SHUTDOWN_BUDGET_MS,
      onStep: (r) => {
        // A step can succeed and still have lost data: drainSamples returns
        // `lost` when samples were still buffered after the drain (budget ran
        // out, or the API is down). 'ok' alone used to hide exactly that.
        const lost = r?.value?.lost
        if (r.outcome === 'ok' && !lost) logInfo('bridge', 'shutdown step ok', { step: r.name })
        else if (r.outcome === 'ok') logWarn('bridge', 'shutdown step ok but dropped samples', { step: r.name, lost })
        else logWarn('bridge', 'shutdown step did not complete', { step: r.name, outcome: r.outcome, err: r.err })
      },
    })

    logInfo('bridge', 'shutdown complete', {
      steps: results.map((r) => `${r.name}:${r.outcome}`).join(' '),
    })
    cancelHardExit()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logError('bridge', 'fatal startup error', { err })
  process.exit(1)
})
