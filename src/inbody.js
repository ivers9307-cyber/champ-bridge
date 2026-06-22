// InBody / Lookin'Body enrichment poller.
//
// The Pi is the only place that can call the Lookin'Body REST API, because
// InBody whitelists by IP and the gym's public IP is the Pi's egress IP. Each
// cycle: ask the CRM which scans still need data (GET /api/bridge/inbody/
// pending), pull each from the Lookin'Body API (POST /inbody/GetFullInBodyData
// with the API-KEY + Account headers), and relay the raw responses back (POST
// /api/bridge/inbody/ingest) where the CRM maps + matches + stores them. The
// API key lives only here.
//
// InBody caps each device at 500 API calls/day (resets 00:00 UTC). We track a
// daily counter and stop well under it (config.inbodyDailyCap, default 450).

import { request } from 'undici'
import { config } from './config.js'
import { getInbodyPending, postInbodyIngest } from './api.js'
import { logInfo, logWarn } from './log.js'

// Pure: how many more InBody calls we may make today.
export function withinDailyCap(sentToday, cap) {
  return Math.max(0, cap - sentToday)
}

// UTC date key (YYYY-MM-DD) used to reset the daily counter at 00:00 UTC.
export function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

// Pull one scan's full measurement set from the Lookin'Body REST API.
// Build the GetFullInBodyData URL. Per the InBody docs the usertoken +
// datetimes go in the request URL path ("add {usertoken} and {datetimes} in
// the request url without the {}"), NOT the JSON body.
export function inbodyDataUrl(apiUrl, usertoken, datetimes) {
  const base = apiUrl.replace(/\/+$/, '')
  return `${base}/inbody/GetFullInBodyData/${encodeURIComponent(usertoken)}/${encodeURIComponent(datetimes)}`
}

// Never throws — returns { ok, statusCode, body }. Reads the response as text
// first so non-JSON error bodies (e.g. "Empty Parameter") are still captured.
export async function fetchFullInBodyData({ apiUrl, apiKey, account, usertoken, datetimes }) {
  const url = inbodyDataUrl(apiUrl, usertoken, datetimes)
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'API-KEY': apiKey, 'Account': account },
      bodyTimeout: 15_000,
      headersTimeout: 15_000,
    })
    const text = await res.body.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { ok: res.statusCode < 400, statusCode: res.statusCode, body }
  } catch (err) {
    logWarn('inbody', 'GetFullInBodyData network error', { err })
    return { ok: false, networkError: true, err }
  }
}

// Run one poll cycle. `state` ({ day, sent }) carries the daily counter across
// cycles. `deps` is injectable for tests (defaults wire to the real api/fetch).
export async function runInbodyCycle(state, deps = {}) {
  const {
    getPending = getInbodyPending,
    postIngest = postInbodyIngest,
    fetcher = fetchFullInBodyData,
    apiUrl = config.inbodyApiUrl,
    apiKey = config.inbodyApiKey,
    account = config.inbodyAccount,
    cap = config.inbodyDailyCap,
    today = utcDateKey(),
  } = deps

  // Reset the counter when the UTC date rolls over.
  if (state.day !== today) { state.day = today; state.sent = 0 }

  const remaining = withinDailyCap(state.sent, cap)
  if (remaining <= 0) {
    logWarn('inbody', 'daily cap reached — skipping cycle', { cap })
    return { fetched: 0, processed: 0 }
  }

  const pendRes = await getPending()
  if (!pendRes.ok) return { fetched: 0, processed: 0 }
  const pending = (pendRes.body?.pending || []).slice(0, remaining)
  if (pending.length === 0) return { fetched: 0, processed: 0 }

  const results = []
  for (const p of pending) {
    const r = await fetcher({ apiUrl, apiKey, account, usertoken: p.usertoken, datetimes: p.datetimes })
    state.sent += 1
    if (r.ok && r.body) {
      results.push({ event_id: p.event_id, raw: r.body })
    } else {
      logWarn('inbody', 'fetch failed', { statusCode: r.statusCode, event_id: p.event_id, body: r.body })
      // 401 = IP not whitelisted, subscription lapsed, or call cap hit.
      // No point hammering the rest of the batch — stop and retry next cycle.
      if (r.statusCode === 401) break
    }
  }

  if (results.length === 0) return { fetched: pending.length, processed: 0 }
  const ingestRes = await postIngest(results)
  const processed = ingestRes.ok ? (ingestRes.body?.processed ?? results.length) : 0
  logInfo('inbody', 'cycle complete', { fetched: pending.length, relayed: results.length, processed })
  return { fetched: pending.length, processed }
}
