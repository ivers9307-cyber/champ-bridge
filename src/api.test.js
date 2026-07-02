// Tests for api.js's auth-zombie wiring. We mock undici's `request`
// so we can drive status codes, and use the __setAuthZombieHandler
// test seam to observe the "token is dead → exit" decision without
// actually calling process.exit.

import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

// Mock undici.request. Each call returns whatever the queue's next
// entry says.
const responses = []
vi.mock('undici', () => ({
  request: vi.fn(async () => {
    const next = responses.shift() ?? { statusCode: 200 }
    if (next.throw) throw new Error('network down')
    return {
      statusCode: next.statusCode,
      body: { json: async () => next.body ?? { ok: true } },
    }
  }),
}))

const { postHeartbeat, __setAuthZombieHandler, postSamples } = await import('./api.js')
const { MAX_CONSECUTIVE_AUTH_FAILURES } = await import('./auth-failure.js')

let zombieCalls
beforeEach(() => {
  responses.length = 0
  zombieCalls = 0
  // Reset the counter + swap the exit for a spy (avoids process.exit).
  __setAuthZombieHandler(() => { zombieCalls++ })
})

describe('auth-zombie exit path', () => {
  it('fires the zombie handler after N consecutive 401s', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTH_FAILURES; i++) {
      responses.push({ statusCode: 401 })
    }
    for (let i = 0; i < MAX_CONSECUTIVE_AUTH_FAILURES - 1; i++) {
      await postHeartbeat()
      expect(zombieCalls).toBe(0) // not yet
    }
    await postHeartbeat() // Nth failure
    expect(zombieCalls).toBe(1)
  })

  it('does NOT fire on a mix reset by a success', async () => {
    responses.push({ statusCode: 401 })
    responses.push({ statusCode: 401 })
    responses.push({ statusCode: 200 }) // token accepted again
    responses.push({ statusCode: 401 })
    for (let i = 0; i < 4; i++) await postHeartbeat()
    expect(zombieCalls).toBe(0)
  })

  it('a network error does not count toward the threshold', async () => {
    responses.push({ statusCode: 401 })
    responses.push({ throw: true }) // network blip, ignored
    responses.push({ statusCode: 401 })
    await postHeartbeat()
    await postSamples([{ device_key: 'ant:1', recorded_at: 'x', bpm: 100 }])
    await postHeartbeat()
    // Only 2 real auth failures → below threshold (3).
    expect(zombieCalls).toBe(0)
  })
})
