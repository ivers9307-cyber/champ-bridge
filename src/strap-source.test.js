// Tests for the dual-protocol orchestrator in fake mode — both the
// ANT+ and BLE fake adapters run, and strap-source merges them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'
process.env.FAKE_STRAPS = '1'
// Default config leaves both protocols enabled.

const { createStrapSource } = await import('./strap-source.js')

describe('StrapSource — dual-protocol merge', () => {
  let source

  beforeEach(() => {
    vi.useFakeTimers()
    source = createStrapSource()
  })

  afterEach(async () => {
    await source.stop()
    vi.useRealTimers()
  })

  it('forwards strap-seen from both protocols', async () => {
    const seen = []
    source.on('strap-seen', (s) => seen.push(s))
    await source.start()
    vi.advanceTimersByTime(300)
    // 2 fake ANT+ straps + 2 fake BLE straps.
    expect(seen.length).toBe(4)
    expect(seen.filter((s) => s.device_key.startsWith('ant:')).length).toBe(2)
    expect(seen.filter((s) => s.device_key.startsWith('ble:')).length).toBe(2)
  })

  it('forwards strap-sample from both protocols', async () => {
    const samples = []
    source.on('strap-sample', (s) => samples.push(s))
    await source.start()
    vi.advanceTimersByTime(300)
    vi.advanceTimersByTime(1000)
    expect(samples.length).toBe(4)
  })

  it('getCurrentStraps concatenates both adapters with unique keys', async () => {
    await source.start()
    vi.advanceTimersByTime(300)
    const straps = source.getCurrentStraps()
    expect(straps.length).toBe(4)
    const keys = straps.map((s) => s.device_key)
    // Protocol-namespaced — no key appears twice.
    expect(new Set(keys).size).toBe(4)
  })

  it('stop() halts every adapter', async () => {
    const samples = []
    source.on('strap-sample', (s) => samples.push(s))
    await source.start()
    vi.advanceTimersByTime(300)
    await source.stop()
    const countAfterStop = samples.length
    vi.advanceTimersByTime(5000)
    expect(samples.length).toBe(countAfterStop)
  })
})
