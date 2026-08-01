// src/homey.test.js — pure mappers + actuation factory (no network).
import { describe, it, expect, vi } from 'vitest'

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
      { id: 'homey:abc-1', kind: 'plug', name_hint: 'Front TVs', model: 'homey:app:com.tplink.tapo:plug' },
      { id: 'homey:abc-2', kind: 'switch', name_hint: 'Bathroom light', model: 'homey:app:com.tplink.tapo:switch' },
    ])
  })
  it('tolerates arrays, null, junk entries', () => {
    expect(mapHomeyDevices(Object.values(homeyRaw))).toHaveLength(2)
    expect(mapHomeyDevices(null)).toEqual([])
    expect(mapHomeyDevices({ x: null, y: 42, z: { name: 'no id' } })).toEqual([])
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
})
