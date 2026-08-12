// Shared promise-timeout helpers.
//
// WHY THIS EXISTS (2026-08-12 incident): the bridge went blind mid-class and
// then HUNG on `systemctl restart` — systemd had to SIGKILL it after the stop
// timeout. Root cause is an await on a promise that can never settle. In
// `ant-plus-next`'s libusb driver:
//
//     write(data) {
//       await new Promise((resolve, reject) => {
//         this.outEndpoint && this.outEndpoint.transfer(buf, err => err ? reject(err) : resolve())
//       })
//     }
//
// If `outEndpoint` is falsy (stick already torn down / yanked) the executor
// runs to completion having called NEITHER resolve nor reject — the promise is
// permanently pending. `BaseSensor.detach()` and `USBDriver.close()` both await
// that write, so every ANT+ teardown path can park forever.
//
// The rule this module encodes: NOTHING on a shutdown or recovery path may
// await a third-party promise unbounded. Race it, then move on.
//
// Two flavours deliberately:
//   withTimeout   — rejects on timeout. For "the caller has a catch that cleans
//                   up" call sites (ble.js's connectAsync).
//   settleWithin  — NEVER rejects; reports the outcome. For shutdown/teardown,
//                   where a failure must not divert control flow.

/** Error thrown by `withTimeout` when the budget elapses. */
export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`timeout: ${label} (${ms}ms)`)
    this.name = 'TimeoutError'
    this.label = label
    this.timeoutMs = ms
  }
}

/**
 * Resolve with `promise`, or reject with a TimeoutError once `ms` elapses.
 * The timer is always cleared (so a won race can't hold the event loop) and is
 * unref'd (so a pending timer alone can never keep the process alive during
 * shutdown).
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} label  human name used in the timeout message
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Bounded, non-throwing settle. Never rejects — the outcome is data.
 *
 * Use on teardown/shutdown paths: a step that hangs, throws, or rejects must
 * not stop the next step (or the exit) from running.
 *
 * @param {Promise<any>|any} promise  may also be a thrown-synchronously thunk's result
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<{ok: true, value: any} | {ok: false, timedOut: true} | {ok: false, err: any}>}
 */
export async function settleWithin(promise, ms, label = 'operation') {
  try {
    const value = await withTimeout(promise, ms, label)
    return { ok: true, value }
  } catch (err) {
    if (err instanceof TimeoutError) return { ok: false, timedOut: true, label, timeoutMs: ms }
    return { ok: false, err }
  }
}

/**
 * `settleWithin` for a thunk, so a function that throws SYNCHRONOUSLY is
 * reported the same way as one that rejects. Teardown code in third-party
 * libraries does both.
 *
 * @param {() => Promise<any>|any} fn
 * @param {number} ms
 * @param {string} label
 */
export async function settleCallWithin(fn, ms, label = 'operation') {
  let p
  try {
    p = fn()
  } catch (err) {
    return { ok: false, err }
  }
  return settleWithin(p, ms, label)
}
