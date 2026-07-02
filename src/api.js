// HTTP client for un1t-crm /api/bridge/*.
//
// All requests include the bearer token. Network failures are
// logged + tolerated — the bridge keeps running and retries on the
// next tick. We never block the BLE side on the network side.

import { request } from 'undici'
import { config } from './config.js'
import { logWarn, logDebug, logError } from './log.js'
import { nextAuthFailureState, MAX_CONSECUTIVE_AUTH_FAILURES } from './auth-failure.js'

const COMMON_HEADERS = {
  'authorization': `Bearer ${config.token}`,
  'content-type': 'application/json',
  'user-agent': `champ-bridge/${config.softwareVersion}`,
}

// Consecutive-auth-failure tracking. A dead/revoked token 401s (or
// 403s) forever; the old client warn-looped as a silent zombie. After
// MAX_CONSECUTIVE_AUTH_FAILURES in a row we exit non-zero so systemd
// restarts and the journal shows why. Any success / network error /
// non-auth response resets the streak (see auth-failure.js), so a
// normal rotation (paired with the CRM-side dual-token grace window)
// won't trip it — only a genuinely dead token does.
let authFailures = 0

// Overridable so the exit path is testable without killing the runner.
let onAuthZombie = () => {
  logError('api', `${MAX_CONSECUTIVE_AUTH_FAILURES} consecutive auth failures — token appears dead; exiting for systemd restart`)
  process.exit(1)
}

/** Test seam: swap the exit behaviour + reset the counter. */
export function __setAuthZombieHandler(fn) {
  onAuthZombie = fn
  authFailures = 0
}

/** Fold one request outcome into the auth-failure counter; act if dead. */
function trackAuth(outcome) {
  const { count, exit } = nextAuthFailureState(authFailures, outcome)
  authFailures = count
  if (exit) onAuthZombie()
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
      trackAuth({ statusCode: res.statusCode })
      return { ok: false, statusCode: res.statusCode, body: parsed }
    }
    logDebug('api', `${path} ok`, { body: parsed })
    trackAuth({ statusCode: res.statusCode })
    return { ok: true, statusCode: res.statusCode, body: parsed }
  } catch (err) {
    logWarn('api', `${path} network error`, { err })
    trackAuth({ networkError: true })
    return { ok: false, networkError: true, err }
  }
}

async function getJson(path) {
  const url = `${config.apiUrl}${path}`
  try {
    const res = await request(url, {
      method: 'GET',
      headers: COMMON_HEADERS,
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    })
    let parsed = null
    try { parsed = await res.body.json() } catch { /* response without body */ }
    if (res.statusCode >= 400) {
      logWarn('api', `${path} returned ${res.statusCode}`, { body: parsed })
      trackAuth({ statusCode: res.statusCode })
      return { ok: false, statusCode: res.statusCode, body: parsed }
    }
    logDebug('api', `${path} ok`, { body: parsed })
    trackAuth({ statusCode: res.statusCode })
    return { ok: true, statusCode: res.statusCode, body: parsed }
  } catch (err) {
    logWarn('api', `${path} network error`, { err })
    trackAuth({ networkError: true })
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
 * InBody enrichment — get scans still needing their measurements pulled.
 * @returns {Promise<{ ok, body?: { pending: Array<{event_id,usertoken,datetimes}> } }>}
 */
export async function getInbodyPending() {
  return getJson('/api/bridge/inbody/pending')
}

/**
 * InBody enrichment — relay fetched GetFullInBodyData responses to the CRM.
 * @param {Array<{ event_id: string, raw: object }>} results
 */
export async function postInbodyIngest(results) {
  return postJson('/api/bridge/inbody/ingest', { results })
}

/**
 * InBody backfill — get on-demand "sync this member" requests to process.
 * @returns {Promise<{ ok, body?: { pending: Array<{request_id,phone}> } }>}
 */
export async function getInbodyBackfillPending() {
  return getJson('/api/bridge/inbody/backfill-pending')
}

/**
 * InBody backfill — relay a member's full scan history (or an error) for one
 * request. Pass `scans` to complete it, or `error` if GetDateTimes failed.
 * @param {{ request_id: string, scans?: Array<{datetimes: string, raw: object}>, error?: string }} payload
 */
export async function postInbodyBackfillIngest(payload) {
  return postJson('/api/bridge/inbody/backfill-ingest', payload)
}

/**
 * Send a batch of samples. Server caps at 1000 per request so the
 * caller (samples-buffer) splits if needed.
 *
 * @param {Array<{ device_key: string, recorded_at: string, bpm: number }>} samples
 *        device_key is protocol-aware — `ant:12345` or `ble:AA:BB:..`.
 */
export async function postSamples(samples) {
  if (!samples || samples.length === 0) return { ok: true, statusCode: 200, body: { ok: true } }
  return postJson('/api/bridge/samples', { samples })
}

/**
 * Send the current "I'm broadcasting" snapshot.
 * @param {Array<{ device_key: string, name?: string, rssi?: number, last_bpm?: number }>} straps
 */
export async function postScan(straps) {
  return postJson('/api/bridge/scan', { straps })
}
