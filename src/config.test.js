// Tests for the pure config helpers: package-version read, interval clamps,
// and token-shape check. Env is set before importing config.js (which fails
// fast on missing env at import time).
import { describe, it, expect } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'
// Garbage on purpose — proves the tapo poll interval is clamp-wired (a typo'd
// env must fall back to the default, not become a 0-delay busy-loop).
process.env.TAPO_POLL_MS = 'garbage'

const { readPackageVersion, clampInterval, tokenLooksValid, config } = await import('./config.js')

describe('readPackageVersion', () => {
  it('reads the real version from package.json (not the npm env fallback)', () => {
    // package.json is 0.2.0 in this repo; the point is it comes from the file,
    // so it stays correct when systemd runs `node src/index.js` directly and
    // npm_package_version is unset.
    expect(readPackageVersion()).toBe('0.2.0')
  })

  it('config.softwareVersion is the real package version', () => {
    expect(config.softwareVersion).toBe('0.2.0')
  })
})

describe('clampInterval', () => {
  it('uses the default when unset / NaN', () => {
    expect(clampInterval(undefined, 3000, 500)).toBe(3000)
    expect(clampInterval('not-a-number', 3000, 500)).toBe(3000)
  })

  it('uses the default for zero / negative (would busy-spin)', () => {
    expect(clampInterval('0', 3000, 500)).toBe(3000)
    expect(clampInterval('-100', 3000, 500)).toBe(3000)
  })

  it('clamps a too-small positive value up to the minimum', () => {
    expect(clampInterval('50', 3000, 500)).toBe(500)
    expect(clampInterval('1', 30000, 5000)).toBe(5000)
  })

  it('passes a sane value through unchanged', () => {
    expect(clampInterval('4000', 3000, 500)).toBe(4000)
  })

  it('floors the minimum exactly', () => {
    expect(clampInterval('500', 3000, 500)).toBe(500)
  })

  it('config.tapoPollMs is clamp-wired: garbage env falls back to the default', () => {
    // TAPO_POLL_MS is set to 'garbage' above, before config.js is imported.
    expect(config.tapoPollMs).toBe(15_000)
  })
})

describe('tokenLooksValid', () => {
  it('accepts a bbr_ token', () => {
    expect(tokenLooksValid('bbr_abcdef123456')).toBe(true)
  })

  it('rejects a non-bbr / short / non-string value', () => {
    expect(tokenLooksValid('sk_live_xxx')).toBe(false)
    expect(tokenLooksValid('bbr_')).toBe(false) // too short
    expect(tokenLooksValid('')).toBe(false)
    expect(tokenLooksValid(null)).toBe(false)
    expect(tokenLooksValid(undefined)).toBe(false)
    expect(tokenLooksValid(12345)).toBe(false)
  })
})
