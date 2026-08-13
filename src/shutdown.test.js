// Tests for the bounded-shutdown decision logic.
//
// The property that matters: runBoundedShutdown ALWAYS returns, within the
// budget, no matter how badly a step behaves. Every step type the real
// shutdown path can produce is covered — resolves, rejects, throws
// synchronously, and (the incident's case) never settles at all.

import { describe, it, expect } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const {
  remainingBudget, nextStepBudget, runBoundedShutdown,
  SHUTDOWN_BUDGET_MS, MIN_STEP_MS,
} = await import('./shutdown.js')

const neverSettles = () => new Promise(() => {})

describe('remainingBudget', () => {
  it('is the full budget at t=0', () => {
    expect(remainingBudget(1000, 1000, 6000)).toBe(6000)
  })

  it('shrinks as time passes', () => {
    expect(remainingBudget(1000, 3500, 6000)).toBe(3500)
  })

  it('clamps to zero once the budget is spent — never negative', () => {
    expect(remainingBudget(1000, 9000, 6000)).toBe(0)
    expect(remainingBudget(1000, 1_000_000, 6000)).toBe(0)
  })

  it('treats a backwards clock as no elapsed time (the Pi has no RTC)', () => {
    expect(remainingBudget(5000, 1000, 6000)).toBe(6000)
  })

  it('defaults to SHUTDOWN_BUDGET_MS', () => {
    expect(remainingBudget(0, 0)).toBe(SHUTDOWN_BUDGET_MS)
  })
})

describe('nextStepBudget', () => {
  it('grants what the step asked for when there is room', () => {
    expect(nextStepBudget(6000, 2000)).toBe(2000)
  })

  it('never grants more than the budget has left', () => {
    expect(nextStepBudget(900, 2500)).toBe(900)
  })

  it('skips the step when nothing is left', () => {
    expect(nextStepBudget(0, 2000)).toBeNull()
    expect(nextStepBudget(-50, 2000)).toBeNull()
  })

  it('skips rather than granting a uselessly small slice', () => {
    // 100ms is not enough to attempt an HTTPS POST — burning it guarantees a
    // timeout and delays the exit for nothing.
    expect(nextStepBudget(100, 2000)).toBeNull()
    expect(nextStepBudget(MIN_STEP_MS, 2000)).toBe(MIN_STEP_MS)
  })

  it('is defensive about non-finite inputs', () => {
    expect(nextStepBudget(NaN, 2000)).toBeNull()
    expect(nextStepBudget(1000, NaN)).toBe(MIN_STEP_MS)
    expect(nextStepBudget(1000, 0)).toBe(MIN_STEP_MS)
  })
})

describe('runBoundedShutdown', () => {
  it('runs every step in order and reports ok', async () => {
    const order = []
    const results = await runBoundedShutdown([
      { name: 'a', budgetMs: 100, run: async () => { order.push('a') } },
      { name: 'b', budgetMs: 100, run: async () => { order.push('b') } },
    ])
    expect(order).toEqual(['a', 'b'])
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok'])
  })

  it('RETURNS when a step never settles — the whole point', async () => {
    const results = await runBoundedShutdown(
      [{ name: 'straps.stop', budgetMs: 30, run: neverSettles }],
      { budgetMs: 400 },
    )
    expect(results[0]).toMatchObject({ name: 'straps.stop', outcome: 'timeout' })
  })

  it('a hung step does NOT prevent the later steps from running', async () => {
    // The incident exactly: straps.stop() parked, so the final flush and the
    // offline heartbeat never happened and exit(0) was never reached.
    const ran = []
    const results = await runBoundedShutdown([
      { name: 'straps.stop', budgetMs: 30, run: neverSettles },
      { name: 'final-flush', budgetMs: 30, run: async () => { ran.push('flush') } },
      { name: 'offline-heartbeat', budgetMs: 30, run: async () => { ran.push('heartbeat') } },
    ], { budgetMs: 500 })
    expect(ran).toEqual(['flush', 'heartbeat'])
    expect(results.map((r) => r.outcome)).toEqual(['timeout', 'ok', 'ok'])
  })

  it('records a rejecting step as error and carries on', async () => {
    const results = await runBoundedShutdown([
      { name: 'a', budgetMs: 50, run: async () => { throw new Error('nope') } },
      { name: 'b', budgetMs: 50, run: async () => 'fine' },
    ])
    expect(results[0].outcome).toBe('error')
    expect(results[0].err.message).toBe('nope')
    expect(results[1].outcome).toBe('ok')
  })

  it('records a SYNCHRONOUSLY throwing step as error and carries on', async () => {
    const results = await runBoundedShutdown([
      { name: 'a', budgetMs: 50, run: () => { throw new Error('sync') } },
      { name: 'b', budgetMs: 50, run: async () => 'fine' },
    ])
    expect(results[0].outcome).toBe('error')
    expect(results[1].outcome).toBe('ok')
  })

  it('skips later steps once the total budget is exhausted', async () => {
    // Injected clock: step 'a' consumes the entire budget.
    let t = 0
    const now = () => t
    const settle = async (run, ms) => { t += ms; await run(); return { ok: false, timedOut: true } }
    const results = await runBoundedShutdown([
      { name: 'a', budgetMs: 6000, run: async () => {} },
      { name: 'b', budgetMs: 2000, run: async () => {} },
      { name: 'c', budgetMs: 2000, run: async () => {} },
    ], { budgetMs: 6000, now, settle })
    expect(results.map((r) => r.outcome)).toEqual(['timeout', 'skipped', 'skipped'])
    expect(results[1].grantedMs).toBeNull()
  })

  it('caps a late step to whatever budget is actually left', async () => {
    let t = 0
    const granted = []
    const now = () => t
    const settle = async (run, ms) => { granted.push(ms); t += ms; return { ok: true } }
    await runBoundedShutdown([
      { name: 'a', budgetMs: 5000, run: async () => {} },
      { name: 'b', budgetMs: 2500, run: async () => {} },
    ], { budgetMs: 6000, now, settle })
    expect(granted).toEqual([5000, 1000]) // second step trimmed to the remainder
  })

  it('never throws on an empty / missing step list', async () => {
    await expect(runBoundedShutdown([])).resolves.toEqual([])
    await expect(runBoundedShutdown(undefined)).resolves.toEqual([])
  })

  it('a throwing onStep logger cannot break shutdown', async () => {
    const results = await runBoundedShutdown(
      [{ name: 'a', budgetMs: 50, run: async () => {} }],
      { onStep: () => { throw new Error('logger exploded') } },
    )
    expect(results[0].outcome).toBe('ok')
  })

  it('completes inside its own budget in real time', async () => {
    const started = Date.now()
    await runBoundedShutdown([
      { name: 'a', budgetMs: 1000, run: neverSettles },
      { name: 'b', budgetMs: 1000, run: neverSettles },
    ], { budgetMs: 300 })
    // Total budget 300ms: 'a' gets 300, then nothing is left for 'b'.
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('step return values', () => {
  it("carries a step's return value through as `value`", async () => {
    // drainSamples() reports { lost } when the final drain could not send
    // everything. runBoundedShutdown used to drop the return value, so a
    // lossy final flush was indistinguishable from a clean one — the caller
    // saw outcome 'ok' and nothing else. index.js now reads r.value.lost.
    const results = await runBoundedShutdown(
      [{ name: 'final-flush', budgetMs: 100, run: async () => ({ sent: 4, lost: 11 }) }],
      { budgetMs: 500 },
    )
    expect(results[0].outcome).toBe('ok')
    expect(results[0].value).toEqual({ sent: 4, lost: 11 })
  })
})
