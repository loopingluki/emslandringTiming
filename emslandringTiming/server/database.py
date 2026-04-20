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


async def get_health_history(limit: int = 500) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM decoder_health ORDER BY recorded_at DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


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


async def get_transponder_strength_history(transponder_id: int,
                                           limit: int = 300) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT timestamp_us, strength, hits FROM passings"
            " WHERE transponder_id = ?"
            " ORDER BY timestamp_us DESC LIMIT ?",
            (transponder_id, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]
