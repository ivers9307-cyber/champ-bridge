# champ-bridge — agent brief

This is the heart-rate bridge that runs on a Pi at each studio. Reads
chest straps over ANT+ and BLE, batches samples, POSTs to un1t-crm.

## What this is NOT

- Not a Next.js project. Pure Node 20+ ESM service. No Vercel.
- Not a customer-facing surface. Members never interact with the
  bridge directly — they just put on a strap and walk into class.
- Not stateful. The bridge holds no DB, no users, no config beyond
  env. State lives server-side. A fresh Pi pulls latest code, gets
  a token, and starts streaming.

## Architecture

```
   Strap ─ANT+─▶ champ-bridge ─HTTPS─▶ un1t-crm /api/bridge/*
   Strap ─BLE──▶    (Pi)
```

ANT+ is the primary protocol (connectionless — one stick reads the
whole room). BLE is the fallback for BLE-only straps. Both adapters
feed one merged stream — see "Code map".

3 outbound endpoints:
- `POST /api/bridge/heartbeat` — every 30s when idle (samples calls
  also touch last_seen_at server-side, so we skip when sending)
- `POST /api/bridge/samples`   — batched BPM, every 3s
- `POST /api/bridge/scan`      — current visible straps, every 5s
                                  (drives the coach pairing UI)

Auth: `Authorization: Bearer bbr_xxx`. Token issued by master in
the CRM. Stored sha256-hashed server-side; the raw value never
persists. Lost token → admin rotates.

## Identifier model — `device_key`

Every strap is identified by one self-describing string:
- `ant:12345`               ANT+ — decimal device number
- `ble:AA:BB:CC:DD:EE:FF`   BLE — canonical MAC

Protocol is encoded *in* the key, so it can't drift from a parallel
column, and ANT+/BLE ids can't collide. That's also why the
dual-protocol bridge needs no de-dup: namespacing does it. A
dual-band strap seen on both protocols appears as two keys; the
server (where a member registers exactly one key) decides which
routes to a session — the other is dropped as unregistered.

`device_key` is built/parsed by `src/device-key.js`, which is
duplicated verbatim into un1t-crm and champ-app.

## Code map

```
src/
  index.js        entrypoint — strap-source → buffer → flush + scan + heartbeat (+ inbody)
  config.js       env loading + validation (fails fast at import time)
  log.js          structured logger (mirrors un1t-crm/src/lib/log.js)
  api.js          HTTP client (undici); never throws — returns {ok, body}
  device-key.js   protocol-aware identifier helpers (shared, duplicated)
  strap-source.js dual-protocol orchestrator — merges ant + ble adapters
  ant.js          ANT+ adapter — RealAnt (ant-plus-next) or FakeAnt
  ble.js          BLE adapter — RealBle (noble) or FakeBle
  buffer.js       bounded sample queue + chunked flush with retry
  inbody.js       InBody enrichment poller (optional; whitelisted-IP fetch)
deploy/
  champ-bridge.service   systemd unit
```

## InBody enrichment (optional)

InBody's Lookin'Body REST API only accepts calls from a whitelisted IP, and
Vercel's egress IPs rotate — so the Pi (which sits on the gym's static public
IP, next to the scanner) is the fetcher. When `INBODY_API_KEY` +
`INBODY_ACCOUNT` are set, `inbody.js` polls the CRM (`GET /api/bridge/inbody/
pending`) for scans needing data, pulls each from `POST /inbody/
GetFullInBodyData` (API-KEY + Account headers), and relays the raw responses to
`POST /api/bridge/inbody/ingest`, where the CRM maps + matches + stores them.
The API key never leaves the Pi. InBody caps each device at 500 calls/day
(resets 00:00 UTC); `inbody.js` keeps a per-day counter and stops at
`INBODY_DAILY_CAP` (450). Whitelist the Pi's egress IP — `curl -s
https://ifconfig.me` — in the InBody portal.

The same tick also runs an **on-demand backfill** (`runInbodyBackfillCycle`):
when an operator clicks "Sync InBody" on a contact, the CRM queues a request;
the Pi polls `GET /api/bridge/inbody/backfill-pending`, calls `GetDateTimes`
for that phone → `GetFullInBodyData` per scan, and relays the lot to `POST
/api/bridge/inbody/backfill-ingest`. Shares the same daily-cap counter as the
enrich cycle. This is how members scanned *before* the integration get pulled.

Every adapter emits the same event shape, keyed by `device_key`:
`strap-seen` `{device_key,name?,rssi?,last_bpm?}`,
`strap-sample` `{device_key,recorded_at,bpm}`, `strap-lost` `device_key`.

## How to dev without hardware

```sh
CHAMP_BRIDGE_TOKEN=bbr_test CHAMP_API_URL=http://localhost:3000 \
  FAKE_STRAPS=1 npm run dev
```

`FAKE_STRAPS=1` emits two synthetic ANT+ straps and two BLE straps
with a slow random walk between 60-180 BPM. The rest of the pipeline
runs unchanged. (`FAKE_BLE=1` is still accepted as an alias.)

## Sample-router contract with un1t-crm

The bridge sends every sample it sees, paired or not, as
`{ device_key, recorded_at, bpm }`. The server's `resolveStrapsForBatch`
(un1t-crm/src/lib/bridge-samples.js) routes each sample by:

1. Manual override (`strap_assignments`) — coach paired this
   device_key to a contact for this class.
2. Auto-association (`contact_devices`) — member registered this
   device_key permanently. Auto-creates a `heart_rate_sessions` tied
   to the contact's in-progress booking if any.
3. Drop — strap broadcasting but unpaired/no booking.

The bridge doesn't need to know which path took.

## When hardware lands

Smoke test order:
1. Provision a Pi following README.md (Node + bluez + libusb, the
   noble setcap, and the ANT+ udev rule).
2. From CRM master account, `POST /api/admin/bridges` with a
   distinct `hardware_id`.
3. Drop the returned token into `/home/pi/champ-bridge/.env`.
4. `sudo systemctl restart champ-bridge && sudo journalctl -u champ-bridge -f`.
5. Power on an ANT+ strap (Garmin HRM-Dual / Polar H9). Should
   appear in scan within ~5s; samples stream within ~10s. Confirm
   the log shows an `ant:` device key.
6. Power on a BLE-only strap. Confirm a `ble:` key appears too.
7. Verify in CRM: `/live/<location>` shows the straps under
   "Available straps", or an active tile if the strap is on a
   registered member's profile with an in-progress booking.
8. Validate the real-hardware adapter paths — `RealAnt` (ant.js)
   and `RealBle` (ble.js) are only exercised on the Pi; the test
   suite covers the fake adapters + pure helpers.
