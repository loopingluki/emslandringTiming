"""
emslandringTiming – Haupteinstiegspunkt.
Startet FastAPI, Decoder, Emulator und Race-Engine.
"""
import asyncio
import sys
import time
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config as cfg
import database
import run_manager
from decoder import decoder
from emulator import emulator
from race_engine import engine
from ws_hub import hub

BASE = Path(__file__).parent.parent
WEB_TEMPLATES = BASE / "web" / "templates"
WEB_STATIC = BASE / "web" / "static"

_last_health_write: float = 0.0


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await database.init_db()
    await run_manager.ensure_today_runs()

    c = cfg.get()
    decoder.set_callbacks(
        on_passing=_on_passing,
        on_heartbeat=_on_heartbeat,
    )
    decoder.start(c["decoder_ip"], c["decoder_port"])
    await emulator.start(c["emulator_port"])

    # Läufe die beim letzten Absturz im Status running/paused/armed steckten → done
    runs = await database.get_runs_for_date(date.today().isoformat())
    for r in runs:
        if r["status"] in ("running", "paused", "finishing", "armed"):
            await database.update_run(r["id"], status="done")

    yield

    await decoder.stop()
    await emulator.stop()


# ── Callbacks ─────────────────────────────────────────────────────────────────

async def _on_passing(transponder_id: int, timestamp_us: int,
                       strength: int, hits: int) -> None:
    await engine.on_passing(transponder_id, timestamp_us, strength, hits)


async def _on_heartbeat(connected: bool, noise: int, loop: int) -> None:
    global _last_health_write
    await hub.broadcast({
        "type": "decoder_health",
        "connected": connected,
        "noise": noise,
        "loop": loop,
    })
    now = int(time.time())
    if now - _last_health_write >= 60:
        _last_health_write = now
        await database.add_health_record(now, noise, loop)


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="emslandringTiming", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(WEB_STATIC)), name="static")


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await hub.connect(ws)
    try:
        today = date.today().isoformat()
        runs = await database.get_runs_for_date(today)
        snap = engine.snapshot()
        await hub.send(ws, {
            "type": "snapshot",
            "run": snap["run"],
            "karts": snap["karts"],
            "runs_today": runs,
            "decoder": {
                "connected": decoder.connected,
                "noise": decoder.noise,
                "loop": decoder.loop,
            },
        })
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(ws)


# ── HTML ──────────────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(WEB_TEMPLATES / "index.html")


# ── Runs API ──────────────────────────────────────────────────────────────────

@app.get("/api/runs")
async def api_runs(date: str = ""):
    d = date or _today()
    return await run_manager.get_runs(d)


@app.post("/api/runs")
async def api_add_run():
    return await run_manager.add_run(_today())


@app.get("/api/runs/{run_id}")
async def api_get_run(run_id: int):
    if engine.run_id == run_id and engine.status not in ("none", "done"):
        # Aktiver Lauf: Live-Daten aus engine
        snap = engine.snapshot()
        run = await database.get_run(run_id)
        run["status"] = engine.status
        run["karts"] = snap["karts"]
        return run
    result = await run_manager.get_run_with_karts(run_id)
    if not result:
        raise HTTPException(404, "Lauf nicht gefunden")
    return result


@app.patch("/api/runs/{run_id}")
async def api_update_run(run_id: int, body: dict):
    # Zeitänderung während aktiven Laufs
    if "duration_sec" in body and engine.run_id == run_id:
        current = engine.run["duration_sec"] if engine.run else 0
        delta = body["duration_sec"] - current
        await engine.adjust_time(delta)
    result = await run_manager.update_run_settings(
        run_id,
        mode=body.get("mode"),
        duration_sec=body.get("duration_sec"),
        gp_laps=body.get("gp_laps"),
        name=body.get("name"),
    )
    if engine.run_id == run_id and engine.run:
        engine.run.update({k: v for k, v in result.items() if k in engine.run})
    await hub.broadcast({"type": "run_updated", "run": result})
    return result


@app.post("/api/runs/{run_id}/arm")
async def api_arm(run_id: int):
    try:
        await engine.arm(run_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/runs/{run_id}/start")
async def api_start_gp(run_id: int):
    if engine.run_id != run_id:
        raise HTTPException(400, "Lauf ist nicht scharf geschaltet")
    try:
        await engine.start_gp()
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/runs/{run_id}/pause")
async def api_pause(run_id: int):
    if engine.run_id != run_id:
        raise HTTPException(400, "Lauf nicht aktiv")
    await engine.pause()
    return {"ok": True}


@app.post("/api/runs/{run_id}/resume")
async def api_resume(run_id: int):
    if engine.run_id != run_id:
        raise HTTPException(400, "Lauf nicht aktiv")
    await engine.resume()
    return {"ok": True}


@app.post("/api/runs/{run_id}/abort")
async def api_abort(run_id: int):
    if engine.run_id != run_id:
        raise HTTPException(400, "Lauf nicht aktiv")
    await engine.abort()
    return {"ok": True}


@app.post("/api/runs/{run_id}/kart-name")
async def api_kart_name(run_id: int, body: dict):
    kart_nr = body.get("kart_nr")
    name = body.get("name", "").strip()
    if not kart_nr or not name:
        raise HTTPException(400, "kart_nr und name erforderlich")
    await engine.set_kart_name(kart_nr, name)
    await database.set_run_kart_name(run_id, kart_nr, name)
    return {"ok": True}


# ── Settings API ──────────────────────────────────────────────────────────────

@app.get("/api/settings")
async def api_get_settings():
    c = cfg.get().copy()
    c.pop("transponders", None)
    return c


@app.post("/api/settings")
async def api_save_settings(body: dict):
    body.pop("transponders", None)
    cfg.save(body)
    return {"ok": True}


# ── Transponders API ──────────────────────────────────────────────────────────

@app.get("/api/transponders")
async def api_transponders():
    stats = await database.get_transponder_stats()
    transponders = cfg.get()["transponders"]
    result = []
    for t_id_str, info in transponders.items():
        t_id = int(t_id_str)
        stat = next((s for s in stats if s["transponder_id"] == t_id), {})
        result.append({
            "transponder_id": t_id,
            "kart_nr": info["kart_nr"],
            "name": info["name"],
            "class": info["class"],
            "passing_count": stat.get("passing_count", 0),
            "total_us": stat.get("total_us", 0),
            "avg_strength": stat.get("avg_strength", 0),
            "last_seen_us": stat.get("last_seen_us"),
        })
    result.sort(key=lambda x: x["kart_nr"])
    return result


@app.get("/api/transponders/{transponder_id}/history")
async def api_transponder_history(transponder_id: int):
    return await database.get_transponder_strength_history(transponder_id)


@app.post("/api/transponders/{transponder_id}")
async def api_update_transponder(transponder_id: int, body: dict):
    c = cfg.get()
    key = str(transponder_id)
    if key not in c["transponders"]:
        raise HTTPException(404, "Transponder nicht gefunden")
    allowed = {"name", "class", "kart_nr"}
    updates = {k: v for k, v in body.items() if k in allowed}
    c["transponders"][key].update(updates)
    cfg.save({"transponders": c["transponders"]})
    return {"ok": True}


# ── Health history API ────────────────────────────────────────────────────────

@app.get("/api/decoder/health")
async def api_decoder_health():
    return await database.get_health_history(limit=1000)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _today() -> str:
    from datetime import date as _d
    return _d.today().isoformat()


# ── Startpunkt ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    c = cfg.get()
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=c["http_port"],
        reload=False,
        log_level="info",
    )
