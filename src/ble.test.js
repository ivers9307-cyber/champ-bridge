// Test the canonicaliseMac helper on its own — same shape as the
// CRM-side helper so a strap MAC the bridge canonicalises will
// match the CRM's contact_devices lookup.

import { describe, it, expect } from 'vitest'

// Stub config so importing ble.js doesn't tip into noble's native
// loader. We only test the pure helper here.
process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { canonicaliseMac } = await import('./ble.js')

describe('canonicaliseMac (champ-bridge)', () => {
  it('uppercases + colon-separates', () => {
    expect(canonicaliseMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(canonicaliseMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(canonicaliseMac('AA-BB-CC-DD-EE-FF')).toBe('AA:BB:CC:DD:EE:FF')
  })
  it('null on bad input', () => {
    expect(canonicaliseMac(null)).toBe(null)
    expect(canonicaliseMac('')).toBe(null)
    expect(canonicaliseMac('not a mac')).toBe(null)
    expect(canonicaliseMac('AA:BB:CC')).toBe(null)
  })
})
