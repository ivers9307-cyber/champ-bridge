// tapo.js — Tapo reconcile cycle (Wave T2).
//
// Every tick (~15s):
//   1. GET /api/bridge/tapo/directives from the CRM; on success cache
//      in memory (this repo is stateless by design — no file cache; a
//      power-cycle during a CRM outage means unmanaged devices until
//      the CRM returns, and the Tapo app is the manual fallback).
//   2. Read actuals from the sidecar (localhost). Sidecar down → skip
//      commanding AND reporting (CRM last_seen goes stale → amber/red
//      dots in the devices UI; that staleness IS the failure signal).
//   3. diffCommands → POST /device/{id}/state to the sidecar per
//      mismatch (idempotent; failures logged, retried next tick).
//   4. buildStateReport → POST /api/bridge/tapo/state (drives
//      last_state/last_seen_at and the auto-register adopt flow).
//
// Never throws. Deps injected for tests; index.js passes the real ones.

import { config } from './config.js'
import { logWarn } from './log.js'
import { diffCommands, buildStateReport } from './tapo-logic.js'

// Cached directives older than this are discarded entirely — after a
// long CRM outage yesterday's windows are wrong (they're resolved per
// Dublin day server-side).
const CACHE_MAX_AGE_MS = 26 * 3600 * 1000

export function newTapoState() {
  return { directives: null, fetchedAt: 0, running: false }
}

export async function runTapoCycle(state, deps) {
  const res = { fresh: false, sidecarDown: false, commanded: 0, commandFailures: 0, reported: 0 }
  // Reentrancy guard: a cycle slower than pollMs would otherwise overlap via
  // setInterval and race last-write-wins on the shared state object. Skip
  // this tick; the in-flight cycle finishes and the next tick reconciles.
  if (state.running) {
    res.skipped = true
    return res
  }
  state.running = true
  try {
    const now = deps.now()

    // 1. Refresh directive cache from the CRM.
    try {
      const dir = await deps.getDirectives()
      if (dir.ok && dir.body?.success) {
        state.directives = dir.body.devices || []
        state.fetchedAt = now
        res.fresh = true
      } else {
        logWarn('tapo', 'directives fetch failed — using cache', { statusCode: dir.statusCode })
      }
    } catch (err) {
      logWarn('tapo', 'directives fetch threw — using cache', { err })
    }
    if (state.directives && now - state.fetchedAt > CACHE_MAX_AGE_MS) {
      logWarn('tapo', 'directive cache expired — devices unmanaged until CRM returns')
      state.directives = null
    }

    // 2. Actuals from the sidecar (both reads in parallel — localhost, cheap).
    let devices = []
    let states = null
    try {
      const [devRes, stateRes] = await Promise.all([deps.getSidecarDevices(), deps.getSidecarState()])
      if (devRes.ok) devices = devRes.body?.devices || []
      if (stateRes.ok) states = stateRes.body?.devices || null
    } catch (err) {
      logWarn('tapo', 'sidecar read threw', { err })
    }
    if (!states) {
      res.sidecarDown = true
      logWarn('tapo', 'sidecar unreachable — skipping reconcile + report')
      return res
    }

    // 3. Reconcile.
    const commands = diffCommands(state.directives || [], states, now, res.fresh)
    for (const c of commands) {
      try {
        const r = await deps.setSidecarPower(c.id, c.on)
        if (r.ok) res.commanded++
        else { res.commandFailures++; logWarn('tapo', 'command failed', { id: c.id, on: c.on, statusCode: r.statusCode }) }
      } catch (err) {
        res.commandFailures++
        logWarn('tapo', 'command threw', { id: c.id, on: c.on, err })
      }
    }

    // 4. Report actuals (pre-command snapshot; next tick reports the effect).
    const report = buildStateReport(devices, states)
    if (report.length) {
      try {
        const r = await deps.postState(report)
        if (r.ok) res.reported = report.length
        else logWarn('tapo', 'state report failed', { statusCode: r.statusCode })
      } catch (err) {
        logWarn('tapo', 'state report threw', { err })
      }
    }
    return res
  } catch (err) {
    logWarn('tapo', 'cycle error', { err })
    return res
  } finally {
    state.running = false
  }
}

// ——— real deps (index.js) ———

import { getTapoDirectives, postTapoState } from './api.js'
import { request } from 'undici'

async function sidecarJson(method, path, body) {
  try {
    const r = await request(config.tapoSidecarUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      headersTimeout: 5000,
      bodyTimeout: 5000,
    })
    const text = await r.body.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
    return { ok: r.statusCode >= 200 && r.statusCode < 300, statusCode: r.statusCode, body: parsed }
  } catch (err) {
    return { ok: false, statusCode: 0, networkError: true, err }
  }
}

export const realTapoDeps = {
  getDirectives: getTapoDirectives,
  getSidecarDevices: () => sidecarJson('GET', '/devices'),
  getSidecarState: () => sidecarJson('GET', '/state'),
  setSidecarPower: (id, on) => sidecarJson('POST', `/device/${encodeURIComponent(id)}/state`, { on }),
  postState: postTapoState,
  now: () => Date.now(),
}
