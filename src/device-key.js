// Protocol-aware strap identifiers.
//
// A strap is identified by a single self-describing `device_key`
// string of the form `<protocol>:<id>`:
//
//   ble:AA:BB:CC:DD:EE:FF   Bluetooth Low Energy — canonical MAC
//   ant:12345               ANT+ — decimal device number (1-65535)
//
// The protocol is encoded *in* the key, so it can never drift from a
// parallel column. BLE and ANT+ ids can't collide (one is colon-hex,
// the other is short decimal), which is also why the dual-protocol
// bridge needs no cross-protocol de-dup — namespacing does it.
//
// This module is duplicated verbatim in un1t-crm and champ-app
// (champ-bridge, un1t-crm and champ-app are separate projects). If it
// drifts, the source of truth is this file.

export const PROTOCOLS = ['ble', 'ant']

/**
 * Normalise a BLE MAC. Accepts upper/lowercase, colon / hyphen /
 * no separator. Returns canonical UPPER colon form AA:BB:CC:DD:EE:FF
 * or null if the input isn't 12 hex chars.
 */
export function canonicaliseMac(input) {
  if (typeof input !== 'string') return null
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g).join(':')
}

/**
 * Normalise an ANT+ device number. ANT+ device numbers are 16-bit:
 * 1-65535. Accepts a number or string, strips leading zeros, returns
 * the decimal string or null.
 */
export function canonicaliseAntId(input) {
  if (input == null) return null
  const s = String(input).trim()
  // Digits only; range — not length — decides validity, so a
  // leading-zero-padded id still canonicalises.
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return String(n)
}

/**
 * Build a device_key from a protocol + raw id. Returns null if the
 * protocol is unknown or the id fails its protocol's canonicaliser.
 */
export function makeDeviceKey(protocol, rawId) {
  if (protocol === 'ble') {
    const mac = canonicaliseMac(rawId)
    return mac ? `ble:${mac}` : null
  }
  if (protocol === 'ant') {
    const id = canonicaliseAntId(rawId)
    return id ? `ant:${id}` : null
  }
  return null
}

/**
 * Parse a device_key into { protocol, deviceId }, re-canonicalising
 * the id. Returns null for anything malformed. Note a BLE key
 * contains its own colons — we split on the FIRST colon only.
 */
export function parseDeviceKey(key) {
  if (typeof key !== 'string') return null
  const idx = key.indexOf(':')
  if (idx < 1) return null
  const protocol = key.slice(0, idx)
  const rest = key.slice(idx + 1)
  if (protocol === 'ble') {
    const mac = canonicaliseMac(rest)
    return mac ? { protocol: 'ble', deviceId: mac } : null
  }
  if (protocol === 'ant') {
    const id = canonicaliseAntId(rest)
    return id ? { protocol: 'ant', deviceId: id } : null
  }
  return null
}

/**
 * Round-trip a device_key through parse + rebuild so callers get a
 * canonical form (or null if it doesn't parse).
 */
export function canonicaliseDeviceKey(key) {
  const parsed = parseDeviceKey(key)
  return parsed ? `${parsed.protocol}:${parsed.deviceId}` : null
}
