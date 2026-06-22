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

const required = ['CHAMP_BRIDGE_TOKEN', 'CHAMP_API_URL']
const missing = required.filter((k) => !process.env[k])
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[champ-bridge] missing env: ${missing.join(', ')}`)
  process.exit(1)
}

export const config = {
  token: process.env.CHAMP_BRIDGE_TOKEN,
  apiUrl: process.env.CHAMP_API_URL.replace(/\/+$/, ''),
  // FAKE_BLE kept as an alias so existing dev scripts don't break.
  fakeStraps: process.env.FAKE_STRAPS === '1' || process.env.FAKE_BLE === '1',
  // Both protocols on by default; set to '0' to disable one.
  enableAnt: process.env.ENABLE_ANT !== '0',
  enableBle: process.env.ENABLE_BLE !== '0',
  batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS, 10) || 3000,
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS, 10) || 5000,
  heartbeatMs: parseInt(process.env.HEARTBEAT_MS, 10) || 30_000,
  maxConnections: parseInt(process.env.MAX_CONNECTIONS, 10) || 30,
  logLevel: process.env.LOG_LEVEL || 'info',
  softwareVersion: process.env.npm_package_version || '0.2.0',
  // InBody enrichment — only active when both key + account are present.
  inbodyApiKey: process.env.INBODY_API_KEY || null,
  inbodyAccount: process.env.INBODY_ACCOUNT || null,
  inbodyApiUrl: (process.env.INBODY_API_URL || 'https://apieur.lookinbody.com').replace(/\/+$/, ''),
  inbodyPollMs: parseInt(process.env.INBODY_POLL_MS, 10) || 300_000,
  inbodyDailyCap: parseInt(process.env.INBODY_DAILY_CAP, 10) || 450,
  get inbodyEnabled() { return !!(this.inbodyApiKey && this.inbodyAccount) },
}
