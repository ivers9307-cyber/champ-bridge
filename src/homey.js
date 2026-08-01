// homey.js — Homey Pro local-API actuation for the tapo reconcile cycle.
//
// Replaces the python-kasa sidecar (removed in this branch; see spec 2026-08-01). The
// Homey Pro owns every vendor protocol; we speak only its local REST API:
//   GET /api/manager/devices/device                      (all devices + live values)
//   PUT /api/manager/devices/device/{id}/capability/onoff {"value": bool}
// Auth: Authorization: Bearer <scoped API key>, LAN only.
//
// Scope: every device exposing an `onoff` capability (Richard, 2026-08-01)
// — the CRM adopt flow auto-registers them disabled. IDs are namespaced
// `homey:<device-id>` (house convention: ant:/ble:/mac:/hub:).

import { request } from 'undici'

const HOMEY_PREFIX = 'homey:'

function homeyDeviceList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw)
  return []
}

const hasOnoff = (d) =>
  Array.isArray(d?.capabilities) ? d.capabilities.includes('onoff') : !!d?.capabilitiesObj?.onoff

const controllableDevices = (raw) =>
  homeyDeviceList(raw).filter((d) => d && typeof d.id === 'string' && d.id && hasOnoff(d))

// → [{ id, kind, name_hint? }] for buildStateReport metadata + adopt.
export function mapHomeyDevices(raw) {
  return controllableDevices(raw).map((d) => {
    const row = { id: HOMEY_PREFIX + d.id, kind: d.class === 'socket' ? 'plug' : 'switch' }
    if (d.name) row.name_hint = String(d.name)
    return row
  })
}

// → [{ id, state: 'on'|'off'|null, reachable }]. Unavailable → state null
// (unknown, never guessed) + reachable false, so diffCommands skips it.
export function mapHomeyStates(raw) {
  return controllableDevices(raw).map((d) => {
    const reachable = d.available !== false
    const v = d.capabilitiesObj?.onoff?.value
    const state = !reachable ? null : v === true ? 'on' : v === false ? 'off' : null
    return { id: HOMEY_PREFIX + d.id, state, reachable }
  })
}

// Actuation deps for runTapoCycle. Concurrent reads share one in-flight GET
// (the cycle reads both slots via Promise.all); cleared on settle so the
// next tick refetches.
export function createHomeyActuation({ address, apiKey, requestJson }) {
  let inflight = null
  const snapshot = () => {
    if (!inflight) {
      inflight = requestJson('GET', `${address}/api/manager/devices/device`, apiKey, undefined)
        .finally(() => { inflight = null })
    }
    return inflight
  }
  const read = (mapper) => async () => {
    const r = await snapshot()
    if (!r.ok) return r
    return { ok: true, statusCode: r.statusCode, body: { devices: mapper(r.body) } }
  }
  return {
    getDevices: read(mapHomeyDevices),
    getState: read(mapHomeyStates),
    setPower: (id, on) => {
      const realId = id.startsWith(HOMEY_PREFIX) ? id.slice(HOMEY_PREFIX.length) : id
      return requestJson(
        'PUT',
        `${address}/api/manager/devices/device/${encodeURIComponent(realId)}/capability/onoff`,
        apiKey,
        { value: on },
      )
    },
  }
}

// Real HTTP dep (index-side wiring passes this in). Never throws.
export async function homeyRequestJson(method, url, apiKey, body) {
  try {
    const r = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
