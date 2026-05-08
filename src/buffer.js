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
  if (buffer.length === 0) return { sent: 0 }
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
}

export function startFlushLoop() {
  logInfo('buffer', `flush loop ${config.batchIntervalMs}ms`)
  return setInterval(() => {
    flushSamples().catch((err) => logWarn('buffer', 'flush threw', { err }))
  }, config.batchIntervalMs)
}
