from tapo_ids import plug_id, hub_child_id, serialize_device, serialize_state

def test_plug_id_normalises_mac():
    assert plug_id("aa-bb-cc-dd-ee-ff") == "mac:AA:BB:CC:DD:EE:FF"
    assert plug_id("AA:BB:CC:DD:EE:FF") == "mac:AA:BB:CC:DD:EE:FF"

def test_plug_id_rejects_garbage():
    import pytest
    with pytest.raises(ValueError):
        plug_id("not-a-mac")

def test_hub_child_id_verbatim():
    assert hub_child_id("8022ABC123") == "hub:8022ABC123"
    import pytest
    with pytest.raises(ValueError):
        hub_child_id("")

def test_serialize_device():
    d = serialize_device("mac:AA:BB:CC:DD:EE:FF", kind="plug", model="P110", alias="Front TVs", host="192.168.1.40")
    assert d == {"id": "mac:AA:BB:CC:DD:EE:FF", "kind": "plug", "model": "P110",
                 "name_hint": "Front TVs", "host": "192.168.1.40"}

def test_serialize_device_truncates_name_hint():
    d = serialize_device("hub:x", kind="switch", model="S220", alias="A" * 200, host=None)
    assert len(d["name_hint"]) == 120  # CRM Zod cap

def test_serialize_state():
    assert serialize_state("mac:AA:BB:CC:DD:EE:FF", True, True) == \
        {"id": "mac:AA:BB:CC:DD:EE:FF", "state": "on", "reachable": True}
    assert serialize_state("hub:x", None, False) == \
        {"id": "hub:x", "state": None, "reachable": False}
