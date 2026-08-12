// Tests for the systemd watchdog ping predicate.
//
// Two properties are load-bearing and both are asserted here:
//   1. It WITHHOLDS on the 2026-08-12 signature (ANT+ supervisor dead, event
//      loop fine) — otherwise arming the watchdog is a placebo.
//   2. It PINGS in every ambiguous or merely-degraded state — otherwise arming
//      the watchdog restart-loops the fleet. Notably: no straps in the room
//      (~80% of classes here), an unplugged stick, and BLE down.

import { describe, it, expect } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { shouldPingWatchdog, stallReason, ANT_STALL_MS, BOOT_GRACE_MS } = await import('./watchdog.js')

const NOW = 1_000_000_000
// Past the boot grace, so the predicate actually engages.
const UP = { uptimeMs: BOOT_GRACE_MS * 2 }

const ant = (over = {}) => ({
  ant: {
    protocol: 'ant', fake: false,
    stick_present: true, scanning: true, opening: false, closing: false,
    reopen_pending: false, last_progress_ms: NOW, seen: 0, ...over,
  },
})

describe('shouldPingWatchdog — healthy states ping', () => {
  it('pings while scanning', () => {
    expect(shouldPingWatchdog(ant(), NOW, UP)).toBe(true)
  })

  it('pings with ZERO straps in the room', () => {
    // Only ~20% of classes at this studio have any strap. A strap-dependent
    // ping would restart the service every quiet evening.
    expect(shouldPingWatchdog(ant({ seen: 0 }), NOW, UP)).toBe(true)
  })

  it('pings while an open/scan attempt is in flight', () => {
    expect(shouldPingWatchdog(
      ant({ scanning: false, opening: true, stick_present: false, last_progress_ms: NOW - ANT_STALL_MS * 2 }),
      NOW, UP,
    )).toBe(true)
  })

  it('pings while a (bounded) teardown is in flight', () => {
    expect(shouldPingWatchdog(
      ant({ scanning: false, closing: true, last_progress_ms: NOW - ANT_STALL_MS * 2 }),
      NOW, UP,
    )).toBe(true)
  })

  it('pings FOREVER with the stick unplugged, because the retry timer is armed', () => {
    // Restarting the service does not plug a USB stick back in. `stick_present:
    // false` goes to the CRM via heartbeat telemetry; it must not restart-loop.
    const unplugged = ant({
      scanning: false, stick_present: false, reopen_pending: true,
      last_progress_ms: NOW - ANT_STALL_MS * 100,
    })
    expect(shouldPingWatchdog(unplugged, NOW, UP)).toBe(true)
  })

  it('pings when the last transition is recent but nothing is flagged', () => {
    expect(shouldPingWatchdog(
      ant({ scanning: false, last_progress_ms: NOW - (ANT_STALL_MS - 1) }),
      NOW, UP,
    )).toBe(true)
  })

  it('ignores BLE entirely — a dead BLE radio must not restart the bridge', () => {
    // 2026-08-12: noble came up `unauthorized` on this Pi and BLE never worked.
    // BLE is the fallback protocol; gating on it would have killed the fleet.
    const adapters = { ...ant(), ble: { protocol: 'ble', fake: false, powered_on: false, connections: 0 } }
    expect(shouldPingWatchdog(adapters, NOW, UP)).toBe(true)
  })
})

describe('shouldPingWatchdog — the incident signature withholds', () => {
  const wedged = ant({
    scanning: false, opening: false, closing: false, reopen_pending: false,
    last_progress_ms: NOW - (ANT_STALL_MS + 1),
  })

  it('withholds when the ANT+ supervisor has gone silent with nothing scheduled', () => {
    expect(shouldPingWatchdog(wedged, NOW, UP)).toBe(false)
  })

  it('still withholds even though the event loop is obviously alive', () => {
    // The predicate is called FROM a live timer. That the timer fired is not
    // evidence of anything — which is the entire point of gating it.
    expect(shouldPingWatchdog(wedged, NOW, { uptimeMs: 86_400_000 })).toBe(false)
  })

  it('stallReason describes why, for the last journal line before the kill', () => {
    expect(stallReason(wedged, NOW)).toEqual({
      scanning: false, opening: false, closing: false, reopen_pending: false,
      stick_present: true, ms_since_progress: ANT_STALL_MS + 1,
    })
  })
})

describe('shouldPingWatchdog — fails open on anything ambiguous', () => {
  it('pings on a missing / malformed adapter map', () => {
    expect(shouldPingWatchdog(null, NOW, UP)).toBe(true)
    expect(shouldPingWatchdog(undefined, NOW, UP)).toBe(true)
    expect(shouldPingWatchdog('nope', NOW, UP)).toBe(true)
  })

  it('pings when ANT is disabled by config (ENABLE_ANT=0)', () => {
    expect(shouldPingWatchdog({ ble: { powered_on: true } }, NOW, UP)).toBe(true)
  })

  it('pings in fake-strap mode', () => {
    expect(shouldPingWatchdog(
      { ant: { fake: true, scanning: false, last_progress_ms: 0 } }, NOW, UP,
    )).toBe(true)
  })

  it('pings inside the boot grace, whatever the state', () => {
    const wedged = ant({ scanning: false, last_progress_ms: 0 })
    expect(shouldPingWatchdog(wedged, NOW, { uptimeMs: BOOT_GRACE_MS - 1 })).toBe(true)
  })

  it('pings when last_progress_ms is missing or unparseable', () => {
    expect(shouldPingWatchdog(ant({ scanning: false, last_progress_ms: undefined }), NOW, UP)).toBe(true)
    expect(shouldPingWatchdog(ant({ scanning: false, last_progress_ms: 'soon' }), NOW, UP)).toBe(true)
  })

  it('pings when the clock jumps backwards (Pi has no RTC)', () => {
    expect(shouldPingWatchdog(ant({ scanning: false, last_progress_ms: NOW + 60_000 }), NOW, UP)).toBe(true)
  })
})
