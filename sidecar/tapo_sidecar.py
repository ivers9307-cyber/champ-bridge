"""tapo-sidecar — localhost-only HTTP facade over python-kasa.

The champ-bridge Node service is the ONLY caller (127.0.0.1). This
process owns the Tapo cloud credentials (needed for the LOCAL KLAP
handshake — they never leave the Pi) and all device addressing.

Endpoints:
  GET  /devices              → {"devices": [{id, kind, model, name_hint, host}]}
  GET  /state                → {"devices": [{id, state: "on"|"off"|null, reachable}]}
  POST /device/{id}/state    body {"on": true|false} → {"ok": true} | 404 | 502

Env:
  TAPO_USERNAME / TAPO_PASSWORD   Tapo business-account creds (required)
  TAPO_HOSTS                      comma-separated IPs of plugs + hub(s)
                                  (DHCP reservations strongly recommended;
                                  discovery broadcast is a fallback only)
  TAPO_SIDECAR_PORT               default 8127
  TAPO_REFRESH_S                  device poll interval, default 10

Design: a background loop refreshes a registry {sidecar_id -> entry}
every TAPO_REFRESH_S. HTTP handlers read the registry (never touch the
network for GETs) so /state is instant and a wedged device can't stall
the bridge. POST /device/{id}/state commands the device directly and
refreshes that entry.
"""
import asyncio
import os
import sys
import time

from aiohttp import web
from kasa import Device, DeviceConfig, Discover, DeviceType
from kasa.credentials import Credentials

from tapo_ids import plug_id, hub_child_id, serialize_device, serialize_state

USERNAME = os.environ.get("TAPO_USERNAME")
PASSWORD = os.environ.get("TAPO_PASSWORD")
HOSTS = [h.strip() for h in os.environ.get("TAPO_HOSTS", "").split(",") if h.strip()]
PORT = int(os.environ.get("TAPO_SIDECAR_PORT", "8127"))
REFRESH_S = int(os.environ.get("TAPO_REFRESH_S", "10"))

if not USERNAME or not PASSWORD:
    print("tapo-sidecar: TAPO_USERNAME and TAPO_PASSWORD are required", file=sys.stderr)
    sys.exit(1)

CREDS = Credentials(USERNAME, PASSWORD)


def log(msg, **meta):
    print(f"tapo-sidecar: {msg} {meta if meta else ''}".strip(), flush=True)


class Registry:
    """sidecar_id -> {device, parent, kind, model, alias, host, is_on, reachable, seen_at}

    Concurrency: a POST command can run while the refresh loop is mid-pass.
    That's safe because python-kasa serialises all traffic to one device
    behind SmartProtocol._query_lock (one lock per Device; hub children
    share the parent's protocol via _ChildProtocolWrapper) — verified in
    python-kasa 0.10.2. If an upgrade moves or removes that locking,
    re-check this invariant before bumping requirements.txt.

    Lifecycle: entries are never purged. A device removed from TAPO_HOSTS
    (or that stops answering discovery) stays as a permanently-unreachable
    entry — intentional: it mirrors the CRM's disable-off-ramp (the row
    goes stale there and the operator disables it). Bounded at studio
    scale (tens of devices); not a leak.
    """

    def __init__(self):
        self.entries = {}
        self._roots = {}  # host -> connected kasa Device (plugs and hubs)

    async def _connect(self, host):
        dev = self._roots.get(host)
        if dev is None:
            dev = await Device.connect(config=DeviceConfig(host=host, credentials=CREDS))
            self._roots[host] = dev
        return dev

    def _upsert(self, sid, *, device, parent, kind, model, alias, host, is_on):
        self.entries[sid] = {
            "device": device, "parent": parent, "kind": kind, "model": model,
            "alias": alias, "host": host, "is_on": is_on, "reachable": True,
            "seen_at": time.time(),
        }

    def _mark_unreachable(self, host):
        for e in self.entries.values():
            if e["host"] == host:
                e["reachable"] = False
                e["is_on"] = None

    async def refresh(self):
        hosts = list(HOSTS)
        if not hosts:  # fallback: LAN broadcast discovery
            try:
                found = await Discover.discover(credentials=CREDS, discovery_timeout=5)
                hosts = list(found.keys())
            except Exception as e:
                log("discovery failed", err=str(e))
                return
        for host in hosts:
            try:
                dev = await self._connect(host)
                # Ceiling per host: python-kasa's default retry stack
                # (retry_count=3 × 5s HTTP timeout + backoffs) can cost
                # ~23s on a dead host, stalling this sequential pass and
                # letting staleness pile up on every other device. The
                # TimeoutError lands in the except below (pop root +
                # mark unreachable), which is exactly right.
                await asyncio.wait_for(dev.update(), timeout=5)
                if dev.device_type == DeviceType.Hub:
                    for child in (dev.children or []):
                        sid = hub_child_id(child.device_id)
                        self._upsert(sid, device=child, parent=dev, kind="switch",
                                     model=child.model, alias=child.alias,
                                     host=host, is_on=child.is_on)
                    # a hub with zero adopted children registers nothing —
                    # correct: there is no togglable entity yet.
                else:  # a plug
                    sid = plug_id(dev.mac)
                    self._upsert(sid, device=dev, parent=None, kind="plug",
                                 model=dev.model, alias=dev.alias,
                                 host=host, is_on=dev.is_on)
            except Exception as e:
                log("refresh failed for host", host=host, err=str(e))
                self._roots.pop(host, None)  # force reconnect next pass
                self._mark_unreachable(host)


REG = Registry()


async def refresh_loop():
    while True:
        try:
            await REG.refresh()
        except Exception as e:  # belt and braces — the loop must never die
            log("refresh loop error", err=str(e))
        await asyncio.sleep(REFRESH_S)


async def handle_devices(request):
    out = [serialize_device(sid, kind=e["kind"], model=e["model"],
                            alias=e["alias"], host=e["host"])
           for sid, e in REG.entries.items()]
    return web.json_response({"devices": out})


async def handle_state(request):
    out = [serialize_state(sid, e["is_on"], e["reachable"])
           for sid, e in REG.entries.items()]
    return web.json_response({"devices": out})


async def handle_set_state(request):
    sid = request.match_info["id"]
    entry = REG.entries.get(sid)
    if entry is None:
        return web.json_response({"ok": False, "error": "unknown device"}, status=404)
    try:
        body = await request.json()
        want_on = bool(body.get("on"))
        dev = entry["device"]
        # Hub children command through their own object; python-kasa routes
        # via the parent transport internally.
        # 4s ceiling: the Node bridge gives this call a 5s HTTP budget —
        # our 502 must beat its hangup, or the bridge sees a socket error
        # while an orphaned coroutine runs the command to completion.
        if want_on:
            await asyncio.wait_for(dev.turn_on(), timeout=4)
        else:
            await asyncio.wait_for(dev.turn_off(), timeout=4)
        entry["is_on"] = want_on
        entry["reachable"] = True
        entry["seen_at"] = time.time()
        return web.json_response({"ok": True})
    except Exception as e:
        entry["reachable"] = False
        entry["is_on"] = None
        log("command failed", id=sid, err=str(e))
        return web.json_response({"ok": False, "error": str(e)}, status=502)


async def main():
    app = web.Application()
    app.router.add_get("/devices", handle_devices)
    app.router.add_get("/state", handle_state)
    app.router.add_post("/device/{id}/state", handle_set_state)
    runner = web.AppRunner(app)
    await runner.setup()
    # 127.0.0.1 ONLY — never expose beyond localhost.
    site = web.TCPSite(runner, "127.0.0.1", PORT)
    await site.start()
    log("listening", port=PORT, hosts=len(HOSTS) or "discovery")
    asyncio.create_task(refresh_loop())
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
