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
   service user can open the stick. Grant it to the `plugdev` group
   (user `pi` is already a member) rather than world-writable `0666`:
   ```sh
   echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0fcf", MODE="0660", GROUP="plugdev"' \
     | sudo tee /etc/udev/rules.d/99-garmin-ant.rules
   sudo udevadm control --reload-rules && sudo udevadm trigger
   ```
   `0fcf` is the Dynastream/Garmin vendor ID — covers both stick
   generations. `0660`+`plugdev` means only members of `plugdev` (the
   service user) can open the stick — not every process on the box.
   If the service runs as a user NOT in `plugdev`, either add it
   (`sudo usermod -aG plugdev <user>`) or set `GROUP=` to that user's
   group.
5. **Clone + install**:
   ```sh
   git clone https://github.com/ivers9307-cyber/champ-bridge.git
   cd champ-bridge
   npm ci --omit=dev
   ```
6. **Get a token from the CRM** — master logs in to crm.repset.ie,
   POST `/api/admin/bridges` with name + location_id + hardware_id.
   Response includes the raw token (shown once).
7. **Create `.env`** and lock it down. It holds the bearer token and
   (if enabled) the InBody API key; a default `755` home leaves it
   world-readable, so restrict it to the owner:
   ```
   CHAMP_BRIDGE_TOKEN=bbr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   CHAMP_API_URL=https://crm.repset.ie
   ```

   > **Note:** these docs set the host for **new** installs only. A live
   > Pi keeps whatever `CHAMP_API_URL` is in its `.env` until the gated
   > per-device fleet pass updates it — devices on the legacy
   > `crm.un1tdublin.com` host keep working meanwhile.
   ```sh
   chmod 600 .env
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
| `BATCH_INTERVAL_MS` | 3000 | sample flush cadence (clamped ≥ 500ms) |
| `SCAN_INTERVAL_MS` | 5000 | `/scan` post cadence (clamped ≥ 1000ms) |
| `HEARTBEAT_MS` | 30000 | idle heartbeat cadence (clamped ≥ 5000ms) |
| `MAX_CONNECTIONS` | 30 | soft cap on concurrent BLE connections (ANT+ has none) |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `INBODY_STATE_FILE` | `inbody-daily-count.json` | where the InBody daily-cap counter persists (point at a `StateDirectory` if the working dir is read-only) |

Interval envs are clamped to a sane minimum so a fat-fingered or
negative value can't turn a poll loop into a busy-spin. `CHAMP_API_URL`
is URL-validated at startup and the token is shape-checked (`bbr_`
prefix) — a mis-paste warns in the journal instead of 401-looping
silently.

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

### One-time Pi ops setup

The Pi has no real-time clock and defaults to RAM-only logs, so do
these once per Pi (all detailed in `deploy/champ-bridge.service`):

- **Block boot on a synced clock** — without an RTC, a power-cut Pi
  can start with a wildly wrong clock and stamp `recorded_at` with
  garbage. The unit orders `After=time-sync.target`; make that a real
  guarantee by enabling the wait unit:
  ```sh
  sudo systemctl enable systemd-time-wait-sync.service
  ```
- **Persistent, capped journald** — so the logs you need after a
  power cut survive the reboot (and don't chew the SD card):
  ```sh
  sudo mkdir -p /var/log/journal
  sudo systemd-tmpfiles --create --prefix /var/log/journal
  # /etc/systemd/journald.conf:  Storage=persistent   SystemMaxUse=200M
  sudo systemctl restart systemd-journald
  ```
- **systemd watchdog (optional, still disarmed)** — the sd_notify
  plumbing is wired (`READY=1` + periodic `WATCHDOG=1`) and, since the
  2026-08-12 fix, the ping is **gated on real ANT+ liveness** rather
  than on a timer firing (`src/watchdog.js`). That distinction is the
  whole point: the wedge that took the bridge blind left the event loop
  perfectly healthy, so a timer-driven ping would have caught nothing.
  The unit still ships `Type=simple` because the *transport*
  (`systemd-notify`, shelled out per ping) has never run on a Pi, and
  under `Type=notify` a broken transport means systemd kills a healthy
  bridge every `WatchdogSec`. Arming procedure, pre-check first, is in
  `deploy/champ-bridge.service`.

## Shutdown behaviour

SIGTERM runs a **hard-bounded** sequence: stop the adapters, one final
sample flush, one `offline` heartbeat — each with its own slice of a 6s
total budget, and a guaranteed `process.exit(0)` afterwards whatever is
still pending (`src/shutdown.js`). Steps are best-effort: a step that
hangs is abandoned, not awaited.

This exists because on 2026-08-12 `systemctl restart` hung in
`deactivating` and systemd had to SIGKILL the process after the default
90s stop timeout. The block was `ant-plus-next`'s libusb
`USBDriver.write()`, which resolves nothing when the endpoint is already
gone; the ANT+ teardown awaited it. The unit now also sets
`TimeoutStopSec=15` so even a pathological hang is capped.

### Pi hardening

The bridge sits on a gym LAN on the studio's static IP; treat it like
any exposed box:

- `chmod 600 ~/champ-bridge/.env` — the token + InBody key are secrets
  and a default home is world-readable.
- **SSH key-only auth** — disable password login
  (`PasswordAuthentication no` in `/etc/ssh/sshd_config`, then
  `sudo systemctl restart ssh`).
- **Change the default `pi` password** (`passwd`) — a fresh Pi OS
  image ships with a known default.
- **Automatic security updates**:
  ```sh
  sudo apt-get install -y unattended-upgrades
  sudo dpkg-reconfigure -plow unattended-upgrades
  ```
- The ANT+ udev rule uses `MODE=0660, GROUP=plugdev` (not `0666`) so
  the stick isn't world-writable — see the setup steps above.

## Token rotation

Master in CRM hits `POST /api/admin/bridges/[id]/rotate-token`. The
response contains the new raw token; update the Pi's `.env` and
restart. The previous token is dead immediately.
