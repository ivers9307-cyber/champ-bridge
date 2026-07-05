import { describe, it, expect } from 'vitest'
import { evaluateDesired, diffCommands, buildStateReport } from './tapo-logic.js'

const W = (onIso, offIso) => ({ on_at: onIso, off_at: offIso })
const T = (iso) => new Date(iso).getTime()

describe('evaluateDesired', () => {
  const directive = {
    sidecar_device_id: 'mac:AA:BB:CC:DD:EE:FF',
    desired: 'on',
    resolved_windows: [W('2026-07-06T06:00:00.000Z', '2026-07-06T20:30:00.000Z')],
    override_until: null,
  }
  it('fresh directives: CRM desired is authoritative', () => {
    expect(evaluateDesired(directive, T('2026-07-06T23:00:00Z'), true)).toBe('on')
  })
  it('stale + inside a window → on; outside → off (membership set)', () => {
    expect(evaluateDesired(directive, T('2026-07-06T12:00:00Z'), false)).toBe('on')
    expect(evaluateDesired(directive, T('2026-07-06T22:00:00Z'), false)).toBe('off')
  })
  it('stale + active override honored until override_until, then windows', () => {
    const d = { ...directive, desired: 'off', override_until: '2026-07-06T13:00:00.000Z' }
    expect(evaluateDesired(d, T('2026-07-06T12:00:00Z'), false)).toBe('off') // override cached
    expect(evaluateDesired(d, T('2026-07-06T14:00:00Z'), false)).toBe('on')  // expired → window
  })
  it('stale + no windows + expired override → null (unmanaged; leave alone)', () => {
    const d = { ...directive, resolved_windows: [], override_until: '2026-07-06T13:00:00.000Z', desired: 'on' }
    expect(evaluateDesired(d, T('2026-07-06T14:00:00Z'), false)).toBe(null)
  })
  it('overlapping windows: on if inside ANY', () => {
    const d = { ...directive, resolved_windows: [
      W('2026-07-06T09:00:00.000Z', '2026-07-06T13:00:00.000Z'),
      W('2026-07-06T12:00:00.000Z', '2026-07-06T17:00:00.000Z'),
    ] }
    expect(evaluateDesired(d, T('2026-07-06T12:30:00Z'), false)).toBe('on')
    expect(evaluateDesired(d, T('2026-07-06T13:30:00Z'), false)).toBe('on') // 1st ended, 2nd holds
  })
  it('garbage override_until is ignored, falls to windows', () => {
    const d = { ...directive, override_until: 'not-a-date' }
    expect(evaluateDesired(d, T('2026-07-06T12:00:00Z'), false)).toBe('on') // in-window
  })
  it('never throws on malformed input', () => {
    expect(evaluateDesired(null, Date.now(), false)).toBe(null)
    expect(evaluateDesired({ resolved_windows: 'junk' }, Date.now(), false)).toBe(null)
  })
})

describe('diffCommands', () => {
  it('commands only mismatched, reachable devices', () => {
    const directives = [
      { sidecar_device_id: 'a', desired: 'on', resolved_windows: [], override_until: null },
      { sidecar_device_id: 'b', desired: 'off', resolved_windows: [], override_until: null },
      { sidecar_device_id: 'c', desired: 'on', resolved_windows: [], override_until: null },
      { sidecar_device_id: 'd', desired: null, resolved_windows: [], override_until: null },
    ]
    const actuals = [
      { id: 'a', state: 'off', reachable: true },  // mismatch → command on
      { id: 'b', state: 'off', reachable: true },  // match → skip
      { id: 'c', state: null, reachable: false },  // unreachable → skip
      { id: 'd', state: 'on', reachable: true },   // unmanaged → skip
      { id: 'e', state: 'on', reachable: true },   // no directive → skip
    ]
    expect(diffCommands(directives, actuals, Date.now(), true))
      .toEqual([{ id: 'a', on: true }])
  })
})

describe('buildStateReport', () => {
  it('maps sidecar shapes to the CRM contract, capped at 200', () => {
    const devices = [{ id: 'mac:AA:BB:CC:DD:EE:FF', kind: 'plug', name_hint: 'TVs', host: 'x' }]
    const states = [{ id: 'mac:AA:BB:CC:DD:EE:FF', state: 'on', reachable: true }]
    expect(buildStateReport(devices, states)).toEqual([{
      sidecar_device_id: 'mac:AA:BB:CC:DD:EE:FF', kind: 'plug',
      state: 'on', reachable: true, name_hint: 'TVs',
    }])
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `d${i}`, state: 'on', reachable: true }))
    expect(buildStateReport([], many)).toHaveLength(200)
  })
})
