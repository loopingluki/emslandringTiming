"""
Zentrale Zustandsmaschine für Trainings- und Grand-Prix-Läufe.

Status-Übergänge:
  Training:  pending → armed → running → paused → finishing → done
  GP Zeit:   pending → armed → running → paused → finishing → done
  GP Runden: identisch zu GP Zeit, aber Trigger ist Rundenanzahl des Führenden
"""
import asyncio
import time
from dataclasses import dataclass, field

import config as cfg
import database
from ampel import ampel
from emulator import emulator
from ws_hub import hub


# ── Kart-State ────────────────────────────────────────────────────────────────

@dataclass
class KartState:
    kart_nr: int
    name: str
    laps: int = 0
    best_us: int | None = None
    last_us: int | None = None
    lap_times_us: list[int] = field(default_factory=list)
    avg5_us: int | None = None
    trend: str | None = None          # "up" | "down" | "stable"
    strength: int = 0
    hits: int = 0
    last_passing_ts: float = 0.0      # wall-clock Unix timestamp
    last_passing_us: int | None = None  # decoder µs timestamp
    seen_after_finish: bool = False   # für finish-Logik

    def record(self, timestamp_us: int, strength: int, hits: int) -> int | None:
        self.strength = strength
        self.hits = hits
        self.last_passing_ts = time.time()

        lap_us: int | None = None
        if self.last_passing_us is not None:
            diff = timestamp_us - self.last_passing_us
            if 10_000_000 <= diff <= 1_800_000_000:
                lap_us = diff

        self.last_passing_us = timestamp_us

        if lap_us is not None:
            self.laps += 1
            self.last_us = lap_us
            self.lap_times_us.append(lap_us)
            if self.best_us is None or lap_us < self.best_us:
                self.best_us = lap_us
            recent = self.lap_times_us[-5:]
            prev_avg = self.avg5_us
            self.avg5_us = sum(recent) // len(recent)
            if prev_avg is not None and len(recent) >= 3:
                if lap_us < prev_avg * 0.98:
                    self.trend = "up"
                elif lap_us > prev_avg * 1.02:
                    self.trend = "down"
                else:
                    self.trend = "stable"

        return lap_us

    def to_dict(self, position: int) -> dict:
        return {
            "position": position,
            "kart_nr": self.kart_nr,
            "name": self.name,
            "laps": self.laps,
            "best_us": self.best_us,
            "last_us": self.last_us,
            "avg5_us": self.avg5_us,
            "trend": self.trend,
            "last_passing_ts": self.last_passing_ts,
            "strength": self.strength,
            "lap_times_us": self.lap_times_us,
            "seen_after_finish": self.seen_after_finish,
            "total_us": sum(self.lap_times_us) if self.lap_times_us else 0,
        }


# ── RaceEngine ────────────────────────────────────────────────────────────────

class RaceEngine:
    def __init__(self) -> None:
        self.run_id: int | None = None
        self.run: dict | None = None
        self.status: str = "none"       # none|armed|running|paused|finishing|done

        self.karts: dict[int, KartState] = {}
        self.kart_names: dict[int, str] = {}  # per-run overrides
        self.first_karts_seen: set[int] = set()

        self.remaining_sec: float = 0.0
        self.elapsed_sec: float = 0.0

        self._timer_task: asyncio.Task | None = None
        self._finish_task: asyncio.Task | None = None
        self._finish_start: float = 0.0
        self._finish_wait_total: int = 0
        self._finish_phase: str = ""   # "waiting_leader" | "waiting_others"

        # Defekt-Erkennung: gemeldete Karts (pro Lauf) – verhindert dass
        # die gleiche Warnung pro Runde erneut feuert.
        self._defect_alerted: set[int] = set()

    def _finish_remaining(self) -> int:
        if self.status != "finishing" or not self._finish_wait_total:
            return 0
        elapsed = time.time() - self._finish_start
        return max(0, int(self._finish_wait_total - elapsed))

    # ── Public API ────────────────────────────────────────────────────────────

    async def arm(self, run_id: int) -> None:
        if self.status not in ("none", "done"):
            raise ValueError(f"Kann nicht scharf schalten: aktueller Status={self.status}")
        run = await database.get_run(run_id)
        if not run:
            raise ValueError(f"Lauf {run_id} nicht gefunden")
        if run["status"] in ("done", "skipped"):
            raise ValueError("Lauf ist bereits beendet")

        # Sequenzprüfung: alle früheren Läufe des selben Tages müssen done/skipped sein
        runs_today = await database.get_runs_for_date(run["date"])
        for r in runs_today:
            if r["run_number"] < run["run_number"] and r["status"] not in ("done", "skipped"):
                raise ValueError(
                    f"Lauf {r['name']} muss zuerst abgeschlossen oder übersprungen werden"
                )

        await self._cancel_tasks()
        self.run_id = run_id
        self.run = run
        self.karts = {}
        self.kart_names = await database.get_run_kart_names(run_id)
        self.first_karts_seen = set()
        self.remaining_sec = float(run["duration_sec"])
        self.elapsed_sec = 0.0
        self._finish_phase = ""
        self._defect_alerted = set()

        self.status = "armed"
        await database.update_run(run_id, status="armed")
        await self._broadcast_run_state()
        await self._broadcast_run_list_update()

    async def disarm(self) -> None:
        if self.status != "armed":
            raise ValueError("Lauf ist nicht scharf geschaltet")
        old_run_id = self.run_id
        await self._cancel_tasks()
        self.run_id = None
        self.run = None
        self.status = "none"
        self.karts = {}
        await database.update_run(old_run_id, status="pending")
        await hub.broadcast({"type": "run_state", "status": "none"})
        await self._ampel_seq("ampel_seq_disarm")
        await self._broadcast_run_list_update()

    async def start_gp(self) -> None:
        if self.status != "armed" or self.run is None:
            raise ValueError("Kein bewaffneter Grand-Prix-Lauf")
        if self.run["mode"] not in ("gp_time", "gp_laps"):
            raise ValueError("Nur für Grand-Prix-Läufe")
        await self._begin_running()

    async def pause(self) -> None:
        if self.status != "running":
            return
        self.status = "paused"
        await self._cancel_timer()
        await database.update_run(self.run_id, status="paused")
        await self._broadcast_run_state()

    async def resume(self) -> None:
        if self.status != "paused":
            return
        self.status = "running"
        await database.update_run(self.run_id, status="running")
        self._timer_task = asyncio.create_task(self._timer_loop(), name="timer")
        await self._broadcast_run_state()

    async def abort(self) -> None:
        if self.status in ("none", "done"):
            return
        await self._finalize()

    async def adjust_time(self, delta_sec: int) -> None:
        # "armed" wurde früher übersprungen → wenn der Operator die Dauer
        # vor dem ersten Passing änderte, wurde remaining_sec nicht
        # angepasst und der Lauf startete später trotzdem mit der alten
        # Zeit. Daher auch im armed-Zustand mitziehen.
        if self.status not in ("armed", "running", "paused", "finishing"):
            return
        self.remaining_sec = max(0.0, self.remaining_sec + delta_sec)
        # Auch die Renndauer im run-Dict mitziehen, damit der Emulator
        # die neue Dauer für seine Countdown-Berechnung kennt.
        if self.run is not None:
            self.run["duration_sec"] = max(
                0, int(self.run.get("duration_sec", 0)) + delta_sec
            )
            # Emulator direkt informieren, damit der Sekunden-Ticker den
            # neuen Countdown sofort verwendet (sonst läuft er weiter mit
            # der alten Renndauer aus session_start und endet zu früh).
            try:
                emulator._duration_sec = int(self.run["duration_sec"])
            except Exception:
                pass
        await self._broadcast_run_state()

    async def set_kart_name(self, kart_nr: int, name: str) -> None:
        self.kart_names[kart_nr] = name
        if kart_nr in self.karts:
            self.karts[kart_nr].name = name
        if self.run_id:
            await database.set_run_kart_name(self.run_id, kart_nr, name)
        await self._broadcast_kart_table()

    # ── Passing-Handler (called by decoder) ──────────────────────────────────

    async def on_passing(
        self,
        transponder_id: int,
        timestamp_us: int,
        strength: int,
        hits: int,
    ) -> None:
        if self.status not in ("armed", "running", "paused", "finishing"):
            return

        kart_nr = cfg.get_kart_nr(transponder_id)
        if kart_nr is None:
            return

        # Training: erste Passing startet den Lauf
        if self.status == "armed" and self.run and self.run["mode"] == "training":
            await self._begin_running()

        # Kart registrieren
        if kart_nr not in self.karts:
            global_name = cfg.get_kart_name(transponder_id)
            name = self.kart_names.get(kart_nr, global_name)
            self.karts[kart_nr] = KartState(kart_nr=kart_nr, name=name)

        kart = self.karts[kart_nr]
        lap_us = kart.record(timestamp_us, strength, hits)

        # In DB speichern
        if self.run_id and self.status in ("running", "finishing"):
            await database.add_passing(
                self.run_id, transponder_id, kart_nr,
                timestamp_us, lap_us, strength, hits,
            )

        # Erstes-Passing-Tracking (für UI-Highlights). Den $A-Versand für
        # neue Karts übernimmt der Emulator selbst beim ersten Passing.
        if kart_nr not in self.first_karts_seen:
            self.first_karts_seen.add(kart_nr)

        # Finish-Flag VOR Broadcast setzen, damit das Kart sofort als „fertig“ im UI erscheint
        if self.status == "finishing":
            kart.seen_after_finish = True

        # Broadcast: einzelnes Passing + aktualisierte Tabelle
        sorted_karts = self._sorted_karts()
        position = next(
            (i + 1 for i, k in enumerate(sorted_karts) if k.kart_nr == kart_nr), 0
        )

        # Emulator: bei jedem Passing $J/$G/$H mit aktueller Rangliste senden.
        # Auch Intro-Passings (lap_us is None) werden weitergereicht – die
        # echte MyLaps-Box gibt diese ebenfalls aus (mit lap_time=0).
        if self.status in ("running", "finishing"):
            sorted_order = [k.kart_nr for k in sorted_karts]
            await emulator.on_passing(
                kart_nr=kart_nr,
                kart_name=kart.name,
                lap_time_us=lap_us,
                passing_wall_time=kart.last_passing_ts,
                sorted_kart_order=sorted_order,
            )
        await hub.broadcast({
            "type": "passing",
            "kart_nr": kart_nr,
            "name": kart.name,
            "lap_time_us": lap_us,
            "lap_nr": kart.laps,
            "strength": strength,
            "hits": hits,
            "position": position,
        })
        await self._broadcast_kart_table()

        # Defekt-Erkennung: gewichteter gleitender Durchschnitt prüfen
        if lap_us is not None and self.status in ("running", "finishing"):
            await self._check_defect(kart, transponder_id)

        # GP Runden: Prüfen ob Führender Rundenziel erreicht
        if (
            self.status == "running"
            and self.run
            and self.run["mode"] == "gp_laps"
            and lap_us is not None
        ):
            leader = sorted_karts[0] if sorted_karts else None
            if leader and leader.laps >= (self.run.get("gp_laps") or cfg.get()["gp_laps_count"]):
                await self._trigger_finishing()

        # Finish-Logik: Übergänge prüfen (Flag ist oben schon gesetzt)
        if self.status == "finishing":
            if self._finish_phase == "waiting_leader":
                await self._check_leader_crossed()
            elif self._finish_phase == "waiting_others":
                await self._check_all_crossed()

    # ── Interne Methoden ─────────────────────────────────────────────────────

    async def _begin_running(self) -> None:
        self.status = "running"
        now = time.time()
        await database.update_run(self.run_id, status="running", started_at=now)

        mode = self.run["mode"]
        is_gp = mode in ("gp_time", "gp_laps")
        group = "RACE" if is_gp else f"Gruppe {self.run['run_number']}"

        # Pre-registered Karts für den $A-Block beim Session-Start.
        # Im 1:1-Mitschnitt zeigt die echte MyLaps-Box: im **Training**
        # werden alle bekannten Karts vorab via $A angemeldet, im
        # **Grand Prix** dagegen entfällt der Vorab-Block – Karts werden
        # nur dynamisch beim ersten Passing nachgemeldet.
        if is_gp:
            pre_registered: list[tuple[int, str]] = []
        else:
            seen: set[int] = set()
            pre_registered = []
            for tid, info in cfg.get().get("transponders", {}).items():
                nr = info.get("kart_nr")
                if nr is None or nr in seen:
                    continue
                seen.add(nr)
                pre_registered.append((nr, info.get("name", f"Kart {nr}")))

        duration = int(self.run.get("duration_sec") or 0)
        await emulator.session_start(
            self.run_id, group, duration, pre_registered, is_gp=is_gp,
        )

        self._timer_task = asyncio.create_task(self._timer_loop(), name="timer")
        mode = self.run["mode"]
        if mode in ("gp_time", "gp_laps"):
            await self._ampel_seq("ampel_seq_gp_start")
        else:
            await self._ampel_seq("ampel_seq_training_start")
        await self._broadcast_run_state()
        await self._broadcast_run_list_update()

    async def _timer_loop(self) -> None:
        try:
            while self.remaining_sec > 0 and self.status == "running":
                await asyncio.sleep(1.0)
                if self.status != "running":
                    break
                self.remaining_sec -= 1.0
                self.elapsed_sec += 1.0
                await hub.broadcast({
                    "type": "timer_tick",
                    "remaining_sec": int(self.remaining_sec),
                    "elapsed_sec": int(self.elapsed_sec),
                })

            if self.status == "running" and self.remaining_sec <= 0:
                await self._trigger_finishing()
        except asyncio.CancelledError:
            pass

    async def _trigger_finishing(self) -> None:
        await self._cancel_timer()
        self.status = "finishing"
        self._finish_start = time.time()
        await database.update_run(self.run_id, status="finishing")

        mode = self.run["mode"] if self.run else "training"

        if mode == "training":
            # Alle bisherigen Karts müssen noch einmal passieren
            self._finish_phase = "waiting_others"
            for k in self.karts.values():
                k.seen_after_finish = False
            wait = cfg.get()["wait_time_sec"]
            await self._ampel_seq("ampel_seq_training_finish")
        else:
            # Grand Prix: erst auf Führenden warten
            self._finish_phase = "waiting_leader"
            for k in self.karts.values():
                k.seen_after_finish = False
            wait = cfg.get()["wait_time_gp_sec"]

        self._finish_wait_total = wait
        await self._broadcast_run_state()
        self._finish_task = asyncio.create_task(
            self._finish_timeout(wait), name="finish_timeout"
        )

    async def _check_leader_crossed(self) -> None:
        sorted_karts = self._sorted_karts()
        if not sorted_karts:
            return
        leader = sorted_karts[0]
        if leader.seen_after_finish:
            # Führender hat Linie überquert → Finish-Signal, warte auf alle
            await emulator.session_finish()
            await self._ampel_seq("ampel_seq_gp_finish")
            self._finish_phase = "waiting_others"
            for k in self.karts.values():
                k.seen_after_finish = False
            leader.seen_after_finish = True  # Führender gilt als schon gesehen
            # Timeout zurücksetzen
            if self._finish_task:
                self._finish_task.cancel()
            wait = cfg.get()["wait_time_gp_sec"]
            self._finish_start = time.time()
            self._finish_wait_total = wait
            await self._broadcast_run_state()
            self._finish_task = asyncio.create_task(
                self._finish_timeout(wait), name="finish_timeout"
            )

    async def _check_all_crossed(self) -> None:
        if all(k.seen_after_finish for k in self.karts.values()):
            await self._finalize()

    async def _finish_timeout(self, wait_sec: int) -> None:
        try:
            end = time.time() + wait_sec
            while True:
                now = time.time()
                if now >= end:
                    break
                await asyncio.sleep(1.0)
                if self.status == "finishing":
                    remaining = max(0, int(end - time.time()))
                    await hub.broadcast({
                        "type": "timer_tick",
                        "remaining_sec": 0,
                        "elapsed_sec": int(self.elapsed_sec),
                        "finish_remaining_sec": remaining,
                        "finish_phase": self._finish_phase,
                    })
            if self.status == "finishing":
                if self._finish_phase == "waiting_leader":
                    await emulator.session_finish()
                await self._finalize()
        except asyncio.CancelledError:
            pass

    async def _finalize(self) -> None:
        await self._cancel_tasks()
        await self._ampel_seq("ampel_seq_done")
        mode = self.run["mode"] if self.run else "training"

        if self.status not in ("finishing",):
            await emulator.session_finish()

        await emulator.session_complete(self.run_id)

        now = time.time()
        self.status = "done"
        finished_run_id = self.run_id
        await database.update_run(finished_run_id, status="done", finished_at=now)
        await hub.broadcast({"type": "run_finished", "run_id": finished_run_id})
        await self._broadcast_run_state()
        await self._broadcast_run_list_update()

        # Automatischer Ausdruck (im Hintergrund, blockiert Finalize nicht)
        asyncio.create_task(self._auto_print(finished_run_id))

        # Firebase-Sync (im Hintergrund, nur wenn konfiguriert)
        asyncio.create_task(self._auto_firebase_sync(finished_run_id))

    async def _auto_firebase_sync(self, run_id: int) -> None:
        try:
            import firebase_sync
            await firebase_sync.sync_run(run_id)
        except Exception as exc:
            print(f"[race_engine] Firebase-Sync Fehler: {exc}")

    async def _auto_print(self, run_id: int) -> None:
        try:
            import printer
            res = await printer.print_run(run_id)
            if not res.get("ok"):
                await hub.broadcast({
                    "type": "print_error",
                    "run_id": run_id,
                    "error": res.get("error", "unbekannt"),
                })
            else:
                await hub.broadcast({
                    "type": "print_ok",
                    "run_id": run_id,
                    "printer": res.get("printer", ""),
                })
        except Exception as e:
            await hub.broadcast({
                "type": "print_error", "run_id": run_id, "error": str(e),
            })

    def _sorted_karts(self) -> list[KartState]:
        mode = self.run["mode"] if self.run else "training"
        if mode == "training":
            return sorted(
                self.karts.values(),
                key=lambda k: (k.best_us is None, k.best_us or 0),
            )
        return sorted(
            self.karts.values(),
            key=lambda k: (
                -k.laps,
                sum(k.lap_times_us) if k.lap_times_us else 0,
            ),
        )

    async def _broadcast_kart_table(self) -> None:
        sorted_karts = self._sorted_karts()
        await hub.broadcast({
            "type": "kart_table",
            "karts": self._build_kart_dicts(sorted_karts),
        })

    def _build_kart_dicts(self, sorted_karts: list[KartState]) -> list[dict]:
        """Erzeugt die Kart-Dicts mit Position und – im GP-Modus –
        ``gap_us`` (Abstand zum Führenden in derselben Rundenzahl).

        ``gap_us`` ist:
          * ``0`` für den Führenden
          * positiver µs-Wert für Karts mit gleicher Rundenzahl wie der
            Führende (``total_us - leader_total_us``)
          * ``None`` für Karts mit weniger Runden (Rundenrückstand wird
            statt einem Zeitabstand angezeigt)
        """
        mode = self.run["mode"] if self.run else "training"
        is_gp = mode in ("gp_time", "gp_laps")

        result: list[dict] = []
        leader_total: int | None = None
        leader_laps: int | None = None
        for i, k in enumerate(sorted_karts):
            d = k.to_dict(i + 1)
            if is_gp:
                if i == 0 and k.laps > 0:
                    leader_total = d["total_us"]
                    leader_laps = k.laps
                if i == 0:
                    d["gap_us"] = 0
                    d["gap_laps"] = 0
                elif leader_laps is None or k.laps == 0:
                    d["gap_us"] = None
                    d["gap_laps"] = None
                elif k.laps == leader_laps:
                    d["gap_us"] = max(0, d["total_us"] - (leader_total or 0))
                    d["gap_laps"] = 0
                else:
                    d["gap_us"] = None
                    d["gap_laps"] = leader_laps - k.laps
            result.append(d)
        return result

    async def _broadcast_run_state(self) -> None:
        if not self.run:
            await hub.broadcast({"type": "run_state", "status": "none"})
            return
        await hub.broadcast({
            "type": "run_state",
            "id": self.run_id,
            "name": self.run["name"],
            "mode": self.run["mode"],
            "status": self.status,
            "remaining_sec": int(self.remaining_sec),
            "elapsed_sec": int(self.elapsed_sec),
            "timer_running": self.status == "running",
            "finish_phase": self._finish_phase,
            "finish_remaining_sec": self._finish_remaining(),
            "finish_wait_total": self._finish_wait_total,
        })

    async def _broadcast_run_list_update(self) -> None:
        from datetime import date
        import run_manager
        today = date.today().isoformat()
        runs = await run_manager.get_runs(today)
        await hub.broadcast({"type": "run_list", "runs": runs})

    async def _cancel_timer(self) -> None:
        # Selbst-Cancel verhindern (siehe _cancel_tasks-Kommentar):
        # _trigger_finishing wird vom _timer_task selbst aufgerufen.
        current = asyncio.current_task()
        if (self._timer_task
                and not self._timer_task.done()
                and self._timer_task is not current):
            self._timer_task.cancel()
            try:
                await self._timer_task
            except asyncio.CancelledError:
                pass

    async def _cancel_tasks(self) -> None:
        await self._cancel_timer()
        # WICHTIG: nicht uns selbst canceln. _finalize() wird vom
        # _finish_task aufgerufen; ein .cancel() auf den eigenen Task
        # plus `await self._finish_task` würde den eigenen Task
        # mittendrin abbrechen → _finalize läuft nicht durch und der
        # Lauf bleibt im "finishing"-Zustand hängen.
        current = asyncio.current_task()
        if (self._finish_task
                and not self._finish_task.done()
                and self._finish_task is not current):
            self._finish_task.cancel()
            try:
                await self._finish_task
            except asyncio.CancelledError:
                pass

    async def _ampel_seq(self, key: str) -> None:
        """Sendet den konfigurierten Ampel-Zustand für ein Ereignis."""
        await ampel.send_seq(key)

    async def _check_defect(self, kart: KartState, transponder_id: int) -> None:
        """Prüft auf Defekt-Verdacht: gewichteter gleitender Durchschnitt
        der letzten N Runden über Schwelle. Sendet einmalig pro Kart und
        Lauf eine ``defect_alert``-WS-Nachricht."""
        c = cfg.get()
        if not c.get("defect_detection_enabled"):
            return
        if kart.kart_nr in self._defect_alerted:
            return  # schon gemeldet, kein Spam
        # Klassen-Filter (nur konfigurierte Klassen prüfen)
        info = cfg.get_kart_info(transponder_id) or {}
        kart_class = info.get("class", "")
        if kart_class not in c.get("defect_classes", []):
            return
        min_laps  = int(c.get("defect_min_laps", 3))
        window    = int(c.get("defect_window", 5))
        threshold = int(c.get("defect_threshold_us", 70_000_000))
        if kart.laps < min_laps:
            return
        # Gewichteter gleitender Durchschnitt – neueste Runde am höchsten
        recent = kart.lap_times_us[-window:]
        if not recent:
            return
        weights = list(range(1, len(recent) + 1))  # älteste=1, neueste=N
        total_weight = sum(weights)
        wma = int(sum(w * x for w, x in zip(weights, recent)) / total_weight)
        if wma <= threshold:
            return
        # Alarm! Einmalig pro Lauf je Kart
        self._defect_alerted.add(kart.kart_nr)
        await hub.broadcast({
            "type": "defect_alert",
            "kart_nr": kart.kart_nr,
            "name": kart.name,
            "class": kart_class,
            "wma_us": wma,
            "threshold_us": threshold,
            "laps": kart.laps,
        })

    def snapshot(self) -> dict:
        sorted_karts = self._sorted_karts()
        return {
            "run_id": self.run_id,
            "run": {
                "id": self.run_id,
                "name": self.run["name"] if self.run else None,
                "mode": self.run["mode"] if self.run else None,
                "status": self.status,
                "remaining_sec": int(self.remaining_sec),
                "elapsed_sec": int(self.elapsed_sec),
                "timer_running": self.status == "running",
                "finish_phase": self._finish_phase,
                "finish_remaining_sec": self._finish_remaining(),
                "finish_wait_total": self._finish_wait_total,
            } if self.run else None,
            "karts": self._build_kart_dicts(sorted_karts),
        }


engine = RaceEngine()
