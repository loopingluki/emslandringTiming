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
import base64
import re
import time

import config as cfg


class AmpelController:
    # Polling-Intervall in Sekunden (wie oft /status.xml abgefragt wird)
    POLL_INTERVAL        = 10.0    # normal
    POLL_INTERVAL_ERROR  = 20.0    # nach Fehler (Board entlasten)
    STATES_CACHE_MAX_AGE = 12.0    # Poll-Ergebnis so lange für Sends nutzen

    def __init__(self) -> None:
        self.state: str = "off"
        self.last_ok: bool | None = None
        self.last_sent: float = 0.0
        self.last_cmd: str = ""
        self.last_err: str = ""
        self._lock = asyncio.Lock()           # serialisiert HTTP-Requests
        self._poll_task: asyncio.Task | None = None
        self._last_states: dict[int, int] | None = None
        self._last_states_ts: float = 0.0

    # ── Public ────────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Startet das periodische Status-Polling (einmal beim App-Start)."""
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass

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

    # ── HTTP/1.0 raw asyncio ──────────────────────────────────────────────────

    async def _http_get(self, path: str, ip: str, port: int,
                         username: str, password: str,
                         attempts: int = 3) -> str | None:
        """
        HTTP-GET via curl-Subprozess (HTTP/0.9 support für Relay-Board).
        Retry bei Timeout – das Board ist manchmal kurz unerreichbar nach
        einem Toggle. Durch _lock serialisiert, damit Polling und aktive
        Sends nicht parallel aufs Board zugreifen.
        """
        async with self._lock:
            return await self._http_get_locked(path, ip, port, username, password, attempts)

    async def _http_get_locked(self, path: str, ip: str, port: int,
                                username: str, password: str,
                                attempts: int) -> str | None:
        url = f"http://{ip}:{port}{path}"
        for attempt in range(1, attempts + 1):
            print(f"[ampel] curl -> {url} (Versuch {attempt}/{attempts})")
            try:
                proc = await asyncio.create_subprocess_exec(
                    "curl",
                    "-sS",
                    "--http0.9",
                    "--max-time", "8",
                    "-u", f"{username}:{password}",
                    url,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10.0)
                out_txt = stdout.decode("utf-8", errors="replace")
                err_txt = stderr.decode("utf-8", errors="replace").strip()
                if proc.returncode == 0:
                    return out_txt
                # Retry bei Timeout (28) oder Connection refused (7)
                if proc.returncode in (7, 28) and attempt < attempts:
                    print(f"[ampel] curl exit={proc.returncode}, retry in 500ms")
                    await asyncio.sleep(0.5)
                    continue
                detail = err_txt or out_txt[:120] or "keine Ausgabe"
                self.last_err = f"curl exit={proc.returncode}: {detail}"
                print(f"[ampel] curl exit={proc.returncode} stderr={err_txt!r}")
                return None
            except asyncio.TimeoutError:
                if attempt < attempts:
                    print(f"[ampel] communicate() Timeout, retry")
                    await asyncio.sleep(0.5)
                    continue
                self.last_err = "curl-Timeout (Prozess)"
                return None
            except FileNotFoundError:
                self.last_err = "curl nicht installiert (apt install curl)"
                return None
            except Exception as exc:
                self.last_err = str(exc)
                print(f"[ampel] curl Fehler: {exc}")
                return None
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
            snippet = repr(resp[:250])
            self.last_err = f"Kein Relay-XML ({len(resp)} Bytes): {snippet}"
            print(f"[ampel] status.xml: kein relay-XML. Länge={len(resp)}, Antwort={resp[:500]!r}")
            return None
        # Cache füttern
        self._last_states    = states
        self._last_states_ts = time.time()
        return states

    async def _toggle(self, relay_idx: int, ip: str, port: int,
                       username: str, password: str) -> bool:
        """Toggelt ein einzelnes Relais (io.cgi?relay=X)."""
        resp = await self._http_get(f"/io.cgi?relay={relay_idx}",
                                     ip, port, username, password)
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

        # Aktuellen Status: Cache nutzen wenn frisch (Poll-Ergebnis), sonst frisch lesen
        now = time.time()
        if (self._last_states is not None
                and (now - self._last_states_ts) < self.STATES_CACHE_MAX_AGE):
            current = self._last_states
            print(f"[ampel] ✓ Status aus Cache (Alter {now - self._last_states_ts:.1f}s)")
        else:
            current = await self._get_relay_states(ip, port, username, password)
            if current is None:
                print(f"[ampel] ✗ status.xml nicht lesbar")
                return False

        # Nur toggeln wenn nötig – mit kleiner Pause zwischen Requests
        ok = True
        first = True
        for relay_idx, desired in want.items():
            if current.get(relay_idx, 0) != desired:
                if not first:
                    await asyncio.sleep(0.2)   # Pause zwischen Toggles
                first = False
                toggled = await self._toggle(relay_idx, ip, port, username, password)
                if not toggled:
                    ok = False
                    print(f"[ampel] ✗ toggle relay={relay_idx} fehlgeschlagen")
                else:
                    print(f"[ampel] ✓ relay={relay_idx} → {'ON' if desired else 'OFF'}")
                    # Cache aktualisieren (vermeidet Extra-Reads bei nachfolgenden Sends)
                    if self._last_states is not None:
                        self._last_states = {**self._last_states, relay_idx: desired}
                        self._last_states_ts = time.time()

        if ok:
            print(f"[ampel] ✓ {state}  ({self.last_cmd})")
        return ok

    # ── Polling ───────────────────────────────────────────────────────────────

    def _derive_state(self, states: dict[int, int], c: dict) -> str:
        """Ermittelt 'red' | 'green' | 'off' | 'both' aus Relay-Zuständen."""
        red_idx   = max(0, min(7, int(c.get("ampel_relay_red",   4)) - 1))
        green_idx = max(0, min(7, int(c.get("ampel_relay_green", 6)) - 1))
        red   = states.get(red_idx,   0) == 1
        green = states.get(green_idx, 0) == 1
        if red and green:     return "both"
        if red:               return "red"
        if green:             return "green"
        return "off"

    async def _poll_loop(self) -> None:
        """
        Fragt periodisch /status.xml ab und broadcastet Änderungen.
        So bekommen wir mit, wenn externe Programme (MyLaps, Taster am
        Modul) die Relais umschalten. Bei Fehlern längerer Backoff,
        um das Board zu entlasten.
        """
        from ws_hub import hub

        # Etwas verzögern, damit uvicorn erst startet
        await asyncio.sleep(2.0)
        while True:
            poll_ok = True
            try:
                c = cfg.get()
                ip = c.get("ampel_ip", "").strip()
                if not ip:
                    await asyncio.sleep(self.POLL_INTERVAL)
                    continue
                port     = int(c.get("ampel_port", 80))
                username = c.get("ampel_username", "admin")
                password = c.get("ampel_password", "")

                # Poll nutzt weniger aggressive Retries (1 Versuch statt 3)
                async with self._lock:
                    resp = await self._http_get_locked(
                        "/status.xml", ip, port, username, password, attempts=1)

                if resp:
                    states: dict[int, int] = {}
                    for m in re.finditer(r"<relay(\d+)>(\d+)</relay\d+>", resp):
                        states[int(m.group(1))] = int(m.group(2))
                    if states:
                        new_state = self._derive_state(states, c)
                        reachable = True
                        # Cache füttern für nachfolgende Sends
                        self._last_states    = states
                        self._last_states_ts = time.time()
                    else:
                        new_state = self.state
                        reachable = False
                        poll_ok = False
                else:
                    new_state = self.state
                    reachable = False
                    poll_ok = False

                # Nur broadcasten bei Änderung (State oder Erreichbarkeit)
                state_changed = new_state != self.state
                ok_changed = (self.last_ok is not True) if reachable else (self.last_ok is not False)
                if state_changed or ok_changed:
                    self.state    = new_state
                    self.last_ok  = reachable
                    self.last_sent = time.time()
                    enabled = bool(c.get("ampel_enabled", False))
                    await hub.broadcast({
                        "type":     "ampel_state",
                        "state":    self.state,
                        "enabled":  enabled,
                        "forced":   False,
                        "ok":       reachable,
                        "ts":       self.last_sent,
                        "last_cmd": self.last_cmd,
                        "last_err": self.last_err if not reachable else "",
                    })
                    if state_changed:
                        print(f"[ampel] Poll: Zustand {new_state} erkannt")
            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[ampel] Poll-Loop Fehler: {exc}")
                poll_ok = False
            # Bei Fehler längerer Backoff, sonst normales Intervall
            await asyncio.sleep(self.POLL_INTERVAL if poll_ok else self.POLL_INTERVAL_ERROR)

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
