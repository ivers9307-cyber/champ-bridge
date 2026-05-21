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
// maintained successor to the classic `ant-plus` package and keeps
// the well-proven HeartRateScanner / hbData API. Talks to the stick
// over libusb — provision `libusb-1.0-0-dev` on the Pi (see README).
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

// HR straps broadcast ~4 Hz. If we've heard nothing for this long the
// strap has left the room.
const ANT_STALE_MS = 15_000
const STALE_SWEEP_MS = 5_000

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
    this.seen = new Map() // device_key → { lastBpm, rssi, lastSeenMs }
  }

  async start() {
    // Lazy import — ant-plus-next pulls the native `usb` binding on
    // require, which isn't present on dev machines.
    const antPlus = await import('ant-plus-next')
    const { GarminStick3, GarminStick2, HeartRateScanner } = antPlus.default || antPlus

    // The ANT+ USB-m stick enumerates as a GarminStick3; the older
    // ANTUSB2 as a GarminStick2. Try the modern one first, fall back.
    const stick = await openAnyStick([GarminStick3, GarminStick2])
    if (!stick) {
      logWarn('ant', 'no ANT+ USB stick found — ANT+ disabled for this run')
      return
    }
    this._stick = stick

    const scanner = new HeartRateScanner(stick)
    this._scanner = scanner

    // hbData fires once per heartbeat page, for EVERY strap in range.
    scanner.on('hbData', (data) => {
      const antId = data?.DeviceId ?? data?.DeviceID
      const bpm = Number(data?.ComputedHeartRate)
      const key = makeDeviceKey('ant', antId)
      if (!key || !Number.isFinite(bpm) || bpm <= 0) return

      const rssi = Number.isFinite(data?.Rssi) ? data.Rssi : null
      const known = this.seen.get(key)
      if (!known) {
        this.seen.set(key, { lastBpm: bpm, rssi, lastSeenMs: Date.now() })
        this.emit('strap-seen', { device_key: key, name: null, rssi, last_bpm: bpm })
        logDebug('ant', 'strap detected', { device_key: key, bpm })
      } else {
        known.lastBpm = bpm
        known.rssi = rssi
        known.lastSeenMs = Date.now()
      }
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

  async stop() {
    if (this._sweep) clearInterval(this._sweep)
    try {
      if (this._scanner && typeof this._scanner.detach === 'function') {
        await Promise.resolve(this._scanner.detach())
      }
      if (this._stick && typeof this._stick.close === 'function') {
        await Promise.resolve(this._stick.close())
      }
    } catch (e) {
      logWarn('ant', 'error closing ANT+ stick', { err: e })
    }
    this.seen.clear()
  }

  getCurrentStraps() {
    return Array.from(this.seen.entries()).map(([key, s]) => ({
      device_key: key, name: null, rssi: s.rssi ?? null, last_bpm: s.lastBpm,
    }))
  }
}

/**
 * Try each stick class in turn; return the first that opens, or null.
 * `open()` is boolean-returning in ant-plus(-next) and emits
 * 'startup' once the stick is ready.
 */
async function openAnyStick(stickClasses) {
  for (const StickClass of stickClasses) {
    if (typeof StickClass !== 'function') continue
    try {
      const stick = new StickClass()
      const opened = await Promise.resolve(stick.open())
      if (opened) {
        await new Promise((resolve) => {
          let done = false
          const finish = () => { if (!done) { done = true; resolve() } }
          stick.once('startup', finish)
          // Don't hang forever if 'startup' never fires.
          setTimeout(finish, 3000)
        })
        return stick
      }
      if (typeof stick.close === 'function') await Promise.resolve(stick.close()).catch(() => {})
    } catch (e) {
      logWarn('ant', `${StickClass.name} open failed`, { err: e })
    }
  }
  return null
}

export function createAntAdapter() {
  return config.fakeStraps ? new FakeAnt() : new RealAnt()
}
