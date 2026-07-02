// Pure parser for the BLE Heart Rate Measurement characteristic
// (GATT 0x2A37). Extracted from ble.js so the byte-level logic can be
// unit-tested off-hardware — the noble event wiring around it can't.
//
// Wire format (Bluetooth SIG Heart Rate Measurement):
//   byte 0: flags
//     bit 0 (0x01)  Heart Rate Value Format:
//                     0 → BPM is uint8  in byte 1
//                     1 → BPM is uint16 (LE) in bytes 1-2
//     bit 1 (0x02)  Sensor Contact Status
//     bit 2 (0x04)  Sensor Contact Supported
//   byte 1..: BPM (width per bit 0)
//
// A real crash was possible here: a 2-byte packet with the wide flag
// set makes the naive reader index byte 2 (readUInt16LE(1)) past the
// end of the buffer → RangeError, thrown inside noble's synchronous
// 'data' emit → uncaught → process death. This parser guards that and
// returns null instead of throwing.

// Upper sanity bound. Real human HR maxes ~220; anything above this is
// a decode artefact, not a heartbeat. Keeps a garbage packet from
// streaming a nonsense spike into a member's session.
export const HRM_MAX_BPM = 240

/**
 * Parse one Heart Rate Measurement packet.
 *
 * @param {Buffer|Uint8Array} data raw characteristic value
 * @returns {{ bpm: number, contactSupported: boolean, contactDetected: boolean } | null}
 *   null when the packet is too short / malformed to trust.
 *   NB: a valid-but-unusable reading (bpm<=0, sensor-off-body, or a
 *   bpm above HRM_MAX_BPM) also returns null — callers should simply
 *   skip a null and NOT emit a sample.
 */
export function parseHeartRateMeasurement(data) {
  // Need at least the flags byte + one BPM byte.
  if (!data || data.length < 2) return null

  const flags = data[0]
  const wide = (flags & 0x01) === 1
  const contactSupported = (flags & 0x04) === 0x04
  const contactDetected = (flags & 0x02) === 0x02

  // Wide (16-bit) format needs bytes 1 AND 2 present. Without this
  // guard readUInt16LE(1) on a 2-byte buffer throws RangeError.
  if (wide && data.length < 3) return null

  const bpm = wide ? data[1] | (data[2] << 8) : data[1]

  // A strap sitting on the shelf (or between beats) reports 0 — never
  // stream that into a session. And if the sensor says contact is
  // supported but not currently detected, the reading is meaningless.
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (bpm > HRM_MAX_BPM) return null
  if (contactSupported && !contactDetected) return null

  return { bpm, contactSupported, contactDetected }
}
