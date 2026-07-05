# tapo-sidecar — localhost python-kasa facade

A tiny localhost-only HTTP service that speaks Tapo (via
[python-kasa](https://github.com/python-kasa/python-kasa)) to the studio's
smart plugs and the H100 hub's sub-GHz switches. **The champ-bridge Node
service is the only caller** — it talks to this sidecar over
`http://127.0.0.1:8127` and never touches Tapo itself. The brand-specific
knowledge (credentials, addressing, KLAP handshake) lives *only here*, so a
future studio on a different device brand swaps this one process and nothing
else.

Like the InBody fetcher, this process holds a secret that must **stay on the
Pi**: the Tapo cloud credentials are required for the *local* KLAP handshake
and never leave the box.

## Endpoints

| Method | Path                     | Body                    | Returns |
|--------|--------------------------|-------------------------|---------|
| GET    | `/devices`               | —                       | `{"devices":[{id, kind, model, name_hint, host}]}` |
| GET    | `/state`                 | —                       | `{"devices":[{id, state:"on"\|"off"\|null, reachable}]}` |
| POST   | `/device/{id}/state`     | `{"on": true\|false}`   | `{"ok":true}` · `404` unknown id · `502` command failed |

A background loop refreshes an in-memory registry every `TAPO_REFRESH_S`; the
GET handlers read that registry and never touch the network, so `/state` is
instant and a wedged device can't stall the bridge. IDs are self-describing
(`mac:AA:BB:CC:DD:EE:FF` for direct plugs, `hub:<child_device_id>` for hub
children) — see `tapo_ids.py`.

## Install (on the Pi)

```sh
cd /home/pi/champ-bridge/sidecar
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Environment

| Var                 | Required | Default              | Notes |
|---------------------|----------|----------------------|-------|
| `TAPO_USERNAME`     | yes      | —                    | Tapo business-account email. **Stays on the Pi** (InBody-key precedent). |
| `TAPO_PASSWORD`     | yes      | —                    | Tapo business-account password. **Stays on the Pi.** |
| `TAPO_HOSTS`        | no       | — (discovery)        | Comma-separated IPs of the plugs + hub(s). Strongly recommended — see below. |
| `TAPO_SIDECAR_PORT` | no       | `8127`               | Bind port (127.0.0.1 only, always). |
| `TAPO_REFRESH_S`    | no       | `10`                 | Registry poll interval, seconds. |

On the Pi these live in `sidecar/.env` (loaded by the systemd unit's
`EnvironmentFile=`). Never commit `.env`.

### Use DHCP reservations for `TAPO_HOSTS`

Set a DHCP reservation per device on the gym router so each plug/hub keeps a
stable IP, then list those IPs in `TAPO_HOSTS`. LAN broadcast discovery is a
fallback only — it's slower, flakier on segmented networks, and gives you no
control over which devices get adopted.

## Per-device Tapo-app prep (do this before adopting)

For **every** plug and the hub, in the Tapo app:

1. **Pin the firmware** — note the current version and **do not** let it move.
2. **Disable auto-update** — TP-Link has repeatedly broken local control in
   firmware waves; auto-update is how it sneaks in.
3. **Enable "Third-Party Compatibility"** (per device) — this is what allows
   the local KLAP handshake python-kasa uses.

One Tapo business account for the whole estate; creds on the Pi only.

## Local smoke

```sh
TAPO_USERNAME=you@example.com TAPO_PASSWORD='…' TAPO_HOSTS=192.168.1.40 \
  .venv/bin/python tapo_sidecar.py
# in another shell:
curl -s localhost:8127/devices
curl -s localhost:8127/state
```

You should see the plug at `192.168.1.40` register within one refresh cycle
(~10s) and report its on/off state.

## Troubleshooting

- **KLAP handshake failures** (the device connects but won't authenticate) are
  almost always one of two things: a **firmware wave** moved the device off a
  known-good version, or the **"Third-Party Compatibility" toggle is off** for
  that device. Re-check both in the Tapo app. See the un1t-crm Tapo scoping
  brief for the fuller failure-mode catalogue.
- **Nothing discovered** with `TAPO_HOSTS` unset → the broadcast didn't reach
  the devices (VLAN/segment). Set `TAPO_HOSTS` explicitly.
- **A device shows `reachable: false`** in `/state` → the refresh loop couldn't
  reach it this pass; it retries every `TAPO_REFRESH_S`. Persistent means the
  IP moved (add a DHCP reservation) or the device is offline.
