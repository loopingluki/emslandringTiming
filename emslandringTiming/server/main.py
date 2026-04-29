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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

import config as cfg
import database
import printer
import run_manager
from ampel import ampel
from decoder import decoder
from emulator import emulator
from race_engine import engine
from ws_hub import hub

BASE = Path(__file__).parent.parent
WEB_TEMPLATES = BASE / "web" / "templates"
WEB_STATIC = BASE / "web" / "static"

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
    hub.start_keepalive()
    ampel.start()
    health_task = asyncio.create_task(_health_logger_loop(), name="health-logger")

    # Läufe die beim letzten Absturz im Status running/paused/armed steckten → done
    runs = await database.get_runs_for_date(date.today().isoformat())
    for r in runs:
        if r["status"] in ("running", "paused", "finishing", "armed"):
            await database.update_run(r["id"], status="done")

    yield

    health_task.cancel()
    try:
        await health_task
    except asyncio.CancelledError:
        pass
    await hub.stop_keepalive()
    await decoder.stop()
    await emulator.stop()
    await ampel.stop()


# ── Callbacks ─────────────────────────────────────────────────────────────────

async def _on_passing(transponder_id: int, timestamp_us: int,
                       strength: int, hits: int) -> None:
    await hub.broadcast({
        "type": "debug_decoder",
        "ts": time.time(),
        "transponder_id": transponder_id,
        "timestamp_us": timestamp_us,
        "strength": strength,
        "hits": hits,
    })
    await engine.on_passing(transponder_id, timestamp_us, strength, hits)


async def _on_heartbeat(connected: bool, noise: int, loop: int) -> None:
    await hub.broadcast({
        "type": "decoder_health",
        "connected": connected,
        "noise": noise,
        "loop": loop,
    })
    # Auch in Debug-Log einspeisen, damit sichtbar ist, dass Daten ankommen
    await hub.broadcast({
        "type": "debug_decoder",
        "ts": time.time(),
        "heartbeat": True,
        "connected": connected,
        "noise": noise,
        "loop": loop,
    })
    # DB-Schreiben übernimmt der _health_logger_loop (alle 60s) – er
    # liest decoder.connected/noise/loop direkt und loggt im Disconnect-
    # Fall sauber 0/0 (statt der vorherigen Werte). Damit ist die
    # Health-Historie auch bei längeren Trennungen lückenlos.


async def _health_logger_loop() -> None:
    """Schreibt einmal pro Minute den aktuellen Decoder-Health in die
    Datenbank. Im Disconnect-Fall werden 0/0 geloggt (decoder.py setzt
    self.noise und self.loop bei Verbindungsverlust auf 0)."""
    while True:
        try:
            await asyncio.sleep(60)
            now = int(time.time())
            if decoder.connected:
                noise, loop = decoder.noise, decoder.loop
            else:
                noise, loop = 0, 0
            await database.add_health_record(now, noise, loop)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[health_logger] Fehler: {exc}")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="emslandringTiming", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(WEB_STATIC)), name="static")
app.mount("/fonts", StaticFiles(directory=str(BASE / "server" / "data" / "fonts")), name="fonts")


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, client: str = "app"):
    client_type = client if client in ("app", "dashboard") else "other"
    await hub.connect(ws, client_type)
    try:
        today = date.today().isoformat()
        runs = await run_manager.get_runs(today)
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
            "ampel": ampel.status_dict(),
        })
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
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


@app.get("/api/printers")
async def api_printers():
    import asyncio
    import shutil
    printers: list[dict] = []
    if shutil.which("lpstat"):
        try:
            proc = await asyncio.create_subprocess_exec(
                "lpstat", "-a",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            for line in out.decode("utf-8", "ignore").splitlines():
                name = line.split(" ", 1)[0].strip()
                if name:
                    printers.append({"name": name, "kind": "cups"})
        except Exception:
            pass
    # Zusätzlich: Netzwerkdrucker-Freitext (vom Nutzer in Config gepflegt)
    for p in cfg.get().get("network_printers", []) or []:
        printers.append({"name": p, "kind": "network"})
    return {"printers": printers, "selected": cfg.get().get("printer", "")}


@app.post("/api/settings")
async def api_save_settings(body: dict):
    body.pop("transponders", None)
    old = cfg.get()
    ip_changed   = body.get("decoder_ip")   != old.get("decoder_ip")
    port_changed = body.get("decoder_port") != old.get("decoder_port")
    cfg.save(body)
    if ip_changed or port_changed:
        await decoder.stop()
        c = cfg.get()
        decoder.start(c["decoder_ip"], c["decoder_port"])
    return {"ok": True}


@app.post("/api/runs/{run_id}/upload")
async def api_run_upload(run_id: int):
    """Manueller Firestore-Upload für einen bereits abgeschlossenen Lauf."""
    import firebase_sync
    run = await database.get_run(run_id)
    if not run:
        raise HTTPException(404, "Lauf nicht gefunden")
    if run["status"] != "done":
        raise HTTPException(400, f"Lauf hat Status '{run['status']}', nur 'done' kann hochgeladen werden")
    ok = await firebase_sync.sync_run(run_id)
    if not ok:
        raise HTTPException(500, "Firebase nicht konfiguriert oder Upload nicht möglich")
    return {"ok": True, "message": f"Upload für Lauf {run_id} gestartet (läuft im Hintergrund)"}


@app.get("/api/ampel")
async def api_ampel_get():
    return ampel.status_dict()


@app.post("/api/ampel")
async def api_ampel_set(body: dict):
    state = body.get("state", "off")
    if state not in ("off", "green", "red"):
        raise HTTPException(400, "Ungültiger Zustand: off | green | red")
    # force=True: Debug-Buttons senden immer, egal ob ampel_enabled
    force = bool(body.get("force", False))
    await ampel.send(state, force=force)
    return {"ok": True, "state": state, "cmd": ampel.last_cmd}


@app.post("/api/runs/{run_id}/disarm")
async def api_disarm(run_id: int):
    if engine.run_id != run_id:
        raise HTTPException(400, "Lauf ist nicht scharf geschaltet")
    try:
        await engine.disarm()
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/runs/{run_id}/skip")
async def api_skip_run(run_id: int):
    run = await database.get_run(run_id)
    if not run:
        raise HTTPException(404, "Lauf nicht gefunden")
    if run["status"] not in ("pending", "armed"):
        raise HTTPException(400, "Nur pending/armed Läufe können übersprungen werden")
    await database.update_run(run_id, status="skipped")
    await hub.broadcast({"type": "run_list", "runs": await run_manager.get_runs(run["date"])})
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
        offset_sec = info.get("offset_sec", 0)
        total_us = stat.get("total_us", 0) + offset_sec * 1_000_000
        result.append({
            "transponder_id": t_id,
            "kart_nr": info["kart_nr"],
            "name": info["name"],
            "class": info["class"],
            "offset_sec": offset_sec,
            "passing_count": stat.get("passing_count", 0),
            "total_us": total_us,
            "avg_strength": stat.get("avg_strength", 0),
            "last_seen_us": stat.get("last_seen_us"),
        })
    result.sort(key=lambda x: x["kart_nr"])
    return result


@app.post("/api/runs/{run_id}/print")
async def api_print_run(run_id: int, kart_nr: int | None = None):
    import traceback as _tb
    try:
        res = await printer.print_run(run_id, kart_nr=kart_nr)
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}\n{_tb.format_exc()}"
        raise HTTPException(500, err)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error", "Druckfehler"))
    return res


@app.get("/api/runs/{run_id}/print-preview")
async def api_print_preview(run_id: int, kart_nr: int | None = None, sim_laps: int = 0):
    import traceback as _tb
    try:
        html_str = await printer.render_run_html(run_id, kart_nr=kart_nr, sim_laps=sim_laps)
    except Exception as exc:
        return HTMLResponse(f"<pre>FEHLER: {_tb.format_exc()}</pre>", status_code=500)
    return HTMLResponse(html_str)


@app.post("/api/logo")
async def api_logo_upload(file: UploadFile = File(...)):
    if not file.content_type or "png" not in file.content_type.lower():
        raise HTTPException(400, "Nur PNG-Dateien erlaubt")
    data = await file.read()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(400, "Datei zu groß (max. 2 MB)")
    printer.LOGO_PATH.write_bytes(data)
    return {"ok": True, "size": len(data)}


@app.delete("/api/logo")
async def api_logo_delete():
    if printer.LOGO_PATH.exists():
        printer.LOGO_PATH.unlink()
    return {"ok": True}


@app.get("/api/logo")
async def api_logo_get():
    if not printer.LOGO_PATH.exists():
        raise HTTPException(404, "Kein Logo hochgeladen")
    return FileResponse(printer.LOGO_PATH, media_type="image/png")


@app.get("/api/bestof")
async def api_bestof(kart_class: str = "", period: str = "day"):
    """period: day | week | month | year"""
    ranges = printer._date_ranges()
    if period not in ranges:
        raise HTTPException(400, "period muss day|week|month|year sein")
    entries = await printer._best_of(kart_class, ranges[period], limit=50)
    return {"class": kart_class, "period": period, "entries": entries}


@app.delete("/api/passing/{passing_id}")
async def api_delete_passing(passing_id: int):
    await database.delete_passing(passing_id)
    return {"ok": True}


@app.get("/api/transponders/{transponder_id}/history")
async def api_transponder_history(transponder_id: int, days: int = 0):
    import time as _t
    since = int(_t.time() - days * 86400) if days > 0 else None
    return await database.get_transponder_strength_history(transponder_id, since_unix=since)


@app.post("/api/transponders")
async def api_add_transponder(body: dict):
    t_id = str(body.get("transponder_id", "")).strip()
    if not t_id:
        raise HTTPException(400, "transponder_id erforderlich")
    c = cfg.get()
    c["transponders"][t_id] = {
        "kart_nr":    body.get("kart_nr", 0),
        "name":       body.get("name", f"Kart {body.get('kart_nr', t_id)}"),
        "class":      body.get("class", "Leihkart"),
        "offset_sec": body.get("offset_sec", 0),
    }
    cfg.save({"transponders": c["transponders"]})
    return {"ok": True}


@app.post("/api/transponders/{transponder_id}")
async def api_update_transponder(transponder_id: int, body: dict):
    c = cfg.get()
    key = str(transponder_id)
    if key not in c["transponders"]:
        raise HTTPException(404, "Transponder nicht gefunden")
    allowed = {"name", "class", "kart_nr", "offset_sec"}
    updates = {k: v for k, v in body.items() if k in allowed}
    c["transponders"][key].update(updates)
    cfg.save({"transponders": c["transponders"]})
    return {"ok": True}


@app.delete("/api/transponders/{transponder_id}")
async def api_delete_transponder(transponder_id: int):
    c = cfg.get()
    key = str(transponder_id)
    if key not in c["transponders"]:
        raise HTTPException(404, "Transponder nicht gefunden")
    del c["transponders"][key]
    cfg.save({"transponders": c["transponders"]})
    return {"ok": True}


# ── Classes API ───────────────────────────────────────────────────────────────

@app.get("/api/classes")
async def api_get_classes():
    return cfg.get().get("classes", [])


@app.post("/api/classes")
async def api_add_class(body: dict):
    name = body.get("name", "").strip()
    color = body.get("color", "#888888")
    if not name:
        raise HTTPException(400, "name erforderlich")
    c = cfg.get()
    classes = c.get("classes", [])
    if any(cl["name"] == name for cl in classes):
        raise HTTPException(400, "Klasse existiert bereits")
    classes.append({"name": name, "color": color})
    cfg.save({"classes": classes})
    return {"ok": True}


@app.put("/api/classes/{class_name}")
async def api_update_class(class_name: str, body: dict):
    c = cfg.get()
    classes = c.get("classes", [])
    cl = next((x for x in classes if x["name"] == class_name), None)
    if not cl:
        raise HTTPException(404, "Klasse nicht gefunden")
    cl.update({k: v for k, v in body.items() if k in ("name", "color")})
    cfg.save({"classes": classes})
    return {"ok": True}


@app.delete("/api/classes/{class_name}")
async def api_delete_class(class_name: str):
    c = cfg.get()
    classes = [x for x in c.get("classes", []) if x["name"] != class_name]
    cfg.save({"classes": classes})
    return {"ok": True}


# ── Health history API ────────────────────────────────────────────────────────

@app.get("/api/decoder/health")
async def api_decoder_health(days: int = 0):
    import time as _t
    since = int(_t.time() - days * 86400) if days > 0 else None
    return await database.get_health_history(since_unix=since, max_points=1000)


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
