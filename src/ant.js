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
}

class RealAnt extends EventEmitter {
  constructor() {
    super()
    // device_key → { lastBpm, rssi, lastSeenMs, lastForwardedMs }
    this.seen = new Map()
    this._stopped = false
  }

  async start() {
    // Lazy import — ant-plus-next pulls the native `usb` binding on
    // require, which isn't present on dev machines.
    const antPlus = await import('ant-plus-next')
    this._stickClasses = antPlus.default || antPlus
    // Kick off the open/scan sequence with a retry loop so a missing
    // stick at boot (USB enumeration race after a power cut) doesn't
    // disable ANT+ for the whole run.
    await this._openAndScan()
  }

  // Try to open a stick + start scanning. If none is present, schedule
  // a retry. Also (re)used to recover after a runtime stick error.
  async _openAndScan() {
    if (this._stopped) return
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
      // Raced with stop() — close what we just opened.
      if (typeof stick.close === 'function') await Promise.resolve(stick.close()).catch(() => {})
      return
    }
    this._stick = stick

    // A runtime 'error' on the stick/scanner is currently unhandled and
    // kills the process. Attach listeners that tear down and re-run the
    // whole open/scan sequence so a USB blip self-heals.
    const onStickError = (err) => {
      logWarn('ant', 'ANT+ stick error — tearing down and reopening', { err })
      this._teardownAndReopen()
    }
    const onStickShutdown = () => {
      logWarn('ant', 'ANT+ stick shutdown — tearing down and reopening')
      this._teardownAndReopen()
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
      this._openAndScan().catch((err) => logWarn('ant', 'reopen failed', { err }))
    }, ANT_OPEN_RETRY_MS)
    if (typeof this._reopenTimer.unref === 'function') this._reopenTimer.unref()
  }

  // Close the current stick/scanner (best-effort) then schedule a fresh
  // open. Used by the error/shutdown listeners.
  async _teardownAndReopen() {
    await this._closeStick()
    this._scheduleReopen()
  }

  async _closeStick() {
    try {
      if (this._scanner) {
        if (this._onStickError && typeof this._scanner.removeListener === 'function') {
          this._scanner.removeListener('error', this._onStickError)
        }
        if (typeof this._scanner.detach === 'function') await Promise.resolve(this._scanner.detach())
      }
      if (this._stick) {
        if (typeof this._stick.removeListener === 'function') {
          if (this._onStickError) this._stick.removeListener('error', this._onStickError)
          if (this._onStickShutdown) this._stick.removeListener('shutdown', this._onStickShutdown)
        }
        if (typeof this._stick.close === 'function') await Promise.resolve(this._stick.close())
      }
    } catch (e) {
      logWarn('ant', 'error closing ANT+ stick', { err: e })
    }
    this._scanner = null
    this._stick = null
  }

  async stop() {
    this._stopped = true
    if (this._reopenTimer) { clearTimeout(this._reopenTimer); this._reopenTimer = null }
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null }
    await this._closeStick()
    this.seen.clear()
  }

  getCurrentStraps() {
    return Array.from(this.seen.entries()).map(([key, s]) => ({
      device_key: key, name: null, rssi: s.rssi ?? null, last_bpm: s.lastBpm,
    }))
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
 */
async function openAnyStick(stickClasses) {
  for (const StickClass of stickClasses) {
    if (typeof StickClass !== 'function') continue
    let stick
    try {
      stick = new StickClass()
      const opened = await Promise.resolve(stick.open())
      if (!opened) {
        if (typeof stick.close === 'function') await Promise.resolve(stick.close()).catch(() => {})
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
      if (typeof stick.close === 'function') await Promise.resolve(stick.close()).catch(() => {})
    } catch (e) {
      logWarn('ant', `${StickClass.name} open failed`, { err: e })
      if (stick && typeof stick.close === 'function') await Promise.resolve(stick.close()).catch(() => {})
    }
  }
  return null
}

export function createAntAdapter() {
  return config.fakeStraps ? new FakeAnt() : new RealAnt()
}
