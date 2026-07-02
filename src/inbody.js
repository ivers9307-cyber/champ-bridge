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
import { writeFileSync, readFileSync, renameSync } from 'node:fs'
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

// Mask a usertoken (a member phone number) for logs — last 4 digits only. It's
// PII and journald is persisted/shipped. e.g. '0873147675' → '******7675'.
export function maskUsertoken(token) {
  const s = String(token ?? '')
  if (s.length <= 4) return s ? '*'.repeat(s.length) : ''
  return '*'.repeat(s.length - 4) + s.slice(-4)
}

// ── Daily-cap persistence ──────────────────────────────────────────────────
// The daily counter is otherwise in-memory only, so every restart reset `sent`
// to 0. A couple of restarts on a busy backfill day could breach InBody's
// 500/device/day cap. We persist { day, sent } to a small JSON file and reload
// it at boot; the UTC-day-rollover reset still applies (a stale file from
// yesterday is treated as sent=0).

// Pure: given the on-disk state and today's UTC key, return the counter to run
// with. A file from a previous UTC day is discarded (fresh day → sent=0).
export function reconcilePersistedState(persisted, today) {
  if (persisted && persisted.day === today && Number.isFinite(persisted.sent) && persisted.sent >= 0) {
    return { day: today, sent: persisted.sent }
  }
  return { day: today, sent: 0 }
}

// Load the persisted counter from disk, reconciled against the current UTC day.
// Never throws — a missing / corrupt file just yields a fresh { day, sent:0 }.
export function loadInbodyState(path = config.inbodyStateFile, today = utcDateKey()) {
  let persisted = null
  try {
    persisted = JSON.parse(readFileSync(path, 'utf8'))
  } catch { /* no file yet, or corrupt — start fresh */ }
  return reconcilePersistedState(persisted, today)
}

// Atomically persist { day, sent }: write a temp file then rename over the
// target (rename is atomic on the same filesystem) so a power-cut mid-write
// can't leave a truncated/corrupt counter file. Never throws — persistence is
// best-effort; the cap still protects within a single process lifetime.
export function saveInbodyState(state, path = config.inbodyStateFile) {
  if (!path) return
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify({ day: state.day, sent: state.sent }), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    logWarn('inbody', 'failed to persist daily-cap counter', { err })
  }
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

// InBody keys members by the phone (TelHP) typed at registration — for this IE
// gym that's the local format `0871234567`, NOT the CRM's `+353871234567`
// (E.164). For backfill we don't know which format was used, so we try the most
// likely candidates in order and use whichever GetDateTimes returns scans for.
// (The webhook path doesn't need this — it carries InBody's own TelHP.)
export function inbodyUsertokenCandidates(phone) {
  const raw = String(phone || '').trim()
  const digits = raw.replace(/\D/g, '')
  const last9 = digits.length >= 9 ? digits.slice(-9) : null
  const out = []
  const add = (v) => { if (v && !out.includes(v)) out.push(v) }
  if (last9) add('0' + last9) // IE local — what InBody shows (confirmed live)
  add(digits)                 // E.164 without the +
  add(raw)                    // exactly as the CRM stores it (+353…)
  if (last9) add(last9)       // bare national
  return out
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
    save = saveInbodyState,
  } = deps

  // Reset the counter when the UTC date rolls over, and persist the reset.
  if (state.day !== today) { state.day = today; state.sent = 0; save(state) }

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
    save(state)
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
    save = saveInbodyState,
  } = deps

  if (state.day !== today) { state.day = today; state.sent = 0; save(state) }
  if (withinDailyCap(state.sent, cap) <= 0) return { requests: 0, ingested: 0 }

  const pendRes = await getBackfillPending()
  if (!pendRes.ok) return { requests: 0, ingested: 0 }
  const requests = pendRes.body?.pending || []
  if (requests.length === 0) return { requests: 0, ingested: 0 }

  let handled = 0
  let ingested = 0
  for (const req of requests) {
    if (withinDailyCap(state.sent, cap) <= 0) break

    // 1. list the member's scans — try each phone-format candidate until one
    // returns scans (InBody stores the local 0… format, not the CRM's +353…).
    let matched = null
    let datetimes = []
    let authError = false
    for (const cand of inbodyUsertokenCandidates(req.phone)) {
      if (withinDailyCap(state.sent, cap) <= 0) break
      const dtRes = await datetimesFetcher({ apiUrl, apiKey, account, usertoken: cand })
      state.sent += 1
      save(state)
      if (!dtRes.ok) {
        if (dtRes.statusCode === 401) { authError = true; break } // IP / cap / subscription
        continue // 400 / no-data for this format → try the next candidate
      }
      const dts = extractInbodyDatetimes(dtRes.body)
      if (dts.length > 0) { matched = cand; datetimes = dts; break }
      // 200 but empty → wrong format, try the next candidate
    }

    if (authError) {
      logWarn('inbody', 'backfill GetDateTimes 401', { request_id: req.request_id })
      await postBackfillIngest({ request_id: req.request_id, error: 'GetDateTimes 401' })
      handled += 1
      break // stop the whole cycle — every request will hit the same wall
    }
    if (!matched) {
      // No format returned scans — close the request as done-with-0 so it
      // doesn't stick at "pending". Member may not be in InBody, or under a
      // phone format we didn't try.
      await postBackfillIngest({ request_id: req.request_id, usertoken: null, scans: [] })
      handled += 1
      logInfo('inbody', 'backfill no scans for any phone format', { request_id: req.request_id })
      continue
    }

    // 2. pull each scan using the matched usertoken (respecting headroom)
    const scans = []
    let hit401 = false
    for (const dt of datetimes) {
      if (withinDailyCap(state.sent, cap) <= 0) break
      const r = await fetcher({ apiUrl, apiKey, account, usertoken: matched, datetimes: dt })
      state.sent += 1
      save(state)
      if (r.ok && r.body) scans.push({ datetimes: dt, raw: r.body })
      else if (r.statusCode === 401) { hit401 = true; break }
    }

    // 3. relay with the matched usertoken so the CRM keys the scan on InBody's
    // own format (dedupes against the webhook path).
    const ingestRes = await postBackfillIngest({ request_id: req.request_id, usertoken: matched, scans })
    if (ingestRes.ok) ingested += ingestRes.body?.ingested ?? 0
    handled += 1
    logInfo('inbody', 'backfill complete', { request_id: req.request_id, usertoken: maskUsertoken(matched), found: datetimes.length, scans: scans.length })
    if (hit401) break
  }

  return { requests: handled, ingested }
}
