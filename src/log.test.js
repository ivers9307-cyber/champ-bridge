// Tests for the pure per-key log dedup decision (log.js). Env is set before
// import so config.js loads cleanly (it fails fast on missing env).
import { describe, it, expect } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { dedupDecision, DEDUP_WINDOW_MS } = await import('./log.js')

// Simulate the logger's per-key Map for a stream of same-key lines.
function runStream(times, windowMs = DEDUP_WINDOW_MS) {
  let entry
  const emits = []
  const summaries = []
  for (const now of times) {
    const d = dedupDecision(entry, now, windowMs)
    entry = d.entry
    if (d.summary) summaries.push({ at: now, ...d.summary })
    if (d.emit) emits.push(now)
  }
  return { emits, summaries, entry }
}

describe('dedupDecision', () => {
  it('emits the first sight of a key, no summary', () => {
    const d = dedupDecision(undefined, 1000)
    expect(d.emit).toBe(true)
    expect(d.summary).toBeNull()
    expect(d.entry).toEqual({ firstTs: 1000, suppressed: 0 })
  })

  it('suppresses repeats within the window and counts them', () => {
    const { emits, entry } = runStream([0, 1000, 2000, 3000])
    expect(emits).toEqual([0]) // only the first
    expect(entry.suppressed).toBe(3)
  })

  it('re-emits + summarises once the window elapses', () => {
    const { emits, summaries } = runStream([0, 1000, 2000, DEDUP_WINDOW_MS])
    expect(emits).toEqual([0, DEDUP_WINDOW_MS])
    expect(summaries).toEqual([{ at: DEDUP_WINDOW_MS, count: 2, sinceMs: DEDUP_WINDOW_MS }])
  })

  it('collapses a 1000-line burst into 1 emit + suppressed count', () => {
    const times = Array.from({ length: 1000 }, (_, i) => i * 50) // 50ms apart, 50s span
    const { emits, entry } = runStream(times)
    expect(emits).toEqual([0])
    expect(entry.suppressed).toBe(999)
  })

  it('honours a custom window', () => {
    const { emits } = runStream([0, 500, 1000, 1500, 2000], 1000)
    // window 1000: emit at 0; 500 suppressed; 1000 elapsed → emit; 1500 suppressed; 2000 elapsed → emit
    expect(emits).toEqual([0, 1000, 2000])
  })

  it('tracks two interleaved keys independently (the scan/heartbeat case)', () => {
    // The real-world defeat of a single-slot dedup: two distinct warns alternate.
    // With per-key state each collapses on its own.
    const map = new Map()
    const emits = { scan: 0, hb: 0 }
    const seq = [
      ['scan', 0], ['hb', 0],
      ['scan', 5000], ['hb', 5000],
      ['scan', 10000], ['hb', 10000],
    ]
    for (const [k, now] of seq) {
      const d = dedupDecision(map.get(k), now)
      map.set(k, d.entry)
      if (d.emit) emits[k]++
    }
    // Each key emits only once (all repeats within the 60s window).
    expect(emits).toEqual({ scan: 1, hb: 1 })
  })
})
