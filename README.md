# champ-bridge

Heart rate bridge service. Runs on a Raspberry Pi at each studio,
picks up chest straps and arm bands over **ANT+** and **Bluetooth Low
Energy**, and streams samples to un1t-crm.

## Why dual-protocol

ANT+ is the **primary** path. It's connectionless: one ANT+ USB stick
in scanning mode picks up every strap broadcasting in the room at once
— no per-device connection, no 7-connection ceiling. That's what makes
it work for a full 15-20 person class.

BLE is the **fallback**. It still uses per-strap GATT connections (and
so is connection-limited), but it covers the minority of straps that
only speak Bluetooth. Most quality straps are dual-band and get picked
up over ANT+ regardless.

Straps are identified by a protocol-aware `device_key` — `ant:12345`
or `ble:AA:BB:CC:DD:EE:FF` (see `src/device-key.js`).

## Architecture

```
   ┌────────┐  ANT+ / BLE  ┌──────────────┐    HTTPS     ┌─────────────┐
   │ Strap  │  ───────────▶│ champ-bridge │ ────────────▶│  un1t-crm   │
   │        │   HR data    │   (Pi)       │   POST /api  │   Vercel    │
   └────────┘              └──────────────┘   /bridge/*  └─────────────┘
                              one per studio                shared backend
```

The bridge holds no persistent state — every sample is forwarded. If
the network drops, samples buffer locally (bounded ~5000) and replay
when connectivity returns. Replays are idempotent server-side (PK on
`(session_id, recorded_at)`).

## Hardware

- Raspberry Pi 4 / 5, Raspberry Pi OS Bookworm.
- **ANT+ USB stick** — Garmin ANT+ USB-m (a `GarminStick3`), or the
  older ANTUSB2 (`GarminStick2`). The bridge tries both.
- **USB BLE adapter** (optional, for the BLE fallback) — TP-Link
  UB500 or the Pi's built-in radio. For BLE-heavy rooms, stack
  multiple adapters; bluez schedules across them.

## Setup (Pi)

1. **Flash Raspberry Pi OS Lite** to a 32GB+ SD card.
2. **Install Node 20+, bluez, and libusb**:
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt-get install -y nodejs bluez libbluetooth-dev libudev-dev libusb-1.0-0-dev
   ```
   `libusb-1.0-0-dev` is needed by the ANT+ stack (`ant-plus-next`
   builds the native `usb` binding against it).
3. **Grant BLE access without root** (noble):
   ```sh
   sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
   ```
4. **Grant ANT+ USB access without root** — add a udev rule so the
   service user can open the stick:
   ```sh
   echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0fcf", MODE="0666"' \
     | sudo tee /etc/udev/rules.d/99-garmin-ant.rules
   sudo udevadm control --reload-rules && sudo udevadm trigger
   ```
   `0fcf` is the Dynastream/Garmin vendor ID — covers both stick
   generations.
5. **Clone + install**:
   ```sh
   git clone https://github.com/ivers9307-cyber/champ-bridge.git
   cd champ-bridge
   npm ci --omit=dev
   ```
6. **Get a token from the CRM** — master logs in to crm.un1tdublin.com,
   POST `/api/admin/bridges` with name + location_id + hardware_id.
   Response includes the raw token (shown once).
7. **Create `.env`**:
   ```
   CHAMP_BRIDGE_TOKEN=bbr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   CHAMP_API_URL=https://crm.un1tdublin.com
   ```
8. **Smoke test**:
   ```sh
   FAKE_STRAPS=1 node src/index.js
   ```
   Should print `champ-bridge starting`, then `strap seen` for the
   fake ANT+ and BLE straps, then `flushed N samples` every 3s.
9. **Install as a systemd service** (see `deploy/champ-bridge.service`).

## Dev workflow (no hardware)

```sh
npm install
CHAMP_BRIDGE_TOKEN=bbr_test CHAMP_API_URL=http://localhost:3000 FAKE_STRAPS=1 npm run dev
```

The fake generator emits two ANT+ straps and two BLE straps with
random-walk BPM ~60-180, so you can develop the un1t-crm side
end-to-end without a Pi.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CHAMP_BRIDGE_TOKEN` | — (required) | bearer token from the CRM |
| `CHAMP_API_URL` | — (required) | CRM base URL |
| `FAKE_STRAPS` | off | synthetic straps for dev (`FAKE_BLE` still works as an alias) |
| `ENABLE_ANT` | on | set `0` to disable the ANT+ adapter |
| `ENABLE_BLE` | on | set `0` to disable the BLE adapter |
| `BATCH_INTERVAL_MS` | 3000 | sample flush cadence |
| `SCAN_INTERVAL_MS` | 5000 | `/scan` post cadence |
| `HEARTBEAT_MS` | 30000 | idle heartbeat cadence |
| `MAX_CONNECTIONS` | 30 | soft cap on concurrent BLE connections (ANT+ has none) |
| `LOG_LEVEL` | info | debug / info / warn / error |

## Deploy

systemd service runs as a non-root user; the noble `setcap` and the
ANT+ udev rule above give the binary hardware access without sudo.
After a code change:

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
