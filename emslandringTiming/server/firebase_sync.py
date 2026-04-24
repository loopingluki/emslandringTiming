"""
Firebase Sync – schreibt einen abgeschlossenen Lauf nach Firestore.

Format 100 % kompatibel mit mylaps_server.py, sodass analyse.html
weiterhin ohne Änderungen funktioniert.

Zusätzliche Felder (rückwärtskompatibel, werden von analyse.html ignoriert):
  sessions/{id}.decoder          → { avg_noise, avg_loop }   Decoder-Gesundheit
  sessions/{id}.run_number       → laufende Nummer des Tages
  sessions/{id}.run_name         → interner Name ("Lauf 3")
  sessions/{id}.source           → "emslandringTiming"
  kart_details/{nr}.signal_strengths  → [int, …] Stärke je Durchfahrt
  kart_details/{nr}.avg_strength      → Durchschnittliche Signalstärke

Wird aufgerufen von race_engine._finalize() nach Lauf-Ende (nicht-blockierend,
läuft in einem Hintergrund-Thread damit der Event-Loop nicht blockiert wird).

firebase-admin muss installiert sein:
  pip install firebase-admin
Der Pfad zum Service-Account-JSON wird in config.json unter
"firebase_credentials" gesetzt.
"""

import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import config as cfg
import database

# Lokale Zeitzone für Anzeige (Sommer-/Winterzeit automatisch)
LOCAL_TZ = ZoneInfo("Europe/Berlin")

# firebase-admin ist optional – nur aktiv wenn installiert + konfiguriert
try:
    import firebase_admin
    from firebase_admin import credentials, firestore as _fs
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False

_db = None
_init_done = False


# ── Initialisierung ────────────────────────────────────────────────────────────

def _init() -> bool:
    """
    Initialisiert Firebase einmalig. Gibt True zurück wenn bereit.
    Gibt False zurück wenn Paket fehlt oder kein Credentials-Pfad gesetzt.
    """
    global _db, _init_done
    if _init_done:
        return _db is not None
    _init_done = True

    if not _AVAILABLE:
        print("[firebase_sync] firebase-admin nicht installiert – kein Upload.")
        return False

    cred_path = cfg.get().get("firebase_credentials", "").strip()
    if not cred_path:
        return False

    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
        _db = _fs.client()
        print("[firebase_sync] Firebase initialisiert.")
        return True
    except Exception as exc:
        print(f"[firebase_sync] Init fehlgeschlagen: {exc}")
        return False


def reset_init() -> None:
    """Erzwingt Re-Initialisierung (z.B. nach Credentials-Änderung in Settings)."""
    global _db, _init_done
    _db = None
    _init_done = False


# ── Hilfsfunktionen ────────────────────────────────────────────────────────────

def _us_to_laptime(us: int) -> str:
    """Konvertiert Mikrosekunden in das MyLaps-Stringformat 'M:SS.mmm'."""
    ms = us // 1000
    minutes = ms // 60000
    seconds = (ms % 60000) // 1000
    millis  = ms % 1000
    return f"{minutes}:{seconds:02d}.{millis:03d}"


def _kart_category(kart_nr: int) -> str:
    """Kart-Nummer → Kategorie-String (identisch zu mylaps_server.py)."""
    n = int(kart_nr)
    if  1 <= n <=  9: return "mini"
    if 10 <= n <= 29: return "leih"
    if 30 <= n <= 49: return "renn"
    if 50 <= n <= 56: return "super"
    if 57 <= n <= 60: return "doppel"
    return "other"


# ── Haupt-Sync-Funktion ────────────────────────────────────────────────────────

async def sync_run(run_id: int) -> bool:
    """
    Synchronisiert einen abgeschlossenen Lauf nach Firestore.

    Liest alle nötigen Daten aus SQLite, baut das Firestore-Dokument auf
    und schreibt es in einem Hintergrund-Thread (nicht-blockierend).

    Rückgabe: True wenn Schreib-Thread gestartet, False wenn Firebase
    nicht konfiguriert oder Lauf noch nicht 'done'.
    """
    if not _init():
        return False

    run = await database.get_run(run_id)
    if not run or run["status"] != "done":
        return False

    passings      = await database.get_passings_for_run(run_id)
    started_at    = run["started_at"]  or 0.0
    finished_at   = run["finished_at"] or time.time()

    # Decoder-Health während des Laufs aus SQLite lesen
    all_health = await database.get_health_history(
        since_unix=int(started_at) - 5,   # -5s Puffer
        max_points=500,
    )
    run_health = [
        h for h in all_health
        if started_at - 5 <= h["recorded_at"] <= finished_at + 5
    ]
    avg_noise = (
        round(sum(h["noise"] for h in run_health) / len(run_health), 1)
        if run_health else 0
    )
    avg_loop = (
        round(sum(h["loop_signal"] for h in run_health) / len(run_health), 1)
        if run_health else 0
    )

    # ── Karts aus Passings aggregieren ────────────────────────────────────────
    karts: dict[int, dict] = {}
    for p in passings:
        kart_nr = p["kart_nr"]
        if kart_nr is None:
            continue
        if kart_nr not in karts:
            karts[kart_nr] = {
                "name":             cfg.get_kart_name(p["transponder_id"]),
                "laps":             0,
                "best_lap_us":      None,
                "total_time_us":    0,
                "lap_times_us":     [],
                "signal_strengths": [],
            }
        k = karts[kart_nr]
        if p.get("strength"):
            k["signal_strengths"].append(p["strength"])
        if p["lap_time_us"] is not None:
            k["laps"]           += 1
            k["lap_times_us"].append(p["lap_time_us"])
            k["total_time_us"]  += p["lap_time_us"]
            if k["best_lap_us"] is None or p["lap_time_us"] < k["best_lap_us"]:
                k["best_lap_us"] = p["lap_time_us"]

    # Nur Karts mit ≥ 1 gewerteter Runde
    driven = {nr: k for nr, k in karts.items() if k["laps"] > 0}

    # ── category_breakdown ────────────────────────────────────────────────────
    cat_breakdown = {
        "mini": 0, "leih": 0, "renn": 0,
        "super": 0, "doppel": 0, "other": 0,
    }
    for nr in driven:
        cat_breakdown[_kart_category(nr)] += 1

    # ── Zeitfelder (lokale Zeit Europe/Berlin für Anzeige) ────────────────────
    start_dt        = datetime.fromtimestamp(started_at,  tz=LOCAL_TZ)
    end_dt          = datetime.fromtimestamp(finished_at, tz=LOCAL_TZ)
    duration_minutes = max(0, int((finished_at - started_at) / 60))

    mode       = "grandprix" if run["mode"] in ("gp_time", "gp_laps") else "training"
    group_name = "RACE" if mode == "grandprix" else f"Gruppe {run['run_number']}"

    # ── Firestore-Dokument (sessions/{run_id}) ────────────────────────────────
    session_doc = {
        # Pflichtfelder – identisch zu mylaps_server.py (analyse.html)
        "group_name":         group_name,
        # Datum aus tatsächlichem Start-Zeitstempel in lokaler Zone ableiten –
        # so stimmt es auch bei Läufen kurz vor/nach Mitternacht, unabhängig
        # davon welche Zeitzone der Server hat.
        "date":               start_dt.strftime("%Y-%m-%d"),
        "start_time":         start_dt.strftime("%H:%M:%S"),
        "end_time":           end_dt.strftime("%H:%M:%S"),
        "duration_minutes":   duration_minutes,
        "kart_count":         len(driven),
        "karts":              [str(nr) for nr in sorted(driven.keys())],
        "category_breakdown": cat_breakdown,
        "mode":               mode,
        "recorded_at":        datetime.utcnow().isoformat() + "Z",
        # Zusatzfelder (rückwärtskompatibel)
        "run_name":           run["name"],
        "run_number":         run["run_number"],
        "source":             "emslandringTiming",
        "decoder": {
            "avg_noise": avg_noise,
            "avg_loop":  avg_loop,
        },
    }

    # ── kart_details/{kart_nr} ────────────────────────────────────────────────
    kart_docs: dict[int, dict] = {}
    for kart_nr, k in driven.items():
        strengths = k["signal_strengths"]
        kart_docs[kart_nr] = {
            # Pflichtfelder – identisch zu mylaps_server.py (analyse.html)
            "name":       k["name"],
            "laps":       k["laps"],
            "best_lap":   _us_to_laptime(k["best_lap_us"]) if k["best_lap_us"] else None,
            "total_time": _us_to_laptime(k["total_time_us"]),
            "lap_times":  [_us_to_laptime(lt) for lt in k["lap_times_us"]],
            # Zusatzfelder
            "signal_strengths": strengths,
            "avg_strength": (
                round(sum(strengths) / len(strengths), 1) if strengths else 0
            ),
        }

    # ── In Hintergrund-Thread schreiben ───────────────────────────────────────
    def _write() -> None:
        try:
            ref = _db.collection("sessions").document(str(run_id))
            ref.set(session_doc, timeout=30)
            for kart_nr, doc in kart_docs.items():
                ref.collection("kart_details").document(str(kart_nr)).set(
                    doc, timeout=30
                )
            print(
                f"[firebase_sync] Lauf {run_id} ({run['date']}, "
                f"{len(kart_docs)} Karts) → Firestore OK"
            )
        except Exception as exc:
            print(f"[firebase_sync] Fehler bei Lauf {run_id}: {exc}")

    t = threading.Thread(target=_write, daemon=True, name=f"fb-sync-{run_id}")
    t.start()
    return True
