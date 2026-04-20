from datetime import date as _date
import database
import config as cfg


async def ensure_today_runs() -> None:
    today = _date.today().isoformat()
    existing = await database.get_runs_for_date(today)
    if existing:
        return
    n = cfg.get()["runs_per_day"]
    dur = cfg.get()["training_duration_sec"]
    for i in range(1, n + 1):
        await database.create_run(today, i, f"Lauf {i}", duration_sec=dur)


async def get_runs(date_str: str) -> list[dict]:
    return await database.get_runs_for_date(date_str)


async def add_run(date_str: str) -> dict:
    existing = await database.get_runs_for_date(date_str)
    next_number = max((r["run_number"] for r in existing), default=0) + 1
    dur = cfg.get()["training_duration_sec"]
    return await database.create_run(
        date_str, next_number, f"Lauf {next_number}", duration_sec=dur
    )


async def update_run_settings(
    run_id: int,
    mode: str | None = None,
    duration_sec: int | None = None,
    gp_laps: int | None = None,
    name: str | None = None,
) -> dict | None:
    updates: dict = {}
    if mode is not None:
        updates["mode"] = mode
    if duration_sec is not None:
        updates["duration_sec"] = duration_sec
    if gp_laps is not None:
        updates["gp_laps"] = gp_laps
    if name is not None:
        updates["name"] = name
    if updates:
        await database.update_run(run_id, **updates)
    return await database.get_run(run_id)


async def get_run_with_karts(run_id: int) -> dict | None:
    run = await database.get_run(run_id)
    if not run:
        return None
    passings = await database.get_passings_for_run(run_id)
    kart_names = await database.get_run_kart_names(run_id)

    karts: dict[int, dict] = {}
    for p in passings:
        kart_nr = p["kart_nr"]
        if kart_nr is None:
            continue
        if kart_nr not in karts:
            global_name = cfg.get_kart_name(p["transponder_id"])
            karts[kart_nr] = {
                "kart_nr": kart_nr,
                "name": kart_names.get(kart_nr, global_name),
                "laps": 0,
                "best_us": None,
                "last_us": None,
                "lap_times_us": [],
                "strength": p["strength"] or 0,
                "last_passing_ts": p["timestamp_us"] / 1_000_000,
            }
        k = karts[kart_nr]
        k["strength"] = p["strength"] or 0
        k["last_passing_ts"] = p["timestamp_us"] / 1_000_000
        if p["lap_time_us"] is not None:
            k["laps"] += 1
            k["lap_times_us"].append(p["lap_time_us"])
            k["last_us"] = p["lap_time_us"]
            if k["best_us"] is None or p["lap_time_us"] < k["best_us"]:
                k["best_us"] = p["lap_time_us"]

    kart_list = _sort_karts(list(karts.values()), run["mode"])
    for i, k in enumerate(kart_list):
        k["position"] = i + 1

    run["karts"] = kart_list
    return run


def _sort_karts(karts: list[dict], mode: str) -> list[dict]:
    if mode == "training":
        return sorted(
            karts,
            key=lambda k: (k["best_us"] is None, k["best_us"] or 0),
        )
    return sorted(
        karts,
        key=lambda k: (-k["laps"], k["lap_times_us"] and sum(k["lap_times_us"]) or 0),
    )
