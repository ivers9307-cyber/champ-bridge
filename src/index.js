// champ-bridge entry point. Wires up:
//   1. BLE adapter (real or fake) → emits strap-sample events
//   2. Sample buffer → batches + flushes to /api/bridge/samples
//   3. Scan loop → posts current connected straps to /api/bridge/scan
//   4. Heartbeat loop → /api/bridge/heartbeat when otherwise idle
//
// The bridge stays running even if the API is offline; we buffer
// samples (bounded, oldest-dropped) and retry. When the API comes
// back, the buffer drains.

import { config } from './config.js'
import { logInfo, logWarn, logError } from './log.js'
import { createBleAdapter } from './ble.js'
import { pushSample, startFlushLoop, pendingCount } from './buffer.js'
import { postHeartbeat, postScan } from './api.js'

async function main() {
  logInfo('bridge', 'champ-bridge starting', {
    apiUrl: config.apiUrl, fakeBle: config.fakeBle, version: config.softwareVersion,
  })

  const ble = createBleAdapter()

  ble.on('strap-sample', (s) => {
    pushSample({ strap_mac: s.mac, recorded_at: s.recorded_at, bpm: s.bpm })
  })

  ble.on('strap-seen', (info) => {
    logInfo('bridge', 'strap seen', info)
  })

  ble.on('strap-lost', (mac) => {
    logInfo('bridge', 'strap lost', { mac })
  })

  await ble.start()

  // Initial heartbeat tells the server "I'm online with this version".
  await postHeartbeat({ status: 'online' }).catch((err) => {
    logWarn('bridge', 'initial heartbeat failed (will retry)', { err })
  })

  const flushTimer = startFlushLoop()

  const scanTimer = setInterval(async () => {
    try {
      const straps = ble.getCurrentStraps()
      await postScan(straps)
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

  // Graceful shutdown. systemd sends SIGTERM on stop; we want to
  // disconnect from straps cleanly before exiting so the next start
  // doesn't hit lingering connections.
  async function shutdown(signal) {
    logInfo('bridge', `received ${signal}, shutting down`)
    clearInterval(flushTimer)
    clearInterval(scanTimer)
    clearInterval(heartbeatTimer)
    await ble.stop().catch(() => {})
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
