"""
Ampel-Controller – Devantech 8-Kanal Ethernet Relais Modul.

Protokoll: HTTP GET mit Basic Auth (Port 80)
  GET /status.xml          → aktuellen Zustand lesen
                             <relay0>0</relay0> ... <relay7>1</relay7>  (0-basiert)
  GET /io.cgi?relay=X      → Relais X (0-basiert) toggeln

  Steuerung: Status lesen → nur toggeln wenn Soll ≠ Ist

Konfiguration in config.json:
  ampel_ip           – IP-Adresse (z.B. "192.168.178.128")
  ampel_port         – HTTP-Port  (Standard: 80)
  ampel_username     – Benutzername (Standard: "admin")
  ampel_password     – Passwort
  ampel_enabled      – bool, ob Befehle automatisch gesendet werden
  ampel_relay_red    – Relais-Nr. ROT   (Web-UI 1–8, Standard: 4)
  ampel_relay_green  – Relais-Nr. GRÜN  (Web-UI 1–8, Standard: 6)

Ablauf-Sequenz (config.json):
  ampel_seq_training_arm      – Zustand beim Scharf schalten (Training)
  ampel_seq_training_start    – Zustand beim ersten Passing (Training)
  ampel_seq_training_finish   – Zustand wenn Zeit abgelaufen (Training)
  ampel_seq_gp_start          – Zustand wenn GP gestartet
  ampel_seq_gp_finish         – Zustand wenn GP-Führender Linie überquert
  ampel_seq_done              – Zustand nach Lauf fertig / abgebrochen
  ampel_seq_disarm            – Zustand beim Unscharf schalten
  Werte: "none" | "off" | "green" | "red"
"""
import asyncio
import re
import time
import urllib.request
import urllib.error

import config as cfg


class AmpelController:
    def __init__(self) -> None:
        self.state: str = "off"
        self.last_ok: bool | None = None
        self.last_sent: float = 0.0
        self.last_cmd: str = ""
        self.last_err: str = ""

    # ── Public ────────────────────────────────────────────────────────────────

    async def send(self, new_state: str, force: bool = False) -> bool:
        """
        Setzt Ampel-Zustand und sendet HTTP-Befehle.
        force=True  → sendet immer (Debug-Test)
        force=False → nur wenn ampel_enabled=True
        """
        from ws_hub import hub

        self.state = new_state
        c = cfg.get()
        enabled = bool(c.get("ampel_enabled", False))

        ok: bool | None = None
        if enabled or force:
            ip   = c.get("ampel_ip", "192.168.178.128")
            port = int(c.get("ampel_port", 80))
            if ip:
                ok = await self._send_http(new_state, ip, port, c)

        self.last_ok   = ok
        self.last_sent = time.time()

        await hub.broadcast({
            "type":     "ampel_state",
            "state":    self.state,
            "enabled":  enabled,
            "forced":   force,
            "ok":       ok,
            "ts":       self.last_sent,
            "last_cmd": self.last_cmd,
            "last_err": self.last_err if ok is False else "",
        })
        return ok is not False

    async def send_seq(self, seq_key: str) -> None:
        """Sendet den in config konfigurierten Zustand für ein Ereignis."""
        state = cfg.get().get(seq_key, "none")
        if state and state != "none":
            await self.send(state)

    # ── HTTP via urllib (thread executor) ────────────────────────────────────

    def _make_request(self, url: str, username: str, password: str) -> urllib.request.Request:
        """Erstellt einen urllib.Request mit Basic Auth und Connection: close."""
        import base64
        req = urllib.request.Request(url)
        creds = base64.b64encode(f"{username}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")
        # Connection: close → Box schließt Verbindung nach Antwort (kein Timeout-Warten)
        req.add_header("Connection", "close")
        return req

    async def _http_get(self, path: str, ip: str, port: int,
                         username: str, password: str) -> str | None:
        """HTTP GET via urllib – handelt alle HTTP-Versionen und Encodings korrekt."""
        url = f"http://{ip}:{port}{path}"
        req = self._make_request(url, username, password)
        loop = asyncio.get_running_loop()
        try:
            def _fetch() -> str:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.read().decode("utf-8", errors="replace")
            return await loop.run_in_executor(None, _fetch)
        except urllib.error.HTTPError as exc:
            self.last_err = f"HTTP {exc.code} {exc.reason}"
            print(f"[ampel] HTTP {path}: {exc.code} {exc.reason}")
            return None
        except Exception as exc:
            self.last_err = str(exc)
            print(f"[ampel] HTTP {path}: {exc}")
            return None

    async def _get_relay_states(self, ip: str, port: int,
                                 username: str, password: str) -> dict[int, int] | None:
        """Liest /status.xml und gibt {relay_idx: 0|1} zurück."""
        resp = await self._http_get("/status.xml", ip, port, username, password)
        if resp is None:
            return None
        states: dict[int, int] = {}
        for m in re.finditer(r"<relay(\d+)>(\d+)</relay\d+>", resp):
            states[int(m.group(1))] = int(m.group(2))
        if not states:
            self.last_err = "Kein Relay-XML in Antwort – falsche IP/Firmware?"
            print(f"[ampel] status.xml: kein relay-XML gefunden. Antwort: {resp[:300]!r}")
            return None
        return states

    async def _toggle(self, relay_idx: int, ip: str, port: int,
                       username: str, password: str) -> bool:
        """Toggelt ein einzelnes Relais (io.cgi?relay=X)."""
        resp = await self._http_get(f"/io.cgi?relay={relay_idx}",
                                     ip, port, username, password)
        # urllib wirft bei 4xx/5xx eine Exception → resp ist None bei Fehler
        return resp is not None

    async def _send_http(self, state: str, ip: str, port: int,
                          c: dict) -> bool:
        """
        Status lesen → für jedes betroffene Relais:
        nur toggeln wenn aktueller Zustand ≠ gewünschter Zustand.
        """
        # Web-UI Nummer (1-basiert) → 0-basierter Index
        relay_red_idx   = max(0, min(7, int(c.get("ampel_relay_red",   4)) - 1))
        relay_green_idx = max(0, min(7, int(c.get("ampel_relay_green", 6)) - 1))

        if state == "off":
            want = {relay_red_idx: 0, relay_green_idx: 0}
        elif state == "red":
            want = {relay_red_idx: 1, relay_green_idx: 0}
        elif state == "green":
            want = {relay_red_idx: 0, relay_green_idx: 1}
        else:
            return False

        cmd_parts = [f"relay={k}→{'ON' if v else 'OFF'}" for k, v in want.items()]
        self.last_cmd = f"{state}: " + ", ".join(cmd_parts)

        username = c.get("ampel_username", "admin")
        password = c.get("ampel_password", "")

        # Aktuellen Status lesen
        current = await self._get_relay_states(ip, port, username, password)
        if current is None:
            print(f"[ampel] ✗ status.xml nicht lesbar")
            return False

        # Nur toggeln wenn nötig
        ok = True
        for relay_idx, desired in want.items():
            if current.get(relay_idx, 0) != desired:
                toggled = await self._toggle(relay_idx, ip, port, username, password)
                if not toggled:
                    ok = False
                    print(f"[ampel] ✗ toggle relay={relay_idx} fehlgeschlagen")
                else:
                    print(f"[ampel] ✓ relay={relay_idx} → {'ON' if desired else 'OFF'}")

        if ok:
            print(f"[ampel] ✓ {state}  ({self.last_cmd})")
        return ok

    # ── Status ────────────────────────────────────────────────────────────────

    def status_dict(self) -> dict:
        c = cfg.get()
        return {
            "state":       self.state,
            "enabled":     bool(c.get("ampel_enabled", False)),
            "ok":          self.last_ok,
            "ts":          self.last_sent,
            "last_cmd":    self.last_cmd,
            "last_err":    self.last_err,
            "relay_red":   int(c.get("ampel_relay_red",   4)),
            "relay_green": int(c.get("ampel_relay_green", 6)),
        }


ampel = AmpelController()
