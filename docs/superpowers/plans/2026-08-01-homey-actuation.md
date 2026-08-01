# Homey Actuation Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the python-kasa sidecar with a Homey Pro local-REST adapter so the existing Tapo reconcile cycle drives devices through Homey.

**Architecture:** New `src/homey.js` exposes pure mapping functions plus `createHomeyActuation()` implementing the three actuation deps `runTapoCycle` already injects. One GET of Homey's device list per tick is shared by both read slots via in-flight dedupe. `sidecar/` and its systemd unit are deleted. CRM contract unchanged (spec: `docs/superpowers/specs/2026-08-01-homey-actuation-design.md`).

**Tech Stack:** Node 20 ESM, undici, vitest. No new dependencies.

**Branch:** `feat/homey-actuation` (already created off origin/main; spec committed).

---

### Task 1: Pure Homey → bridge-shape mappers

**Files:**
- Create: `src/homey.js`
- Test: `src/homey.test.js`

Homey's `GET /api/manager/devices/device` returns a JSON **object keyed by device id** (each value has `id`, `name`, `class`, `available`, `driverId`, `capabilities` array, `capabilitiesObj.onoff.value`). The mappers accept an object map or array defensively and produce exactly the shapes `tapo-logic.js` consumes (`buildStateReport` reads `id`/`kind`/`name_hint` from devices, `id`/`state`/`reachable` from states; `diffCommands` matches on `id`). `model` was dropped in review (HOMEY.1b) — buildStateReport never forwards it.

- [ ] **Step 1: Write the failing tests**

```js
// src/homey.test.js — pure mappers + actuation factory (no network).
import { describe, it, expect, vi } from 'vitest'

process.env.CHAMP_BRIDGE_TOKEN = process.env.CHAMP_BRIDGE_TOKEN || 'bbr_test'
process.env.CHAMP_API_URL = process.env.CHAMP_API_URL || 'http://localhost:3000'

const { mapHomeyDevices, mapHomeyStates } = await import('./homey.js')

// Realistic slice of Homey's object-map response.
const homeyRaw = {
  'abc-1': {
    id: 'abc-1', name: 'Front TVs', class: 'socket', available: true,
    driverId: 'homey:app:com.tplink.tapo:plug',
    capabilities: ['onoff', 'measure_power'],
    capabilitiesObj: { onoff: { value: true } },
  },
  'abc-2': {
    id: 'abc-2', name: 'Bathroom light', class: 'light', available: false,
    driverId: 'homey:app:com.tplink.tapo:switch',
    capabilities: ['onoff'],
    capabilitiesObj: { onoff: { value: false } },
  },
  'abc-3': { // no onoff — must be invisible to the bridge
    id: 'abc-3', name: 'Motion sensor', class: 'sensor', available: true,
    capabilities: ['alarm_motion'], capabilitiesObj: { alarm_motion: { value: false } },
  },
}

describe('mapHomeyDevices', () => {
  it('filters to onoff devices, prefixes ids, maps socket→plug else switch', () => {
    expect(mapHomeyDevices(homeyRaw)).toEqual([
      { id: 'homey:abc-1', kind: 'plug', name_hint: 'Front TVs' },
      { id: 'homey:abc-2', kind: 'switch', name_hint: 'Bathroom light' },
    ])
  })
  it('tolerates arrays, null, junk entries', () => {
    expect(mapHomeyDevices(Object.values(homeyRaw))).toHaveLength(2)
    expect(mapHomeyDevices(null)).toEqual([])
    expect(mapHomeyDevices({ x: null, y: 42, z: { name: 'no id' } })).toEqual([])
  })
})

describe('mapHomeyStates', () => {
  it('maps onoff value to on/off and available to reachable', () => {
    expect(mapHomeyStates(homeyRaw)).toEqual([
      { id: 'homey:abc-1', state: 'on', reachable: true },
      { id: 'homey:abc-2', state: null, reachable: false }, // unavailable → state unknown
    ])
  })
  it('non-boolean onoff value → state null (never guess)', () => {
    const raw = { a: { id: 'a', class: 'socket', available: true, capabilities: ['onoff'], capabilitiesObj: { onoff: { value: null } } } }
    expect(mapHomeyStates(raw)).toEqual([{ id: 'homey:a', state: null, reachable: true }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/homey.test.js`
Expected: FAIL — `Cannot find module './homey.js'`

- [ ] **Step 3: Write the mappers**

```js
// homey.js — Homey Pro local-API actuation for the tapo reconcile cycle.
//
// Replaces the python-kasa sidecar (deleted; see spec 2026-08-01). The
// Homey Pro owns every vendor protocol; we speak only its local REST API:
//   GET /api/manager/devices/device                      (all devices + live values)
//   PUT /api/manager/devices/device/{id}/capability/onoff {"value": bool}
// Auth: Authorization: Bearer <scoped API key>, LAN only.
//
// Scope: every device exposing an `onoff` capability (Richard, 2026-08-01)
// — the CRM adopt flow auto-registers them disabled. IDs are namespaced
// `homey:<device-id>` (house convention: ant:/ble:/mac:/hub:).

const HOMEY_PREFIX = 'homey:'

function homeyDeviceList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw)
  return []
}

const hasOnoff = (d) =>
  Array.isArray(d?.capabilities) ? d.capabilities.includes('onoff') : !!d?.capabilitiesObj?.onoff

const controllable = (raw) =>
  homeyDeviceList(raw).filter((d) => d && typeof d.id === 'string' && d.id && hasOnoff(d))

// → [{ id, kind, name_hint? }] for buildStateReport metadata + adopt.
export function mapHomeyDevices(raw) {
  return controllable(raw).map((d) => {
    const row = { id: HOMEY_PREFIX + d.id, kind: d.class === 'socket' ? 'plug' : 'switch' }
    if (d.name) row.name_hint = String(d.name)
    return row
  })
}

// → [{ id, state: 'on'|'off'|null, reachable }]. Unavailable → state null
// (unknown, never guessed) + reachable false, so diffCommands skips it.
export function mapHomeyStates(raw) {
  return controllable(raw).map((d) => {
    const reachable = d.available !== false
    const v = d.capabilitiesObj?.onoff?.value
    const state = !reachable ? null : v === true ? 'on' : v === false ? 'off' : null
    return { id: HOMEY_PREFIX + d.id, state, reachable }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/homey.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/homey.js src/homey.test.js
git commit -m "HOMEY.1 — pure Homey→bridge shape mappers (onoff filter, homey: ids, socket→plug)"
```

---

### Task 2: `createHomeyActuation` — shared snapshot + command

**Files:**
- Modify: `src/homey.js` (append)
- Test: `src/homey.test.js` (append)

The cycle calls its two read deps via `Promise.all`; a naive adapter would GET the (chunky) full device list twice per tick. `createHomeyActuation` dedupes: both reads share one in-flight request, cleared on settle so the next tick refetches. `requestJson` is injected for tests; Task 3 supplies the real undici one. Result contract is the sidecar's `{ok, statusCode, body}` — a failed GET passes through unchanged so `runTapoCycle`'s existing `sidecarDown` handling fires.

- [ ] **Step 1: Write the failing tests (append to `src/homey.test.js`)**

```js
const { createHomeyActuation } = await import('./homey.js')

describe('createHomeyActuation', () => {
  const cfg = { address: 'http://192.168.1.50', apiKey: 'key-1' }

  it('shares ONE GET between concurrent device+state reads, refetches next tick', async () => {
    const requestJson = vi.fn(async () => ({ ok: true, statusCode: 200, body: homeyRaw }))
    const a = createHomeyActuation({ ...cfg, requestJson })
    const [dev, st] = await Promise.all([a.getDevices(), a.getState()])
    expect(requestJson).toHaveBeenCalledTimes(1)
    expect(requestJson).toHaveBeenCalledWith('GET', 'http://192.168.1.50/api/manager/devices/device', 'key-1', undefined)
    expect(dev.body.devices).toHaveLength(2)
    expect(st.body.devices[0]).toEqual({ id: 'homey:abc-1', state: 'on', reachable: true })
    await a.getState() // after settle → fresh fetch
    expect(requestJson).toHaveBeenCalledTimes(2)
  })

  it('passes a failed GET through untouched (drives sidecarDown path)', async () => {
    const fail = { ok: false, statusCode: 0, networkError: true }
    const a = createHomeyActuation({ ...cfg, requestJson: vi.fn(async () => fail) })
    expect(await a.getState()).toBe(fail)
  })

  it('setPower strips the homey: prefix and PUTs the onoff capability', async () => {
    const requestJson = vi.fn(async () => ({ ok: true, statusCode: 200, body: {} }))
    const a = createHomeyActuation({ ...cfg, requestJson })
    await a.setPower('homey:abc-1', true)
    expect(requestJson).toHaveBeenCalledWith(
      'PUT', 'http://192.168.1.50/api/manager/devices/device/abc-1/capability/onoff', 'key-1', { value: true },
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/homey.test.js`
Expected: FAIL — `createHomeyActuation` not exported

- [ ] **Step 3: Implement (append to `src/homey.js`)**

```js
// Actuation deps for runTapoCycle. One GET per tick: concurrent reads share
// the in-flight request (cleared on settle → next tick refetches).
export function createHomeyActuation({ address, apiKey, requestJson }) {
  let inflight = null
  const snapshot = () => {
    if (!inflight) {
      inflight = requestJson('GET', `${address}/api/manager/devices/device`, apiKey, undefined)
        .finally(() => { inflight = null })
    }
    return inflight
  }
  const read = (mapper) => async () => {
    const r = await snapshot()
    if (!r.ok) return r
    return { ok: true, statusCode: r.statusCode, body: { devices: mapper(r.body) } }
  }
  return {
    getDevices: read(mapHomeyDevices),
    getState: read(mapHomeyStates),
    setPower: (id, on) => {
      const realId = id.startsWith(HOMEY_PREFIX) ? id.slice(HOMEY_PREFIX.length) : id
      return requestJson(
        'PUT',
        `${address}/api/manager/devices/device/${encodeURIComponent(realId)}/capability/onoff`,
        apiKey,
        { value: on },
      )
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/homey.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/homey.js src/homey.test.js
git commit -m "HOMEY.2 — createHomeyActuation: shared per-tick snapshot + onoff command"
```

---

### Task 3: Real undici `requestJson` + config vars

**Files:**
- Modify: `src/homey.js` (append)
- Modify: `src/config.js`
- Test: `src/config.test.js` (append)

- [ ] **Step 1: Append the real HTTP helper to `src/homey.js`** (thin I/O wrapper, mirrors the old `sidecarJson`; exercised on hardware, not unit-tested — house pattern)

```js
import { request } from 'undici'

// Real HTTP dep (index-side wiring passes this in). Never throws.
export async function homeyRequestJson(method, url, apiKey, body) {
  try {
    const r = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headersTimeout: 5000,
      bodyTimeout: 5000,
    })
    const text = await r.body.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
    return { ok: r.statusCode >= 200 && r.statusCode < 300, statusCode: r.statusCode, body: parsed }
  } catch (err) {
    return { ok: false, statusCode: 0, networkError: true, err }
  }
}
```

(`import { request } from 'undici'` goes at the top of `src/homey.js`.)

- [ ] **Step 2: Write the failing config test (append to `src/config.test.js`, matching its existing pure-helper style)**

```js
const { homeyConfigError } = await import('./config.js')

describe('homeyConfigError', () => {
  it('is null when tapo control is disabled, whatever else is set', () => {
    expect(homeyConfigError({})).toBe(null)
    expect(homeyConfigError({ HOMEY_ADDRESS: 'nonsense' })).toBe(null)
  })
  it('requires both HOMEY vars when TAPO_ENABLED=1', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1' })).toMatch(/HOMEY_ADDRESS/)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50' })).toMatch(/HOMEY_API_KEY/)
  })
  it('rejects a non-http(s) or unparseable address', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: '192.168.1.50', HOMEY_API_KEY: 'k' })).toMatch(/valid URL/)
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'ftp://x', HOMEY_API_KEY: 'k' })).toMatch(/http/)
  })
  it('accepts a good pair', () => {
    expect(homeyConfigError({ TAPO_ENABLED: '1', HOMEY_ADDRESS: 'http://192.168.1.50', HOMEY_API_KEY: 'k' })).toBe(null)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/config.test.js`
Expected: FAIL — `homeyConfigError` not exported

- [ ] **Step 4: Update `src/config.js`**

Replace the Tapo comment block (lines 37–43) with:

```
// Tapo/device control (optional — only runs when TAPO_ENABLED=1). The bridge
// polls the CRM for device directives, reads actuals from the Homey Pro's
// local REST API, applies diffs, and reports state back. The Homey API key
// stays on the Pi (InBody-key posture).
//   TAPO_ENABLED=1         turn the reconcile loop on (default: off)
//   HOMEY_ADDRESS          http://<LAN IP of the Homey Pro> (DHCP-reserve it)
//   HOMEY_API_KEY          scoped API key (Homey web app → Settings → API Keys)
//   TAPO_POLL_MS=15000     how often to reconcile directives vs actuals
```

Add the validated pure helper (next to `tokenLooksValid`):

```js
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
```

Call it after the token warning (same exit-fast pattern as the missing-env check):

```js
const homeyErr = homeyConfigError(process.env)
if (homeyErr) {
  // eslint-disable-next-line no-console
  console.error(`[champ-bridge] ${homeyErr}`)
  process.exit(1)
}
```

In the `config` object, replace the `tapoSidecarUrl` line with:

```js
  homeyAddress: (process.env.HOMEY_ADDRESS || '').replace(/\/+$/, '') || null,
  homeyApiKey: process.env.HOMEY_API_KEY || null,
```

(`tapoEnabled` and `tapoPollMs` stay exactly as they are.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/config.test.js src/homey.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/homey.js src/config.js src/config.test.js
git commit -m "HOMEY.3 — undici requestJson + HOMEY_ADDRESS/HOMEY_API_KEY config (fail-fast when enabled)"
```

---

### Task 4: Wire the cycle to Homey; drop the sidecar client

**Files:**
- Modify: `src/tapo.js` (header comment + the entire `real deps` section, lines 111–141)
- Modify: `src/index.js:153` (log line)

- [ ] **Step 1: Replace the real-deps section of `src/tapo.js`**

Delete everything from `// ——— real deps (index.js) ———` down (the `sidecarJson` helper and current `realTapoDeps`), replace with:

```js
// ——— real deps (index.js) ———

import { getTapoDirectives, postTapoState } from './api.js'
import { createHomeyActuation, homeyRequestJson } from './homey.js'

const homey = createHomeyActuation({
  address: config.homeyAddress,
  apiKey: config.homeyApiKey,
  requestJson: homeyRequestJson,
})

// Dep slot names keep the sidecar-era contract (accepted debt, spec
// 2026-08-01) — the cycle and its tests are backend-agnostic.
export const realTapoDeps = {
  getDirectives: getTapoDirectives,
  getSidecarDevices: homey.getDevices,
  getSidecarState: homey.getState,
  setSidecarPower: homey.setPower,
  postState: postTapoState,
  now: () => Date.now(),
}
```

Also drop the now-unused `import { request } from 'undici'` from tapo.js, and update the file header comment: step 2's "Read actuals from the sidecar (localhost)" becomes "Read actuals from the Homey Pro (LAN, local REST)"; step 3's "POST /device/{id}/state to the sidecar" becomes "PUT capability/onoff on Homey"; keep the staleness-is-the-signal wording.

- [ ] **Step 2: Update the enable log in `src/index.js:153`**

```js
    logInfo('tapo', 'tapo reconcile enabled', { homey: config.homeyAddress, pollMs: config.tapoPollMs })
```

(Also update the loop comment above it: "reads actuals from the Homey Pro's local API" instead of the sidecar sentence.)

- [ ] **Step 3: Run the FULL suite (cycle tests must stay green untouched)**

Run: `npm test`
Expected: PASS — zero changes to `tapo.test.js`/`tapo-logic.test.js` is the proof the contract held

- [ ] **Step 4: Commit**

```bash
git add src/tapo.js src/index.js
git commit -m "HOMEY.4 — point realTapoDeps at Homey actuation; sidecar client removed"
```

---

### Task 5: Delete the sidecar; rewrite the README section

**Files:**
- Delete: `sidecar/` (entire directory), `deploy/champ-tapo-sidecar.service`
- Modify: `README.md` (the "Tapo device control (optional)" section, lines ~134–201)

- [ ] **Step 1: Delete**

```bash
git rm -r sidecar deploy/champ-tapo-sidecar.service
```

- [ ] **Step 2: Replace the README section** with:

```markdown
## Device control via Homey Pro (optional)

The bridge can drive any on/off device paired to the studio's **Homey
Pro** (today: the Tapo plugs/switches) on CRM-computed schedules with
manual override from `/automations/devices`. Homey owns every vendor
protocol; the bridge speaks only Homey's local REST API. Off unless
`TAPO_ENABLED=1`. Design: `docs/superpowers/specs/2026-08-01-homey-actuation-design.md`.

1. **DHCP-reserve the Homey Pro's IP** on the gym router.
2. **Create a scoped API key**: Homey web app → Settings → API Keys →
   New API Key, device read + control permissions only. Shown once.
3. **Add to `/home/pi/champ-bridge/.env`** (same posture as the InBody
   key — it never leaves the Pi):

   ```
   TAPO_ENABLED=1
   HOMEY_ADDRESS=http://192.168.1.50
   HOMEY_API_KEY=xxxxxxxx
   # TAPO_POLL_MS=15000
   ```

4. `sudo systemctl restart champ-bridge` then
   `sudo journalctl -u champ-bridge -f` — expect
   `tapo reconcile enabled` with the Homey address.
5. In the CRM, `/automations/devices` fills with every switchable
   Homey device (auto-registered **disabled**); enable + schedule the
   ones you want.

Keep Tapo firmware auto-update **OFF** in the Tapo app until Homey's
Tapo integration confirms support for a new firmware — TP-Link's
protocol changes now break Homey's link, not ours, but a broken link
still means unreachable devices.
```

- [ ] **Step 3: Sanity-check nothing still references the sidecar**

Run: `grep -rn "sidecar\|8127\|python-kasa" src/ deploy/ README.md package.json`
Expected: only the accepted-debt dep-slot names in `src/tapo.js`/tests (`getSidecarDevices` etc.) and `sidecar_device_id` (CRM column name) — no URLs, paths, or install steps

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "HOMEY.5 — delete python-kasa sidecar + unit; README: Homey Pro setup"
```

---

### Task 6: Final verification + PR

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint`
Expected: both green

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/homey-actuation
gh pr create --base main --title "Homey Pro actuation layer (replaces python-kasa sidecar)" --body "$(cat <<'EOF'
Swaps the Tapo actuation backend to the Homey Pro local REST API per
docs/superpowers/specs/2026-08-01-homey-actuation-design.md.

- New src/homey.js: pure mappers (onoff filter, homey:<id> namespace,
  socket→plug) + createHomeyActuation (one shared GET per tick, PUT
  capability/onoff commands, sidecar result contract preserved).
- realTapoDeps now Homey-backed; runTapoCycle/tapo-logic and their
  tests untouched — the backend-agnostic contract held.
- Config: HOMEY_ADDRESS + HOMEY_API_KEY (fail-fast when TAPO_ENABLED=1),
  TAPO_SIDECAR_URL gone.
- sidecar/ + champ-tapo-sidecar.service deleted; README rewritten.
- CRM untouched; tapo_devices verified empty in prod → no ID migration.

Exit gate (on-site): scoped API key, DHCP reservation, TAPO_ENABLED=1;
one plug follows a schedule + a CRM toggle round-trips; adopt flow
lists the studio's devices.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL**
