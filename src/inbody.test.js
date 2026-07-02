// Tests for the InBody enrichment poller. Pure helpers + runInbodyCycle with
// injected deps (no network). Env is set before importing so config.js (which
// fails fast on missing env at import time) loads cleanly.
import { describe, it, expect, vi } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const {
  withinDailyCap, utcDateKey, runInbodyCycle, inbodyDataUrl,
  inbodyDatetimesUrl, extractInbodyDatetimes, runInbodyBackfillCycle,
  inbodyUsertokenCandidates, maskUsertoken, reconcilePersistedState,
  loadInbodyState, saveInbodyState,
} = await import('./inbody.js')

const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')

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

describe('inbodyUsertokenCandidates', () => {
  it('tries the IE local 0-format first for a +353 E.164 number', () => {
    expect(inbodyUsertokenCandidates('+353873147675'))
      .toEqual(['0873147675', '353873147675', '+353873147675', '873147675'])
  })
  it('handles a bare local number and de-dupes', () => {
    expect(inbodyUsertokenCandidates('0873147675'))
      .toEqual(['0873147675', '873147675'])
  })
  it('returns [] for junk', () => {
    expect(inbodyUsertokenCandidates('')).toEqual([])
    expect(inbodyUsertokenCandidates(null)).toEqual([])
  })
})

describe('runInbodyBackfillCycle', () => {
  const base = (over) => ({
    today: '2024-01-01', apiUrl: 'x', apiKey: 'k', account: 'a', cap: 450, save: () => {},
    getBackfillPending: vi.fn(async () => ({ ok: true, body: { pending: [] } })),
    postBackfillIngest: vi.fn(async () => ({ ok: true, body: { ingested: 0 } })),
    datetimesFetcher: vi.fn(async () => ({ ok: true, statusCode: 200, body: ['20240101120000'] })),
    fetcher: vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } })),
    ...over,
  })
  const onePending = (phone) => vi.fn(async () => ({ ok: true, body: { pending: [{ request_id: 'r1', phone }] } }))

  it('matches the local 0-format, pulls each scan with it, relays with the matched usertoken', async () => {
    const getBackfillPending = onePending('+353873147675')
    const datetimesFetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: ['20240101120000', '20240202130000'] }))
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const postBackfillIngest = vi.fn(async () => ({ ok: true, body: { ingested: 2 } }))
    const state = { day: null, sent: 0 }
    const out = await runInbodyBackfillCycle(state, base({ getBackfillPending, datetimesFetcher, fetcher, postBackfillIngest }))
    expect(out).toEqual({ requests: 1, ingested: 2 })
    // first candidate (0+last9) returned data → only one GetDateTimes call
    expect(datetimesFetcher).toHaveBeenCalledTimes(1)
    expect(datetimesFetcher.mock.calls[0][0].usertoken).toBe('0873147675')
    // scans fetched with the matched usertoken
    expect(fetcher.mock.calls[0][0].usertoken).toBe('0873147675')
    expect(postBackfillIngest).toHaveBeenCalledWith({ request_id: 'r1', usertoken: '0873147675', scans: [
      { datetimes: '20240101120000', raw: { Weight: 80 } },
      { datetimes: '20240202130000', raw: { Weight: 80 } },
    ] })
    expect(state.sent).toBe(3) // 1 GetDateTimes + 2 GetFullInBodyData
  })

  it('falls through to the next candidate when the first returns no scans', async () => {
    const getBackfillPending = onePending('+353873147675')
    // empty for 0873147675, data for the next candidate (353873147675)
    const datetimesFetcher = vi.fn(async ({ usertoken }) =>
      usertoken === '353873147675'
        ? ({ ok: true, statusCode: 200, body: ['20240101120000'] })
        : ({ ok: true, statusCode: 200, body: [] }))
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const postBackfillIngest = vi.fn(async () => ({ ok: true, body: { ingested: 1 } }))
    const out = await runInbodyBackfillCycle({ day: null, sent: 0 }, base({ getBackfillPending, datetimesFetcher, fetcher, postBackfillIngest }))
    expect(out).toEqual({ requests: 1, ingested: 1 })
    expect(datetimesFetcher).toHaveBeenCalledTimes(2) // tried 0…, then 353…
    expect(postBackfillIngest.mock.calls[0][0].usertoken).toBe('353873147675')
  })

  it('closes the request done-with-0 when no format returns scans', async () => {
    const getBackfillPending = onePending('+353873147675')
    const datetimesFetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: [] }))
    const fetcher = vi.fn()
    const postBackfillIngest = vi.fn(async () => ({ ok: true, body: { ingested: 0 } }))
    const out = await runInbodyBackfillCycle({ day: null, sent: 0 }, base({ getBackfillPending, datetimesFetcher, fetcher, postBackfillIngest }))
    expect(fetcher).not.toHaveBeenCalled()
    expect(postBackfillIngest).toHaveBeenCalledWith({ request_id: 'r1', usertoken: null, scans: [] })
    expect(out.requests).toBe(1)
  })

  it('reports an error (and never fetches scans) on a GetDateTimes 401', async () => {
    const getBackfillPending = onePending('+353873147675')
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
  const deps = (over) => ({ today: '2024-01-01', getPending: vi.fn(async () => pendingOf(0)), postIngest: okIngest, fetcher: okFetch, apiUrl: 'x', apiKey: 'k', account: 'a', cap: 450, save: () => {}, ...over })

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

  it('persists the counter after each fetch (save dep called)', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, statusCode: 200, body: { Weight: 80 } }))
    const getPending = vi.fn(async () => pendingOf(2))
    const save = vi.fn()
    const state = { day: '2024-01-01', sent: 0 }
    await runInbodyCycle(state, deps({ fetcher, getPending, save }))
    // Two fetches → at least two saves, each seeing an incremented counter.
    expect(save).toHaveBeenCalled()
    expect(save.mock.calls.some(([s]) => s.sent === 2)).toBe(true)
  })
})

describe('maskUsertoken', () => {
  it('shows only the last 4 digits of a phone', () => {
    expect(maskUsertoken('0873147675')).toBe('******7675')
    expect(maskUsertoken('353873147675')).toBe('********7675')
  })
  it('fully masks a very short value', () => {
    expect(maskUsertoken('12')).toBe('**')
    expect(maskUsertoken('1234')).toBe('****')
  })
  it('handles null / undefined / empty', () => {
    expect(maskUsertoken(null)).toBe('')
    expect(maskUsertoken(undefined)).toBe('')
    expect(maskUsertoken('')).toBe('')
  })
})

describe('reconcilePersistedState', () => {
  it('keeps the persisted count when the day matches', () => {
    expect(reconcilePersistedState({ day: '2024-01-01', sent: 42 }, '2024-01-01'))
      .toEqual({ day: '2024-01-01', sent: 42 })
  })
  it('resets to 0 when the persisted day is stale', () => {
    expect(reconcilePersistedState({ day: '2023-12-31', sent: 400 }, '2024-01-01'))
      .toEqual({ day: '2024-01-01', sent: 0 })
  })
  it('resets on missing / malformed state', () => {
    expect(reconcilePersistedState(null, '2024-01-01')).toEqual({ day: '2024-01-01', sent: 0 })
    expect(reconcilePersistedState({ day: '2024-01-01', sent: -1 }, '2024-01-01'))
      .toEqual({ day: '2024-01-01', sent: 0 })
    expect(reconcilePersistedState({ day: '2024-01-01', sent: 'x' }, '2024-01-01'))
      .toEqual({ day: '2024-01-01', sent: 0 })
  })
})

describe('inbody daily-cap persistence round-trip', () => {
  it('save then load returns the same {day,sent} for today', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbody-'))
    const path = join(dir, 'count.json')
    try {
      saveInbodyState({ day: '2024-01-01', sent: 137 }, path)
      expect(existsSync(path)).toBe(true)
      const loaded = loadInbodyState(path, '2024-01-01')
      expect(loaded).toEqual({ day: '2024-01-01', sent: 137 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('load discards a file from a previous UTC day (fresh sent=0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbody-'))
    const path = join(dir, 'count.json')
    try {
      saveInbodyState({ day: '2024-01-01', sent: 400 }, path)
      const loaded = loadInbodyState(path, '2024-01-02') // next day
      expect(loaded).toEqual({ day: '2024-01-02', sent: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('load returns a fresh counter when the file is missing', () => {
    const loaded = loadInbodyState(join(tmpdir(), 'does-not-exist-xyz.json'), '2024-01-01')
    expect(loaded).toEqual({ day: '2024-01-01', sent: 0 })
  })

  it('saveInbodyState never throws on an unwritable path', () => {
    expect(() => saveInbodyState({ day: '2024-01-01', sent: 1 }, '/no/such/dir/x.json')).not.toThrow()
  })
})
