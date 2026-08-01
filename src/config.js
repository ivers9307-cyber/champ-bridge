// champ-bridge configuration. All values come from env vars so the
// same code runs on every studio's Pi with only its env file
// distinct.
//
// Required:
//   CHAMP_BRIDGE_TOKEN     bbr_<43 chars>  shown once when admin
//                                          creates the bridge in CRM
//   CHAMP_API_URL          https://crm.un1tdublin.com
//
// Optional:
//   FAKE_STRAPS=1          skip real hardware; emit synthetic ANT+ +
//                          BLE straps for development. (FAKE_BLE=1 is
//                          still accepted as a back-compat alias.)
//   ENABLE_ANT=0           disable the ANT+ adapter (default: on)
//   ENABLE_BLE=0           disable the BLE adapter (default: on)
//   BATCH_INTERVAL_MS=3000 how often to flush samples to the API
//   SCAN_INTERVAL_MS=5000  how often to POST /api/bridge/scan
//   HEARTBEAT_MS=30000     how often to ping /api/bridge/heartbeat
//                          when otherwise idle (samples calls also
//                          touch last_seen_at)
//   MAX_CONNECTIONS=30     soft cap on concurrent BLE connections
//                          (ANT+ is connectionless — no equivalent)
//   LOG_LEVEL=info         debug | info | warn | error
//
// InBody / Lookin'Body enrichment (optional — only runs when both
// INBODY_API_KEY and INBODY_ACCOUNT are set). The Pi is the whitelisted-IP
// fetcher: it polls the CRM for scans needing data, pulls them from the
// Lookin'Body REST API, and relays them back. The API key never leaves the Pi.
//   INBODY_API_KEY         WebAPI key from the InBody portal (secret)
//   INBODY_ACCOUNT         account id, e.g. stillorganun1t
//   INBODY_API_URL         default https://apieur.lookinbody.com
//   INBODY_POLL_MS=300000  how often to poll the CRM for pending scans
//   INBODY_DAILY_CAP=450   safety cap under InBody's 500 calls/device/day
//   INBODY_STATE_FILE      where the { day, sent } daily-cap counter persists
//                          (default: inbody-daily-count.json in the working dir)
//
// Tapo/device control (optional — only runs when TAPO_ENABLED=1). The bridge
// polls the CRM for device directives, reads actuals from the Homey Pro's
// local REST API, applies diffs, and reports state back. The Homey API key
// stays on the Pi (InBody-key posture).
//   TAPO_ENABLED=1         turn the reconcile loop on (default: off)
//   HOMEY_ADDRESS          http://<LAN IP of the Homey Pro> (DHCP-reserve it)
//   HOMEY_API_KEY          scoped API key (Homey web app → Settings → API Keys)
//   TAPO_POLL_MS=15000     how often to reconcile directives vs actuals

import { createRequire } from 'node:module'

const required = ['CHAMP_BRIDGE_TOKEN', 'CHAMP_API_URL']
const missing = required.filter((k) => !process.env[k])
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[champ-bridge] missing env: ${missing.join(', ')}`)
  process.exit(1)
}

// Read the REAL version out of package.json. `npm_package_version` is only set
// when the process is launched via an npm script; systemd runs
// `node src/index.js` directly, so relying on the env var pinned every
// heartbeat to the '0.2.0' fallback forever. createRequire lets us pull it in
// from the package manifest regardless of how the process was started.
export function readPackageVersion(fallback = '0.0.0') {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json')
    return pkg.version || fallback
  } catch {
    return fallback
  }
}

// Parse an interval env var, falling back to `def`, then clamp to `min` so a
// negative / zero / tiny value can't turn a poll loop into a busy-spin that
// hammers the API (and the SD card). NaN → default. Non-integers are floored.
export function clampInterval(raw, def, min) {
  const n = parseInt(raw, 10)
  const val = Number.isFinite(n) && n > 0 ? n : def
  return Math.max(min, val)
}

// Light sanity check on the bearer token shape. CRM tokens are `bbr_…`; a
// value missing the prefix is almost certainly a mis-paste (whole .env line,
// quotes, a URL). We only warn — the CRM is the real authority — but a warn in
// the journal turns a silent 401 loop into an obvious "check your token".
export function tokenLooksValid(token) {
  return typeof token === 'string' && /^bbr_/.test(token) && token.length >= 8
}

// Validate CHAMP_API_URL parses as an http(s) URL. Fails fast (like the
// missing-env check) rather than letting every request throw an opaque
// "invalid URL" deep in undici.
function normaliseApiUrl(raw) {
  const trimmed = String(raw).replace(/\/+$/, '')
  let u
  try { u = new URL(trimmed) } catch {
    // eslint-disable-next-line no-console
    console.error(`[champ-bridge] CHAMP_API_URL is not a valid URL: ${raw}`)
    process.exit(1)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // eslint-disable-next-line no-console
    console.error(`[champ-bridge] CHAMP_API_URL must be http(s): ${raw}`)
    process.exit(1)
  }
  return trimmed
}

if (!tokenLooksValid(process.env.CHAMP_BRIDGE_TOKEN)) {
  // eslint-disable-next-line no-console
  console.warn('[champ-bridge] CHAMP_BRIDGE_TOKEN does not look like a bbr_ token — check .env')
}

// Fail-fast guard for device control: enabling the reconcile loop without a
// reachable Homey target would silently no-op every tick. Pure + exported for
// tests; called once at import below.
export function homeyConfigError(env) {
  if (env.TAPO_ENABLED !== '1') return null
  if (!env.HOMEY_ADDRESS) return 'TAPO_ENABLED=1 requires HOMEY_ADDRESS'
  if (!env.HOMEY_API_KEY) return 'TAPO_ENABLED=1 requires HOMEY_API_KEY'
  let u
  try { u = new URL(env.HOMEY_ADDRESS) } catch {
    return `HOMEY_ADDRESS is not a valid URL: ${env.HOMEY_ADDRESS}`
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `HOMEY_ADDRESS must be http(s): ${env.HOMEY_ADDRESS}`
  return null
}

const homeyErr = homeyConfigError(process.env)
if (homeyErr) {
  // eslint-disable-next-line no-console
  console.error(`[champ-bridge] ${homeyErr}`)
  process.exit(1)
}

export const config = {
  token: process.env.CHAMP_BRIDGE_TOKEN,
  apiUrl: normaliseApiUrl(process.env.CHAMP_API_URL),
  // FAKE_BLE kept as an alias so existing dev scripts don't break.
  fakeStraps: process.env.FAKE_STRAPS === '1' || process.env.FAKE_BLE === '1',
  // Both protocols on by default; set to '0' to disable one.
  enableAnt: process.env.ENABLE_ANT !== '0',
  enableBle: process.env.ENABLE_BLE !== '0',
  // Clamped to sane minimums so a fat-fingered / negative env can't busy-loop.
  batchIntervalMs: clampInterval(process.env.BATCH_INTERVAL_MS, 3000, 500),
  scanIntervalMs: clampInterval(process.env.SCAN_INTERVAL_MS, 5000, 1000),
  heartbeatMs: clampInterval(process.env.HEARTBEAT_MS, 30_000, 5000),
  maxConnections: parseInt(process.env.MAX_CONNECTIONS, 10) || 30,
  logLevel: process.env.LOG_LEVEL || 'info',
  softwareVersion: readPackageVersion('0.2.0'),
  // InBody enrichment — only active when both key + account are present.
  inbodyApiKey: process.env.INBODY_API_KEY || null,
  inbodyAccount: process.env.INBODY_ACCOUNT || null,
  inbodyApiUrl: (process.env.INBODY_API_URL || 'https://apieur.lookinbody.com').replace(/\/+$/, ''),
  // Clamp the poll to >=30s: the InBody REST API is IP-rate-limited and each
  // cycle can burn several of the 500/day calls — a tiny value would blow the
  // cap in minutes.
  inbodyPollMs: clampInterval(process.env.INBODY_POLL_MS, 300_000, 30_000),
  inbodyDailyCap: parseInt(process.env.INBODY_DAILY_CAP, 10) || 450,
  // Where the { day, sent } daily-cap counter is persisted so a restart
  // doesn't reset it to 0 and risk breaching InBody's 500/day cap. Defaults to
  // the working dir; override with INBODY_STATE_FILE when the working dir is
  // read-only under systemd (point it at a StateDirectory / ReadWritePaths).
  inbodyStateFile: process.env.INBODY_STATE_FILE || 'inbody-daily-count.json',
  get inbodyEnabled() { return !!(this.inbodyApiKey && this.inbodyAccount) },
  // Tapo device control (Wave T2) — OFF unless explicitly enabled.
  tapoEnabled: process.env.TAPO_ENABLED === '1',
  homeyAddress: (process.env.HOMEY_ADDRESS || '').replace(/\/+$/, '') || null,
  homeyApiKey: process.env.HOMEY_API_KEY || null,
  // Clamped like every other interval — a typo'd env (NaN → 0-delay
  // setInterval) must not busy-loop against the CRM + sidecar.
  tapoPollMs: clampInterval(process.env.TAPO_POLL_MS, 15_000, 5_000),
}
