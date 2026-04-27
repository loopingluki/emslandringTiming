"""
MyLaps Race Control Box ASCII-Emulator – Kloft Zeitentafel.

Dieser Emulator reproduziert das exakte ASCII-Protokoll der originalen
MyLaps Race Control Box, wie es 1:1 mitgeschnitten wurde
(siehe ``mylaps-protokoll.md`` Abschnitt "Reales Format").

Format-Eigenheiten (gegenüber älteren Annahmen):

* **Komma-getrennt mit Anführungszeichen**, nicht Tab-getrennt.
* ``$F`` wird **jede Sekunde** gesendet – auch im Leerlauf (RED).
* Status-Feld ist immer **6 Zeichen** breit
  (``"RED   "``, ``"GREEN "``, ``"FINISH"``).
* Bei Session-Start wird die Sequenz
  ``$C → $B → $I → $A* → $F GREEN`` als ein Block geschickt.
* Bei jedem Passing wird die **komplette Rangliste** als ``$G``+``$H``
  Block ausgegeben.
* Nach FINISH friert ``elapsed`` auf der Renndauer ein und springt
  ~75 s später auf ``00:00:00`` zurück (Status bleibt ``FINISH``
  bis zur nächsten Session).

Race-Engine ruft die High-Level-Methoden auf
(``session_start``, ``on_passing``, ``session_finish``, ``session_complete``).
Den per-Sekunde-Tick erzeugt der Emulator selbständig im Hintergrund-Task.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime

import config as cfg
from ws_hub import hub


# ── Format-Helpers ────────────────────────────────────────────────────────────

_MONTHS_EN = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _hms(total_sec: int | float) -> str:
    """``HH:MM:SS`` (für $F Felder)."""
    s = max(0, int(total_sec))
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def _hmsm(total_us: int) -> str:
    """``HH:MM:SS.mmm`` (für $J/$G/$H Zeit-Felder)."""
    if total_us is None or total_us < 0:
        total_us = 0
    total_ms = total_us // 1000
    h = total_ms // 3_600_000
    m = (total_ms % 3_600_000) // 60_000
    s = (total_ms % 60_000) // 1000
    ms = total_ms % 1000
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _status6(status: str) -> str:
    """Status-Feld immer auf 6 Zeichen mit Leerzeichen aufgefüllt."""
    return f"{status:<6}"


def _date_en(now: datetime) -> str:
    """Datums-Format wie MyLaps: ``27 Apr 26`` – locale-unabhängig."""
    return f"{now.day:02d} {_MONTHS_EN[now.month - 1]} {now.year % 100:02d}"


# ── Emulator ──────────────────────────────────────────────────────────────────

class Emulator:
    """Sendet das MyLaps-ASCII-Protokoll an alle verbundenen TCP-Clients
    (z.B. Kloft-Bridge) und broadcastet jede Zeile zusätzlich als
    ``debug_emulator`` über den WS-Hub (für das Debug-Fenster)."""

    def __init__(self) -> None:
        # Server / Clients
        self._writers: set[asyncio.StreamWriter] = set()
        self._server: asyncio.Server | None = None
        self._lock = asyncio.Lock()
        self._ticker_task: asyncio.Task | None = None
        self._last_tick_sec: int = -1

        # Cache der zuletzt gestarteten Session (bleibt nach session_complete
        # erhalten, damit der Ticker die Post-Finish-Phase korrekt darstellt).
        self._duration_sec: int = 0
        self._is_gp: bool = False
        self._green_wall_time: float | None = None
        # Wird beim ersten FINISH-Tick gesetzt (außer GP-Overtime).
        self._finish_wall_time: float | None = None

        # Zeitschwellen (Sekunden seit FINISH-Beginn) – aus Mitschnitten:
        # Training: elapsed friert, springt nach ~75 s auf 0.
        # GP: elapsed wächst weiter, springt nach ~50 s auf 0.
        # Beide gehen nach ~110-200 s in den OFF-State (Feld 1 = 0).
        self._post_finish_reset_gp: float = 50.0
        self._post_finish_reset_training: float = 75.0
        self._post_finish_off_gp: float = 110.0
        self._post_finish_off_training: float = 200.0

        # Per-Session Tracking für $G/$H
        # kart_nr → {laps, best_us, best_lap_nr, last_total_us, name}
        self._kart_data: dict[int, dict] = {}
        self._announced_karts: set[int] = set()

        # Delta-Tracking für $G/$H: nach jedem Passing emittieren wir nur
        # **veränderte** Positionen (so wie die echte MyLaps-Box).
        # pos (int) → (kart_nr, laps, last_total_us)
        self._last_g_state: dict[int, tuple[int, int, int]] = {}

    # ── Server-Lifecycle ─────────────────────────────────────────────────────

    async def start(self, port: int) -> None:
        self._server = await asyncio.start_server(
            self._handle_client, "0.0.0.0", port
        )
        asyncio.create_task(self._server.serve_forever(), name="emulator-srv")
        self._ticker_task = asyncio.create_task(
            self._tick_loop(), name="emulator-tick"
        )

    async def stop(self) -> None:
        if self._ticker_task and not self._ticker_task.done():
            self._ticker_task.cancel()
            try:
                await self._ticker_task
            except asyncio.CancelledError:
                pass
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        async with self._lock:
            self._writers.add(writer)
        try:
            await reader.read()
        finally:
            async with self._lock:
                self._writers.discard(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    # ── Senden ────────────────────────────────────────────────────────────────

    async def _send(self, line: str) -> None:
        """Schickt eine Zeile an alle TCP-Clients **und** broadcastet sie
        als ``debug_emulator`` über den WS-Hub (Debug-Fenster).

        Wird über ``emulator_enabled`` in config.json gesteuert: bei
        ``false`` wird nur das Debug-Event geschickt, kein TCP-Send.
        """
        enabled = bool(cfg.get().get("emulator_enabled", True))
        sent_count = 0
        if enabled:
            data = (line + "\r\n").encode("latin-1")
            dead: list[asyncio.StreamWriter] = []
            async with self._lock:
                writers = list(self._writers)
            for w in writers:
                try:
                    w.write(data)
                    await w.drain()
                    sent_count += 1
                except Exception:
                    dead.append(w)
            if dead:
                async with self._lock:
                    for w in dead:
                        self._writers.discard(w)

        await hub.broadcast({
            "type":    "debug_emulator",
            "ts":      time.time(),
            "line":    line,
            "clients": sent_count,
            "enabled": enabled,
        })

    # ── Sekunden-Ticker ($F jede Sekunde) ────────────────────────────────────

    async def _tick_loop(self) -> None:
        """Sendet jede Wandzeit-Sekunde genau ein ``$F``."""
        try:
            while True:
                await asyncio.sleep(0.25)
                cur = int(time.time())
                if cur > self._last_tick_sec:
                    try:
                        await self._send_tick()
                    except Exception as exc:
                        print(f"[emulator] tick error: {exc}")
                    self._last_tick_sec = cur
        except asyncio.CancelledError:
            pass

    async def _send_tick(self) -> None:
        """Sendet **eine** $F-Zeile passend zum aktuellen race_engine-Zustand.

        Die Statusableitung folgt 1:1 dem 1:1-Mitschnitt der echten
        MyLaps-Box (Training und Grand Prix unterscheiden sich!):

        | engine.status | GP? | Phase            | Ausgabe                                 |
        |---------------|-----|------------------|-----------------------------------------|
        | none + run=∅  | -   | -                | OFF: ``$F,0,…," "``                     |
        | armed         | -   | -                | RED: ``$F,9999,"00:00:00",…,"RED   "``  |
        | running       | -   | -                | GREEN: ``cd=duration-elapsed, el=elapsed`` |
        | finishing     | GP  | waiting_leader   | GREEN cd=0, elapsed wächst weiter       |
        | finishing     | GP  | waiting_others   | FINISH, elapsed wächst weiter           |
        | finishing     | TR  | -                | FINISH, elapsed eingefroren auf duration|
        | done          | -   | (Post-Finish)    | FINISH→FINISH(el=0)→OFF mit Zeitstaffel |
        """
        from race_engine import engine

        wall = datetime.now().strftime("%H:%M:%S")
        st = engine.status if engine.run else "none"
        is_gp_now = bool(
            engine.run and engine.run.get("mode") in ("gp_time", "gp_laps")
        )
        finish_phase = getattr(engine, "_finish_phase", "") or ""
        el_live = self._live_elapsed_sec()

        # FINISH-Zeitstempel beim ersten Übergang merken (außer GP-Overtime).
        in_overtime = (
            st == "finishing" and is_gp_now and finish_phase == "waiting_leader"
        )
        in_finish = st in ("finishing", "done") and not in_overtime
        if in_finish and self._finish_wall_time is None:
            self._finish_wall_time = time.time()
        elif st in ("running", "armed", "paused"):
            # Neuer Lauf läuft → alten FINISH-Stempel verwerfen.
            self._finish_wall_time = None

        # ── State → Zeile ────────────────────────────────────────────────────
        if st in ("running", "paused"):
            cd = max(0, self._duration_sec - el_live)
            line = self._fmt_F(9999, cd, wall, el_live, "GREEN ")

        elif st == "armed":
            # Im Mitschnitt war RED unterschiedlich gepolstert
            # (Training: "RED   ", GP: "RED "). Wir nehmen die 6-Zeichen-
            # Variante – das Trailing-Padding ist laut Doku irrelevant.
            line = self._fmt_F(9999, 0, wall, 0, "RED   ")

        elif in_overtime:
            # GP-Overtime: cd=0, GREEN, elapsed wächst weiter über Renndauer
            line = self._fmt_F(9999, 0, wall, el_live, "GREEN ")

        elif st == "finishing":
            # GP nach Leader OR Training: FINISH
            el = el_live if self._is_gp else self._duration_sec
            line = self._fmt_F(9999, 0, wall, el, "FINISH")

        elif st == "done":
            line = self._done_state_line(wall, el_live)

        else:
            # Keine aktive Session → OFF, ggf. noch Restanzeige aus letzter
            # Session, wenn die _finish_wall_time noch innerhalb der Anzeige-
            # Frist liegt.
            if self._finish_wall_time is not None:
                line = self._done_state_line(wall, el_live)
            else:
                line = self._fmt_F_off(wall)

        await self._send(line)

    def _done_state_line(self, wall: str, el_live: int) -> str:
        """Phasen nach Session-Ende:

        1. ``[0 .. reset_offset)``: FINISH, elapsed läuft weiter (GP) bzw.
           bleibt auf duration eingefroren (Training).
        2. ``[reset_offset .. off_offset)``: FINISH mit elapsed = 00:00:00.
        3. ``>= off_offset``: OFF-State (Feld 1 = 0).
        """
        if self._finish_wall_time is None:
            return self._fmt_F_off(wall)
        t_since = time.time() - self._finish_wall_time
        reset_offset = (
            self._post_finish_reset_gp if self._is_gp
            else self._post_finish_reset_training
        )
        off_offset = (
            self._post_finish_off_gp if self._is_gp
            else self._post_finish_off_training
        )
        if t_since < reset_offset:
            el = el_live if self._is_gp else self._duration_sec
            return self._fmt_F(9999, 0, wall, el, "FINISH")
        if t_since < off_offset:
            return self._fmt_F(9999, 0, wall, 0, "FINISH")
        return self._fmt_F_off(wall)

    def _live_elapsed_sec(self) -> int:
        """Wand-zeit-basierte elapsed seit GREEN. Wächst auch dann weiter,
        wenn race_engine den internen Timer angehalten hat (z.B. nach
        Countdown=0 in der GP-Overtime-Phase)."""
        if self._green_wall_time is None:
            return 0
        return max(0, int(time.time() - self._green_wall_time))

    def _fmt_F(
        self, field1: int, cd_sec: int, wall: str, el_sec: int, status6: str
    ) -> str:
        return (
            f'$F,{field1},"{_hms(cd_sec)}","{wall}","{_hms(el_sec)}","{status6}"'
        )

    def _fmt_F_off(self, wall: str) -> str:
        """OFF-State: Feld 1 = 0, Status = einzelnes Leerzeichen
        (genau wie im 1:1-Mitschnitt vor/nach jeder Session)."""
        return f'$F,0,"00:00:00","{wall}","00:00:00"," "'

    # ── Public API für race_engine ───────────────────────────────────────────

    async def session_start(
        self,
        run_id: int,
        group_name: str,
        duration_sec: int,
        pre_registered: list[tuple[int, str]] | None = None,
        is_gp: bool = False,
    ) -> None:
        """Schickt die Start-Sequenz wie die echte MyLaps-Box::

            $C,12,"Online  [Online]"        (Training: 2 Spaces)
            $C,12,"Online [Online]"         (Grand Prix: 1 Space)
            $B,<id>,"<group>"               ("Gruppe N" oder "RACE")
            $I,"HH:MM:SS.mmm","DD MMM YY"
            $A,"<n>","<n>",,"","Kart <n>","",12     (NUR Training)
            $F,9999,"00:00:00","HH:MM:SS","00:00:00","GREEN "

        Danach übernimmt der Sekunden-Ticker die laufenden ``$F`` Updates.

        ``is_gp`` steuert zwei Eigenheiten der echten Box:

        * Im GP wird der ``$A``-Vorab-Block übersprungen – Karts werden
          dynamisch beim ersten Passing per ``$A`` nachgemeldet.
        * Im GP wird im ``$C`` ein einzelnes Leerzeichen verwendet, im
          Training zwei (so im 1:1-Mitschnitt vom 27.04.2026 / 07.04.2026
          beobachtet).
        """
        # State zurücksetzen
        self._kart_data = {}
        self._announced_karts = set()
        self._last_g_state = {}
        self._duration_sec = max(0, int(duration_sec))
        self._is_gp = bool(is_gp)
        self._green_wall_time = time.time()
        self._finish_wall_time = None

        # 1. $C – "Online" Status (Spacing exakt wie im Mitschnitt)
        if self._is_gp:
            await self._send('$C,12,"Online [Online]"')
        else:
            await self._send('$C,12,"Online  [Online]"')

        # 2. $B – Session-Start
        await self._send(f'$B,{run_id},"{group_name}"')

        # 3. $I – präziser Zeitstempel + Datum
        now = datetime.now()
        time_str = now.strftime("%H:%M:%S.") + f"{now.microsecond // 1000:03d}"
        await self._send(f'$I,"{time_str}","{_date_en(now)}"')

        # 4. $A – nur für Training: alle vorab registrierten Karts.
        # Im GP überspringt die Box den $A-Block und meldet Karts
        # dynamisch beim ersten Passing.
        sorted_pre: list[tuple[int, str]] = []
        if not self._is_gp and pre_registered:
            sorted_pre = sorted(pre_registered, key=lambda x: x[0])
            for nr, name in sorted_pre:
                await self._send(
                    f'$A,"{nr}","{nr}",,"","{name}","",12'
                )
                self._announced_karts.add(nr)

        # 5. Initial-Snapshot (NUR Training): die echte MyLaps-Box sendet
        # nach dem $A-Block einen kompletten $G/$H-Block mit allen
        # vorab registrierten Karts auf laps=0, total=00:00:00.000 (in
        # numerischer Reihenfolge). Erst dadurch sieht die Zeitentafel
        # die volle Roster-Liste schon vor dem ersten Passing.
        if sorted_pre:
            for i, (nr, _name) in enumerate(sorted_pre, start=1):
                await self._send(
                    f'$G,{i},"{nr}",0,"00:00:00.000"'
                )
                self._last_g_state[i] = (nr, 0, 0)
            for i, (nr, _name) in enumerate(sorted_pre, start=1):
                await self._send(
                    f'$H,{i},"{nr}",0,"00:00:00.000"'
                )

        # 6. Erstes $F GREEN (cd=0, el=0 – exakt im Start-Moment)
        wall = datetime.now().strftime("%H:%M:%S")
        await self._send(
            f'$F,9999,"00:00:00","{wall}","00:00:00","{_status6("GREEN")}"'
        )

        # Ticker für diese Wandzeit-Sekunde unterdrücken (kein Doppel-$F)
        self._last_tick_sec = int(time.time())

    async def on_passing(
        self,
        kart_nr: int,
        kart_name: str,
        lap_time_us: int | None,
        passing_wall_time: float,
        sorted_kart_order: list[int],
    ) -> None:
        """Wird vom race_engine bei JEDEM gewerteten Decoder-Passing
        aufgerufen.

        Sendet (in genau dieser Reihenfolge):

        1. ``$A`` – falls dieses Kart noch nicht angemeldet war
        2. ``$J`` – Passing-Ankündigung (lap_time + elapsed_total)
        3. ``$G`` – komplette Rangliste mit aktueller Rundenzahl + total
        4. ``$H`` – komplette Rangliste mit Bestzeit je Kart

        ``lap_time_us`` darf ``None`` sein → erste/Intro-Durchfahrt.
        """
        from race_engine import engine
        # Passings nur durchreichen, solange wirklich eine Session läuft.
        # Während GP-Overtime (status=finishing + waiting_leader) noch zählen,
        # ebenso während waiting_others (FINISH-Phase, Karts dürfen einlaufen).
        if engine.status not in ("running", "paused", "finishing"):
            return
        if self._green_wall_time is None:
            return

        # Elapsed seit GREEN beim Moment des Passings (in µs)
        elapsed_us = int((passing_wall_time - self._green_wall_time) * 1_000_000)
        if elapsed_us < 0:
            elapsed_us = 0

        # Per-Kart Tracking aktualisieren
        if kart_nr not in self._kart_data:
            self._kart_data[kart_nr] = {
                "laps":          0,
                "best_us":       None,
                "best_lap_nr":   0,
                "last_total_us": elapsed_us,
                "name":          kart_name,
            }
        kd = self._kart_data[kart_nr]
        kd["last_total_us"] = elapsed_us
        kd["name"] = kart_name

        if lap_time_us is not None and lap_time_us > 0:
            kd["laps"] += 1
            if kd["best_us"] is None or lap_time_us < kd["best_us"]:
                kd["best_us"] = lap_time_us
                kd["best_lap_nr"] = kd["laps"]
            j_lap_str = _hmsm(lap_time_us)
        else:
            # Intro-Durchfahrt → lap_time=00:00:00.000
            j_lap_str = "00:00:00.000"

        # 1. $A nur einmal pro Kart
        if kart_nr not in self._announced_karts:
            await self._send(
                f'$A,"{kart_nr}","{kart_nr}",,"","{kart_name}","",12'
            )
            self._announced_karts.add(kart_nr)

        # 2. $J – Passing-Ankündigung
        await self._send(
            f'$J,"{kart_nr}","{j_lap_str}","{_hmsm(elapsed_us)}"'
        )

        # 3+4. Delta-Update für $G/$H – Ranking nach **MyLaps-Regeln**:
        #
        #   primär  : laps DESC (mehr Runden zuerst)
        #   sekundär: best_lap ASC (laps>0)  ODER  -last_total_us (laps=0,
        #             also: zuletzt gefahren zuerst)
        #   tertiär : kart_nr ASC (Tiebreaker)
        #
        # Wir senden NUR die Positionen, deren (kart_nr, laps, total) sich
        # gegenüber dem letzten emittierten Stand verändert hat – exakt so
        # wie die echte Box.
        active = sorted(
            self._kart_data.items(),
            key=lambda item: (
                -item[1]["laps"],
                item[1]["best_us"] if item[1]["laps"] > 0
                else -item[1]["last_total_us"],
                item[0],
            ),
        )

        # Neue $G-States pro Position berechnen
        new_g_state: dict[int, tuple[int, int, int]] = {}
        for pos, (nr, d) in enumerate(active, start=1):
            new_g_state[pos] = (nr, d["laps"], d["last_total_us"])

        # Veränderte Positionen ermitteln
        changed_positions: list[int] = [
            pos for pos, val in new_g_state.items()
            if self._last_g_state.get(pos) != val
        ]

        # $G für veränderte Positionen
        for pos in changed_positions:
            nr, d = active[pos - 1]
            await self._send(
                f'$G,{pos},"{nr}",{d["laps"]},"{_hmsm(d["last_total_us"])}"'
            )
            self._last_g_state[pos] = new_g_state[pos]

        # $H für dieselben Positionen (paarweise mit $G, wie MyLaps)
        for pos in changed_positions:
            nr, d = active[pos - 1]
            best_str = _hmsm(d["best_us"]) if d["best_us"] else "00:00:00.000"
            await self._send(
                f'$H,{pos},"{nr}",{d["best_lap_nr"]},"{best_str}"'
            )

    async def session_finish(self) -> None:
        """Wird beim FINISH-Übergang aufgerufen (für GP: wenn Führender
        die Linie überquert; für Training: wenn die Renndauer abgelaufen
        ist und ``_finalize`` keine separate FINISH-Nachricht mehr senden
        muss). Setzt den FINISH-Zeitstempel und schickt sofort einen
        passenden ``$F``-Tick, damit Clients keine Sekunde warten müssen.

        Der Sekunden-Ticker übernimmt danach automatisch die laufenden
        FINISH-Updates."""
        if self._finish_wall_time is None:
            self._finish_wall_time = time.time()

        wall = datetime.now().strftime("%H:%M:%S")
        # GP: elapsed wächst weiter, Training: friert auf duration ein
        if self._is_gp:
            el = self._live_elapsed_sec()
        else:
            el = self._duration_sec
        await self._send(
            f'$F,9999,"00:00:00","{wall}","{_hms(el)}","FINISH"'
        )
        self._last_tick_sec = int(time.time())

    async def session_complete(self, run_id: int) -> None:
        """Markiert das endgültige Session-Ende intern.

        Im 1:1-Mitschnitt sendet die echte MyLaps-Box **kein** abschließendes
        ``$C`` – sie bleibt einfach im FINISH-State, bis nach Ablauf der
        Wartezeit der elapsed-Reset und schließlich der OFF-Übergang
        kommen. Wir setzen daher nur den FINISH-Zeitstempel; der Ticker
        kümmert sich um den Rest über ``_done_state_line``."""
        if self._finish_wall_time is None:
            self._finish_wall_time = time.time()

    async def reset_to_idle(self) -> None:
        """Vollständiger Reset – Ticker wechselt sofort in den OFF-State.
        Wird derzeit nicht aktiv genutzt (nächster ``session_start``
        überschreibt den State ohnehin)."""
        self._duration_sec = 0
        self._is_gp = False
        self._green_wall_time = None
        self._finish_wall_time = None
        self._kart_data = {}
        self._announced_karts = set()


emulator = Emulator()
