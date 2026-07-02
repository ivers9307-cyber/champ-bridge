// Tests for the pure 401/403 zombie-detection state machine
// (auth-failure.js), lifted out of api.js so the "dead token → exit"
// counter logic is testable without spinning a real HTTP client or
// killing the process.

import { describe, it, expect } from 'vitest'
import {
  isAuthFailure,
  nextAuthFailureState,
  MAX_CONSECUTIVE_AUTH_FAILURES,
} from './auth-failure.js'

describe('isAuthFailure', () => {
  it('is true for 401 and 403', () => {
    expect(isAuthFailure(401)).toBe(true)
    expect(isAuthFailure(403)).toBe(true)
  })
  it('is false for other statuses', () => {
    expect(isAuthFailure(200)).toBe(false)
    expect(isAuthFailure(404)).toBe(false)
    expect(isAuthFailure(429)).toBe(false)
    expect(isAuthFailure(500)).toBe(false)
    expect(isAuthFailure(null)).toBe(false)
    expect(isAuthFailure(undefined)).toBe(false)
  })
})

describe('nextAuthFailureState', () => {
  it('counts consecutive 401s and exits at the threshold', () => {
    let count = 0
    let exit = false
    for (let i = 0; i < MAX_CONSECUTIVE_AUTH_FAILURES; i++) {
      expect(exit).toBe(false) // not yet
      ;({ count, exit } = nextAuthFailureState(count, { statusCode: 401 }))
    }
    expect(count).toBe(MAX_CONSECUTIVE_AUTH_FAILURES)
    expect(exit).toBe(true)
  })

  it('treats 403 the same as 401', () => {
    let s = nextAuthFailureState(0, { statusCode: 403 })
    s = nextAuthFailureState(s.count, { statusCode: 403 })
    s = nextAuthFailureState(s.count, { statusCode: 403 })
    expect(s.exit).toBe(true)
  })

  it('a success resets the streak (rotation grace)', () => {
    let s = nextAuthFailureState(0, { statusCode: 401 })
    s = nextAuthFailureState(s.count, { statusCode: 401 })
    expect(s.count).toBe(2)
    // Token starts working again (dual-token grace window on the CRM side).
    s = nextAuthFailureState(s.count, { statusCode: 200 })
    expect(s.count).toBe(0)
    expect(s.exit).toBe(false)
    // One more 401 does NOT immediately exit — streak restarted.
    s = nextAuthFailureState(s.count, { statusCode: 401 })
    expect(s.count).toBe(1)
    expect(s.exit).toBe(false)
  })

  it('a network error does NOT count toward the threshold (and does not reset)', () => {
    let s = nextAuthFailureState(0, { statusCode: 401 })
    expect(s.count).toBe(1)
    // Flaky WiFi mid-streak: leave the counter untouched.
    s = nextAuthFailureState(s.count, { networkError: true })
    expect(s.count).toBe(1)
    expect(s.exit).toBe(false)
    // The interrupted 401 streak still reaches the threshold.
    s = nextAuthFailureState(s.count, { statusCode: 401 })
    s = nextAuthFailureState(s.count, { statusCode: 401 })
    expect(s.exit).toBe(true)
  })

  it('a non-auth 4xx/5xx resets the streak (token is being accepted)', () => {
    let s = nextAuthFailureState(0, { statusCode: 401 })
    s = nextAuthFailureState(s.count, { statusCode: 500 })
    expect(s.count).toBe(0)
    s = nextAuthFailureState(s.count, { statusCode: 429 })
    expect(s.count).toBe(0)
  })

  it('honours a custom threshold', () => {
    let s = nextAuthFailureState(0, { statusCode: 401 }, 2)
    expect(s.exit).toBe(false)
    s = nextAuthFailureState(s.count, { statusCode: 401 }, 2)
    expect(s.exit).toBe(true)
  })

  it('exposes a sane default threshold', () => {
    expect(MAX_CONSECUTIVE_AUTH_FAILURES).toBeGreaterThanOrEqual(2)
  })
})
