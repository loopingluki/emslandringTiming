"""
MyLaps Race Control Box ASCII-Emulator.
Akzeptiert mehrere TCP-Verbindungen und sendet das identische Protokoll
wie die originale MyLaps Race Control Box, damit Kloft-Bridge und andere
Clients unverändert weiterarbeiten können.
"""
import asyncio
import time

from ws_hub import hub


def _fmt_laptime(us: int) -> str:
    total_ms = us // 1000
    minutes = total_ms // 60000
    seconds = (total_ms % 60000) / 1000
    return f"{minutes}:{seconds:06.3f}"


def _fmt_laptime_padded(us: int) -> str:
    total_ms = us // 1000
    minutes = total_ms // 60000
    seconds = (total_ms % 60000) / 1000
    return f"{minutes:02d}:{seconds:06.3f}"


def _fmt_countdown(remaining_sec: int) -> str:
    h = remaining_sec // 3600
    m = (remaining_sec % 3600) // 60
    s = remaining_sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


class Emulator:
    def __init__(self) -> None:
        self._writers: set[asyncio.StreamWriter] = set()
        self._server: asyncio.Server | None = None
        self._lock = asyncio.Lock()

    async def start(self, port: int) -> None:
        self._server = await asyncio.start_server(
            self._handle_client, "0.0.0.0", port
        )
        asyncio.create_task(self._server.serve_forever(), name="emulator")

    async def stop(self) -> None:
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

    async def _send(self, line: str) -> None:
        data = (line + "\r\n").encode("latin-1")
        dead: list[asyncio.StreamWriter] = []
        async with self._lock:
            writers = list(self._writers)
        for w in writers:
            try:
                w.write(data)
                await w.drain()
            except Exception:
                dead.append(w)
        if dead:
            async with self._lock:
                for w in dead:
                    self._writers.discard(w)
        await hub.broadcast({
            "type": "debug_emulator",
            "ts": time.time(),
            "line": line,
            "clients": len(writers),
        })

    # ── Public API called by race_engine ────────────────────────────────────

    async def session_start(self, run_id: int, group_name: str) -> None:
        await self._send(f"$B\t{run_id}\t{group_name}")
        await self._send(f"$F\t9999\tGREEN         \t00:00:00")

    async def session_red_flag(self, run_id: int, remaining_sec: int) -> None:
        countdown = _fmt_countdown(remaining_sec)
        await self._send(f"$F\t9999\tRED           \t{countdown}")

    async def session_green_flag(self) -> None:
        await self._send("$F\t9999\tGREEN         \t00:00:00")

    async def kart_registered(self, run_id: int, kart_nr: int) -> None:
        await self._send(f"$A\t{run_id}\t{kart_nr}")

    async def on_passing(
        self,
        kart_nr: int,
        best_us: int,
        laps: int,
        last_us: int,
    ) -> None:
        best_str = _fmt_laptime(best_us)
        last_str = _fmt_laptime_padded(last_us)
        await self._send(f"$H\t{kart_nr}\t{best_str}")
        await self._send(f"$G\t{kart_nr}\t{laps}\t{last_str}")

    async def session_finish(self) -> None:
        await self._send("$F\t9999\tFINISH        \t00:00:00")

    async def session_complete(self, run_id: int) -> None:
        await self._send(f"$C\t12\t{run_id}")


emulator = Emulator()
