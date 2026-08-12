// Minimal sd_notify(3) client — no native/npm dependency.
//
// systemd's watchdog (Type=notify + WatchdogSec=) needs the service to:
//   1. send READY=1 once it's up, and
//   2. send WATCHDOG=1 periodically (at least every WatchdogSec/2) to prove it
//      is still alive; if the pings stop, systemd kills + restarts us.
//
// ── Why we shell out, and why that is (just about) acceptable ────────────────
// The wire protocol is a datagram of `KEY=value` lines to the AF_UNIX
// SOCK_DGRAM socket in $NOTIFY_SOCKET. Node cannot write it natively: `dgram`
// only speaks UDP (there is no `unix_dgram` socket type) and `net`'s unix
// sockets are SOCK_STREAM. There is no pure-JS path — the alternatives are a
// native addon (a compiler on every Pi, for one datagram) or the
// `systemd-notify` binary that ships with systemd itself.
//
// So: one fork+exec per ping. With the recommended WatchdogSec=120 that is a
// ping every 60s — ~1440 execs/day, a few ms each. On a Pi 4 that is noise
// next to the ANT+ decode loop. It is acceptable at THIS cadence and would not
// be at, say, WatchdogSec=10 — do not lower the deadline without revisiting.
//
// The genuine fragilities, and what is done about each:
//   - PATH lookup under a systemd unit. Resolved once against absolute paths
//     (/usr/bin, /bin, /usr/lib/systemd) with a bare-name fallback, cached.
//   - A wedged child accumulating one zombie per ping. Each child gets a
//     SIGKILL timer.
//   - Silent failure looking identical to success. Every call reports a
//     boolean and `notifyStats()` counts outcomes, so a broken transport is
//     visible in the journal and in heartbeat telemetry BEFORE it is trusted to
//     keep the service alive.
//
// CRITICAL: every function here is a NO-OP when $NOTIFY_SOCKET is unset — i.e.
// on a dev Mac or any non-systemd launch. A Type=notify unit whose process
// never sends READY=1 gets killed, so this plumbing must be safe to call
// unconditionally and simply do nothing off-systemd. We spawn detached +
// unref'd so a missing/slow binary never blocks or crashes the bridge.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logDebug, logWarn } from './log.js'

// Where systemd installs the binary across Debian/RPi OS layouts. Resolved
// once — a systemd unit gets a minimal PATH and we do not want to depend on it.
const NOTIFY_BINARY_CANDIDATES = [
  '/usr/bin/systemd-notify',
  '/bin/systemd-notify',
  '/usr/local/bin/systemd-notify',
]

// A `systemd-notify` that hasn't exited by now is wedged; kill it rather than
// let one child per ping pile up.
const CHILD_KILL_MS = 2_000

let resolvedBinary
const stats = { sent: 0, failed: 0, lastError: null }

/** Resolve (and cache) the systemd-notify path. Falls back to a PATH lookup. */
export function notifyBinary() {
  if (resolvedBinary !== undefined) return resolvedBinary
  resolvedBinary = NOTIFY_BINARY_CANDIDATES.find((p) => {
    try { return existsSync(p) } catch { return false }
  }) || 'systemd-notify'
  return resolvedBinary
}

/** Test seam — drop the cached path resolution. */
export function __resetNotifyBinary() {
  resolvedBinary = undefined
}

/**
 * Transport health, for heartbeat telemetry and for the on-Pi verification
 * that must happen BEFORE Type=notify is armed. `failed > 0` under a
 * Type=notify unit means the watchdog will eventually kill a healthy bridge.
 */
export function notifyStats() {
  return { ...stats, armed: !!process.env.NOTIFY_SOCKET }
}

/** True only when running under systemd with notify wired up. */
export function notifyEnabled() {
  return !!process.env.NOTIFY_SOCKET
}

// Fire one `systemd-notify <args>` best-effort. Never throws, never blocks.
function notify(args) {
  if (!process.env.NOTIFY_SOCKET) return false // not under systemd → no-op
  try {
    const child = spawn(notifyBinary(), args, { stdio: 'ignore', detached: true })
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, CHILD_KILL_MS)
    if (typeof killTimer.unref === 'function') killTimer.unref()
    child.on('exit', (code) => {
      clearTimeout(killTimer)
      if (code === 0) { stats.sent += 1; return }
      stats.failed += 1
      stats.lastError = `exit ${code}`
      // log.js dedups warns, so a persistently broken transport is one line a
      // minute-ish plus a suppression summary — loud enough, not a flood.
      logWarn('sd-notify', 'systemd-notify exited non-zero', { code, args })
    })
    child.on('error', (err) => {
      clearTimeout(killTimer)
      stats.failed += 1
      stats.lastError = err?.message || String(err)
      logWarn('sd-notify', 'systemd-notify unavailable', { err, binary: notifyBinary() })
    })
    if (typeof child.unref === 'function') child.unref()
    return true
  } catch (err) {
    stats.failed += 1
    stats.lastError = err?.message || String(err)
    logDebug('sd-notify', 'systemd-notify spawn threw', { err })
    return false
  }
}

/** Tell systemd we've finished startup and are serving. No-op off-systemd. */
export function notifyReady() {
  return notify(['--ready'])
}

/** Watchdog keep-alive ping. No-op off-systemd. */
export function notifyWatchdog() {
  return notify(['WATCHDOG=1'])
}

/** Tell systemd we're shutting down (stops the watchdog clock). No-op off. */
export function notifyStopping() {
  return notify(['STOPPING=1'])
}

// Derive the ping interval from $WATCHDOG_USEC (systemd sets it to WatchdogSec
// in microseconds). Ping at half the deadline so a single slow tick doesn't
// trip the kill. Returns null when the watchdog isn't configured. Pure.
export function watchdogPingMs(usecRaw = process.env.WATCHDOG_USEC) {
  const usec = parseInt(usecRaw, 10)
  if (!Number.isFinite(usec) || usec <= 0) return null
  return Math.max(1000, Math.floor(usec / 1000 / 2))
}
