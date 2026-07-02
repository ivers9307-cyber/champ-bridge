// Tests for the pure Heart Rate Measurement parser (hrm.js). This is
// the logic lifted out of ble.js's noble 'data' handler so the
// byte-level decode — including the packet that used to crash the
// process — is testable off-hardware.

import { describe, it, expect } from 'vitest'
import { parseHeartRateMeasurement, HRM_MAX_BPM } from './hrm.js'

// Helper: build a Heart Rate Measurement buffer.
const buf = (...bytes) => Buffer.from(bytes)

describe('parseHeartRateMeasurement — 8-bit format', () => {
  it('reads an 8-bit bpm (flag bit0 = 0)', () => {
    // flags=0x00 → 8-bit; byte1 = 72
    expect(parseHeartRateMeasurement(buf(0x00, 72))).toEqual({
      bpm: 72, contactSupported: false, contactDetected: false,
    })
  })

  it('reads bpm at the top of the 8-bit range', () => {
    expect(parseHeartRateMeasurement(buf(0x00, 199)).bpm).toBe(199)
  })
})

describe('parseHeartRateMeasurement — 16-bit (wide) format', () => {
  it('reads a 16-bit LE bpm (flag bit0 = 1)', () => {
    // flags=0x01 → 16-bit LE; 0x00E6 = 230
    expect(parseHeartRateMeasurement(buf(0x01, 0xe6, 0x00)).bpm).toBe(230)
  })

  it('decodes little-endian byte order correctly', () => {
    // 0x0064 LE = bytes [0x64, 0x00] = 100
    expect(parseHeartRateMeasurement(buf(0x01, 0x64, 0x00)).bpm).toBe(100)
  })
})

describe('parseHeartRateMeasurement — short-packet crash guard', () => {
  it('returns null (does NOT throw) for a 2-byte wide packet', () => {
    // flags=0x01 says 16-bit, but only 2 bytes present. The old code
    // did data.readUInt16LE(1) here → RangeError → process death.
    expect(() => parseHeartRateMeasurement(buf(0x01, 0x50))).not.toThrow()
    expect(parseHeartRateMeasurement(buf(0x01, 0x50))).toBeNull()
  })

  it('returns null for a 1-byte packet (flags only, no bpm)', () => {
    expect(parseHeartRateMeasurement(buf(0x00))).toBeNull()
  })

  it('returns null for an empty / nullish buffer', () => {
    expect(parseHeartRateMeasurement(buf())).toBeNull()
    expect(parseHeartRateMeasurement(null)).toBeNull()
    expect(parseHeartRateMeasurement(undefined)).toBeNull()
  })
})

describe('parseHeartRateMeasurement — bad readings dropped', () => {
  it('returns null for bpm 0 (strap on the shelf)', () => {
    expect(parseHeartRateMeasurement(buf(0x00, 0))).toBeNull()
  })

  it('returns null when contact is supported but not detected', () => {
    // flags: contactSupported (0x04) set, contactDetected (0x02) clear.
    expect(parseHeartRateMeasurement(buf(0x04, 72))).toBeNull()
  })

  it('accepts the reading when contact supported AND detected', () => {
    // flags: 0x04 | 0x02 = 0x06.
    const out = parseHeartRateMeasurement(buf(0x06, 72))
    expect(out).toEqual({ bpm: 72, contactSupported: true, contactDetected: true })
  })

  it('accepts the reading when contact is NOT supported (bit clear)', () => {
    // Many straps leave contactSupported clear; must not be dropped.
    expect(parseHeartRateMeasurement(buf(0x00, 80)).bpm).toBe(80)
  })

  it('returns null for an implausibly high bpm (decode artefact)', () => {
    // 16-bit 0x0BB8 = 3000, way over HRM_MAX_BPM.
    expect(parseHeartRateMeasurement(buf(0x01, 0xb8, 0x0b))).toBeNull()
  })

  it('accepts a bpm exactly at HRM_MAX_BPM', () => {
    expect(parseHeartRateMeasurement(buf(0x00, HRM_MAX_BPM)).bpm).toBe(HRM_MAX_BPM)
  })
})
