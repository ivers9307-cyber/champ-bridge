// src/homey.test.js — pure mappers + actuation factory (no network).
import { describe, it, expect, vi } from 'vitest'

// homey.js never imports config.js, but keep the house env-before-import pattern in case that changes.
process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { mapHomeyDevices, mapHomeyStates } = await import('./homey.js')

// Realistic slice of Homey's object-map response.
const homeyRaw = {
  'abc-1': {
    id: 'abc-1', name: 'Front TVs', class: 'socket', available: true,
    driverId: 'homey:app:com.tplink.tapo:plug',
    capabilities: ['onoff', 'measure_power'],
    capabilitiesObj: { onoff: { value: true } },
  },
  'abc-2': {
    id: 'abc-2', name: 'Bathroom light', class: 'light', available: false,
    driverId: 'homey:app:com.tplink.tapo:switch',
    capabilities: ['onoff'],
    capabilitiesObj: { onoff: { value: false } },
  },
  'abc-3': { // no onoff — must be invisible to the bridge
    id: 'abc-3', name: 'Motion sensor', class: 'sensor', available: true,
    capabilities: ['alarm_motion'], capabilitiesObj: { alarm_motion: { value: false } },
  },
}

describe('mapHomeyDevices', () => {
  it('filters to onoff devices, prefixes ids, maps socket→plug else switch', () => {
    expect(mapHomeyDevices(homeyRaw)).toEqual([
      { id: 'homey:abc-1', kind: 'plug', name_hint: 'Front TVs' },
      { id: 'homey:abc-2', kind: 'switch', name_hint: 'Bathroom light' },
    ])
  })
  it('tolerates arrays, null, junk entries', () => {
    expect(mapHomeyDevices(Object.values(homeyRaw))).toHaveLength(2)
    expect(mapHomeyDevices(null)).toEqual([])
    expect(mapHomeyDevices({ x: null, y: 42, z: { name: 'no id' } })).toEqual([])
  })
  it('falls back to capabilitiesObj.onoff when capabilities array is absent', () => {
    const raw = { a: { id: 'a', class: 'socket', capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyDevices(raw)).toEqual([{ id: 'homey:a', kind: 'plug' }])
  })
  it('an empty capabilities array excludes the device even if capabilitiesObj.onoff is present', () => {
    const raw = { a: { id: 'a', class: 'socket', capabilities: [], capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyDevices(raw)).toEqual([])
  })
  it('omits name_hint when the device has no name', () => {
    const raw = { a: { id: 'a', class: 'socket', available: true, capabilities: ['onoff'], capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyDevices(raw)).toEqual([{ id: 'homey:a', kind: 'plug' }])
  })
})

describe('mapHomeyStates', () => {
  it('maps onoff value to on/off and available to reachable', () => {
    expect(mapHomeyStates(homeyRaw)).toEqual([
      { id: 'homey:abc-1', state: 'on', reachable: true },
      { id: 'homey:abc-2', state: null, reachable: false }, // unavailable → state unknown
    ])
  })
  it('non-boolean onoff value → state null (never guess)', () => {
    const raw = { a: { id: 'a', class: 'socket', available: true, capabilities: ['onoff'], capabilitiesObj: { onoff: { value: null } } } }
    expect(mapHomeyStates(raw)).toEqual([{ id: 'homey:a', state: null, reachable: true }])
  })
  it('tolerates null and junk entries', () => {
    expect(mapHomeyStates(null)).toEqual([])
    expect(mapHomeyStates({ x: null, y: 42, z: { name: 'no id' } })).toEqual([])
  })
})

const { createHomeyActuation } = await import('./homey.js')

describe('createHomeyActuation', () => {
  const cfg = { address: 'http://192.168.1.50', apiKey: 'key-1' }

  it('shares ONE GET between concurrent device+state reads, refetches next tick', async () => {
    const requestJson = vi.fn(async () => ({ ok: true, statusCode: 200, body: homeyRaw }))
    const a = createHomeyActuation({ ...cfg, requestJson })
    const [dev, st] = await Promise.all([a.getDevices(), a.getState()])
    expect(requestJson).toHaveBeenCalledTimes(1)
    expect(requestJson).toHaveBeenCalledWith('GET', 'http://192.168.1.50/api/manager/devices/device', 'key-1', undefined)
    expect(dev.body.devices).toHaveLength(2)
    expect(st.body.devices[0]).toEqual({ id: 'homey:abc-1', state: 'on', reachable: true })
    await a.getState() // after settle → fresh fetch
    expect(requestJson).toHaveBeenCalledTimes(2)
  })

  it('passes a failed GET through untouched (drives sidecarDown path)', async () => {
    const fail = { ok: false, statusCode: 0, networkError: true }
    const a = createHomeyActuation({ ...cfg, requestJson: vi.fn(async () => fail) })
    expect(await a.getState()).toBe(fail)
  })

  it('setPower strips the homey: prefix and PUTs the onoff capability', async () => {
    const requestJson = vi.fn(async () => ({ ok: true, statusCode: 200, body: {} }))
    const a = createHomeyActuation({ ...cfg, requestJson })
    await a.setPower('homey:abc-1', true)
    expect(requestJson).toHaveBeenCalledWith(
      'PUT', 'http://192.168.1.50/api/manager/devices/device/abc-1/capability/onoff', 'key-1', { value: true },
    )
  })
})
