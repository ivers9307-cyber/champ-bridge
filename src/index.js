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
import { pushSample, startFlushLoop, pendingCount } from './buffer.js'
import { postHeartbeat, postScan } from './api.js'
import { runInbodyCycle, runInbodyBackfillCycle } from './inbody.js'

async function main() {
  logInfo('bridge', 'champ-bridge starting', {
    apiUrl: config.apiUrl,
    fakeStraps: config.fakeStraps,
    ant: config.enableAnt,
    ble: config.enableBle,
    version: config.softwareVersion,
  })

  const straps = createStrapSource()

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

  // Initial heartbeat tells the server "I'm online with this version".
  await postHeartbeat({ status: 'online' }).catch((err) => {
    logWarn('bridge', 'initial heartbeat failed (will retry)', { err })
  })

  const flushTimer = startFlushLoop()

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
        await postHeartbeat({ status: 'online' })
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
    // any backfill requests with whatever call headroom is left.
    const inbodyState = { day: null, sent: 0 }
    const inbodyTick = async () => {
      await runInbodyCycle(inbodyState).catch((err) => logWarn('inbody', 'cycle threw', { err }))
      await runInbodyBackfillCycle(inbodyState).catch((err) => logWarn('inbody', 'backfill threw', { err }))
    }
    inbodyTick() // kick once on boot, then on the poll interval
    inbodyTimer = setInterval(inbodyTick, config.inbodyPollMs)
  }

  // Graceful shutdown. systemd sends SIGTERM on stop; we want to
  // disconnect from straps cleanly before exiting so the next start
  // doesn't hit lingering connections.
  async function shutdown(signal) {
    logInfo('bridge', `received ${signal}, shutting down`)
    clearInterval(flushTimer)
    clearInterval(scanTimer)
    clearInterval(heartbeatTimer)
    if (inbodyTimer) clearInterval(inbodyTimer)
    await straps.stop().catch(() => {})
    await postHeartbeat({ status: 'error' }).catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logError('bridge', 'fatal startup error', { err })
  process.exit(1)
})
