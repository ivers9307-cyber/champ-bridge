// systemd watchdog liveness predicate.
//
// ── Why a plain watchdog would have been a placebo ───────────────────────────
// The 2026-08-12 wedge did NOT stop the event loop. Timers kept firing: scan
// every 5s, heartbeat every 30s, so the CRM saw a perfectly healthy bridge the
// whole time it was reading nothing. A naive `setInterval(() => notifyWatchdog())`
// is a heartbeat OF THE TIMER — it would have pinged happily through the entire
// incident and caught nothing. Arming WatchdogSec with that ping would have
// bought us a comforting config line and zero detection.
//
// So the ping is gated on a REAL liveness signal instead: is the ANT+
// supervisor still making progress?
//
// ── What "progress" means (and what it deliberately does NOT mean) ───────────
// NOT "a strap was seen recently". Measured at this studio, only ~20% of
// classes have any strap in the room at all — a strap-dependent ping would
// withhold every quiet evening and restart-loop the service nightly.
//
// Progress = the ANT+ adapter's own supervision state machine is turning:
//   scanning        the scanner is open and in scan mode      → healthy
//   opening         an open/scan attempt is in flight         → healthy
//   closing         a (now bounded) teardown is in flight     → healthy
//   reopen_pending  a retry timer is armed                    → healthy
// An unplugged stick therefore stays HEALTHY forever: the retry timer keeps
// re-arming every ANT_OPEN_RETRY_MS. That is correct — restarting the service
// does not plug a USB stick back in, and a restart loop would be strictly worse
// than a warning in the journal (the CRM already gets `stick_present:false` in
// heartbeat telemetry, which is the right channel for "come fix the hardware").
//
// The ONLY state that withholds a ping is the incident's exact signature: not
// scanning, not opening, not closing, no retry armed, and no supervisor
// transition for ANT_STALL_MS. That is a supervisor that has fallen off a
// cliff mid-teardown — which is unrecoverable in-process and IS what a restart
// fixes.
//
// ── Failure mode is safe ─────────────────────────────────────────────────────
// If in doubt, PING. Unknown shape, missing adapter, ANT disabled, fake mode,
// unparseable timestamps, still inside the boot grace → ping. Only an
// affirmatively-diagnosed stall withholds.

/** No ANT+ supervisor transition for this long with nothing in flight = stalled. */
export const ANT_STALL_MS = 90_000

/**
 * Never gate the ping during early boot: the first `_openAndScan()` can spend
 * seconds probing stick classes before any state is set, and a Pi that just
 * cold-booted may still be waiting on USB enumeration.
 */
export const BOOT_GRACE_MS = 120_000

/**
 * Should we send WATCHDOG=1 this tick?
 *
 * Pure. `adapters` is exactly `strapSource.getAdapterStatus()` — i.e.
 * `{ ant?: {...}, ble?: {...} }`.
 *
 * NB: BLE is intentionally not consulted. Its known steady-state failure
 * (`noble unauthorized`, missing CAP_NET_RAW) leaves `powered_on:false`
 * indefinitely, and it is the FALLBACK protocol — gating on it would have
 * restart-looped the fleet all through the period BLE was broken.
 *
 * @param {object|null|undefined} adapters  getAdapterStatus() output
 * @param {number} nowMs
 * @param {object} [opts]
 * @param {number} [opts.uptimeMs]  process uptime; inside BOOT_GRACE_MS → always ping
 * @param {number} [opts.stallMs]
 * @param {number} [opts.bootGraceMs]
 * @returns {boolean} true = ping (healthy / unknown), false = withhold (stalled)
 */
export function shouldPingWatchdog(adapters, nowMs, opts = {}) {
  const {
    uptimeMs = Number.POSITIVE_INFINITY,
    stallMs = ANT_STALL_MS,
    bootGraceMs = BOOT_GRACE_MS,
  } = opts

  // Anything we can't read confidently → ping.
  if (!adapters || typeof adapters !== 'object') return true
  if (Number.isFinite(uptimeMs) && uptimeMs < bootGraceMs) return true

  const ant = adapters.ant
  if (!ant || typeof ant !== 'object') return true // ANT disabled by config → nothing to gate on
  if (ant.fake) return true                        // dev / FAKE_STRAPS

  // Any supervisor activity in flight or scheduled = alive.
  if (ant.scanning || ant.opening || ant.closing || ant.reopen_pending) return true

  // Otherwise fall back to "did the supervisor transition recently?".
  const last = ant.last_progress_ms
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return true // unknown → ping
  const since = nowMs - last
  if (since < 0) return true // clock went backwards (Pi has no RTC) → ping
  return since < stallMs
}

/**
 * Human-readable reason for a withheld ping, for the journal line that will be
 * the only breadcrumb before systemd kills us. Pure.
 */
export function stallReason(adapters, nowMs) {
  const ant = adapters?.ant || {}
  const last = Number.isFinite(ant.last_progress_ms) ? nowMs - ant.last_progress_ms : null
  return {
    scanning: !!ant.scanning,
    opening: !!ant.opening,
    closing: !!ant.closing,
    reopen_pending: !!ant.reopen_pending,
    stick_present: !!ant.stick_present,
    ms_since_progress: last,
  }
}
