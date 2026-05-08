# champ-bridge

Heart rate bridge service. Runs on a Raspberry Pi at each studio,
scans for BLE chest straps (Polar / Wahoo / Coospo / Garmin / any
device implementing the standard Heart Rate Service `0x180D`), and
streams samples to un1t-crm.

## Architecture

```
   ┌────────┐     BLE      ┌──────────────┐    HTTPS     ┌─────────────┐
   │ Strap  │  ───────────▶│ champ-bridge │ ────────────▶│  un1t-crm   │
   │ (Pi-   │  HR notifs   │   (Pi)       │   POST /api  │   Vercel    │
   │  side) │              │              │   /bridge/*  │             │
   └────────┘              └──────────────┘              └─────────────┘
                              one per studio                shared backend
```

The bridge holds no persistent state — every sample is forwarded.
If the network drops, samples buffer locally (bounded ~5000 ≈ 3min
of 30 straps × 1Hz) and replay when connectivity returns. Replays
are idempotent server-side (PK on `(session_id, recorded_at)`).

## Hardware

Tested on:
- Raspberry Pi 4 4GB, Raspbian Bookworm
- USB BLE adapter (TP-Link UB500 or built-in radio)
- Polar H10, Wahoo TICKR, Coospo H6 chest straps

For >7 concurrent straps, stack multiple USB BLE adapters; bluez
schedules across them automatically.

## Setup (Pi)

1. **Flash Raspberry Pi OS Lite** to a 32GB+ SD card.
2. **Install Node 20+** + bluez:
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt-get install -y nodejs bluez libbluetooth-dev libudev-dev
   ```
3. **Grant noble permission to use BLE without root**:
   ```sh
   sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
   ```
4. **Clone + install**:
   ```sh
   git clone https://github.com/ivers9307-cyber/champ-bridge.git
   cd champ-bridge
   npm ci --omit=dev
   ```
5. **Get a token from the CRM** — master logs in to crm.un1tdublin.com,
   POST `/api/admin/bridges` with name + location_id + hardware_id.
   Response includes the raw token (shown once).
6. **Create `.env`**:
   ```
   CHAMP_BRIDGE_TOKEN=bbr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   CHAMP_API_URL=https://crm.un1tdublin.com
   ```
7. **Smoke test**:
   ```sh
   FAKE_BLE=1 node src/index.js
   ```
   Should print `champ-bridge starting`, then `strap seen` for each
   of the 3 fake straps, then `flushed N samples` every 3s.
8. **Install as a systemd service** (see `deploy/champ-bridge.service`).

## Dev workflow (no hardware)

```sh
npm install
CHAMP_BRIDGE_TOKEN=bbr_test CHAMP_API_URL=http://localhost:3000 FAKE_BLE=1 npm run dev
```

The fake BLE generator emits 3 straps with random-walk BPM ~60-180,
so you can develop the un1t-crm side end-to-end without a Pi.

## Deploy

systemd service runs as a non-root user; the noble setcap above
gives the binary BLE access without sudo. After a code change:

```sh
ssh pi@studio1-bridge.local
cd ~/champ-bridge && git pull && npm ci --omit=dev
sudo systemctl restart champ-bridge
```

Logs:
```sh
sudo journalctl -u champ-bridge -f
```

## Token rotation

Master in CRM hits `POST /api/admin/bridges/[id]/rotate-token`. The
response contains the new raw token; update the Pi's `.env` and
restart. The previous token is dead immediately.
