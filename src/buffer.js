// Sample buffer — collects BPM samples between API flushes.
//
// Bounded: if we accumulate > MAX_BUFFER samples without managing
// to flush (network down, server down), we drop the oldest. The
// alternative — unbounded growth — would OOM the Pi during a long
// outage, and the live TV display has no use for "what happened
// 20min ago" samples once we recover. The session row's max BPM
// already lives server-side from before the outage.

import { config } from './config.js'
import { postSamples } from './api.js'
import { logDebug, logInfo, logWarn } from './log.js'

const MAX_BUFFER = 5000  // ~3min of 30 straps × 1Hz before we drop
const SERVER_BATCH_CAP = 1000  // matches /api/bridge/samples cap

let buffer = []
// In-flight guard: the flush loop is a setInterval, so a slow API call
// (one flush still awaiting the network) must not let the next tick
// start a second, concurrent flush — that would double-send the same
// snapshot and race the re-prepend-on-failure logic. While a flush is
// running, later ticks no-op.
let flushing = false
// The in-flight flush itself, so a caller that must NOT no-op (the final
// drain on the SIGTERM path) can await it instead of skipping. The interval
// loop still skips — see flushSamples. Always cleared in the same finally
// that clears `flushing`, so a thrown flush can never leave a stale promise
// that a later drain would await forever.
let inFlight = null

export function pushSample(s) {
  buffer.push(s)
  if (buffer.length > MAX_BUFFER) {
    const dropped = buffer.length - MAX_BUFFER
    buffer = buffer.slice(-MAX_BUFFER)
    logWarn('buffer', `buffer overflow — dropped ${dropped} oldest samples`)
  }
}

export function pendingCount() {
  return buffer.length
}

/**
 * Flush the buffer in chunks of SERVER_BATCH_CAP. On any chunk
 * failure, prepend the un-sent remainder back onto the buffer so
 * the next tick retries.
 */
export async function flushSamples() {
  // Guard against a slow API letting the interval stack a second flush
  // on top of an in-flight one. A concurrent flush would snapshot +
  // clear the same buffer twice and double-send / race the retry.
  if (flushing) {
    logDebug('buffer', 'flush already in flight — skipping this tick')
    return { sent: 0, skipped: true }
  }
  if (buffer.length === 0) return { sent: 0 }
  flushing = true
  const done = _runFlush()
  inFlight = done
  return done
}

/**
 * The final drain, for the SIGTERM path ONLY.
 *
 * flushSamples() deliberately no-ops while a flush is in flight — correct for
 * the 3s interval, fatal at shutdown: if the periodic flush happened to be
 * mid-HTTPS-request when SIGTERM arrived, the shutdown step returned
 * `{sent: 0, skipped: true}` INSTANTLY and reported `outcome: 'ok'`, so every
 * sample buffered since the last successful flush was lost on that restart —
 * silently, because nothing in the journal said otherwise.
 *
 * So: await the in-flight flush (it owns a snapshot we cannot see and may
 * re-prepend it on failure), THEN flush whatever remains — the samples that
 * arrived during that request, plus anything it handed back. Does NOT weaken
 * the concurrency guard: this never runs a second flush in parallel, it waits
 * for the first to finish and then takes its turn.
 *
 * Bounded by the caller (the shutdown step grants 2500ms via shutdown.js) —
 * the await below is bounded only by that, which is why the caller must keep
 * capping it. A rejected in-flight flush is swallowed: its own catch/finally
 * has already re-prepended, so the remainder is still ours to send.
 *
 * @returns {Promise<{sent: number, waited?: boolean, failed?: boolean, lost?: number}>}
 *   `lost` is set when samples remain buffered after the drain — that is data
 *   this restart will drop, and it is reported so the journal shows it.
 */
export async function drainSamples() {
  let waited = false
  if (inFlight) {
    waited = true
    logDebug('buffer', 'final drain — waiting for in-flight flush')
    await inFlight.catch(() => {})
  }
  const out = await flushSamples()
  const remaining = buffer.length
  const result = { ...out, waited }
  if (remaining > 0) {
    result.lost = remaining
    logWarn('buffer', 'final drain left samples unsent — they are lost on this restart', {
      lost: remaining, sent: out.sent ?? 0,
    })
  }
  return result
}

async function _runFlush() {
  try {
    // Snapshot + clear; we'll re-prepend on partial failure.
    const snapshot = buffer
    buffer = []

    let sent = 0
    for (let i = 0; i < snapshot.length; i += SERVER_BATCH_CAP) {
      const chunk = snapshot.slice(i, i + SERVER_BATCH_CAP)
      const out = await postSamples(chunk)
      if (!out.ok) {
        // Re-prepend the rest (this chunk + everything after) for retry.
        const remaining = snapshot.slice(i)
        buffer = [...remaining, ...buffer]
        if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER)
        logWarn('buffer', 'flush partial failure — will retry', {
          chunk_size: chunk.length, remaining: remaining.length,
        })
        return { sent, failed: true }
      }
      sent += chunk.length
    }
    if (sent > 0) logDebug('buffer', `flushed ${sent} samples`)
    return { sent }
  } finally {
    flushing = false
    inFlight = null
  }
}

export function startFlushLoop() {
  logInfo('buffer', `flush loop ${config.batchIntervalMs}ms`)
  return setInterval(() => {
    flushSamples().catch((err) => logWarn('buffer', 'flush threw', { err }))
  }, config.batchIntervalMs)
}
