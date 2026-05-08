# champ-bridge — agent brief

This is the BLE-to-API bridge that runs on a Pi at each studio.
Reads chest-strap heart rate, batches samples, POSTs to un1t-crm.

## What this is NOT

- Not a Next.js project. Pure Node 20+ ESM service. No Vercel.
- Not a customer-facing surface. Members never interact with the
  bridge directly — they just put on a strap and walk into class.
- Not stateful. The bridge holds no DB, no users, no config beyond
  env. State lives server-side. A fresh Pi pulls latest code, gets
  a token, and starts streaming.

## Architecture

```
   Strap ─BLE─▶ champ-bridge ─HTTPS─▶ un1t-crm /api/bridge/*
                  (Pi)
```

3 outbound endpoints:
- `POST /api/bridge/heartbeat` — every 30s when idle (samples calls
  also touch last_seen_at server-side, so we skip when sending)
- `POST /api/bridge/samples`   — batched BPM, every 3s
- `POST /api/bridge/scan`      — current connected straps, every 5s
                                  (drives the coach pairing UI)

Auth: `Authorization: Bearer bbr_xxx`. Token issued by master in
the CRM. Stored sha256-hashed server-side; the raw value never
persists. Lost token → admin rotates.

## Code map

```
src/
  index.js     entrypoint — wires BLE → buffer → flush + scan + heartbeat loops
  config.js    env loading + validation (fails fast at import time)
  log.js       structured logger (mirrors un1t-crm/src/lib/log.js)
  api.js       HTTP client (undici); never throws — returns {ok, body}
  ble.js       BLE adapter — RealBle (noble) or FakeBle (FAKE_BLE=1)
  buffer.js    bounded sample queue + chunked flush with retry
deploy/
  champ-bridge.service   systemd unit
```

## How to dev without hardware

```sh
CHAMP_BRIDGE_TOKEN=bbr_test CHAMP_API_URL=http://localhost:3000 \
  FAKE_BLE=1 npm run dev
```

`FakeBle` emits 3 synthetic straps with a slow random walk between
60-180 BPM. Rest of the pipeline runs unchanged: buffer fills,
flushes every 3s, /scan posts every 5s.

## Sample-router contract with un1t-crm

The bridge sends every sample it sees, paired or not. The server's
`resolveStrapsForBatch` (un1t-crm/src/lib/bridge-samples.js) routes
each sample by:

1. Manual override (`strap_assignments`) — coach paired this MAC
   to a contact for this class.
2. Auto-association (`contact_devices`) — member registered this
   MAC permanently. Auto-creates a `heart_rate_sessions` tied to
   the contact's in-progress booking if any.
3. Drop — strap broadcasting but unpaired/no booking.

The bridge doesn't need to know which path took: server returns
stats in the response (`accepted`, `dropped_unpaired`, etc) for
diagnostic logging only.

## When hardware lands

Smoke test order:
1. Provision a Pi following README.md.
2. From CRM master account, `POST /api/admin/bridges` with a
   distinct `hardware_id`.
3. Drop the returned token into `/home/pi/champ-bridge/.env`.
4. `sudo systemctl restart champ-bridge && sudo journalctl -u champ-bridge -f`.
5. Power on a Polar H10 (or similar). Should appear in scan within
   ~5s; bridge connects within ~10s; samples stream within 15s.
6. Verify in CRM: `/live/<location>` shows the strap under
   "Available straps" (member not yet registered) OR an active
   tile if the strap is on a registered member's profile and
   they have an in-progress booking.
