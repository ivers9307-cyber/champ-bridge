// tapo-logic.js — pure decision logic for the tapo reconcile cycle.
// No I/O. Fully unit-tested; tapo.js is a thin orchestrator around this.
//
// Offline semantics (CRM unreachable, cache stale):
//   resolved_windows is a MEMBERSHIP SET — device on iff now is inside
//   ANY window. An active override (override_until in the future) keeps
//   the cached desired until it expires, then windows take over; a
//   pure-override device (no windows) reverts to unmanaged (null).

export function evaluateDesired(directive, nowMs, fresh) {
  if (!directive || typeof directive !== 'object') return null
  if (fresh) return directive.desired ?? null

  const until = directive.override_until ? new Date(directive.override_until).getTime() : NaN
  if (Number.isFinite(until) && until > nowMs) {
    return directive.desired ?? null // cached desired reflects the override
  }

  const windows = Array.isArray(directive.resolved_windows) ? directive.resolved_windows : null
  if (!windows || windows.length === 0) return null // nothing to schedule from → unmanaged
  for (const w of windows) {
    const on = new Date(w?.on_at).getTime()
    const off = new Date(w?.off_at).getTime()
    if (Number.isFinite(on) && Number.isFinite(off) && nowMs >= on && nowMs < off) return 'on'
  }
  return 'off'
}

// → [{ id, on: bool }] — only for devices that are reachable, managed,
// and actually different from desired (idempotent reconciliation).
export function diffCommands(directives, actuals, nowMs, fresh) {
  const byId = new Map((actuals || []).map((a) => [a.id, a]))
  const out = []
  for (const d of directives || []) {
    const desired = evaluateDesired(d, nowMs, fresh)
    if (desired !== 'on' && desired !== 'off') continue
    const actual = byId.get(d.sidecar_device_id)
    if (!actual || actual.reachable === false) continue
    if (actual.state === desired) continue
    out.push({ id: d.sidecar_device_id, on: desired === 'on' })
  }
  return out
}

// Sidecar /devices + /state → CRM POST /api/bridge/tapo/state body rows.
// kind/name_hint ride along so brand-new devices auto-register correctly.
export function buildStateReport(devices, states) {
  const meta = new Map((devices || []).map((d) => [d.id, d]))
  return (states || []).slice(0, 200).map((s) => {
    const m = meta.get(s.id)
    const row = { sidecar_device_id: s.id, state: s.state ?? null, reachable: s.reachable !== false }
    if (m?.kind) row.kind = m.kind
    if (m?.name_hint) row.name_hint = m.name_hint
    return row
  })
}
