// BLE strap adapter — wraps @abandonware/noble (real hardware) or a
// synthetic generator (fake mode) behind one event interface.
//
// This is the *fallback* protocol. ANT+ (ant.js) is primary because
// it has no concurrent-connection ceiling; BLE picks up the minority
// of straps that only speak Bluetooth. Both adapters are merged by
// strap-source.js.
//
// Every event payload identifies the strap by a protocol-aware
// `device_key` (see device-key.js) — here always `ble:<MAC>`:
//   adapter.on('strap-seen',   ({ device_key, name?, rssi?, last_bpm? }))
//   adapter.on('strap-sample', ({ device_key, recorded_at, bpm }))
//   adapter.on('strap-lost',   (device_key))
//
// Heart Rate Service UUID 0x180D, characteristic 0x2A37 (Heart Rate
// Measurement). Standard for every modern chest strap.
//
// Real-mode caveats:
// - noble's "discover" callback can fire for every advertising
//   packet so we de-dup by peripheral.id and only act on first sight.
// - Bluetooth radios cap concurrent connections (typically 7-8 per
//   adapter chip). This is exactly why ANT+ is the primary path; for
//   BLE-heavy rooms the operator stacks USB adapters and noble +
//   bluez schedule across them transparently.
// - Connections drop occasionally — we listen for 'disconnect' and
//   re-discover. The strap re-appears on the next scan tick.

import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { logInfo, logWarn, logDebug } from './log.js'
import { canonicaliseMac, makeDeviceKey } from './device-key.js'
import { parseHeartRateMeasurement } from './hrm.js'
import { withTimeout, settleCallWithin } from './with-timeout.js'

const HEART_RATE_SERVICE = '180d'
const HEART_RATE_MEASUREMENT_CHAR = '2a37'

// A connectAsync() that never resolves parks a peripheral forever,
// holding a maxConnections slot as a ghost. Cap the attempt.
const CONNECT_TIMEOUT_MS = 15_000

// Teardown bounds. `stopScanningAsync()` on an adapter that came up
// `unauthorized` (the 2026-08-12 Pi state — noble had no CAP_NET_RAW) can sit
// on a bluez call that never answers, and disconnecting up to maxConnections
// peripherals one-at-a-time is unbounded by construction. Both are on the
// SIGTERM path, so both are capped.
const STOP_SCAN_TIMEOUT_MS = 1_500
const DISCONNECT_TIMEOUT_MS = 1_500
const STOP_TOTAL_TIMEOUT_MS = 3_500

class FakeBle extends EventEmitter {
  constructor() {
    super()
    // Two synthetic BLE straps. ant.js contributes its own fakes, so
    // the merged fake source looks like a real mixed-protocol room.
    this.straps = [
      { mac: 'AA:BB:CC:DD:EE:01', name: 'Fake Polar H10 (BLE)' },
      { mac: 'AA:BB:CC:DD:EE:02', name: 'Fake Wahoo TICKR (BLE)' },
    ]
    this.connected = new Map() // device_key → { lastBpm }
  }

  async start() {
    logInfo('ble', 'starting fake BLE generator')
    setTimeout(() => {
      for (const s of this.straps) {
        const key = makeDeviceKey('ble', s.mac)
        const initialBpm = 70 + Math.floor(Math.random() * 20)
        this.connected.set(key, { lastBpm: initialBpm })
        this.emit('strap-seen', { device_key: key, name: s.name, rssi: -50, last_bpm: initialBpm })
      }
    }, 250)

    this._tick = setInterval(() => {
      for (const [key, state] of this.connected.entries()) {
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
    this.connected.clear()
  }

  getCurrentStraps() {
    return Array.from(this.connected.entries()).map(([key, s]) => {
      const meta = this.straps.find((x) => makeDeviceKey('ble', x.mac) === key) || {}
      return { device_key: key, name: meta.name || null, rssi: -50, last_bpm: s.lastBpm }
    })
  }

  status() {
    return { protocol: 'ble', fake: true, powered_on: !!this._tick, connections: this.connected.size }
  }
}

class RealBle extends EventEmitter {
  constructor() {
    super()
    this.connected = new Map() // device_key → { peripheral, name, rssi, lastBpm }
  }

  async start() {
    // Lazy import — @abandonware/noble loads native bindings on
    // require, which fails on dev machines without the bluez stack.
    const noble = (await import('@abandonware/noble')).default

    noble.on('stateChange', async (state) => {
      logInfo('ble', `noble state ${state}`)
      if (state === 'poweredOn') {
        this._poweredOn = true
        await this._startScanning()
      } else {
        this._poweredOn = false
        await noble.stopScanningAsync().catch(() => {})
      }
    })

    noble.on('discover', (peripheral) => this._onDiscover(peripheral))

    this._noble = noble
  }

  // Scan with allowDuplicates=TRUE so a strap that dropped mid-class
  // keeps re-advertising and gets picked up again — with dedup gated on
  // the `connected` map below, not on noble's one-shot discovery. With
  // allowDuplicates=false a disconnected strap would never re-surface
  // and the member's session would end for the rest of class.
  async _startScanning() {
    if (!this._noble || !this._poweredOn) return
    try {
      await this._noble.startScanningAsync([HEART_RATE_SERVICE], true)
      logInfo('ble', 'scanning for heart rate service')
    } catch (e) {
      logWarn('ble', 'startScanning failed', { err: e })
    }
  }

  async _onDiscover(peripheral) {
    const mac = canonicaliseMac(peripheral.address || peripheral.id)
    const key = makeDeviceKey('ble', mac)
    if (!key) return
    // Dedup: already connected/connecting to this strap → ignore the
    // duplicate advertising packet. This is what lets allowDuplicates
    // be true without re-connecting an in-session strap every packet.
    if (this.connected.has(key)) return
    if (this.connected.size >= config.maxConnections) return

    const name = peripheral.advertisement?.localName || null
    const rssi = peripheral.rssi || null
    // Claim the slot up front so concurrent discover packets dedup.
    this.connected.set(key, { peripheral, name, rssi, lastBpm: null })
    this.emit('strap-seen', { device_key: key, name, rssi })
    logDebug('ble', 'discovered', { device_key: key, name, rssi })

    try {
      // connectAsync can hang forever (holding a maxConnections slot as
      // a ghost). Race it against a timeout and treat a timeout as a
      // failed connect → clean up the slot.
      await withTimeout(
        peripheral.connectAsync(),
        CONNECT_TIMEOUT_MS,
        `connect ${key}`,
      )
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [HEART_RATE_SERVICE],
        [HEART_RATE_MEASUREMENT_CHAR],
      )
      const hrChar = characteristics[0]
      if (!hrChar) {
        logWarn('ble', 'no HR characteristic found', { device_key: key })
        await peripheral.disconnectAsync().catch(() => {})
        this.connected.delete(key)
        return
      }

      hrChar.on('data', (data) => {
        // Parse via the pure HRM parser (hrm.js): guards the wide-flag
        // short-packet RangeError that would otherwise be thrown inside
        // noble's synchronous 'data' emit → uncaught → process death.
        // It also drops bpm<=0, off-body, and out-of-range readings.
        const parsed = parseHeartRateMeasurement(data)
        if (!parsed) return
        const state = this.connected.get(key)
        if (state) state.lastBpm = parsed.bpm
        this.emit('strap-sample', {
          device_key: key,
          recorded_at: new Date().toISOString(),
          bpm: parsed.bpm,
        })
      })

      await hrChar.subscribeAsync()
      peripheral.once('disconnect', () => {
        this.connected.delete(key)
        this.emit('strap-lost', key)
        logInfo('ble', 'disconnect', { device_key: key })
        // Force re-discovery so a sweaty-gym mid-class drop doesn't end
        // the session: restart scanning (allowDuplicates flushes noble's
        // seen-cache so the strap re-advertises and we reconnect).
        this._startScanning().catch(() => {})
      })
    } catch (e) {
      logWarn('ble', 'connect failed', { err: e, device_key: key })
      // Ensure we don't leak a half-open GATT connection into a ghost slot.
      await peripheral.disconnectAsync().catch(() => {})
      this.connected.delete(key)
    }
  }

  /**
   * Bounded, non-hanging teardown.
   *
   * Was: `await stopScanningAsync()` then a SEQUENTIAL loop of
   * `await disconnectAsync()` — an unbounded await chain sitting directly on
   * the SIGTERM path. Now: every bluez call is time-boxed, the disconnects run
   * in parallel, and the whole thing is capped again on the outside. Never
   * throws; the connected map is cleared regardless of what bluez does.
   */
  async stop() {
    const noble = this._noble
    const peripherals = Array.from(this.connected.values(), (s) => s.peripheral)
    this.connected.clear()
    this._poweredOn = false

    if (!noble) return
    await settleCallWithin(async () => {
      await settleCallWithin(
        () => noble.stopScanningAsync(),
        STOP_SCAN_TIMEOUT_MS,
        'ble stopScanning',
      )
      await Promise.all(peripherals.map((p) => settleCallWithin(
        () => p?.disconnectAsync(),
        DISCONNECT_TIMEOUT_MS,
        'ble disconnect',
      )))
    }, STOP_TOTAL_TIMEOUT_MS, 'ble stop')
  }

  getCurrentStraps() {
    return Array.from(this.connected.entries()).map(([key, s]) => ({
      device_key: key, name: s.name, rssi: s.rssi, last_bpm: s.lastBpm,
    }))
  }

  // Operational telemetry for the heartbeat: is the noble stack powered on, and
  // how many GATT connections are live? `powered_on:false` = the BLE adapter is
  // down (radio off / bluez not up) even though the process is running.
  status() {
    return { protocol: 'ble', fake: false, powered_on: !!this._poweredOn, connections: this.connected.size }
  }
}

export function createBleAdapter() {
  return config.fakeStraps ? new FakeBle() : new RealBle()
}
