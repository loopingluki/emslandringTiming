import asyncio
import struct
import time
from collections.abc import Callable
from datetime import datetime, timezone


RECONNECT_DELAY    = 3.0
HEARTBEAT_TIMEOUT  = 15.0   # Sekunden ohne Heartbeat → Verbindung als tot werten


def descape(data: bytes) -> bytes:
    result = bytearray()
    i = 0
    while i < len(data):
        if data[i] == 0x8D and i < len(data) - 1:
            result.append(data[i + 1] - 0x20)
            i += 2
        else:
            result.append(data[i])
            i += 1
    return bytes(result)


def parse_packet(raw: bytes) -> dict | None:
    body = descape(raw[1:-1])
    packet = bytes([raw[0]]) + body + bytes([raw[-1]])
    if len(packet) < 10:
        return None
    tor = struct.unpack_from("<H", packet, 8)[0]

    if tor == 0x0001 and len(packet) >= 50:
        ts_us = struct.unpack_from("<Q", packet, 24)[0]
        return {
            "type": "PASSING",
            "passing_number": struct.unpack_from("<I", packet, 12)[0],
            "transponder": struct.unpack_from("<I", packet, 18)[0],
            "timestamp_us": ts_us,
            "datetime": datetime.fromtimestamp(ts_us / 1_000_000, tz=timezone.utc),
            "strength": struct.unpack_from("<H", packet, 34)[0],
            "hits": struct.unpack_from("<H", packet, 38)[0],
            "flags": struct.unpack_from("<H", packet, 42)[0],
        }
    if tor == 0x0002 and len(packet) >= 21:
        return {
            "type": "HEARTBEAT",
            "noise": struct.unpack_from("<H", packet, 16)[0],
            "loop": packet[20],
        }
    return None


class Decoder:
    def __init__(self) -> None:
        self.ip: str = "192.168.178.193"
        self.port: int = 5403
        self.connected: bool = False
        self.noise: int = 0
        self.loop: int = 0
        self._last_health_write: float = 0.0

        self._on_passing: Callable | None = None
        self._on_heartbeat: Callable | None = None
        self._task: asyncio.Task | None = None

    def set_callbacks(
        self,
        on_passing: Callable,
        on_heartbeat: Callable,
    ) -> None:
        self._on_passing = on_passing
        self._on_heartbeat = on_heartbeat

    def start(self, ip: str, port: int) -> None:
        self.ip = ip
        self.port = port
        self._task = asyncio.create_task(self._run(), name="decoder")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        while True:
            try:
                await self._connect_and_read()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            self.connected = False
            if self._on_heartbeat:
                await self._on_heartbeat(connected=False, noise=self.noise, loop=self.loop)
            await asyncio.sleep(RECONNECT_DELAY)

    async def _connect_and_read(self) -> None:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(self.ip, self.port), timeout=10.0
        )
        # connected bleibt False bis zum ersten echten Heartbeat
        buffer = b""
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(
                        reader.read(4096), timeout=HEARTBEAT_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    # Kein Heartbeat innerhalb der Frist → Decoder schweigt → trennen
                    break
                if not chunk:
                    break
                buffer += chunk

                while len(buffer) >= 4:
                    if buffer[0] != 0x8E:
                        buffer = buffer[1:]
                        continue

                    pkt_len = struct.unpack_from("<H", buffer, 2)[0]
                    if pkt_len < 4 or pkt_len > 300:
                        buffer = buffer[1:]
                        continue

                    if len(buffer) < pkt_len:
                        break

                    raw = buffer[:pkt_len]
                    buffer = buffer[pkt_len:]

                    if raw[-1] != 0x8F:
                        end = buffer.find(0x8F)
                        if end == -1:
                            break
                        raw = raw + buffer[: end + 1]
                        buffer = buffer[end + 1 :]

                    parsed = parse_packet(raw)
                    if not parsed:
                        continue

                    if parsed["type"] == "HEARTBEAT":
                        self.noise = parsed["noise"]
                        self.loop  = parsed["loop"]
                        # Erst beim ersten Heartbeat als "verbunden" markieren
                        if not self.connected:
                            self.connected = True
                        if self._on_heartbeat:
                            await self._on_heartbeat(
                                connected=True,
                                noise=self.noise,
                                loop=self.loop,
                            )
                    elif parsed["type"] == "PASSING":
                        if self._on_passing:
                            await self._on_passing(
                                transponder_id=parsed["transponder"],
                                timestamp_us=parsed["timestamp_us"],
                                strength=parsed["strength"],
                                hits=parsed["hits"],
                            )
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


decoder = Decoder()
