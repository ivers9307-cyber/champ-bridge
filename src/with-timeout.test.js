// Tests for the shared timeout helpers. These are the primitive the whole
// bounded-shutdown fix rests on, so the never-settling case (the exact shape
// of the ant-plus-next libusb write that wedged the bridge) is tested
// explicitly.

import { describe, it, expect } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { withTimeout, settleWithin, settleCallWithin, TimeoutError } = await import('./with-timeout.js')

/** A promise that can NEVER settle — the incident's shape. */
const neverSettles = () => new Promise(() => {})

describe('withTimeout', () => {
  it('resolves with the underlying value when it wins', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 500, 'x')).resolves.toBe('ok')
  })

  it('accepts a non-promise value', async () => {
    await expect(withTimeout(42, 500, 'x')).resolves.toBe(42)
  })

  it('propagates the underlying rejection unchanged', async () => {
    const boom = new Error('boom')
    await expect(withTimeout(Promise.reject(boom), 500, 'x')).rejects.toBe(boom)
  })

  it('rejects with a TimeoutError when the promise never settles', async () => {
    await expect(withTimeout(neverSettles(), 20, 'stuck')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('the TimeoutError names the label and budget', async () => {
    const err = await withTimeout(neverSettles(), 20, 'ant stick.close').catch((e) => e)
    expect(err.label).toBe('ant stick.close')
    expect(err.timeoutMs).toBe(20)
    expect(err.message).toContain('ant stick.close')
  })
})

describe('settleWithin', () => {
  it('never rejects — a never-settling promise reports timedOut', async () => {
    const r = await settleWithin(neverSettles(), 20, 'stuck')
    expect(r).toMatchObject({ ok: false, timedOut: true, label: 'stuck' })
  })

  it('never rejects — a rejecting promise reports the error', async () => {
    const r = await settleWithin(Promise.reject(new Error('nope')), 500, 'x')
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBeUndefined()
    expect(r.err.message).toBe('nope')
  })

  it('reports success with the value', async () => {
    expect(await settleWithin(Promise.resolve(7), 500, 'x')).toEqual({ ok: true, value: 7 })
  })
})

describe('settleCallWithin', () => {
  it('catches a SYNCHRONOUS throw from the thunk', async () => {
    const r = await settleCallWithin(() => { throw new Error('sync boom') }, 500, 'x')
    expect(r.ok).toBe(false)
    expect(r.err.message).toBe('sync boom')
  })

  it('bounds a thunk returning a never-settling promise', async () => {
    const r = await settleCallWithin(neverSettles, 20, 'stuck')
    expect(r).toMatchObject({ ok: false, timedOut: true })
  })

  it('tolerates an optional-call thunk on a missing method', async () => {
    const obj = {}
    const r = await settleCallWithin(() => obj.close?.(), 100, 'x')
    expect(r).toEqual({ ok: true, value: undefined })
  })
})
