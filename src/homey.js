// homey.js — Homey Pro local-API actuation for the tapo reconcile cycle.
//
// Replaces the python-kasa sidecar (deleted; see spec 2026-08-01). The
// Homey Pro owns every vendor protocol; we speak only its local REST API:
//   GET /api/manager/devices/device                      (all devices + live values)
//   PUT /api/manager/devices/device/{id}/capability/onoff {"value": bool}
// Auth: Authorization: Bearer <scoped API key>, LAN only.
//
// Scope: every device exposing an `onoff` capability (Richard, 2026-08-01)
// — the CRM adopt flow auto-registers them disabled. IDs are namespaced
// `homey:<device-id>` (house convention: ant:/ble:/mac:/hub:).

const HOMEY_PREFIX = 'homey:'

function homeyDeviceList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw)
  return []
}

const hasOnoff = (d) =>
  Array.isArray(d?.capabilities) ? d.capabilities.includes('onoff') : !!d?.capabilitiesObj?.onoff

const controllable = (raw) =>
  homeyDeviceList(raw).filter((d) => d && typeof d.id === 'string' && d.id && hasOnoff(d))

// → [{ id, kind, name_hint?, model? }] for buildStateReport metadata + adopt.
export function mapHomeyDevices(raw) {
  return controllable(raw).map((d) => {
    const row = { id: HOMEY_PREFIX + d.id, kind: d.class === 'socket' ? 'plug' : 'switch' }
    if (d.name) row.name_hint = String(d.name)
    if (d.driverId) row.model = String(d.driverId)
    return row
  })
}

// → [{ id, state: 'on'|'off'|null, reachable }]. Unavailable → state null
// (unknown, never guessed) + reachable false, so diffCommands skips it.
export function mapHomeyStates(raw) {
  return controllable(raw).map((d) => {
    const reachable = d.available !== false
    const v = d.capabilitiesObj?.onoff?.value
    const state = !reachable ? null : v === true ? 'on' : v === false ? 'off' : null
    return { id: HOMEY_PREFIX + d.id, state, reachable }
  })
}
