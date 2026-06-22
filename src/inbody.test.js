// Tests for the InBody enrichment poller. Pure helpers + runInbodyCycle with
// injected deps (no network). Env is set before importing so config.js (which
// fails fast on missing env at import time) loads cleanly.
import { describe, it, expect, vi } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const {
  withinDailyCap, utcDateKey, runInbodyCycle, inbodyDataUrl,
  inbodyDatetimesUrl, extractInbodyDatetimes, runInbodyBackfillCycle,
} = await import('./inbody.js')

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

describe('inbodyDataUrl', () => {
  it('puts usertoken + datetimes in the URL path (not the body)', () => {
    expect(inbodyDataUrl('https://apieur.lookinbody.com', '353871234567', '20240101120000'))
      .toBe('https://apieur.lookinbody.com/inbody/GetFullInBodyData/353871234567/20240101120000')
  })
  it('strips a trailing slash on the base and url-encodes the segments', () => {
    expect(inbodyDataUrl('https://apieur.lookinbody.com/', '08 7/1', '2024'))
      .toBe('https://apieur.lookinbody.com/inbody/GetFullInBodyData/08%207%2F1/2024')
  })
})

describe('inbodyDatetimesUrl', () => {
  it('puts the usertoken in the GetDateTimes path', () => {
    expect(inbodyDatetimesUrl('https://apieur.lookinbody.com', '353871234567'))
      .toBe('https://apieur.lookinbody.com/inbody/GetDateTimes/353871234567')
  })
})

describe('extractInbodyDatetimes', () => {
  it('reads a bare array of datetime strings', () => {
    expect(extractInbodyDatetimes(['20240101120000', '20240202130000']))
      .toEqual(['20240101120000', '20240202130000'])
  })
  it('reads an array of objects', () => {
    expect(extractInbodyDatetimes([{ TestDatetimes: '20240101120000' }, { datetimes: '20240202130000' }]))
      .toEqual(['20240101120000', '20240202130000'])
  })
  it('reads an array wrapped under a common key, de-duped', () => {
    expect(extractInbodyDatetimes({ datetimes: ['20240101120000', '20240101120000'] }))
      .toEqual(['20240101120000'])
  })
  it('returns [] for junk / empty', () => {
    expect(extractInbodyDatetimes(null)).toEqual([])
    expect(extractInbodyDatetimes('nope')).toEqual([])
    expect(extractInbodyDatetimes(['not-a-date'])).toEqual([])
  })
})

describe('runInbodyBackfillCycle', () => {
  const base = (over) => ({
    today: '2024-01-01', apiUrl: 'x', apiKey: 'k', account: 'a', cap: 450,
    getBackfillPending: vi.fn(async () => ({ ok: true, body: { pending: [] } })),
    postBackfillIngest: vi.fn(async () => ({ ok: true, body: { ingested: 0 } })),
    datetimesFetcher: vi.fn(async () => ({ ok: true, statusCode: 200, body: ['20240101120000'] })),
    fetcher: vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } })),
    ...over,
  })

  it('GetDateTimes → GetFullInBodyData per scan → relays them', async () => {
    const getBackfillPending = vi.fn(async () => ({ ok: true, body: { pending: [{ request_id: 'r1', phone: '353871' }] } }))
    const datetimesFetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: ['20240101120000', '20240202130000'] }))
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const postBackfillIngest = vi.fn(async () => ({ ok: true, body: { ingested: 2 } }))
    const state = { day: null, sent: 0 }
    const out = await runInbodyBackfillCycle(state, base({ getBackfillPending, datetimesFetcher, fetcher, postBackfillIngest }))
    expect(out).toEqual({ requests: 1, ingested: 2 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(postBackfillIngest).toHaveBeenCalledWith({ request_id: 'r1', scans: [
      { datetimes: '20240101120000', raw: { Weight: 80 } },
      { datetimes: '20240202130000', raw: { Weight: 80 } },
    ] })
    expect(state.sent).toBe(3) // 1 GetDateTimes + 2 GetFullInBodyData
  })

  it('reports an error (and never fetches scans) when GetDateTimes fails', async () => {
    const getBackfillPending = vi.fn(async () => ({ ok: true, body: { pending: [{ request_id: 'r1', phone: 'x' }] } }))
    const datetimesFetcher = vi.fn(async () => ({ ok: false, statusCode: 401, body: 'no' }))
    const fetcher = vi.fn()
    const postBackfillIngest = vi.fn(async () => ({ ok: true, body: {} }))
    const out = await runInbodyBackfillCycle({ day: null, sent: 0 }, base({ getBackfillPending, datetimesFetcher, fetcher, postBackfillIngest }))
    expect(fetcher).not.toHaveBeenCalled()
    expect(postBackfillIngest).toHaveBeenCalledWith({ request_id: 'r1', error: 'GetDateTimes 401' })
    expect(out.requests).toBe(1)
  })

  it('does nothing when there are no pending requests', async () => {
    const datetimesFetcher = vi.fn()
    const out = await runInbodyBackfillCycle({ day: '2024-01-01', sent: 0 }, base({ datetimesFetcher }))
    expect(out).toEqual({ requests: 0, ingested: 0 })
    expect(datetimesFetcher).not.toHaveBeenCalled()
  })

  it('skips entirely once the daily cap is hit', async () => {
    const getBackfillPending = vi.fn()
    const out = await runInbodyBackfillCycle({ day: '2024-01-01', sent: 450 }, base({ getBackfillPending }))
    expect(out).toEqual({ requests: 0, ingested: 0 })
    expect(getBackfillPending).not.toHaveBeenCalled()
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
