// BLE adapter — wraps @abandonware/noble (real hardware) or a
// synthetic generator (FAKE_BLE=1) behind one event interface.
//
// Both modes emit:
//   bridge.on('strap-seen',   (info))   strap appeared in scan
//   bridge.on('strap-sample', (sample)) BPM notification arrived
//   bridge.on('strap-lost',   (mac))    connection dropped
//
// Sample shape: { mac, recorded_at: ISO string, bpm: number }
// Strap-seen shape: { mac, name?, rssi?, last_bpm? }
//
// Heart Rate Service UUID 0x180D, characteristic 0x2A37 (Heart Rate
// Measurement). Standard for every modern chest strap (Polar, Wahoo,
// Coospo, Garmin HRM-Dual, etc).
//
// Real-mode caveats:
// - noble's "discover" callback can fire for every advertising
//   packet so we de-dup by peripheral.id and only act on first sight.
// - Bluetooth radios cap concurrent connections (typically 7-8 per
//   adapter chip). To go beyond, the operator stacks multiple USB
//   adapters; noble + bluez schedule across them transparently.
// - Connections drop occasionally — we listen for 'disconnect' and
//   re-discover. The strap will re-appear on the next scan tick.

import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { logInfo, logWarn, logDebug } from './log.js'

const HEART_RATE_SERVICE = '180d'
const HEART_RATE_MEASUREMENT_CHAR = '2a37'

class FakeBle extends EventEmitter {
  constructor() {
    super()
    this.straps = [
      { mac: 'AA:BB:CC:DD:EE:01', name: 'Fake Polar H10' },
      { mac: 'AA:BB:CC:DD:EE:02', name: 'Fake Wahoo TICKR' },
      { mac: 'AA:BB:CC:DD:EE:03', name: 'Fake Coospo H6' },
    ]
    this.connected = new Map() // mac → { lastBpm }
  }

  async start() {
    logInfo('ble', 'starting fake BLE generator (FAKE_BLE=1)')
    // Emit initial discovery + start sample emitters.
    setTimeout(() => {
      for (const s of this.straps) {
        const initialBpm = 70 + Math.floor(Math.random() * 20)
        this.connected.set(s.mac, { lastBpm: initialBpm })
        this.emit('strap-seen', { mac: s.mac, name: s.name, rssi: -50, last_bpm: initialBpm })
      }
    }, 250)

    // Each "strap" emits a sample every 1s with a slow random walk.
    this._tick = setInterval(() => {
      for (const [mac, state] of this.connected.entries()) {
        const drift = (Math.random() - 0.5) * 4
        state.lastBpm = Math.max(60, Math.min(180, Math.round(state.lastBpm + drift)))
        this.emit('strap-sample', {
          mac,
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
    return Array.from(this.connected.entries()).map(([mac, s]) => {
      const meta = this.straps.find((x) => x.mac === mac) || {}
      return { mac, name: meta.name, rssi: -50, last_bpm: s.lastBpm }
    })
  }
}

class RealBle extends EventEmitter {
  constructor() {
    super()
    this.connected = new Map() // mac → { peripheral, name, rssi, lastBpm }
  }

  async start() {
    // Lazy import — @abandonware/noble loads native bindings on
    // require, which fails on dev machines without the bluez
    // stack. We only want to require it in real mode.
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
      if (!mac || this.connected.size >= config.maxConnections) return
      if (this.connected.has(mac)) return

      const name = peripheral.advertisement?.localName || null
      const rssi = peripheral.rssi || null
      this.connected.set(mac, { peripheral, name, rssi, lastBpm: null })
      this.emit('strap-seen', { mac, name, rssi })
      logDebug('ble', 'discovered', { mac, name, rssi })

      try {
        await peripheral.connectAsync()
        const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [HEART_RATE_SERVICE],
          [HEART_RATE_MEASUREMENT_CHAR],
        )
        const hrChar = characteristics[0]
        if (!hrChar) {
          logWarn('ble', 'no HR characteristic found', { mac })
          await peripheral.disconnectAsync().catch(() => {})
          this.connected.delete(mac)
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
          const state = this.connected.get(mac)
          if (state) state.lastBpm = bpm
          this.emit('strap-sample', {
            mac,
            recorded_at: new Date().toISOString(),
            bpm,
          })
        })

        await hrChar.subscribeAsync()
        peripheral.once('disconnect', () => {
          this.connected.delete(mac)
          this.emit('strap-lost', mac)
          logInfo('ble', 'disconnect', { mac })
        })
      } catch (e) {
        logWarn('ble', 'connect failed', { err: e, mac })
        this.connected.delete(mac)
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
    return Array.from(this.connected.entries()).map(([mac, s]) => ({
      mac, name: s.name, rssi: s.rssi, last_bpm: s.lastBpm,
    }))
  }
}

export function canonicaliseMac(input) {
  if (typeof input !== 'string') return null
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g).join(':')
}

export function createBleAdapter() {
  return config.fakeBle ? new FakeBle() : new RealBle()
}
