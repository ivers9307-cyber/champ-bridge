// Tests for the pure config helpers: package-version read, interval clamps,
// and token-shape check. Env is set before importing config.js (which fails
// fast on missing env at import time).
import { describe, it, expect } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'
// Garbage on purpose — proves the tapo poll interval is clamp-wired (a typo'd
// env must fall back to the default, not become a 0-delay busy-loop).
process.env.TAPO_POLL_MS = 'garbage'
// Immunise against a dev shell that already exports TAPO_ENABLED=1 — the
// import-time fail-fast guard below would exit the whole test process.
delete process.env.TAPO_ENABLED
// Set before import so config.homeyAddress wiring (origin-normalised, via
// homeyOrigin) can be pinned below without enabling the reconcile loop.
process.env.HOMEY_ADDRESS = 'http://192.168.1.50/'

const { readPackageVersion, clampInterval, tokenLooksValid, config, homeyConfigError } = await import('./config.js')

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

describe('homeyConfigError', () => {
  it('is null when tapo control is disabled, whatever else is set', () => {
    expect(homeyConfigError({})).toBe(null)
    expect(homeyConfigError({ HOMEY_ADDRESS: 'nonsense' })).toBe(null)
  })
  it('is null for anything other than the strict string "1" (pins the strict contract)', () => {
    expect(homeyConfigError({ TAPO_ENABLED: 'true', HOMEY_ADDRESS: 'nonsense' })).toBe(null)
  })
  it('requires both HOMEY vars when TAPO_ENABLED=1', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1' })).toMatch(/HOMEY_ADDRESS/)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: '' })).toMatch(/HOMEY_ADDRESS/)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50' })).toMatch(/HOMEY_API_KEY/)
  })
  it('rejects a missing / whitespace-only HOMEY_API_KEY', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50', HOMEY_API_KEY: '   ' })).toMatch(/HOMEY_API_KEY/)
  })
  it('rejects a non-http(s) or unparseable address', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: '192.168.1.50', HOMEY_API_KEY: 'k' })).toMatch(/valid URL/)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'ftp://x', HOMEY_API_KEY: 'k' })).toMatch(/http/)
  })
  it('rejects a path-bearing or query-bearing address (web-app URL mis-paste)', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50/api', HOMEY_API_KEY: 'k' })).toMatch(/just the origin/)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://x/?a=b', HOMEY_API_KEY: 'k' })).toMatch(/just the origin/)
  })
  it('accepts a good pair, including https and a bare-origin trailing slash', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50', HOMEY_API_KEY: 'k' })).toBe(null)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'https://192.168.1.50', HOMEY_API_KEY: 'k' })).toBe(null)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50/', HOMEY_API_KEY: 'k' })).toBe(null)
  })
  it('config.homeyAddress is origin-normalised (trailing slash stripped via homeyOrigin)', () => {
    // HOMEY_ADDRESS is set to 'http://192.168.1.50/' before config.js is imported.
    expect(config.homeyAddress).toBe('http://192.168.1.50')
  })
})
