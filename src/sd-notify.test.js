// Tests for the sd_notify helper. The interesting pure bit is the watchdog
// ping-interval derivation; the notify functions are exercised only for their
// no-op-when-unset safety contract (they must never throw / never spawn off
// systemd). Env is set before import so config.js loads cleanly.
import { describe, it, expect, afterEach } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const {
  watchdogPingMs, notifyEnabled, notifyReady, notifyWatchdog, notifyStopping,
} = await import('./sd-notify.js')

afterEach(() => {
  delete process.env.NOTIFY_SOCKET
  delete process.env.WATCHDOG_USEC
})

describe('watchdogPingMs', () => {
  it('returns null when WATCHDOG_USEC is unset / invalid', () => {
    expect(watchdogPingMs(undefined)).toBeNull()
    expect(watchdogPingMs('')).toBeNull()
    expect(watchdogPingMs('nope')).toBeNull()
    expect(watchdogPingMs('0')).toBeNull()
    expect(watchdogPingMs('-5')).toBeNull()
  })

  it('pings at half the WatchdogSec deadline', () => {
    // WatchdogSec=120 → systemd exports 120_000_000 usec → ping every 60_000ms.
    expect(watchdogPingMs('120000000')).toBe(60_000)
    expect(watchdogPingMs('30000000')).toBe(15_000)
  })

  it('never pings faster than 1s even for a tiny deadline', () => {
    expect(watchdogPingMs('1000000')).toBe(1000) // 1s deadline → half = 500 → floored to 1000
  })
})

describe('notify* off-systemd (NOTIFY_SOCKET unset)', () => {
  it('notifyEnabled is false and calls are safe no-ops', () => {
    expect(notifyEnabled()).toBe(false)
    // Must not throw and must report "did nothing" (false) with no socket.
    expect(notifyReady()).toBe(false)
    expect(notifyWatchdog()).toBe(false)
    expect(notifyStopping()).toBe(false)
  })

  it('notifyEnabled reflects NOTIFY_SOCKET presence', () => {
    process.env.NOTIFY_SOCKET = '/run/systemd/notify'
    expect(notifyEnabled()).toBe(true)
  })
})
