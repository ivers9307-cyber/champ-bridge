# Homey Actuation Layer — Design

**Date:** 2026-08-01
**Status:** Approved in conversation (Richard, 2026-08-01)
**Repos:** champ-bridge only (CRM contract unchanged)
**Supersedes:** the python-kasa sidecar half of `un1t-crm/docs/superpowers/specs/2026-07-05-tapo-device-control-design.md` (Wave T2 actuation). Everything CRM-side in that spec stands.

## Problem

The direct-Tapo actuation path (python-kasa sidecar, champ-bridge PR #8) stalled at the on-site handshake gate — TP-Link's undocumented protocol churn (KLAP → TPAP/SPAKE2+) was the headline risk from scoping and it landed. Meanwhile the studio now runs a **Homey Pro** with all Tapo devices paired and working through it. Homey owns the vendor protocol dance; we swap our actuation layer to speak to Homey instead of to the devices.

The original design isolated exactly this layer: the CRM never speaks Tapo, and the bridge's reconcile cycle (`src/tapo.js`) takes injected deps. This change replaces those deps and deletes the sidecar. **Zero CRM changes** — `tapo_devices` is empty in prod (verified 2026-08-01), so there is no ID migration.

## Decisions (Richard, 2026-08-01)

1. **Scope: any on/off device Homey exposes**, not just Tapo. The bridge reports every device with an `onoff` capability; everything auto-registers **disabled** (existing adopt flow) and the operator enables what they want.
2. **Delete the python-kasa sidecar** (`sidecar/`, `deploy/champ-tapo-sidecar.service`). Git history keeps it. No dual-backend switch.
3. **Raw local REST via undici** — no `homey-api` npm dependency (still rc-versioned; websockets add long-lived-connection fragility the 15s polling model deliberately avoids).
4. **Accepted debt:** internal `tapo_*` naming (CRM table/routes, `src/tapo.js`, `TAPO_ENABLED`) survives. The operator-facing UI already says "Devices"; renaming would touch the CRM for nothing.

## Architecture

```
CRM (Vercel)                          Stillorgan Pi                  Studio LAN
──────────────                        ─────────────────              ───────────
tapo_devices  ⇄  /api/bridge/tapo/*  ⇄  champ-bridge (Node)  ──LAN──▶ Homey Pro ──▶ Tapo
operator UI       (bridge token)         tapo.js reconcile ~15s        local REST      (+ any
                                         homey.js adapter (NEW)        Bearer API key   future
                                                                                        brand)
```

Unchanged: `tapo.js` cycle (directive cache w/ 26h ceiling, reentrancy guard, membership-set offline eval), `tapo-logic.js` (diffCommands / buildStateReport), CRM directive/state contract, staleness-as-alert model.

## Homey local API (verified against docs + community, 2026-08-01)

- `GET http://<HOMEY_ADDRESS>/api/manager/devices/device` — all devices, incl. `class`, `available`, `capabilitiesObj` with live values. Auth: `Authorization: Bearer <API key>`.
- `PUT http://<HOMEY_ADDRESS>/api/manager/devices/device/<id>/capability/onoff` body `{"value": true|false}`.
- API key created in the Homey web app (Settings → API Keys), scoped to device read+control only.

## Adapter — `src/homey.js`

Implements the three injected deps `realTapoDeps` currently points at the sidecar:

- **One GET per tick** of the full device list; both dep reads (`getSidecarDevices` / `getSidecarState` slots) are served from that single fetch (the two slots share one in-flight promise per tick — the cycle calls them via `Promise.all`, so a naive implementation would double-fetch a chunky payload for no reason).
- **Filter:** devices advertising `onoff` — the `capabilities` array is authoritative when present (an empty array excludes, even if `capabilitiesObj.onoff` exists); `capabilitiesObj` is the fallback when the array is absent. Everything else is invisible to the bridge.
- **Device shape:** `{ id: 'homey:<homey-device-id>', kind, name_hint }` — `kind` maps Homey `class` `socket` → `plug`, anything else → `switch` (CRM column constraint). `name_hint` = Homey device name.
- **State shape:** `{ id, state: 'on'|'off'|null, reachable }` — `state` from `capabilitiesObj.onoff.value` (strictly boolean, else `null` — never guessed), `null` when unavailable; `reachable` = `available !== false` (missing `available` counts as reachable).
- **Command:** strip the `homey:` prefix, `PUT .../capability/onoff`. Idempotent; failures logged + counted, retried next tick (existing cycle behaviour).
- Same never-throw `{ok, statusCode, body}` result shape as the old `sidecarJson`, 5s headers/body timeouts.

IDs are self-describing per house convention (`ant:` / `ble:` / old `mac:` / `hub:`); the `homey:` namespace can never collide with stale rows (and there are none).

## Config

| Var | Required | Notes |
|---|---|---|
| `TAPO_ENABLED` | existing gate, default off | unchanged |
| `HOMEY_ADDRESS` | when enabled | `http://<LAN IP>` — DHCP-reserve the Homey Pro on the studio router |
| `HOMEY_API_KEY` | when enabled | Pi `.env` only (InBody-key posture); scoped read+control |

`TAPO_SIDECAR_URL` and the sidecar's `TAPO_*` env vars die with it. `config.js` fails fast at import when enabled without the two Homey vars (house pattern).

## Failure modes (all inherited)

- Homey unreachable → skip commanding AND reporting; CRM `last_seen_at` goes stale → amber/red dots. Staleness IS the alert (no new alerting).
- Internet outage → Pi evaluates cached resolved windows and commands Homey over LAN; schedules keep executing.
- Homey's Tapo integration breaks (TP-Link firmware games move to Athom's problem) → devices report `available: false` → `reachable: false` in the UI. Keep Tapo auto-update OFF until Homey's app confirms support for a firmware.
- Homey Pro reboot → stateless polls self-heal within a tick.

## Deletions

- `sidecar/` (service, tests, requirements, README)
- `deploy/champ-tapo-sidecar.service`
- README sidecar sections → replaced by a short Homey setup section (API key, DHCP reservation, env vars)

## Testing

- `tapo.test.js` / `tapo-logic.test.js` stay green untouched (backend-agnostic fakes).
- New `homey.test.js`: pure mapping (Homey JSON → device/state shapes, `homey:` prefixing, class→kind, `available`/`onoff` → `state`/`reachable`, missing-capability filtering), single-fetch-per-tick sharing, error/timeout result shapes. No live-Homey tests (house convention: fakes + pure helpers; hardware is the exit gate).
- **Exit gate (Richard on-site):** create scoped API key, DHCP reservation, set env, `TAPO_ENABLED=1`, restart service; verify one plug follows a schedule AND a CRM toggle round-trips; adopt flow shows the full device list in `/automations/devices`.

## Out of scope

Energy monitoring; Homey realtime/websocket events; renaming `tapo_*`; Wave T3 (mobile toggle parity) — unchanged, follows once this is device-verified; non-onoff capabilities (dim, thermostat).
