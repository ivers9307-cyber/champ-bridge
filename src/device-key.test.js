// Tests for the protocol-aware device-key helpers. Pure module — no
// env stubbing needed (device-key.js imports nothing).

import { describe, it, expect } from 'vitest'
import {
  canonicaliseMac,
  canonicaliseAntId,
  makeDeviceKey,
  parseDeviceKey,
  canonicaliseDeviceKey,
  PROTOCOLS,
} from './device-key.js'

describe('canonicaliseMac', () => {
  it('uppercases + colon-separates every accepted form', () => {
    expect(canonicaliseMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(canonicaliseMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(canonicaliseMac('AA-BB-CC-DD-EE-FF')).toBe('AA:BB:CC:DD:EE:FF')
  })
  it('returns null on bad input', () => {
    expect(canonicaliseMac(null)).toBe(null)
    expect(canonicaliseMac('')).toBe(null)
    expect(canonicaliseMac('not a mac')).toBe(null)
    expect(canonicaliseMac('AA:BB:CC')).toBe(null)
    expect(canonicaliseMac(123)).toBe(null)
  })
})

describe('canonicaliseAntId', () => {
  it('accepts 16-bit device numbers and strips leading zeros', () => {
    expect(canonicaliseAntId('12345')).toBe('12345')
    expect(canonicaliseAntId(12345)).toBe('12345')
    expect(canonicaliseAntId('00042')).toBe('42')
    expect(canonicaliseAntId('1')).toBe('1')
    expect(canonicaliseAntId('65535')).toBe('65535')
  })
  it('rejects out-of-range and non-numeric values', () => {
    expect(canonicaliseAntId('0')).toBe(null)
    expect(canonicaliseAntId('65536')).toBe(null)
    expect(canonicaliseAntId('-5')).toBe(null)
    expect(canonicaliseAntId('12.5')).toBe(null)
    expect(canonicaliseAntId('abc')).toBe(null)
    expect(canonicaliseAntId('')).toBe(null)
    expect(canonicaliseAntId(null)).toBe(null)
  })
})

describe('makeDeviceKey', () => {
  it('builds ble keys from any MAC form', () => {
    expect(makeDeviceKey('ble', 'aabbccddeeff')).toBe('ble:AA:BB:CC:DD:EE:FF')
  })
  it('builds ant keys from a device number', () => {
    expect(makeDeviceKey('ant', 12345)).toBe('ant:12345')
  })
  it('returns null for an unknown protocol or bad id', () => {
    expect(makeDeviceKey('zigbee', '1')).toBe(null)
    expect(makeDeviceKey('ble', 'nope')).toBe(null)
    expect(makeDeviceKey('ant', '99999')).toBe(null)
  })
})

describe('parseDeviceKey', () => {
  it('splits a ble key on the FIRST colon only', () => {
    expect(parseDeviceKey('ble:AA:BB:CC:DD:EE:FF')).toEqual({
      protocol: 'ble', deviceId: 'AA:BB:CC:DD:EE:FF',
    })
  })
  it('parses an ant key', () => {
    expect(parseDeviceKey('ant:12345')).toEqual({ protocol: 'ant', deviceId: '12345' })
  })
  it('re-canonicalises the id while parsing', () => {
    expect(parseDeviceKey('ble:aa-bb-cc-dd-ee-ff')).toEqual({
      protocol: 'ble', deviceId: 'AA:BB:CC:DD:EE:FF',
    })
    expect(parseDeviceKey('ant:00042')).toEqual({ protocol: 'ant', deviceId: '42' })
  })
  it('returns null for malformed keys', () => {
    expect(parseDeviceKey('')).toBe(null)
    expect(parseDeviceKey('nocolon')).toBe(null)
    expect(parseDeviceKey(':missing')).toBe(null)
    expect(parseDeviceKey('ble:bad')).toBe(null)
    expect(parseDeviceKey('ant:0')).toBe(null)
    expect(parseDeviceKey('zigbee:1')).toBe(null)
    expect(parseDeviceKey(null)).toBe(null)
  })
})

describe('canonicaliseDeviceKey', () => {
  it('round-trips a key into canonical form', () => {
    expect(canonicaliseDeviceKey('ble:aabbccddeeff')).toBe('ble:AA:BB:CC:DD:EE:FF')
    expect(canonicaliseDeviceKey('ant:00042')).toBe('ant:42')
  })
  it('returns null for anything that does not parse', () => {
    expect(canonicaliseDeviceKey('garbage')).toBe(null)
    expect(canonicaliseDeviceKey('ant:abc')).toBe(null)
  })
})

describe('PROTOCOLS', () => {
  it('lists the two supported protocols', () => {
    expect(PROTOCOLS).toEqual(['ble', 'ant'])
  })
})
