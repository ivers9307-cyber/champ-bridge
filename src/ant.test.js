// Tests for the ANT+ adapter in fake mode. The real-hardware path
// (ant-plus-next over libusb) is validated by the on-Pi smoke test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'
process.env.FAKE_STRAPS = '1'

const { createAntAdapter, RealAnt } = await import('./ant.js')

describe('FakeAnt adapter', () => {
  let adapter

  beforeEach(() => {
    vi.useFakeTimers()
    adapter = createAntAdapter()
  })

  afterEach(async () => {
    await adapter.stop()
    vi.useRealTimers()
  })

  it('emits strap-seen with ant: device keys', async () => {
    const seen = []
    adapter.on('strap-seen', (s) => seen.push(s))
    await adapter.start()
    vi.advanceTimersByTime(300)
    expect(seen.length).toBe(2)
    for (const s of seen) {
      expect(s.device_key).toMatch(/^ant:\d{1,5}$/)
      // ANT+ straps broadcast no friendly name and no RSSI.
      expect(s.rssi).toBe(null)
    }
  })

  it('emits strap-sample with an ant device key and an in-range bpm', async () => {
    const samples = []
    adapter.on('strap-sample', (s) => samples.push(s))
    await adapter.start()
    vi.advanceTimersByTime(300)
    vi.advanceTimersByTime(1000)
    expect(samples.length).toBe(2)
    for (const s of samples) {
      expect(s.device_key.startsWith('ant:')).toBe(true)
      expect(s.bpm).toBeGreaterThanOrEqual(60)
      expect(s.bpm).toBeLessThanOrEqual(180)
    }
  })

  it('getCurrentStraps reflects detected straps', async () => {
    await adapter.start()
    vi.advanceTimersByTime(300)
    const straps = adapter.getCurrentStraps()
    expect(straps.length).toBe(2)
    expect(straps.every((s) => s.device_key.startsWith('ant:'))).toBe(true)
  })

  it('stop() halts the sample stream', async () => {
    const samples = []
    adapter.on('strap-sample', (s) => samples.push(s))
    await adapter.start()
    vi.advanceTimersByTime(300)
    await adapter.stop()
    const countAfterStop = samples.length
    vi.advanceTimersByTime(5000)
    expect(samples.length).toBe(countAfterStop)
  })
})

// ── RealAnt teardown / recovery (the 2026-08-12 wedge) ───────────────────────
// `start()` needs the native ant-plus-next binding, but the state machine that
// failed does not: we drive `_closeStick` / `_teardownAndReopen` against stub
// scanner/stick objects whose close paths behave like ant-plus-next's
// `USBDriver.write()` did — a promise that is never resolved and never
// rejected because `outEndpoint` was already gone.

/** A stub whose teardown call parks forever, exactly like the real one did. */
function hungStick() {
  return {
    close: () => new Promise(() => {}),
    removeListener() {},
  }
}
function hungScanner() {
  return {
    detach: () => new Promise(() => {}),
    removeListener() {},
  }
}

describe('RealAnt teardown is bounded and recovery is guaranteed', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('_closeStick returns even when detach AND close never settle', async () => {
    const a = new RealAnt()
    a._scanner = hungScanner()
    a._stick = hungStick()
    let done = false
    const p = a._closeStick().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(done).toBe(true)
  })

  it('drops the handles up front so status() stops lying about a dead stick', async () => {
    const a = new RealAnt()
    a._scanner = hungScanner()
    a._stick = hungStick()
    a._scanning = true
    const p = a._closeStick()
    // Before any await settles, the adapter must already report itself down —
    // heartbeat telemetry used to keep saying stick_present:true forever.
    expect(a.status().stick_present).toBe(false)
    expect(a.status().scanning).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await p
  })

  it('schedules the reopen EVEN WHEN the close hangs — the actual root cause', async () => {
    // Previously `_scheduleReopen()` sat after an unbounded `await
    // _closeStick()`, so a parked close meant ANT+ never came back while the
    // process kept heartbeating as healthy.
    const a = new RealAnt()
    a._scanner = hungScanner()
    a._stick = hungStick()
    const p = a._teardownAndReopen()
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(a.status().reopen_pending).toBe(true)
    await a.stop()
  })

  it('a second error event during teardown does not stack a second teardown', async () => {
    const a = new RealAnt()
    let detachCalls = 0
    a._scanner = { detach: () => { detachCalls += 1; return new Promise(() => {}) }, removeListener() {} }
    a._stick = hungStick()
    const first = a._teardownAndReopen()
    const second = a._teardownAndReopen() // stick emits 'error' then 'shutdown'
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([first, second])
    expect(detachCalls).toBe(1)
    await a.stop()
  })

  it('stop() completes despite a hung close, so SIGTERM can never park here', async () => {
    const a = new RealAnt()
    a._scanner = hungScanner()
    a._stick = hungStick()
    a.seen.set('ant:44670', { lastBpm: 120, rssi: null, lastSeenMs: 0, lastForwardedMs: 0 })
    let done = false
    const p = a.stop().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(done).toBe(true)
    expect(a.seen.size).toBe(0)
    expect(a.status().reopen_pending).toBe(false) // stopped for good, no retry
  })

  it('status() exposes the supervisor fields the watchdog predicate reads', async () => {
    const a = new RealAnt()
    const s = a.status()
    expect(s).toHaveProperty('scanning')
    expect(s).toHaveProperty('opening')
    expect(s).toHaveProperty('closing')
    expect(s).toHaveProperty('reopen_pending')
    expect(Number.isFinite(s.last_progress_ms)).toBe(true)
  })
})
