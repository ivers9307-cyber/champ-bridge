// Tests for the InBody enrichment poller. Pure helpers + runInbodyCycle with
// injected deps (no network). Env is set before importing so config.js (which
// fails fast on missing env at import time) loads cleanly.
import { describe, it, expect, vi } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { withinDailyCap, utcDateKey, runInbodyCycle } = await import('./inbody.js')

const okIngest = vi.fn(async (results) => ({ ok: true, body: { processed: results.length, linked: 0 } }))
const okFetch = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
const pendingOf = (n) => ({
  ok: true,
  body: { pending: Array.from({ length: n }, (_, i) => ({ event_id: `e${i}`, usertoken: `35387${i}`, datetimes: '20240101120000' })) },
})

describe('withinDailyCap', () => {
  it('returns remaining headroom, floored at 0', () => {
    expect(withinDailyCap(0, 450)).toBe(450)
    expect(withinDailyCap(10, 450)).toBe(440)
    expect(withinDailyCap(450, 450)).toBe(0)
    expect(withinDailyCap(460, 450)).toBe(0)
  })
})

describe('utcDateKey', () => {
  it('returns the YYYY-MM-DD UTC date', () => {
    expect(utcDateKey(new Date('2024-03-09T23:30:00Z'))).toBe('2024-03-09')
  })
})

describe('runInbodyCycle', () => {
  const deps = (over) => ({ today: '2024-01-01', getPending: vi.fn(async () => pendingOf(0)), postIngest: okIngest, fetcher: okFetch, apiUrl: 'x', apiKey: 'k', account: 'a', cap: 450, ...over })

  it('fetches each pending scan and relays the batch', async () => {
    const getPending = vi.fn(async () => pendingOf(2))
    const postIngest = vi.fn(async (r) => ({ ok: true, body: { processed: r.length } }))
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const state = { day: null, sent: 0 }
    const out = await runInbodyCycle(state, deps({ getPending, postIngest, fetcher }))
    expect(out).toEqual({ fetched: 2, processed: 2 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(postIngest).toHaveBeenCalledWith([
      { event_id: 'e0', raw: { Weight: 80 } },
      { event_id: 'e1', raw: { Weight: 80 } },
    ])
    expect(state.sent).toBe(2)
  })

  it('does nothing when there is no pending work', async () => {
    const postIngest = vi.fn()
    const out = await runInbodyCycle({ day: '2024-01-01', sent: 0 }, deps({ postIngest }))
    expect(out).toEqual({ fetched: 0, processed: 0 })
    expect(postIngest).not.toHaveBeenCalled()
  })

  it('skips entirely once the daily cap is hit', async () => {
    const fetcher = vi.fn()
    const getPending = vi.fn(async () => pendingOf(3))
    const out = await runInbodyCycle({ day: '2024-01-01', sent: 450 }, deps({ fetcher, getPending }))
    expect(out).toEqual({ fetched: 0, processed: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('only fetches up to the remaining daily headroom', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const getPending = vi.fn(async () => pendingOf(3))
    const state = { day: '2024-01-01', sent: 449 }
    const out = await runInbodyCycle(state, deps({ fetcher, getPending }))
    expect(out.fetched).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(state.sent).toBe(450)
  })

  it('stops the batch on a 401 (IP / cap / subscription) and relays nothing', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, statusCode: 401, body: null }))
    const postIngest = vi.fn()
    const getPending = vi.fn(async () => pendingOf(2))
    const out = await runInbodyCycle({ day: '2024-01-01', sent: 0 }, deps({ fetcher, postIngest, getPending }))
    expect(out).toEqual({ fetched: 2, processed: 0 })
    expect(fetcher).toHaveBeenCalledTimes(1) // broke after the first 401
    expect(postIngest).not.toHaveBeenCalled()
  })

  it('resets the daily counter when the UTC date rolls over', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const getPending = vi.fn(async () => pendingOf(1))
    const state = { day: '2023-12-31', sent: 450 }
    const out = await runInbodyCycle(state, deps({ fetcher, getPending, today: '2024-01-01' }))
    expect(out.fetched).toBe(1)
    expect(state.day).toBe('2024-01-01')
    expect(state.sent).toBe(1)
  })
})
