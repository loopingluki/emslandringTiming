import asyncio
import json
import time
from fastapi import WebSocket


class WsHub:
    def __init__(self) -> None:
        # ws -> client_type ("app", "dashboard", "other")
        self._clients: dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()
        self._keepalive_task: asyncio.Task | None = None

    def start_keepalive(self) -> None:
        if self._keepalive_task is None or self._keepalive_task.done():
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def stop_keepalive(self) -> None:
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except asyncio.CancelledError:
                pass

    async def connect(self, ws: WebSocket, client_type: str = "app") -> None:
        await ws.accept()
        async with self._lock:
            self._clients[ws] = client_type
        await self._broadcast_client_counts()

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.pop(ws, None)
        await self._broadcast_client_counts()

    def counts_by_type(self) -> dict:
        counts = {"app": 0, "dashboard": 0, "other": 0}
        for t in self._clients.values():
            counts[t] = counts.get(t, 0) + 1
        counts["total"] = len(self._clients)
        return counts

    async def _broadcast_client_counts(self) -> None:
        await self.broadcast({"type": "client_count", **self.counts_by_type()})

    async def broadcast(self, message: dict) -> None:
        payload = json.dumps(message, ensure_ascii=False)
        async with self._lock:
            clients = list(self._clients.keys())
        dead: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.pop(ws, None)
            # Zombies entfernt → Zählerstand frisch verschicken
            if message.get("type") != "client_count":
                await self._broadcast_client_counts()

    async def send(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_text(json.dumps(message, ensure_ascii=False))
        except Exception:
            await self.disconnect(ws)

    async def _keepalive_loop(self) -> None:
        """Alle 10s Ping-Broadcast, damit tote Verbindungen sicher entfernt werden."""
        while True:
            try:
                await asyncio.sleep(30)
                if self._clients:
                    await self.broadcast({"type": "ping", "ts": time.time()})
            except asyncio.CancelledError:
                return
            except Exception:
                continue

    @property
    def client_count(self) -> int:
        return len(self._clients)


hub = WsHub()
