// Minimal structured logger. JSON in prod (so journald can ship to
// any aggregator), prose in dev for grep'ability. Mirrors un1t-crm's
// log.js shape so the format is consistent across both sides of the
// wire.
//
// Rate-limiting / dedup: an API or InBody outage makes the same warn line
// fire on every tick — thousands of near-identical lines an hour. On a Pi
// that's real SD-card write wear AND it evicts the useful context around it
// from a RAM-capped journal. We collapse a repeated identical (level+module+
// msg) line: emit it, then suppress duplicates for a window, and when the
// window closes (or the line changes) emit a one-line summary of how many were
// suppressed. The dedup DECISION is pure (`dedupDecision`) so it's unit-tested
// off the clock.

import { config } from './config.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[config.logLevel] || LEVELS.info
const isProd = process.env.NODE_ENV === 'production'

// Only warn/error get deduped — those are the outage-spam levels. info/debug
// are cadence-bounded already (one per tick by design) and deduping them would
// hide the steady "cycle complete" heartbeat that proves liveness.
const DEDUP_LEVELS = new Set(['warn', 'error'])
export const DEDUP_WINDOW_MS = 60_000

/**
 * Pure dedup decision for ONE line-identity key. `entry` is that key's mutable
 * state ({ firstTs, suppressed }) or undefined the first time the key is seen.
 * Deciding per-key (rather than a single last-line slot) matters here because
 * scan (5s), heartbeat (30s) and flush (3s) warns INTERLEAVE during an outage —
 * a single-slot LRU would flip-flop and collapse nothing.
 *
 * Returns { emit, entry, summary }:
 *   - emit: true if THIS line should be written now.
 *   - entry: the updated per-key state to store back.
 *   - summary: null, or { count, sinceMs } for a just-ended suppressed run to
 *     log alongside this emit.
 *
 * Rules: first sight emits (fresh window). A repeat within the window is
 * suppressed + counted. The first repeat AFTER the window elapses flushes the
 * run's summary and re-emits, opening a fresh window.
 */
export function dedupDecision(entry, now, windowMs = DEDUP_WINDOW_MS) {
  if (!entry) {
    return { emit: true, summary: null, entry: { firstTs: now, suppressed: 0 } }
  }
  if (now - entry.firstTs >= windowMs) {
    const summary = entry.suppressed > 0
      ? { count: entry.suppressed, sinceMs: now - entry.firstTs }
      : null
    return { emit: true, summary, entry: { firstTs: now, suppressed: 0 } }
  }
  // Inside the window — suppress and count.
  return { emit: false, summary: null, entry: { firstTs: entry.firstTs, suppressed: entry.suppressed + 1 } }
}

// Per-key suppression state. Bounded: an outage cycles a handful of distinct
// keys (one per endpoint), so this never grows unbounded, but we cap defensively.
const dedupMap = new Map()
const DEDUP_MAX_KEYS = 256

function write(level, entry) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (isProd) {
    // eslint-disable-next-line no-console
    fn(JSON.stringify(entry))
    return
  }
  // Dev/prose: `[module] msg`, plus the meta object only if there is any (ts +
  // level are structural, not meta).
  const { ts, level: _level, module, msg, ...m } = entry
  void ts; void _level
  const head = `[${module}] ${msg}`
  // eslint-disable-next-line no-console
  if (Object.keys(m).length === 0) fn(head)
  else fn(head, m)
}

function emit(level, module, msg, meta) {
  if (LEVELS[level] < threshold) return
  const m = meta && typeof meta === 'object' ? { ...meta } : {}
  if (m.err instanceof Error) m.err = { name: m.err.name, message: m.err.message, stack: m.err.stack }

  const now = Date.now()
  if (DEDUP_LEVELS.has(level)) {
    // Identity is level+module+msg only — NOT the meta. Two warns with the same
    // text but different `err` still collapse (an outage repeats the same
    // failure with jittering detail); the summary preserves the count.
    const key = `${level}|${module}|${msg}`
    const decision = dedupDecision(dedupMap.get(key), now)
    dedupMap.set(key, decision.entry)
    if (dedupMap.size > DEDUP_MAX_KEYS) dedupMap.delete(dedupMap.keys().next().value)
    if (decision.summary) writeSummary(module, msg, decision.summary, now)
    if (!decision.emit) return
  }

  write(level, { ts: new Date(now).toISOString(), level, module, msg, ...m })
}

// Emit the "N duplicates suppressed" one-liner for a just-ended run of `msg`.
function writeSummary(module, msg, summary, now) {
  write('info', {
    ts: new Date(now).toISOString(),
    level: 'info',
    module: module || 'log',
    msg: 'suppressed duplicate log lines',
    suppressed: summary.count,
    over_ms: summary.sinceMs,
    of: msg,
  })
}

export const logDebug = (module, msg, meta) => emit('debug', module, msg, meta)
export const logInfo  = (module, msg, meta) => emit('info',  module, msg, meta)
export const logWarn  = (module, msg, meta) => emit('warn',  module, msg, meta)
export const logError = (module, msg, meta) => emit('error', module, msg, meta)
