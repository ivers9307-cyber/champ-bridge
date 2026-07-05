// Tests for the Tapo reconcile cycle. runTapoCycle with injected deps (no
// network). Env is set before importing so config.js (which fails fast on
// missing env at import time) loads cleanly.
import { describe, it, expect, vi } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { runTapoCycle, newTapoState } = await import('./tapo.js')

const directive = (id, desired) => ({ sidecar_device_id: id, desired, resolved_windows: [], override_until: null })
const ok = (body) => ({ ok: true, statusCode: 200, body })
const fail = () => ({ ok: false, statusCode: 0, networkError: true })

function deps(overrides = {}) {
  return {
    getDirectives: vi.fn(async () => ok({ success: true, devices: [directive('a', 'on')] })),
    getSidecarDevices: vi.fn(async () => ok({ devices: [{ id: 'a', kind: 'plug', name_hint: 'TVs' }] })),
    getSidecarState: vi.fn(async () => ok({ devices: [{ id: 'a', state: 'off', reachable: true }] })),
    setSidecarPower: vi.fn(async () => ok({ ok: true })),
    postState: vi.fn(async () => ok({ success: true, updated: 1, discovered: 0, failed: 0 })),
    now: () => 1_000_000,
    ...overrides,
  }
}

describe('runTapoCycle', () => {
  it('happy path: fetch → diff → command → report', async () => {
    const d = deps()
    const state = newTapoState()
    const res = await runTapoCycle(state, d)
    expect(d.setSidecarPower).toHaveBeenCalledWith('a', true)
    expect(d.postState).toHaveBeenCalledWith([
      { sidecar_device_id: 'a', state: 'off', reachable: true, kind: 'plug', name_hint: 'TVs' },
    ])
    expect(state.directives).toHaveLength(1)
    expect(res.commanded).toBe(1)
  })

  it('CRM down: falls back to cached directives, still reconciles + reports', async () => {
    const state = newTapoState()
    state.directives = [{ sidecar_device_id: 'a', desired: 'on',
      resolved_windows: [{ on_at: new Date(999_000).toISOString(), off_at: new Date(2_000_000).toISOString() }],
      override_until: null }]
    state.fetchedAt = 900_000
    const d = deps({ getDirectives: vi.fn(async () => fail()) })
    const res = await runTapoCycle(state, d)
    expect(d.setSidecarPower).toHaveBeenCalledWith('a', true) // window membership, stale mode
    expect(res.fresh).toBe(false)
  })

  it('sidecar down: refreshes cache, commands nothing, reports nothing', async () => {
    const d = deps({ getSidecarState: vi.fn(async () => fail()) })
    const res = await runTapoCycle(newTapoState(), d)
    expect(d.setSidecarPower).not.toHaveBeenCalled()
    expect(d.postState).not.toHaveBeenCalled()
    expect(res.sidecarDown).toBe(true)
  })

  it('a failed command does not block the state report or other commands', async () => {
    const d = deps({
      getDirectives: vi.fn(async () => ok({ success: true, devices: [directive('a', 'on'), directive('b', 'on')] })),
      getSidecarState: vi.fn(async () => ok({ devices: [
        { id: 'a', state: 'off', reachable: true }, { id: 'b', state: 'off', reachable: true },
      ] })),
      setSidecarPower: vi.fn(async (id) => (id === 'a' ? { ok: false, statusCode: 502 } : ok({ ok: true }))),
    })
    const res = await runTapoCycle(newTapoState(), d)
    expect(d.setSidecarPower).toHaveBeenCalledTimes(2)
    expect(d.postState).toHaveBeenCalled()
    expect(res.commandFailures).toBe(1)
  })

  it('never throws even if everything explodes', async () => {
    const d = deps({
      getDirectives: vi.fn(async () => { throw new Error('boom') }),
      getSidecarState: vi.fn(async () => { throw new Error('boom') }),
    })
    await expect(runTapoCycle(newTapoState(), d)).resolves.toBeTruthy()
  })

  it('reentrancy: a second concurrent invocation skips without touching deps', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const d = deps({ getDirectives: vi.fn(async () => { await gate; return fail() }) })
    const state = newTapoState()
    const first = runTapoCycle(state, d) // parks on the gated directives fetch
    const second = await runTapoCycle(state, d)
    expect(second.skipped).toBe(true)
    expect(d.getDirectives).toHaveBeenCalledTimes(1) // first cycle only
    expect(d.getSidecarState).not.toHaveBeenCalled() // second never got past the guard
    release()
    await first
    // Guard released: a fresh invocation runs normally again.
    const third = await runTapoCycle(state, d)
    expect(third.skipped).toBeUndefined()
  })
})
