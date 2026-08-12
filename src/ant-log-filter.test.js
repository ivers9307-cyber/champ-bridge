// Tests for the ant-plus-next stray-`0` filter.
//
// The predicate must be strict: it swallows exactly the dependency's
// `console.log(this.deviceId)` with deviceId===0 and nothing else — most
// importantly not our own logger's output, which always leads with a string.

import { describe, it, expect, afterEach } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const {
  isStrayScannerLog, installAntLogFilter, uninstallAntLogFilter, suppressedCount,
} = await import('./ant-log-filter.js')

afterEach(() => { uninstallAntLogFilter() })

describe('isStrayScannerLog', () => {
  it('matches a lone numeric zero — the scanner-mode deviceId', () => {
    expect(isStrayScannerLog([0])).toBe(true)
  })

  it('does not match the string "0"', () => {
    expect(isStrayScannerLog(['0'])).toBe(false)
  })

  it('does not match other numbers (a real deviceId must still print)', () => {
    expect(isStrayScannerLog([44670])).toBe(false)
    expect(isStrayScannerLog([-0.5])).toBe(false)
  })

  it('does not match 0 alongside other arguments', () => {
    expect(isStrayScannerLog([0, 'context'])).toBe(false)
    expect(isStrayScannerLog(['count', 0])).toBe(false)
  })

  it('does not match our own logger output (always a leading string)', () => {
    expect(isStrayScannerLog(['{"level":"info","msg":"strap seen"}'])).toBe(false)
    expect(isStrayScannerLog(['[ant] strap detected', { bpm: 0 }])).toBe(false)
  })

  it('does not match empty / non-array input', () => {
    expect(isStrayScannerLog([])).toBe(false)
    expect(isStrayScannerLog(null)).toBe(false)
    expect(isStrayScannerLog('0')).toBe(false)
  })
})

describe('installAntLogFilter', () => {
  it('swallows the stray 0 and passes everything else through', () => {
    const original = console.log
    const captured = []
    // Install OVER a capture spy, so whatever the filter forwards lands here.
    console.log = (...a) => captured.push(a)
    installAntLogFilter()
    captured.length = 0 // drop the filter's own "now filtering" install line

    console.log(0)                       // dependency noise → swallowed
    console.log(44670)                   // a real device id → forwarded
    console.log('[ant] strap detected')  // our logger → forwarded
    console.log(0, 'with context')       // not the stray shape → forwarded

    uninstallAntLogFilter()
    console.log = original

    expect(captured).toEqual([[44670], ['[ant] strap detected'], [0, 'with context']])
  })

  it('counts what it suppressed', () => {
    const original = console.log
    console.log = () => {}
    installAntLogFilter()
    console.log(0); console.log(0); console.log(0)
    const n = suppressedCount()
    uninstallAntLogFilter()
    console.log = original
    expect(n).toBe(3)
  })

  it('is idempotent — a second install does not double-wrap', () => {
    const original = console.log
    console.log = () => {}
    expect(installAntLogFilter()).toBe(true)
    expect(installAntLogFilter()).toBe(false)
    uninstallAntLogFilter()
    console.log = original
  })

  it('uninstall restores the original console.log', () => {
    const original = console.log
    installAntLogFilter()
    expect(console.log).not.toBe(original)
    uninstallAntLogFilter()
    expect(console.log).toBe(original)
  })
})
