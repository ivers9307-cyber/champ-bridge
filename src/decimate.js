// Pure decimation decision + bpm clamp for the ANT+ adapter.
//
// ANT+ HR straps broadcast at ~4 Hz. The bridge's downstream design
// budget (buffer sizing, /samples cadence, server load) assumes ~1 Hz
// per device — so 4× the intended sample rate flows in unless we thin
// it. We keep the LATEST sample per device per wall-clock second and
// drop the rest. Extracted here so the decision is unit-testable off
// the ant-plus-next event stream.

// Clamp ANT+ bpm to a sane human upper bound. ANT+ ComputedHeartRate
// is a single byte; a decode glitch can surface an implausible value.
export const ANT_MAX_BPM = 240

// One sample per device per this many ms (~1 Hz).
export const DECIMATE_WINDOW_MS = 1000

/**
 * Decide whether this sample should be forwarded, given the last time
 * (ms) we forwarded one for this device. Pure — the caller owns the
 * per-device "last forwarded" state and updates it when this returns
 * true.
 *
 * @param {number} nowMs           current time in ms
 * @param {number|undefined|null} lastForwardedMs  last forward for this device, or null/undefined if never
 * @param {number} [windowMs=DECIMATE_WINDOW_MS]
 * @returns {boolean} true → forward this sample (and update lastForwardedMs to nowMs)
 */
export function shouldForwardSample(nowMs, lastForwardedMs, windowMs = DECIMATE_WINDOW_MS) {
  if (lastForwardedMs == null) return true
  return nowMs - lastForwardedMs >= windowMs
}

/**
 * Clamp a bpm to [1, ANT_MAX_BPM], or return null if it isn't a finite
 * positive number. null means "don't emit".
 * @param {number} bpm
 * @param {number} [maxBpm=ANT_MAX_BPM]
 * @returns {number|null}
 */
export function clampBpm(bpm, maxBpm = ANT_MAX_BPM) {
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  return bpm > maxBpm ? maxBpm : bpm
}
