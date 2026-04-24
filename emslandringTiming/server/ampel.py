"""
Ampel-Controller – Devantech 8-Kanal Ethernet Relais Modul (ETH008/ETH8020).

Protokoll: TCP-Binär, Port 17494
  Befehl 0x21 + Bitmask setzt alle Relais auf einmal:
    Bit 0 = Relais 1, Bit 1 = Relais 2, ... Bit 7 = Relais 8

  AUS:  0x21 0x00          → alle Relais aus
  ROT:  0x21 <mask_rot>    → Relais N_rot an, alle anderen aus
  GRÜN: 0x21 <mask_gruen>  → Relais N_gruen an, alle anderen aus

Konfiguration in config.json:
  ampel_ip          – IP-Adresse des Moduls (z.B. "192.168.178.128")
  ampel_port        – TCP-Port (Standard: 17494)
  ampel_enabled     – bool, ob Befehle gesendet werden
  ampel_relay_red   – Relais-Nr. für ROT   (1–8, Standard: 1)
  ampel_relay_green – Relais-Nr. für GRÜN  (1–8, Standard: 2)
"""
import asyncio
import time

import config as cfg


class AmpelController:
    def __init__(self) -> None:
        self.state: str = "off"           # "off" | "green" | "red"
        self.last_ok: bool | None = None  # None = noch nie gesendet
        self.last_sent: float = 0.0

    # ── Public ────────────────────────────────────────────────────────────────

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
            port = int(c.get("ampel_port", 17494))
            if ip:
                ok = await self._send_devantech(new_state, ip, port, c)
            # else: keine IP konfiguriert → nichts senden

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

    # ── Devantech ETH Relay Protokoll ─────────────────────────────────────────

    async def _send_devantech(self, state: str, ip: str, port: int,
                               c: dict) -> bool:
        """
        Devantech ETH Relay Binärprotokoll:
          Byte 1: 0x21 = "Set all relay states"
          Byte 2: Bitmask  (Bit 0 = Relais 1, Bit 1 = Relais 2, ...)
        """
        relay_red   = max(1, min(8, int(c.get("ampel_relay_red",   1))))
        relay_green = max(1, min(8, int(c.get("ampel_relay_green", 2))))

        if state == "off":
            mask = 0x00
        elif state == "red":
            mask = 1 << (relay_red - 1)
        elif state == "green":
            mask = 1 << (relay_green - 1)
        else:
            return False

        cmd = bytes([0x21, mask])

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
            print(f"[ampel] ✓ {state} → {ip}:{port}  mask=0x{mask:02X}")
            return True
        except Exception as exc:
            print(f"[ampel] ✗ {state} → {ip}:{port}: {exc}")
            return False

    # ── Status ────────────────────────────────────────────────────────────────

    def status_dict(self) -> dict:
        c = cfg.get()
        return {
            "state":        self.state,
            "enabled":      bool(c.get("ampel_enabled", False)),
            "ok":           self.last_ok,
            "ts":           self.last_sent,
            "relay_red":    int(c.get("ampel_relay_red",   1)),
            "relay_green":  int(c.get("ampel_relay_green", 2)),
        }


ampel = AmpelController()
