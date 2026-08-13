// Tests for the sample buffer. We mock the api module so flushSamples
// can be exercised without network.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api.js', () => ({
  postSamples: vi.fn(),
  // (samples carry a protocol-aware device_key — see device-key.js)
}))
// Also need to satisfy config.js loading — it bails if env is missing.
process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { pushSample, flushSamples, drainSamples, pendingCount } = await import('./buffer.js')
const { postSamples } = await import('./api.js')

beforeEach(() => {
  vi.clearAllMocks()
  // Drain whatever previous tests left behind.
  postSamples.mockResolvedValue({ ok: true })
  return flushSamples()
})

describe('pushSample / pendingCount', () => {
  it('accumulates samples until flush', () => {
    pushSample({ device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T00:00:00.000Z', bpm: 120 })
    pushSample({ device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-08T00:00:01.000Z', bpm: 121 })
    expect(pendingCount()).toBe(2)
  })
})

describe('flushSamples', () => {
  it('returns sent:0 when buffer is empty', async () => {
    expect(await flushSamples()).toEqual({ sent: 0 })
  })

  it('sends in single chunk under 1000 samples', async () => {
    postSamples.mockResolvedValue({ ok: true })
    for (let i = 0; i < 50; i++) {
      pushSample({ device_key: 'ant:12345', recorded_at: new Date().toISOString(), bpm: 120 })
    }
    const out = await flushSamples()
    expect(out.sent).toBe(50)
    expect(postSamples).toHaveBeenCalledTimes(1)
    expect(pendingCount()).toBe(0)
  })

  it('chunks at 1000 samples', async () => {
    postSamples.mockResolvedValue({ ok: true })
    for (let i = 0; i < 1500; i++) {
      pushSample({ device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: new Date().toISOString(), bpm: 120 })
    }
    const out = await flushSamples()
    expect(out.sent).toBe(1500)
    expect(postSamples).toHaveBeenCalledTimes(2)
  })

  it('on a chunk failure, re-prepends the unsent remainder for retry', async () => {
    postSamples
      .mockResolvedValueOnce({ ok: true })   // first chunk fine
      .mockResolvedValueOnce({ ok: false, networkError: true }) // second fails
    for (let i = 0; i < 1500; i++) {
      pushSample({ device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: new Date().toISOString(), bpm: 120 })
    }
    const out = await flushSamples()
    expect(out.sent).toBe(1000)
    expect(out.failed).toBe(true)
    // 500 remaining buffered for retry on next tick.
    expect(pendingCount()).toBe(500)
  })
})

describe('overflow', () => {
  it('drops oldest when buffer exceeds MAX_BUFFER (5000)', () => {
    for (let i = 0; i < 5500; i++) {
      pushSample({ device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: new Date(Date.now() + i).toISOString(), bpm: 120 })
    }
    expect(pendingCount()).toBe(5000)
  })
})

describe('in-flight guard (concurrent flush prevention)', () => {
  it('a second flush while the first is in-flight no-ops and does not double-send', async () => {
    // beforeEach may have drained a leftover buffer; reset call count so
    // we count only this test's posts.
    postSamples.mockClear()
    // Make postSamples hang until we release it — simulates a slow API.
    let release
    const gate = new Promise((r) => { release = r })
    postSamples.mockImplementation(async () => { await gate; return { ok: true } })

    for (let i = 0; i < 10; i++) {
      pushSample({ device_key: 'ant:12345', recorded_at: new Date().toISOString(), bpm: 120 })
    }

    // Start flush #1 (parks on the gate mid-post).
    const first = flushSamples()
    // Flush #2 fires from the next interval tick while #1 is in-flight.
    const second = await flushSamples()
    // #2 must have skipped — NOT started a concurrent post of the same snapshot.
    expect(second).toEqual({ sent: 0, skipped: true })

    release()
    const firstResult = await first
    expect(firstResult.sent).toBe(10)
    // Exactly one network post for the 10 samples — no double-send.
    expect(postSamples).toHaveBeenCalledTimes(1)
    expect(pendingCount()).toBe(0)
  })

  it('flushing flag clears after completion so the next tick can flush', async () => {
    postSamples.mockResolvedValue({ ok: true })
    pushSample({ device_key: 'ant:12345', recorded_at: new Date().toISOString(), bpm: 120 })
    await flushSamples()
    // Second, sequential flush works normally (guard reset in finally).
    pushSample({ device_key: 'ant:12345', recorded_at: new Date().toISOString(), bpm: 121 })
    const out = await flushSamples()
    expect(out.sent).toBe(1)
  })
})


// ── drainSamples — the SIGTERM path ──────────────────────────────
//
// flushSamples() no-ops while a flush is in flight. That is correct for the
// 3s interval and WRONG at shutdown: it returned {sent:0,skipped:true}
// instantly and the shutdown step logged 'ok', so everything buffered since
// the last successful flush was lost on that restart, silently.
describe('drainSamples (final drain on shutdown)', () => {
  const sample = (bpm) => ({ device_key: 'ant:44670', recorded_at: new Date().toISOString(), bpm })

  it('waits for the in-flight flush and then sends the remainder', async () => {
    // Hold the first flush open mid-"request", exactly like a slow HTTPS POST
    // when SIGTERM lands.
    let releaseFirst
    const firstInFlight = new Promise((res) => { releaseFirst = res })
    const seen = []
    postSamples
      .mockImplementationOnce(async (chunk) => { seen.push(chunk.length); await firstInFlight; return { ok: true } })
      .mockImplementation(async (chunk) => { seen.push(chunk.length); return { ok: true } })

    pushSample(sample(120))
    pushSample(sample(121))
    const periodic = flushSamples()          // in flight, holding 2 samples

    // Samples keep arriving while that request is open — these are the ones
    // the old code threw away.
    pushSample(sample(130))
    pushSample(sample(131))
    pushSample(sample(132))

    const drainPromise = drainSamples()
    releaseFirst()
    const [, drained] = await Promise.all([periodic, drainPromise])

    expect(drained.waited).toBe(true)
    expect(drained.sent).toBe(3)             // the 3 that arrived mid-request
    expect(drained.lost).toBeUndefined()
    expect(seen).toEqual([2, 3])             // both batches actually posted
    expect(pendingCount()).toBe(0)           // nothing left behind
  })

  it('reports `lost` when the drain cannot send (so the journal shows it)', async () => {
    postSamples.mockResolvedValue({ ok: false, status: 503 })
    pushSample(sample(140))
    pushSample(sample(141))

    const out = await drainSamples()
    expect(out.sent).toBe(0)
    expect(out.lost).toBe(2)                 // re-prepended, and REPORTED
    expect(pendingCount()).toBe(2)
  })

  it('drains normally when no flush is in flight', async () => {
    postSamples.mockResolvedValue({ ok: true })
    pushSample(sample(150))
    const out = await drainSamples()
    expect(out.waited).toBe(false)
    expect(out.sent).toBe(1)
    expect(pendingCount()).toBe(0)
  })

  it('still drains when the in-flight flush REJECTS', async () => {
    // A thrown flush must not poison the drain — its finally has already
    // re-prepended, so the remainder is still ours to send.
    let rejectFirst
    const boom = new Promise((_, rej) => { rejectFirst = rej })
    postSamples
      .mockImplementationOnce(async () => { await boom; return { ok: true } })
      .mockImplementation(async () => ({ ok: true }))

    pushSample(sample(160))
    const periodic = flushSamples().catch(() => {})
    pushSample(sample(161))

    const drainPromise = drainSamples()
    rejectFirst(new Error('socket hang up'))
    await periodic
    const out = await drainPromise

    expect(out.waited).toBe(true)
    expect(pendingCount()).toBe(0)
  })

  it('does NOT weaken the interval guard — concurrent flushSamples still skips', async () => {
    let release
    const held = new Promise((res) => { release = res })
    postSamples.mockImplementationOnce(async () => { await held; return { ok: true } })

    pushSample(sample(170))
    const first = flushSamples()
    const second = await flushSamples()      // the interval's next tick
    expect(second).toEqual({ sent: 0, skipped: true })

    release()
    await first
  })
})
