import aiosqlite
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "emslandring.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT    NOT NULL,
    run_number   INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    mode         TEXT    NOT NULL DEFAULT 'training',
    duration_sec INTEGER NOT NULL DEFAULT 420,
    gp_laps      INTEGER,
    status       TEXT    NOT NULL DEFAULT 'pending',
    started_at   REAL,
    finished_at  REAL,
    UNIQUE(date, run_number)
);

CREATE TABLE IF NOT EXISTS run_kart_names (
    run_id  INTEGER NOT NULL,
    kart_nr INTEGER NOT NULL,
    name    TEXT    NOT NULL,
    PRIMARY KEY (run_id, kart_nr)
);

CREATE TABLE IF NOT EXISTS passings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER NOT NULL,
    transponder_id INTEGER NOT NULL,
    kart_nr        INTEGER,
    timestamp_us   INTEGER NOT NULL,
    lap_time_us    INTEGER,
    strength       INTEGER,
    hits           INTEGER
);

CREATE TABLE IF NOT EXISTS decoder_health (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at INTEGER NOT NULL,
    noise       INTEGER,
    loop_signal INTEGER
);

-- Customer-Claims für Bestenlisten-Einträge:
-- Wenn ein Kart eine Rekord-Runde fährt, generieren wir ein Token,
-- drucken QR-Code mit URL /record/<token>. Customer scannt, trägt
-- seinen Namen ein → name wird in Bestenliste statt "Kart 12" angezeigt.
-- Locked nach 24h: ab claimed_at + 86400s können Namen nicht mehr
-- geändert werden (verhindert verspätete Sabotage durch andere).
CREATE TABLE IF NOT EXISTS record_claims (
    passing_id  INTEGER PRIMARY KEY,
    token       TEXT    NOT NULL UNIQUE,
    name        TEXT,
    claimed_at  REAL,
    created_at  REAL    NOT NULL,
    FOREIGN KEY (passing_id) REFERENCES passings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_record_claims_token ON record_claims(token);

-- Indizes für Performance bei wachsender Datenmenge
-- (ohne idx_passings_transponder_id würden GROUP BY und Window-
-- Funktionen wie ROW_NUMBER() OVER (PARTITION BY transponder_id ...)
-- bei vielen 1000 Passings einen full-table-scan brauchen.
-- Mit Index: O(log n) lookups, Defekt-Erkennung bleibt schnell auch
-- bei mehreren 100k Passings).
CREATE INDEX IF NOT EXISTS idx_passings_transponder_id ON passings(transponder_id);
CREATE INDEX IF NOT EXISTS idx_passings_run_id         ON passings(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_date               ON runs(date);
CREATE INDEX IF NOT EXISTS idx_decoder_health_recorded ON decoder_health(recorded_at);
"""


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_SCHEMA)
        await db.commit()


async def get_runs_for_date(date: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM runs WHERE date = ? ORDER BY run_number", (date,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_stale_active_runs(before_date: str | None = None) -> list[dict]:
    """Liefert Läufe die noch in einem aktiven Status (armed/running/
    paused/finishing) hängen. Wenn ``before_date`` gesetzt ist, werden
    nur Läufe **vor** diesem Datum zurückgegeben (z.B. Tagesübergang).
    Sonst alle aktiven Läufe (z.B. nach Server-Crash/-Neustart)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if before_date:
            sql = ("SELECT * FROM runs "
                   "WHERE status IN ('armed','running','paused','finishing') "
                   "  AND date < ? "
                   "ORDER BY date, run_number")
            params = (before_date,)
        else:
            sql = ("SELECT * FROM runs "
                   "WHERE status IN ('armed','running','paused','finishing') "
                   "ORDER BY date, run_number")
            params = ()
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_run(run_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def create_run(date: str, run_number: int, name: str,
                     duration_sec: int = 420) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO runs (date, run_number, name, duration_sec)"
            " VALUES (?, ?, ?, ?)",
            (date, run_number, name, duration_sec),
        )
        await db.commit()
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM runs WHERE date = ? AND run_number = ?", (date, run_number)
        ) as cur:
            row = await cur.fetchone()
    return dict(row)


async def update_run(run_id: int, **kwargs) -> None:
    if not kwargs:
        return
    fields = ", ".join(f"{k} = ?" for k in kwargs)
    values = list(kwargs.values()) + [run_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE runs SET {fields} WHERE id = ?", values)
        await db.commit()


async def add_passing(run_id: int, transponder_id: int, kart_nr: int | None,
                      timestamp_us: int, lap_time_us: int | None,
                      strength: int, hits: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO passings"
            " (run_id, transponder_id, kart_nr, timestamp_us, lap_time_us, strength, hits)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (run_id, transponder_id, kart_nr, timestamp_us, lap_time_us, strength, hits),
        )
        await db.commit()


async def get_passings_for_run(run_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM passings WHERE run_id = ? ORDER BY timestamp_us", (run_id,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_last_lap_times(transponder_id: int, limit: int = 50) -> list[dict]:
    """Letzte N Rundenzeiten eines Transponders (chronologisch absteigend
    – neueste zuerst). Nur gewertete Runden (lap_time_us NOT NULL)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT p.id, p.lap_time_us, p.timestamp_us, p.strength,
                      p.run_id, r.date AS run_date, r.started_at AS run_started_at
               FROM passings p
               LEFT JOIN runs r ON p.run_id = r.id
               WHERE p.transponder_id = ? AND p.lap_time_us IS NOT NULL
               ORDER BY p.id DESC
               LIMIT ?""",
            (transponder_id, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_recent_lap_times_bulk(limit_per_transponder: int = 50) -> dict[int, list[int]]:
    """Holt für ALLE Transponder die letzten N gewerteten Rundenzeiten
    in einem Call. Rückgabe: {transponder_id: [lap_time_us, …]} mit
    neueste zuerst.

    Effizient implementiert per ROW_NUMBER() Window-Funktion – nur ein
    SQLite-Roundtrip statt einer Query pro Transponder.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT transponder_id, lap_time_us FROM (
                   SELECT transponder_id, lap_time_us,
                          ROW_NUMBER() OVER (
                              PARTITION BY transponder_id
                              ORDER BY id DESC
                          ) AS rn
                   FROM passings
                   WHERE lap_time_us IS NOT NULL
               )
               WHERE rn <= ?
               ORDER BY transponder_id, rn""",
            (limit_per_transponder,),
        ) as cur:
            rows = await cur.fetchall()
    result: dict[int, list[int]] = {}
    for r in rows:
        result.setdefault(r["transponder_id"], []).append(r["lap_time_us"])
    return result


async def set_run_kart_name(run_id: int, kart_nr: int, name: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO run_kart_names (run_id, kart_nr, name)"
            " VALUES (?, ?, ?)",
            (run_id, kart_nr, name),
        )
        await db.commit()


async def get_run_kart_names(run_id: int) -> dict[int, str]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT kart_nr, name FROM run_kart_names WHERE run_id = ?", (run_id,)
        ) as cur:
            rows = await cur.fetchall()
    return {r["kart_nr"]: r["name"] for r in rows}


async def add_health_record(recorded_at: int, noise: int, loop_signal: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO decoder_health (recorded_at, noise, loop_signal)"
            " VALUES (?, ?, ?)",
            (recorded_at, noise, loop_signal),
        )
        await db.commit()


async def get_health_history(since_unix: int | None = None,
                             max_points: int = 1000) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if since_unix:
            async with db.execute(
                "SELECT COUNT(*) FROM decoder_health WHERE recorded_at >= ?",
                (since_unix,)
            ) as cur:
                total = (await cur.fetchone())[0]
            interval = max(1, total // max_points)
            async with db.execute(
                """SELECT id, recorded_at, noise, loop_signal,
                          ROW_NUMBER() OVER (ORDER BY recorded_at) as rn
                   FROM decoder_health WHERE recorded_at >= ?
                   ORDER BY recorded_at ASC""",
                (since_unix,)
            ) as cur:
                rows = await cur.fetchall()
            result = [dict(r) for r in rows if r["rn"] % interval == 0 or r["rn"] == 1]
            # Gleiche Reihenfolge wie ungefilterter Pfad (DESC) damit JS .reverse() passt
            result.sort(key=lambda r: r["recorded_at"], reverse=True)
            return result
        else:
            async with db.execute(
                "SELECT * FROM decoder_health ORDER BY recorded_at DESC LIMIT ?",
                (max_points,)
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_transponders_per_run(run_ids: list[int]) -> dict[int, list[int]]:
    if not run_ids:
        return {}
    placeholders = ",".join("?" for _ in run_ids)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT DISTINCT run_id, transponder_id FROM passings "
            f"WHERE run_id IN ({placeholders})",
            run_ids,
        ) as cur:
            rows = await cur.fetchall()
    result: dict[int, list[int]] = {}
    for r in rows:
        result.setdefault(r["run_id"], []).append(r["transponder_id"])
    return result


async def get_transponder_stats() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT
                transponder_id,
                kart_nr,
                COUNT(*)                                                       AS passing_count,
                SUM(CASE WHEN lap_time_us IS NOT NULL THEN lap_time_us ELSE 0 END) AS total_us,
                MAX(strength)                                                  AS max_strength,
                CAST(AVG(strength) AS INTEGER)                                 AS avg_strength,
                MAX(timestamp_us)                                              AS last_seen_us
            FROM passings
            GROUP BY transponder_id
            ORDER BY kart_nr NULLS LAST, transponder_id
        """) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_best_laps_since(since_unix: float, transponder_ids: list[int] | None = None,
                              limit_per_kart: int = 1,
                              mode: str = "per_kart") -> list[dict]:
    """Beste Rundenzeiten seit since_unix für die Bestenliste.

    ``mode``:
      * ``"per_kart"`` (Standard): pro Kart max. ``limit_per_kart`` Runden –
        die schnellsten. Klassisches Ranking.
      * ``"per_run"``: pro (Kart, Lauf) max. 1 Runde – die schnellste
        dieses Karts in diesem Lauf. Karts können mehrfach in der
        Liste auftauchen wenn sie in verschiedenen Läufen Top-Zeiten
        gefahren haben.

    Optional gefiltert auf eine Liste Transponder-IDs (Klassen-Filter).
    Rückgabe: [{transponder_id, kart_nr, lap_time_us, timestamp_us,
                run_id, run_date, run_started_at, run_kart_name, claim_name}]
    """
    # Namens-Priorität (höchste zuerst):
    #   1. rc.name   = Customer hat sich via QR-Scan selbst eingetragen
    #   2. rkn.name  = Operator hat im Lauf einen Namen vergeben
    #   3. (Frontend-Fallback)  globaler Kart-Name aus der Konfiguration
    q = """
      SELECT p.transponder_id, p.kart_nr, p.lap_time_us, p.timestamp_us,
             r.date AS run_date, r.started_at AS run_started_at, p.id AS pid,
             p.run_id AS run_id,
             rkn.name AS run_kart_name,
             rc.name  AS claim_name,
             rc.passing_id AS claim_passing_id
      FROM passings p
      JOIN runs r ON p.run_id = r.id
      LEFT JOIN run_kart_names rkn
             ON rkn.run_id = p.run_id AND rkn.kart_nr = p.kart_nr
      LEFT JOIN record_claims rc
             ON rc.passing_id = p.id
      WHERE p.lap_time_us IS NOT NULL
        AND r.started_at >= ?
    """
    params: list = [since_unix]
    if transponder_ids:
        placeholders = ",".join("?" for _ in transponder_ids)
        q += f" AND p.transponder_id IN ({placeholders})"
        params.extend(transponder_ids)
    q += " ORDER BY p.lap_time_us ASC"

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(q, params) as cur:
            rows = await cur.fetchall()

    # rows ist bereits nach lap_time_us ASC sortiert. Wir dedupen je
    # nach Modus und behalten dabei automatisch die schnellste Runde
    # pro Bucket.
    if mode == "per_run":
        # Bucket = (transponder_id, run_id) → max. 1 Eintrag pro Bucket
        seen: set[tuple[int, int]] = set()
        result: list[dict] = []
        for r in rows:
            key = (r["transponder_id"], r["run_id"])
            if key in seen:
                continue
            seen.add(key)
            result.append(dict(r))
    else:
        # Klassisch: max. ``limit_per_kart`` Einträge pro Kart
        best: dict[int, list[dict]] = {}
        for r in rows:
            tid = r["transponder_id"]
            lst = best.setdefault(tid, [])
            if len(lst) < limit_per_kart:
                lst.append(dict(r))
        result = [d for lst in best.values() for d in lst]

    result.sort(key=lambda d: d["lap_time_us"])
    return result


async def delete_passing(passing_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        # Claim hängt per FK an der Passing-ID – beim Löschen der Runde
        # geht auch der Name automatisch weg (ON DELETE CASCADE).
        await db.execute("DELETE FROM passings WHERE id = ?", (passing_id,))
        await db.commit()


# ── Bestenlisten-Claims (Customer-eingetragene Namen) ──────────────────────

async def get_or_create_claim_token(passing_id: int) -> str:
    """Token für ein Passing holen – wird beim ersten Aufruf erzeugt.

    Idempotent: mehrfaches Drucken derselben Rekord-Runde produziert
    immer denselben Token (= dieselbe QR-URL).
    """
    import secrets, time
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT token FROM record_claims WHERE passing_id = ?", (passing_id,)
        ) as cur:
            row = await cur.fetchone()
        if row:
            return row["token"]
        # Neuer Token – 11 Zeichen URL-safe (~64 Bit Entropie).
        token = secrets.token_urlsafe(8)
        await db.execute(
            "INSERT INTO record_claims (passing_id, token, created_at) VALUES (?, ?, ?)",
            (passing_id, token, time.time()),
        )
        await db.commit()
        return token


async def get_claim_by_token(token: str) -> dict | None:
    """Claim-Daten anhand des Tokens – inkl. Passing- und Lauf-Metadaten."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT c.passing_id, c.token, c.name, c.claimed_at, c.created_at,
                      p.transponder_id, p.kart_nr, p.lap_time_us, p.run_id,
                      r.date AS run_date, r.name AS run_name
               FROM record_claims c
               JOIN passings p ON p.id = c.passing_id
               JOIN runs     r ON r.id = p.run_id
               WHERE c.token = ?""",
            (token,),
        ) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None


async def set_claim_name(token: str, name: str) -> bool:
    """Setzt den Customer-Namen. Gibt True zurück bei Erfolg, False
    wenn Token nicht existiert oder bereits gelocked (>24 h nach
    erstem Eintrag)."""
    import time
    now = time.time()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT claimed_at FROM record_claims WHERE token = ?", (token,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return False
        if row["claimed_at"] is not None and now - row["claimed_at"] > 86400:
            # 24 h Lock abgelaufen → kein Update mehr erlaubt.
            return False
        # claimed_at wird beim ERSTEN Setzen geschrieben; spätere Updates
        # (innerhalb 24 h) lassen claimed_at unverändert, sonst würde der
        # Lock-Timer immer neu starten.
        if row["claimed_at"] is None:
            await db.execute(
                "UPDATE record_claims SET name = ?, claimed_at = ? WHERE token = ?",
                (name, now, token),
            )
        else:
            await db.execute(
                "UPDATE record_claims SET name = ? WHERE token = ?",
                (name, token),
            )
        await db.commit()
        return True


async def delete_claim(passing_id: int) -> None:
    """Admin-Reset: Claim-Eintrag löschen – Name fällt zurück auf
    Default (Kart-Override aus Lauf, sonst globaler Name)."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM record_claims WHERE passing_id = ?", (passing_id,)
        )
        await db.commit()


async def get_transponder_strength_history(transponder_id: int,
                                           since_unix: int | None = None,
                                           max_points: int = 1000) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if since_unix:
            # Join with runs to filter by real-world time (started_at is Unix timestamp)
            async with db.execute(
                """SELECT COUNT(*) FROM passings p
                   JOIN runs r ON p.run_id = r.id
                   WHERE p.transponder_id = ? AND r.started_at >= ?""",
                (transponder_id, since_unix)
            ) as cur:
                total = (await cur.fetchone())[0]
            interval = max(1, total // max_points)
            async with db.execute(
                """SELECT p.timestamp_us, p.strength, p.hits,
                          ROW_NUMBER() OVER (ORDER BY p.id) as rn
                   FROM passings p
                   JOIN runs r ON p.run_id = r.id
                   WHERE p.transponder_id = ? AND r.started_at >= ?
                   ORDER BY p.id ASC""",
                (transponder_id, since_unix)
            ) as cur:
                rows = await cur.fetchall()
            result = [dict(r) for r in rows if r["rn"] % interval == 0 or r["rn"] == 1]
            # Gleiche Reihenfolge wie ungefilterter Pfad (DESC) damit JS .reverse() passt
            result.sort(key=lambda r: r["timestamp_us"], reverse=True)
            return result
        else:
            async with db.execute(
                "SELECT timestamp_us, strength, hits FROM passings"
                " WHERE transponder_id = ?"
                " ORDER BY id DESC LIMIT ?",
                (transponder_id, max_points),
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]
