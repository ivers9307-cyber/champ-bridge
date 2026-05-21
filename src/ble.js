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

const HEART_RATE_SERVICE = '180d'
const HEART_RATE_MEASUREMENT_CHAR = '2a37'

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
        try {
          await noble.startScanningAsync([HEART_RATE_SERVICE], false)
          logInfo('ble', 'scanning for heart rate service')
        } catch (e) {
          logWarn('ble', 'startScanning failed', { err: e })
        }
      } else {
        await noble.stopScanningAsync().catch(() => {})
      }
    })

    noble.on('discover', async (peripheral) => {
      const mac = canonicaliseMac(peripheral.address || peripheral.id)
      const key = makeDeviceKey('ble', mac)
      if (!key || this.connected.size >= config.maxConnections) return
      if (this.connected.has(key)) return

      const name = peripheral.advertisement?.localName || null
      const rssi = peripheral.rssi || null
      this.connected.set(key, { peripheral, name, rssi, lastBpm: null })
      this.emit('strap-seen', { device_key: key, name, rssi })
      logDebug('ble', 'discovered', { device_key: key, name, rssi })

      try {
        await peripheral.connectAsync()
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
          // Heart Rate Measurement format (BLE GATT spec):
          //   byte 0: flags. bit 0 = 0 → bpm in byte 1 (8-bit);
          //                  bit 0 = 1 → bpm in bytes 1-2 (16-bit LE).
          if (!data || data.length < 2) return
          const flags = data[0]
          const wide = (flags & 0x01) === 1
          const bpm = wide ? data.readUInt16LE(1) : data[1]
          const state = this.connected.get(key)
          if (state) state.lastBpm = bpm
          this.emit('strap-sample', {
            device_key: key,
            recorded_at: new Date().toISOString(),
            bpm,
          })
        })

        await hrChar.subscribeAsync()
        peripheral.once('disconnect', () => {
          this.connected.delete(key)
          this.emit('strap-lost', key)
          logInfo('ble', 'disconnect', { device_key: key })
        })
      } catch (e) {
        logWarn('ble', 'connect failed', { err: e, device_key: key })
        this.connected.delete(key)
      }
    })

    this._noble = noble
  }

  async stop() {
    if (this._noble) {
      await this._noble.stopScanningAsync().catch(() => {})
      for (const { peripheral } of this.connected.values()) {
        await peripheral.disconnectAsync().catch(() => {})
      }
    }
    this.connected.clear()
  }

  getCurrentStraps() {
    return Array.from(this.connected.entries()).map(([key, s]) => ({
      device_key: key, name: s.name, rssi: s.rssi, last_bpm: s.lastBpm,
    }))
  }
}

export function createBleAdapter() {
  return config.fakeStraps ? new FakeBle() : new RealBle()
}
