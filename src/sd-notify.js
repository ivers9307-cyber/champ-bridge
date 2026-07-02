// Minimal sd_notify(3) client — no native/npm dependency.
//
// systemd's watchdog (Type=notify + WatchdogSec=) needs the service to:
//   1. send READY=1 once it's up, and
//   2. send WATCHDOG=1 periodically (at least every WatchdogSec/2) to prove the
//      event loop is alive; if the pings stop, systemd kills + restarts us.
//
// The wire protocol is a datagram of `KEY=value` lines to the AF_UNIX SOCK_DGRAM
// socket in $NOTIFY_SOCKET. Node's `dgram` only speaks UDP (no unix_dgram) and
// `net` unix sockets are SOCK_STREAM, so we can't write the datagram natively.
// Rather than add a native dep, we shell out to the `systemd-notify` binary
// that ships with systemd — it exists on every Pi that would run us under
// systemd. (This is why the unit needs `NotifyAccess=all`: the ping arrives
// from a short-lived `systemd-notify` child, not the main PID.)
//
// CRITICAL: every function here is a NO-OP when $NOTIFY_SOCKET is unset — i.e.
// on a dev Mac or any non-systemd launch. A Type=notify unit whose process
// never sends READY=1 gets killed, so this plumbing must be safe to call
// unconditionally and simply do nothing off-systemd. We spawn detached +
// unref'd so a missing/slow binary never blocks or crashes the bridge.

import { spawn } from 'node:child_process'
import { logDebug } from './log.js'

/** True only when running under systemd with notify wired up. */
export function notifyEnabled() {
  return !!process.env.NOTIFY_SOCKET
}

// Fire one `systemd-notify <args>` best-effort. Never throws, never blocks.
function notify(args) {
  if (!process.env.NOTIFY_SOCKET) return false // not under systemd → no-op
  try {
    const child = spawn('systemd-notify', args, { stdio: 'ignore', detached: true })
    child.on('error', (err) => logDebug('sd-notify', 'systemd-notify unavailable', { err }))
    if (typeof child.unref === 'function') child.unref()
    return true
  } catch (err) {
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
