// Bounded shutdown — the decision logic, kept pure and injectable so it is
// testable without real timers or a real process.
//
// WHY (2026-08-12): SIGTERM ran an unbounded sequence —
//   await straps.stop()  →  await flushSamples()  →  await postHeartbeat(offline)  →  exit(0)
// The first step parked forever inside the ANT+ teardown (see with-timeout.js
// for the never-settling promise), so `exit(0)` was never reached. systemd sat
// in `deactivating` for its full 90s TimeoutStopSec and then SIGKILLed us:
//
//   champ-bridge.service: Killing process 1218 with signal SIGKILL
//   champ-bridge.service: Failed with result 'timeout'
//
// The contract now: shutdown is a SEQUENCE OF STEPS UNDER A TOTAL BUDGET. Each
// step gets its own slice, a step that hangs is abandoned (not awaited), the
// budget is never exceeded, and the caller exits unconditionally afterwards.
// Best-effort intent is preserved — the final flush and the `offline` heartbeat
// still happen whenever they can — but they can no longer PREVENT the exit.

import { settleCallWithin } from './with-timeout.js'

/** Total wall-clock budget for the whole SIGTERM sequence. */
export const SHUTDOWN_BUDGET_MS = 6000

/**
 * Grace added on top of the budget before the unconditional hard exit fires.
 * Covers the bookkeeping between steps; the hard exit is the last-resort
 * guarantee, not the normal path.
 */
export const HARD_EXIT_GRACE_MS = 1500

/**
 * Don't START a step we can't meaningfully run. A 40ms slice for an HTTPS POST
 * just burns the remainder of the budget on a guaranteed timeout.
 */
export const MIN_STEP_MS = 250

/**
 * Pure: how much of the total budget is left.
 * @param {number} startedAtMs
 * @param {number} nowMs
 * @param {number} [budgetMs]
 * @returns {number} ms remaining, never negative
 */
export function remainingBudget(startedAtMs, nowMs, budgetMs = SHUTDOWN_BUDGET_MS) {
  const elapsed = Math.max(0, nowMs - startedAtMs)
  return Math.max(0, budgetMs - elapsed)
}

/**
 * Pure: the slice to grant the next step, or null to skip it.
 *
 * A step never gets more than it asked for and never more than the budget has
 * left. The MIN_STEP_MS floor applies to what the BUDGET can still offer, not
 * to what a step asks for — a step is free to request a small slice, but once
 * the remainder is too small to be useful for anything we stop starting steps
 * and head for the exit.
 *
 * @param {number} remainingMs
 * @param {number} preferredMs
 * @param {number} [minMs]
 * @returns {number|null} ms to allow, or null = skip
 */
export function nextStepBudget(remainingMs, preferredMs, minMs = MIN_STEP_MS) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null
  if (remainingMs < minMs) return null
  const want = Number.isFinite(preferredMs) && preferredMs > 0 ? preferredMs : minMs
  return Math.min(want, remainingMs)
}

/**
 * Run an ordered list of shutdown steps under a total budget.
 *
 * NEVER throws and ALWAYS returns — that is the whole point. A step that
 * rejects, throws synchronously, or never settles is recorded and stepped over.
 *
 * @param {Array<{name: string, budgetMs: number, run: () => Promise<any>|any}>} steps
 * @param {object} [opts]
 * @param {number} [opts.budgetMs]  total budget (default SHUTDOWN_BUDGET_MS)
 * @param {() => number} [opts.now] clock seam for tests
 * @param {Function} [opts.settle]  settleCallWithin seam for tests
 * @param {(r: {name: string, outcome: string, grantedMs: number|null}) => void} [opts.onStep]
 * @returns {Promise<Array<{name: string, outcome: 'ok'|'timeout'|'error'|'skipped', grantedMs: number|null}>>}
 */
export async function runBoundedShutdown(steps, opts = {}) {
  const {
    budgetMs = SHUTDOWN_BUDGET_MS,
    now = () => Date.now(),
    settle = settleCallWithin,
    onStep = () => {},
  } = opts

  const startedAt = now()
  const results = []

  for (const step of steps || []) {
    const grantedMs = nextStepBudget(remainingBudget(startedAt, now(), budgetMs), step.budgetMs)
    let result
    if (grantedMs == null) {
      result = { name: step.name, outcome: 'skipped', grantedMs: null }
    } else {
      // settleCallWithin never rejects; the extra catch is belt-and-braces so a
      // broken seam in a test (or a future refactor) can't break the guarantee.
      const r = await settle(step.run, grantedMs, step.name).catch((err) => ({ ok: false, err }))
      const outcome = r?.ok ? 'ok' : r?.timedOut ? 'timeout' : 'error'
      result = { name: step.name, outcome, grantedMs, err: r?.err }
    }
    results.push(result)
    try { onStep(result) } catch { /* logging must never break shutdown */ }
  }

  return results
}
