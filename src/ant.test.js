// Tests for the ANT+ adapter in fake mode. The real-hardware path
// (ant-plus-next over libusb) is validated by the on-Pi smoke test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'
process.env.FAKE_STRAPS = '1'

const { createAntAdapter } = await import('./ant.js')

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
