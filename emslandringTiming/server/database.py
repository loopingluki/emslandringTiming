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
                              limit_per_kart: int = 1) -> list[dict]:
    """Beste Rundenzeit pro Kart (Transponder) seit since_unix.
    Optional gefiltert auf eine Liste Transponder-IDs (für Klassen-Filter).
    Rückgabe: [{transponder_id, kart_nr, lap_time_us, timestamp_us, run_date, run_started_at}]
    """
    q = """
      SELECT p.transponder_id, p.kart_nr, p.lap_time_us, p.timestamp_us,
             r.date AS run_date, r.started_at AS run_started_at, p.id AS pid
      FROM passings p
      JOIN runs r ON p.run_id = r.id
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
        await db.execute("DELETE FROM passings WHERE id = ?", (passing_id,))
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
