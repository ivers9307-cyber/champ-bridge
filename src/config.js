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
//   FAKE_BLE=1             skip noble; emit synthetic samples for
//                          development without straps
//   BATCH_INTERVAL_MS=3000 how often to flush samples to the API
//   SCAN_INTERVAL_MS=5000  how often to POST /api/bridge/scan
//   HEARTBEAT_MS=30000     how often to ping /api/bridge/heartbeat
//                          when otherwise idle (samples calls also
//                          touch last_seen_at)
//   MAX_CONNECTIONS=30     soft cap on concurrent BLE connections
//   LOG_LEVEL=info         debug | info | warn | error

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
  fakeBle: process.env.FAKE_BLE === '1',
  batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS, 10) || 3000,
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS, 10) || 5000,
  heartbeatMs: parseInt(process.env.HEARTBEAT_MS, 10) || 30_000,
  maxConnections: parseInt(process.env.MAX_CONNECTIONS, 10) || 30,
  logLevel: process.env.LOG_LEVEL || 'info',
  softwareVersion: process.env.npm_package_version || '0.1.0',
}
