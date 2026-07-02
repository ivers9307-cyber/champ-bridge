// Tests for the pure ANT+ decimation decision + bpm clamp (decimate.js),
// lifted out of ant.js so the ~4 Hz → ~1 Hz thinning is testable off the
// hardware event stream.

import { describe, it, expect } from 'vitest'
import {
  shouldForwardSample,
  clampBpm,
  DECIMATE_WINDOW_MS,
  ANT_MAX_BPM,
} from './decimate.js'

describe('shouldForwardSample', () => {
  it('always forwards the first sample (no prior forward)', () => {
    expect(shouldForwardSample(1000, null)).toBe(true)
    expect(shouldForwardSample(1000, undefined)).toBe(true)
  })

  it('drops a second sample inside the same 1s window', () => {
    // ANT+'s ~4 Hz: samples ~250ms apart should be dropped after the first.
    expect(shouldForwardSample(1000, 1000)).toBe(false)
    expect(shouldForwardSample(1250, 1000)).toBe(false)
    expect(shouldForwardSample(1500, 1000)).toBe(false)
    expect(shouldForwardSample(1750, 1000)).toBe(false)
  })

  it('forwards once the window has fully elapsed', () => {
    expect(shouldForwardSample(2000, 1000)).toBe(true) // exactly 1000ms later
    expect(shouldForwardSample(2001, 1000)).toBe(true)
  })

  it('thins a ~4 Hz stream to ~1 Hz', () => {
    // Simulate 4 Hz for 2 seconds; count forwards keeping state.
    let last = null
    let forwarded = 0
    for (let t = 0; t < 2000; t += 250) {
      if (shouldForwardSample(t, last)) { forwarded++; last = t }
    }
    // t = 0, 1000 → 2 forwards over 2s of 4 Hz input (8 samples).
    expect(forwarded).toBe(2)
  })

  it('honours a custom window', () => {
    expect(shouldForwardSample(1500, 1000, 2000)).toBe(false)
    expect(shouldForwardSample(3000, 1000, 2000)).toBe(true)
  })

  it('exposes a 1000ms default window', () => {
    expect(DECIMATE_WINDOW_MS).toBe(1000)
  })
})

describe('clampBpm', () => {
  it('passes a normal bpm through unchanged', () => {
    expect(clampBpm(72)).toBe(72)
  })

  it('clamps an out-of-range bpm to the max', () => {
    expect(clampBpm(300)).toBe(ANT_MAX_BPM)
    expect(clampBpm(255)).toBe(ANT_MAX_BPM)
  })

  it('accepts a bpm exactly at the max', () => {
    expect(clampBpm(ANT_MAX_BPM)).toBe(ANT_MAX_BPM)
  })

  it('returns null for zero / negative / non-finite', () => {
    expect(clampBpm(0)).toBeNull()
    expect(clampBpm(-5)).toBeNull()
    expect(clampBpm(NaN)).toBeNull()
    expect(clampBpm(Infinity)).toBeNull()
    expect(clampBpm('nope')).toBeNull()
  })
})
