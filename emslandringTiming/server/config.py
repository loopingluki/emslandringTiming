import json
from pathlib import Path

CONFIG_PATH = Path(__file__).parent.parent / "config.json"

_DEFAULTS: dict = {
    "decoder_ip": "192.168.178.193",
    "decoder_port": 5403,
    "http_port": 8080,
    "websocket_port": 8765,
    "emulator_port": 50000,
    "runs_per_day": 10,
    "training_duration_sec": 420,
    "gp_time_duration_sec": 720,
    "gp_laps_count": 15,
    "wait_time_sec": 60,
    "wait_time_gp_sec": 120,
    "firebase_credentials": "",
    "printer": "default",
    "ampel_ip":          "",
    "ampel_port":        80,
    "ampel_enabled":     False,
    "ampel_cmd_off":     "OFF\r\n",
    "ampel_cmd_green":   "GREEN\r\n",
    "ampel_cmd_red":     "RED\r\n",
    "emulator_enabled":  True,
    "classes": [
        {"name": "Minikart",  "color": "#f9a800"},
        {"name": "Leihkart",  "color": "#1565c0"},
        {"name": "Rennkart",  "color": "#c62828"},
        {"name": "Superkart", "color": "#757575"},
    ],
    "transponders": {
        "8534580":  {"kart_nr": 1,  "name": "Kart 1",  "class": "Minikart"},
        "7203974":  {"kart_nr": 2,  "name": "Kart 2",  "class": "Minikart"},
        "7985608":  {"kart_nr": 3,  "name": "Kart 3",  "class": "Minikart"},
        "6178323":  {"kart_nr": 4,  "name": "Kart 4",  "class": "Minikart"},
        "7775264":  {"kart_nr": 5,  "name": "Kart 5",  "class": "Minikart"},
        "7645613":  {"kart_nr": 6,  "name": "Kart 6",  "class": "Minikart"},
        "8122251":  {"kart_nr": 7,  "name": "Kart 7",  "class": "Minikart"},
        "8474848":  {"kart_nr": 8,  "name": "Kart 8",  "class": "Minikart"},
        "8461873":  {"kart_nr": 9,  "name": "Kart 9",  "class": "Minikart"},
        "13906348": {"kart_nr": 10, "name": "Kart 10", "class": "Leihkart"},
        "8306992":  {"kart_nr": 11, "name": "Kart 11", "class": "Leihkart"},
        "8457309":  {"kart_nr": 12, "name": "Kart 12", "class": "Leihkart"},
        "7989563":  {"kart_nr": 13, "name": "Kart 13", "class": "Leihkart"},
        "7685531":  {"kart_nr": 14, "name": "Kart 14", "class": "Leihkart"},
        "10691825": {"kart_nr": 15, "name": "Kart 15", "class": "Leihkart"},
        "6620896":  {"kart_nr": 16, "name": "Kart 16", "class": "Leihkart"},
        "5125264":  {"kart_nr": 17, "name": "Kart 17", "class": "Leihkart"},
        "13795518": {"kart_nr": 18, "name": "Kart 18", "class": "Leihkart"},
        "11104835": {"kart_nr": 19, "name": "Kart 19", "class": "Leihkart"},
        "8201836":  {"kart_nr": 20, "name": "Kart 20", "class": "Leihkart"},
        "8577408":  {"kart_nr": 21, "name": "Kart 21", "class": "Leihkart"},
        "7719945":  {"kart_nr": 22, "name": "Kart 22", "class": "Leihkart"},
        "8317232":  {"kart_nr": 23, "name": "Kart 23", "class": "Leihkart"},
        "8559971":  {"kart_nr": 24, "name": "Kart 24", "class": "Leihkart"},
        "6670633":  {"kart_nr": 25, "name": "Kart 25", "class": "Leihkart"},
        "7784193":  {"kart_nr": 26, "name": "Kart 26", "class": "Leihkart"},
        "7724841":  {"kart_nr": 27, "name": "Kart 27", "class": "Leihkart"},
        "6601127":  {"kart_nr": 28, "name": "Kart 28", "class": "Leihkart"},
        "8108897":  {"kart_nr": 30, "name": "Kart 30", "class": "Rennkart"},
        "8380544":  {"kart_nr": 31, "name": "Kart 31", "class": "Rennkart"},
        "7658373":  {"kart_nr": 32, "name": "Kart 32", "class": "Rennkart"},
        "8409817":  {"kart_nr": 33, "name": "Kart 33", "class": "Rennkart"},
        "8060215":  {"kart_nr": 34, "name": "Kart 34", "class": "Rennkart"},
        "8331040":  {"kart_nr": 35, "name": "Kart 35", "class": "Rennkart"},
        "8413331":  {"kart_nr": 36, "name": "Kart 36", "class": "Rennkart"},
        "8434771":  {"kart_nr": 37, "name": "Kart 37", "class": "Rennkart"},
        "7637197":  {"kart_nr": 38, "name": "Kart 38", "class": "Rennkart"},
        "10650190": {"kart_nr": 39, "name": "Kart 39", "class": "Rennkart"},
        "7560079":  {"kart_nr": 40, "name": "Kart 40", "class": "Rennkart"},
        "8465148":  {"kart_nr": 41, "name": "Kart 41", "class": "Rennkart"},
        "7215714":  {"kart_nr": 42, "name": "Kart 42", "class": "Rennkart"},
        "8286938":  {"kart_nr": 43, "name": "Kart 43", "class": "Rennkart"},
        "4830943":  {"kart_nr": 44, "name": "Kart 44", "class": "Rennkart"},
        "6621693":  {"kart_nr": 47, "name": "Kart 47", "class": "Rennkart"},
        "13821590": {"kart_nr": 48, "name": "Kart 48", "class": "Rennkart"},
        "12847817": {"kart_nr": 49, "name": "Kart 49", "class": "Rennkart"},
        "8504332":  {"kart_nr": 50, "name": "Kart 50", "class": "Superkart"},
        "11617196": {"kart_nr": 51, "name": "Kart 51", "class": "Superkart"},
        "8552547":  {"kart_nr": 52, "name": "Kart 52", "class": "Superkart"},
        "7981707":  {"kart_nr": 53, "name": "Kart 53", "class": "Superkart"},
        "10615398": {"kart_nr": 54, "name": "Kart 54", "class": "Superkart"},
        "7060162":  {"kart_nr": 58, "name": "Kart 58", "class": "Leihkart"},
        "8372997":  {"kart_nr": 59, "name": "Kart 59", "class": "Leihkart"},
        "14711183": {"kart_nr": 60, "name": "Kart 60", "class": "Leihkart"},
    },
}

_cache: dict = {}
_mtime: float = 0.0


def _ensure_file() -> None:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(
            json.dumps(_DEFAULTS, indent=2, ensure_ascii=False), encoding="utf-8"
        )


def get() -> dict:
    global _cache, _mtime
    _ensure_file()
    try:
        mtime = CONFIG_PATH.stat().st_mtime
    except OSError:
        return _cache or _DEFAULTS
    if mtime != _mtime:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        _cache = {**_DEFAULTS, **data}
        _mtime = mtime
    return _cache


def save(updates: dict) -> None:
    global _mtime
    cfg = get().copy()
    cfg.update(updates)
    CONFIG_PATH.write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _mtime = 0.0


def get_kart_info(transponder_id: int) -> dict | None:
    return get()["transponders"].get(str(transponder_id))


def get_kart_name(transponder_id: int) -> str:
    info = get_kart_info(transponder_id)
    return info["name"] if info else f"T:{transponder_id}"


def get_kart_nr(transponder_id: int) -> int | None:
    info = get_kart_info(transponder_id)
    return info["kart_nr"] if info else None
