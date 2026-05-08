// HTTP client for un1t-crm /api/bridge/*.
//
// All requests include the bearer token. Network failures are
// logged + tolerated — the bridge keeps running and retries on the
// next tick. We never block the BLE side on the network side.

import { request } from 'undici'
import { config } from './config.js'
import { logWarn, logDebug } from './log.js'

const COMMON_HEADERS = {
  'authorization': `Bearer ${config.token}`,
  'content-type': 'application/json',
  'user-agent': `champ-bridge/${config.softwareVersion}`,
}

async function postJson(path, body) {
  const url = `${config.apiUrl}${path}`
  try {
    const res = await request(url, {
      method: 'POST',
      headers: COMMON_HEADERS,
      body: JSON.stringify(body),
      // 10s budget per call; longer than the polling cadence so a
      // slow API doesn't queue up parallel requests.
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    })
    let parsed = null
    try { parsed = await res.body.json() } catch { /* response without body */ }
    if (res.statusCode >= 400) {
      logWarn('api', `${path} returned ${res.statusCode}`, { body: parsed })
      return { ok: false, statusCode: res.statusCode, body: parsed }
    }
    logDebug('api', `${path} ok`, { body: parsed })
    return { ok: true, statusCode: res.statusCode, body: parsed }
  } catch (err) {
    logWarn('api', `${path} network error`, { err })
    return { ok: false, networkError: true, err }
  }
}

export async function postHeartbeat({ status = 'online' } = {}) {
  return postJson('/api/bridge/heartbeat', {
    software_version: config.softwareVersion,
    status,
  })
}

/**
 * Send a batch of samples. Server caps at 1000 per request so the
 * caller (samples-buffer) splits if needed.
 *
 * @param {Array<{ strap_mac: string, recorded_at: string, bpm: number }>} samples
 */
export async function postSamples(samples) {
  if (!samples || samples.length === 0) return { ok: true, statusCode: 200, body: { ok: true } }
  return postJson('/api/bridge/samples', { samples })
}

/**
 * Send the current "I'm broadcasting" snapshot.
 * @param {Array<{ mac: string, name?: string, rssi?: number, last_bpm?: number }>} straps
 */
export async function postScan(straps) {
  return postJson('/api/bridge/scan', { straps })
}
