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
import { pushSample, startFlushLoop, pendingCount, flushSamples } from './buffer.js'
import { postHeartbeat, postScan } from './api.js'
import { runInbodyCycle, runInbodyBackfillCycle, loadInbodyState } from './inbody.js'
import { runTapoCycle, newTapoState, realTapoDeps } from './tapo.js'
import { notifyReady, notifyWatchdog, notifyStopping, watchdogPingMs } from './sd-notify.js'

// Crash safety net. Without these an uncaught exception / unhandled
// rejection tears the process down immediately and silently — the
// in-memory sample buffer is lost with no journal breadcrumb. We log
// structured, attempt one last flush so buffered samples aren't lost,
// then exit non-zero so systemd restarts cleanly.
let crashing = false
async function fatalExit(kind, err) {
  if (crashing) return
  crashing = true
  logError('bridge', `fatal: ${kind}`, { err })
  try {
    await Promise.race([
      flushSamples(),
      new Promise((r) => setTimeout(r, 5_000)),
    ])
  } catch { /* best-effort final flush */ }
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
  // WATCHDOG_USEC; we ping at half that. If the event loop wedges, the pings
  // stop and systemd restarts us. NO-OP when not under a watchdog unit.
  let watchdogTimer = null
  const pingMs = watchdogPingMs()
  if (pingMs) {
    logInfo('bridge', 'systemd watchdog active', { pingMs })
    notifyWatchdog() // one immediate ping so the first deadline is armed
    watchdogTimer = setInterval(() => notifyWatchdog(), pingMs)
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
      // Only heartbeat when the samples stream is idle — when samples
      // are flowing, /samples already touches last_seen_at, so we
      // skip the redundant call.
      if (pendingCount() === 0) {
        await postHeartbeat({ status: 'online', telemetry: buildTelemetry() })
      }
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

  // Tapo reconcile loop — only when TAPO_ENABLED=1. Poll the CRM for device
  // directives, read actuals from the localhost python-kasa sidecar, apply
  // diffs, and report state back. The sidecar owns the Tapo credentials. The
  // directive cache lives in memory only (this repo is stateless by design).
  let tapoTimer = null
  if (config.tapoEnabled) {
    const tapoState = newTapoState()
    logInfo('tapo', 'tapo reconcile enabled', { sidecar: config.tapoSidecarUrl, pollMs: config.tapoPollMs })
    tapoTimer = setInterval(() => {
      runTapoCycle(tapoState, realTapoDeps).catch((err) => logWarn('tapo', 'cycle threw', { err }))
    }, config.tapoPollMs)
  }

  // Graceful shutdown. systemd sends SIGTERM on stop; we want to
  // disconnect from straps cleanly before exiting so the next start
  // doesn't hit lingering connections. A once-guard stops a double
  // signal (e.g. SIGINT then SIGTERM) running shutdown twice.
  let shuttingDown = false
  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    logInfo('bridge', `received ${signal}, shutting down`)
    // Stop the watchdog clock so systemd doesn't kill us mid-drain.
    notifyStopping()
    if (watchdogTimer) clearInterval(watchdogTimer)
    clearInterval(flushTimer)
    clearInterval(scanTimer)
    clearInterval(heartbeatTimer)
    if (inbodyTimer) clearInterval(inbodyTimer)
    if (tapoTimer) clearInterval(tapoTimer)
    await straps.stop().catch(() => {})
    // Drain the buffer one last time so a clean restart/deploy doesn't
    // drop the samples collected since the last flush tick.
    await flushSamples().catch(() => {})
    // A clean stop is 'offline', NOT 'error' — every deploy/restart used
    // to post status:'error' and spam monitoring. 'error' now means a
    // real crash (via fatalExit), which keeps the signal meaningful.
    await postHeartbeat({ status: 'offline' }).catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logError('bridge', 'fatal startup error', { err })
  process.exit(1)
})
