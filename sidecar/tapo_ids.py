"""Pure helpers: stable device ids + wire serialisation.

sidecar_device_id is self-describing (mirrors champ-bridge's device_key
idiom): 'mac:<MAC>' for direct plugs, 'hub:<child_device_id>' for hub
children. The CRM stores these verbatim — never change the format once
devices are adopted.
"""
import re

_MAC = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
NAME_HINT_MAX = 120  # CRM Zod cap on name_hint


def plug_id(mac: str) -> str:
    if not mac or not _MAC.match(mac):
        raise ValueError(f"invalid MAC: {mac!r}")
    return "mac:" + mac.upper().replace("-", ":")


def hub_child_id(child_device_id: str) -> str:
    if not child_device_id:
        raise ValueError("empty hub child device_id")
    return "hub:" + child_device_id


def serialize_device(dev_id: str, kind: str, model: str, alias, host) -> dict:
    return {
        "id": dev_id,
        "kind": kind,  # 'plug' | 'switch'
        "model": model,
        "name_hint": (alias or None) and str(alias)[:NAME_HINT_MAX],
        "host": host,
    }


def serialize_state(dev_id: str, is_on, reachable: bool) -> dict:
    # is_on: True/False/None (None = unknown, e.g. unreachable)
    state = None if is_on is None else ("on" if is_on else "off")
    return {"id": dev_id, "state": state, "reachable": bool(reachable)}
