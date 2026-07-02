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

const { pushSample, flushSamples, pendingCount } = await import('./buffer.js')
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
