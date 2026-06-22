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
import {
  getInbodyPending, postInbodyIngest,
  getInbodyBackfillPending, postInbodyBackfillIngest,
} from './api.js'
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

// GetDateTimes URL — lists a member's scan datetimes. Same URL-path convention
// as GetFullInBodyData: usertoken in the path, not the body.
export function inbodyDatetimesUrl(apiUrl, usertoken) {
  const base = apiUrl.replace(/\/+$/, '')
  return `${base}/inbody/GetDateTimes/${encodeURIComponent(usertoken)}`
}

// Pure: pull the yyyyMMddHHmmSS datetime strings out of a GetDateTimes
// response. Defensive about the (undocumented) shape — accepts a bare array, an
// array of objects, or an object wrapping the array under a common key — and
// grabs the first 14-digit run from each element. De-duped, order preserved.
export function extractInbodyDatetimes(body) {
  const pick = (el) => {
    if (typeof el === 'string') return (el.match(/\d{14}/) || [])[0] || null
    if (el && typeof el === 'object') {
      for (const k of ['Datetimes', 'datetimes', 'TestDatetimes', 'TestDatetime', 'testDatetime', 'date', 'Date', 'value']) {
        const v = el[k]
        if (typeof v === 'string') { const m = v.match(/\d{14}/); if (m) return m[0] }
      }
    }
    return null
  }
  let arr = null
  if (Array.isArray(body)) arr = body
  else if (body && typeof body === 'object') {
    for (const k of ['datetimes', 'Datetimes', 'data', 'dates', 'result', 'Result', 'list']) {
      if (Array.isArray(body[k])) { arr = body[k]; break }
    }
  }
  if (!arr) return []
  const out = []
  const seen = new Set()
  for (const el of arr) {
    const dt = pick(el)
    if (dt && !seen.has(dt)) { seen.add(dt); out.push(dt) }
  }
  return out
}

// List a member's scan datetimes. Never throws — { ok, statusCode, body }.
export async function fetchInbodyDatetimes({ apiUrl, apiKey, account, usertoken }) {
  const url = inbodyDatetimesUrl(apiUrl, usertoken)
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
    logWarn('inbody', 'GetDateTimes network error', { err })
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

// Run one on-demand backfill cycle (SP2 Phase 2b). For each queued member:
// GetDateTimes(phone) → GetFullInBodyData per scan → relay the lot to the CRM,
// which lands them in inbody_scans and closes the request. Shares the daily-cap
// counter with runInbodyCycle (both run in the same tick) — every GetDateTimes
// AND every GetFullInBodyData counts as one InBody call.
export async function runInbodyBackfillCycle(state, deps = {}) {
  const {
    getBackfillPending = getInbodyBackfillPending,
    postBackfillIngest = postInbodyBackfillIngest,
    datetimesFetcher = fetchInbodyDatetimes,
    fetcher = fetchFullInBodyData,
    apiUrl = config.inbodyApiUrl,
    apiKey = config.inbodyApiKey,
    account = config.inbodyAccount,
    cap = config.inbodyDailyCap,
    today = utcDateKey(),
  } = deps

  if (state.day !== today) { state.day = today; state.sent = 0 }
  if (withinDailyCap(state.sent, cap) <= 0) return { requests: 0, ingested: 0 }

  const pendRes = await getBackfillPending()
  if (!pendRes.ok) return { requests: 0, ingested: 0 }
  const requests = pendRes.body?.pending || []
  if (requests.length === 0) return { requests: 0, ingested: 0 }

  let handled = 0
  let ingested = 0
  for (const req of requests) {
    if (withinDailyCap(state.sent, cap) <= 0) break

    // 1. list the member's scans
    const dtRes = await datetimesFetcher({ apiUrl, apiKey, account, usertoken: req.phone })
    state.sent += 1
    if (!dtRes.ok) {
      logWarn('inbody', 'backfill GetDateTimes failed', { statusCode: dtRes.statusCode, request_id: req.request_id, body: dtRes.body })
      await postBackfillIngest({ request_id: req.request_id, error: `GetDateTimes ${dtRes.statusCode ?? 'error'}` })
      handled += 1
      if (dtRes.statusCode === 401) break // IP / cap / subscription — stop the cycle
      continue
    }

    // 2. pull each scan (respecting remaining daily headroom)
    const datetimes = extractInbodyDatetimes(dtRes.body)
    const scans = []
    let hit401 = false
    for (const dt of datetimes) {
      if (withinDailyCap(state.sent, cap) <= 0) break
      const r = await fetcher({ apiUrl, apiKey, account, usertoken: req.phone, datetimes: dt })
      state.sent += 1
      if (r.ok && r.body) scans.push({ datetimes: dt, raw: r.body })
      else if (r.statusCode === 401) { hit401 = true; break }
    }

    // 3. relay (empty scans still closes the request as done with 0)
    const ingestRes = await postBackfillIngest({ request_id: req.request_id, scans })
    if (ingestRes.ok) ingested += ingestRes.body?.ingested ?? 0
    handled += 1
    logInfo('inbody', 'backfill complete', { request_id: req.request_id, found: datetimes.length, scans: scans.length })
    if (hit401) break
  }

  return { requests: handled, ingested }
}
