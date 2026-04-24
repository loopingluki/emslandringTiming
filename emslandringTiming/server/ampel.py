"""
Ampel-Controller – sendet Befehle an die IP-Ampel über TCP.

Protokoll TBD; die Rohtext-Befehle sind in config.json konfigurierbar.
"""
import asyncio
import time

import config as cfg


class AmpelController:
    def __init__(self) -> None:
        self.state: str = "off"           # "off" | "green" | "red"
        self.last_ok: bool | None = None  # None = noch nie gesendet
        self.last_sent: float = 0.0

    async def send(self, new_state: str) -> bool:
        """
        Setzt den Ampel-Zustand und sendet den Befehl (falls aktiviert).
        Broadcastet immer den neuen Zustand per WebSocket (für Debug-Panel).
        """
        from ws_hub import hub  # lokaler Import, vermeide Kreisimport

        self.state = new_state
        c = cfg.get()
        enabled = bool(c.get("ampel_enabled", False))

        ok: bool | None = None
        if enabled:
            ip   = c.get("ampel_ip", "")
            port = int(c.get("ampel_port", 80))
            if ip:
                ok = await self._tcp_send(new_state, ip, port, c)
            # else: keine IP → nichts senden, ok bleibt None

        self.last_ok   = ok
        self.last_sent = time.time()

        await hub.broadcast({
            "type":    "ampel_state",
            "state":   self.state,
            "enabled": enabled,
            "ok":      ok,
            "ts":      self.last_sent,
        })
        return ok is not False

    async def _tcp_send(self, state: str, ip: str, port: int, c: dict) -> bool:
        cmd_map = {
            "off":   c.get("ampel_cmd_off",   "OFF\r\n"),
            "green": c.get("ampel_cmd_green", "GREEN\r\n"),
            "red":   c.get("ampel_cmd_red",   "RED\r\n"),
        }
        raw = cmd_map.get(state, "")
        if not raw:
            return False
        cmd = raw.replace("\\r", "\r").replace("\\n", "\n").encode("latin-1")
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=3.0
            )
            writer.write(cmd)
            await writer.drain()
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            print(f"[ampel] ✓ {state} → {ip}:{port}")
            return True
        except Exception as exc:
            print(f"[ampel] ✗ {state} → {ip}:{port}: {exc}")
            return False

    def status_dict(self) -> dict:
        c = cfg.get()
        return {
            "state":   self.state,
            "enabled": bool(c.get("ampel_enabled", False)),
            "ok":      self.last_ok,
            "ts":      self.last_sent,
        }


ampel = AmpelController()
