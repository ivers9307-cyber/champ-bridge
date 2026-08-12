// ANT+ strap adapter — wraps an ANT+ USB stick (real hardware) or a
// synthetic generator (fake mode) behind the same event interface as
// ble.js.
//
// ANT+ is the PRIMARY protocol for the bridge. Unlike BLE it is
// connectionless: one USB stick in scanning mode picks up every HR
// strap broadcasting in the room at once — no 7-connection ceiling,
// which is what makes it the right fit for a full class.
//
// Library: ant-plus-next (lazy-imported, real mode only). It is the
// maintained successor to the classic `ant-plus` package. Talks to the
// stick over libusb — provision `libusb-1.0-0-dev` on the Pi (see README).
//
// NB: ant-plus-next RENAMED the data event from the classic ant-plus
// `hbData` to `heartRateData` (and the field `DeviceID` → `DeviceId`).
// Listening on the old `hbData` name silently never fires — every
// heartbeat page is dropped and no strap is ever seen. This cost us the
// first real-hardware bring-up; do not "fix" it back to hbData.
//
// Every event payload identifies the strap by a `device_key` (see
// device-key.js) — here always `ant:<deviceNumber>`:
//   adapter.on('strap-seen',   ({ device_key, name?, rssi?, last_bpm? }))
//   adapter.on('strap-sample', ({ device_key, recorded_at, bpm }))
//   adapter.on('strap-lost',   (device_key))
//
// ANT+ has no explicit disconnect: a strap that walks out of range
// just stops broadcasting. We sweep for devices we haven't heard
// from in ANT_STALE_MS and emit strap-lost for them.

import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { logInfo, logWarn, logDebug } from './log.js'
import { makeDeviceKey } from './device-key.js'
import { shouldForwardSample, clampBpm } from './decimate.js'
import { settleCallWithin } from './with-timeout.js'
import { installAntLogFilter } from './ant-log-filter.js'

// HR straps broadcast ~4 Hz. If we've heard nothing for this long the
// strap has left the room.
const ANT_STALE_MS = 15_000
const STALE_SWEEP_MS = 5_000

// No stick at boot (USB enumeration race after a power cut) must not
// kill ANT+ for the whole run — retry the open this often until one
// appears. Same backoff used to re-open after a runtime stick error.
const ANT_OPEN_RETRY_MS = 30_000

// Wait this long for a stick's 'startup' event before treating the
// open as failed and trying the next stick class.
const ANT_STARTUP_TIMEOUT_MS = 3_000

// ── Hard bounds on every call into ant-plus-next ─────────────────────────────
// 2026-08-12: the bridge went blind mid-class and then hung in `deactivating`
// on restart until systemd SIGKILLed it. Cause: `ant-plus-next`'s libusb
// `USBDriver.write()` awaits
//
//     new Promise((res, rej) => { this.outEndpoint && this.outEndpoint.transfer(buf, cb) })
//
// which, when `outEndpoint` is falsy (stick torn down or yanked), calls NEITHER
// res nor rej — permanently pending. `BaseSensor.detach()` awaits that write
// (it sends closeChannel), and `USBDriver.close()` awaits `detachAll()` which
// awaits the same detach. So BOTH teardown calls we make can park forever.
//
// Consequence beyond the hung restart: `_teardownAndReopen()` awaited the close
// BEFORE scheduling the reopen, so a parked close meant the reopen was never
// scheduled — the scanner never came back and the process kept heartbeating as
// "healthy". That is exactly what was observed.
//
// Every call into the library is now time-boxed and the recovery path is
// guaranteed to run regardless of the outcome.
const ANT_DETACH_TIMEOUT_MS = 2_000
const ANT_CLOSE_TIMEOUT_MS = 2_000
const ANT_OPEN_TIMEOUT_MS = 5_000

class FakeAnt extends EventEmitter {
  constructor() {
    super()
    // Two synthetic ANT+ straps. Combined with ble.js's fakes the
    // merged source mimics a real mixed-protocol room.
    this.straps = [
      { antId: '10001', name: 'Fake Garmin HRM-Dual (ANT+)' },
      { antId: '10002', name: 'Fake Polar H9 (ANT+)' },
    ]
    this.seen = new Map() // device_key → { lastBpm }
  }

  async start() {
    logInfo('ant', 'starting fake ANT+ generator')
    setTimeout(() => {
      for (const s of this.straps) {
        const key = makeDeviceKey('ant', s.antId)
        const initialBpm = 70 + Math.floor(Math.random() * 20)
        this.seen.set(key, { lastBpm: initialBpm })
        this.emit('strap-seen', { device_key: key, name: s.name, rssi: null, last_bpm: initialBpm })
      }
    }, 250)

    this._tick = setInterval(() => {
      for (const [key, state] of this.seen.entries()) {
        const drift = (Math.random() - 0.5) * 4
        state.lastBpm = Math.max(60, Math.min(180, Math.round(state.lastBpm + drift)))
        this.emit('strap-sample', {
          device_key: key,
          recorded_at: new Date().toISOString(),
          bpm: state.lastBpm,
        })
      }
    }, 1000)
  }

  async stop() {
    if (this._tick) clearInterval(this._tick)
    this.seen.clear()
  }

  getCurrentStraps() {
    return Array.from(this.seen.entries()).map(([key, s]) => {
      const meta = this.straps.find((x) => makeDeviceKey('ant', x.antId) === key) || {}
      return { device_key: key, name: meta.name || null, rssi: null, last_bpm: s.lastBpm }
    })
  }

  // Operational telemetry for the heartbeat. Fake adapter is always "present"
  // once ticking so dev heartbeats look healthy.
  status() {
    return {
      protocol: 'ant', fake: true,
      stick_present: !!this._tick,
      scanning: !!this._tick,
      opening: false, closing: false, reopen_pending: false,
      last_progress_ms: Date.now(),
      seen: this.seen.size,
    }
  }
}

// Exported as a test seam. `start()` lazy-imports the native ant-plus-next
// binding and so is Pi-only, but the teardown/recovery state machine — the
// part that wedged on 2026-08-12 — is testable off-hardware by driving
// `_closeStick` / `_teardownAndReopen` against stub scanner/stick objects.
export class RealAnt extends EventEmitter {
  constructor() {
    super()
    // device_key → { lastBpm, rssi, lastSeenMs, lastForwardedMs }
    this.seen = new Map()
    this._stopped = false
    // ── Supervisor liveness state ──────────────────────────────────────────
    // These four booleans + the timestamp are what the systemd watchdog
    // predicate reads (watchdog.js). They describe whether this adapter's
    // OWN state machine is turning — deliberately NOT whether any strap is
    // present, because only ~20% of classes here have a strap in the room.
    this._scanning = false
    this._opening = false
    this._closing = false
    this._lastProgressMs = Date.now()
  }

  /** Stamp a supervisor state transition. Fuel for the watchdog predicate. */
  _markProgress() {
    this._lastProgressMs = Date.now()
  }

  async start() {
    // Lazy import — ant-plus-next pulls the native `usb` binding on
    // require, which isn't present on dev machines.
    const antPlus = await import('ant-plus-next')
    this._stickClasses = antPlus.default || antPlus
    // ant-plus-next's scanner has a leftover `console.log(this.deviceId)` in
    // its per-page decode path; in scanning mode deviceId is 0, so it prints a
    // bare `0` several times a second and buries the journal. Filter it.
    installAntLogFilter()
    // Kick off the open/scan sequence with a retry loop so a missing
    // stick at boot (USB enumeration race after a power cut) doesn't
    // disable ANT+ for the whole run.
    await this._openAndScan()
  }

  // Try to open a stick + start scanning. If none is present, schedule
  // a retry. Also (re)used to recover after a runtime stick error.
  async _openAndScan() {
    // `_opening` also guards re-entry: a reopen timer firing while a previous
    // open is still probing stick classes would otherwise open two sticks and
    // leak one.
    if (this._stopped || this._opening) return
    this._opening = true
    this._markProgress()
    try {
      await this._openAndScanInner()
    } finally {
      this._opening = false
      this._markProgress()
    }
  }

  async _openAndScanInner() {
    const { GarminStick3, GarminStick2, HeartRateScanner } = this._stickClasses

    // The ANT+ USB-m stick enumerates as a GarminStick3; the older
    // ANTUSB2 as a GarminStick2. Try the modern one first, fall back.
    const stick = await openAnyStick([GarminStick3, GarminStick2])
    if (!stick) {
      logWarn('ant', `no ANT+ USB stick found — retrying in ${ANT_OPEN_RETRY_MS}ms`)
      this._scheduleReopen()
      return
    }
    if (this._stopped) {
      // Raced with stop() — close what we just opened (time-boxed: close()
      // reaches the same never-settling libusb write as every other teardown).
      await settleCallWithin(() => stick.close?.(), ANT_CLOSE_TIMEOUT_MS, 'ant stick.close (stop race)')
      return
    }
    this._stick = stick

    // A runtime 'error' on the stick/scanner is currently unhandled and
    // kills the process. Attach listeners that tear down and re-run the
    // whole open/scan sequence so a USB blip self-heals.
    const onStickError = (err) => {
      logWarn('ant', 'ANT+ stick error — tearing down and reopening', { err })
      this._teardownAndReopen().catch((e) => logWarn('ant', 'teardown threw', { err: e }))
    }
    const onStickShutdown = () => {
      logWarn('ant', 'ANT+ stick shutdown — tearing down and reopening')
      this._teardownAndReopen().catch((e) => logWarn('ant', 'teardown threw', { err: e }))
    }
    this._onStickError = onStickError
    this._onStickShutdown = onStickShutdown
    if (typeof stick.on === 'function') {
      stick.on('error', onStickError)
      stick.on('shutdown', onStickShutdown)
    }

    const scanner = new HeartRateScanner(stick)
    this._scanner = scanner
    if (typeof scanner.on === 'function') {
      scanner.on('error', onStickError)
    }

    // heartRateData fires once per heartbeat page, for EVERY strap in
    // range. (ant-plus-next renamed this from the classic `hbData`.)
    scanner.on('heartRateData', (data) => {
      const antId = data?.DeviceId ?? data?.DeviceID
      const key = makeDeviceKey('ant', antId)
      // Clamp to a sane upper bound (a byte-decode glitch can surface an
      // implausible value); clampBpm returns null for <=0 / non-finite.
      const bpm = clampBpm(Number(data?.ComputedHeartRate))
      if (!key || bpm == null) return

      const now = Date.now()
      const rssi = Number.isFinite(data?.Rssi) ? data.Rssi : null
      const known = this.seen.get(key)
      if (!known) {
        // First sight always forwards (lastForwardedMs = now).
        this.seen.set(key, { lastBpm: bpm, rssi, lastSeenMs: now, lastForwardedMs: now })
        this.emit('strap-seen', { device_key: key, name: null, rssi, last_bpm: bpm })
        this.emit('strap-sample', { device_key: key, recorded_at: new Date().toISOString(), bpm })
        logDebug('ant', 'strap detected', { device_key: key, bpm })
        return
      }

      known.lastBpm = bpm
      known.rssi = rssi
      known.lastSeenMs = now
      // Decimate ANT+'s ~4 Hz down to ~1 Hz per device: keep the latest
      // sample per device per second, drop the rest. (Pure decision in
      // decimate.js.) Still tracks lastBpm/lastSeenMs for scan + stale.
      if (!shouldForwardSample(now, known.lastForwardedMs)) return
      known.lastForwardedMs = now
      this.emit('strap-sample', {
        device_key: key,
        recorded_at: new Date().toISOString(),
        bpm,
      })
    })

    // Scanning mode = connectionless pickup of every nearby strap.
    scanner.scan()
    this._scanning = true
    this._markProgress()
    logInfo('ant', 'ANT+ scanner running')

    // ANT+ has no disconnect event — sweep for silent straps.
    if (!this._sweep) {
      this._sweep = setInterval(() => {
        const cutoff = Date.now() - ANT_STALE_MS
        for (const [key, s] of this.seen.entries()) {
          if (s.lastSeenMs < cutoff) {
            this.seen.delete(key)
            this.emit('strap-lost', key)
            logInfo('ant', 'strap silent — dropped', { device_key: key })
          }
        }
      }, STALE_SWEEP_MS)
    }
  }

  _scheduleReopen() {
    if (this._stopped || this._reopenTimer) return
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = null
      this._markProgress()
      this._openAndScan().catch((err) => logWarn('ant', 'reopen failed', { err }))
    }, ANT_OPEN_RETRY_MS)
    if (typeof this._reopenTimer.unref === 'function') this._reopenTimer.unref()
    this._markProgress()
  }

  // Close the current stick/scanner (best-effort, time-boxed) then schedule a
  // fresh open. Used by the error/shutdown listeners.
  //
  // THE FIX: `_scheduleReopen()` is in a `finally`. Previously it sat after an
  // unbounded `await this._closeStick()`, so the parked libusb write meant the
  // reopen was NEVER scheduled and ANT+ stayed dead for the rest of the
  // process's life while the heartbeat kept reporting healthy. Recovery must
  // not be downstream of a third-party close succeeding.
  async _teardownAndReopen() {
    if (this._tearingDown) return // a stick can emit 'error' AND 'shutdown'
    this._tearingDown = true
    try {
      await this._closeStick()
    } finally {
      this._tearingDown = false
      this._scheduleReopen()
    }
  }

  /**
   * Close the scanner + stick. NEVER hangs, NEVER throws, ALWAYS ends with the
   * references dropped.
   *
   * Order matters: we detach listeners and null out `_scanner`/`_stick` FIRST,
   * before awaiting anything. If a close does park, the adapter's own state is
   * already consistent — `status()` immediately reports `stick_present:false`
   * / `scanning:false` (so heartbeat telemetry stops lying about a dead stick),
   * a concurrent stop() can't double-close the same handle, and the next
   * `_openAndScan()` starts from a clean slate.
   */
  async _closeStick() {
    const scanner = this._scanner
    const stick = this._stick
    this._scanner = null
    this._stick = null
    this._scanning = false
    this._closing = true
    this._markProgress()

    try {
      if (scanner && typeof scanner.removeListener === 'function' && this._onStickError) {
        try { scanner.removeListener('error', this._onStickError) } catch { /* best effort */ }
      }
      if (stick && typeof stick.removeListener === 'function') {
        try {
          if (this._onStickError) stick.removeListener('error', this._onStickError)
          if (this._onStickShutdown) stick.removeListener('shutdown', this._onStickShutdown)
        } catch { /* best effort */ }
      }

      // `detach()` sends closeChannel over the stick → USBDriver.write() →
      // the never-settling promise when the endpoint is gone. Time-boxed.
      if (scanner && typeof scanner.detach === 'function') {
        const r = await settleCallWithin(() => scanner.detach(), ANT_DETACH_TIMEOUT_MS, 'ant scanner.detach')
        if (r.timedOut) logWarn('ant', 'scanner.detach timed out — abandoning it', { ms: ANT_DETACH_TIMEOUT_MS })
        else if (r.err) logWarn('ant', 'scanner.detach failed', { err: r.err })
      }
      // `close()` awaits detachAll() → the same write. Time-boxed too.
      if (stick && typeof stick.close === 'function') {
        const r = await settleCallWithin(() => stick.close(), ANT_CLOSE_TIMEOUT_MS, 'ant stick.close')
        if (r.timedOut) logWarn('ant', 'stick.close timed out — abandoning it', { ms: ANT_CLOSE_TIMEOUT_MS })
        else if (r.err) logWarn('ant', 'stick.close failed', { err: r.err })
      }
    } finally {
      this._closing = false
      this._markProgress()
    }
  }

  async stop() {
    this._stopped = true
    if (this._reopenTimer) { clearTimeout(this._reopenTimer); this._reopenTimer = null }
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null }
    // Bounded by construction (each library call is time-boxed inside), so
    // index.js's shutdown budget is an outer guard, not the only one.
    await this._closeStick()
    this.seen.clear()
  }

  getCurrentStraps() {
    return Array.from(this.seen.entries()).map(([key, s]) => ({
      device_key: key, name: null, rssi: s.rssi ?? null, last_bpm: s.lastBpm,
    }))
  }

  // Operational telemetry for the heartbeat: is the ANT+ stick open + scanning?
  // `stick_present:false` on a live bridge = the room is going unread (stick
  // unplugged / enumeration failed) even though the process is up.
  //
  // The supervisor fields below are also the systemd watchdog's liveness
  // signal (see watchdog.js). `scanning|opening|closing|reopen_pending` all
  // false AND a stale `last_progress_ms` is the 2026-08-12 signature: the
  // adapter fell off a cliff mid-teardown and will never come back.
  status() {
    return {
      protocol: 'ant',
      fake: false,
      stick_present: !!this._stick,
      scanning: !!this._scanning,
      opening: !!this._opening,
      closing: !!this._closing,
      reopen_pending: !!this._reopenTimer,
      last_progress_ms: this._lastProgressMs,
      seen: this.seen.size,
    }
  }
}

/**
 * Try each stick class in turn; return the first that opens AND fires
 * 'startup', or null. `open()` is boolean-returning in ant-plus(-next)
 * and emits 'startup' once the stick is actually ready.
 *
 * A stick that opens but never fires 'startup' is NOT usable — the old
 * code resolved that timeout as success (returning a dead stick) and
 * leaked the setTimeout. Now a timeout is a failure: close the stick,
 * clear the timer, and fall through to the next class.
 *
 * `open()` and `close()` are both time-boxed: `open()` claims the interface
 * and resets the stick over libusb (either can block on a wedged device), and
 * `close()` reaches the same never-settling write as every other teardown. A
 * hang here would strand `_opening=true` forever, which reads as "healthy" to
 * the watchdog while the room goes unread.
 */
async function openAnyStick(stickClasses) {
  for (const StickClass of stickClasses) {
    if (typeof StickClass !== 'function') continue
    let stick
    try {
      stick = new StickClass()
      const openRes = await settleCallWithin(() => stick.open(), ANT_OPEN_TIMEOUT_MS, `${StickClass.name}.open`)
      if (!openRes.ok || !openRes.value) {
        if (openRes.timedOut) logWarn('ant', `${StickClass.name} open timed out — skipping`)
        else if (openRes.err) logWarn('ant', `${StickClass.name} open failed`, { err: openRes.err })
        await settleCallWithin(() => stick.close?.(), ANT_CLOSE_TIMEOUT_MS, `${StickClass.name}.close`)
        continue
      }
      const started = await new Promise((resolve) => {
        let timer
        const finish = (ok) => {
          clearTimeout(timer)
          resolve(ok)
        }
        stick.once('startup', () => finish(true))
        // 'startup' never fired within the budget → treat as failure.
        timer = setTimeout(() => finish(false), ANT_STARTUP_TIMEOUT_MS)
      })
      if (started) return stick
      logWarn('ant', `${StickClass.name} opened but never signalled startup — skipping`)
      await settleCallWithin(() => stick.close?.(), ANT_CLOSE_TIMEOUT_MS, `${StickClass.name}.close`)
    } catch (e) {
      logWarn('ant', `${StickClass.name} open threw`, { err: e })
      if (stick) await settleCallWithin(() => stick.close?.(), ANT_CLOSE_TIMEOUT_MS, `${StickClass.name}.close`)
    }
  }
  return null
}

export function createAntAdapter() {
  return config.fakeStraps ? new FakeAnt() : new RealAnt()
}
