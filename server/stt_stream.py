"""Streaming STT over Sarvam's WebSocket API.

Mic audio is forwarded continuously while the candidate speaks, so
transcription happens in parallel with speech. Sarvam's server-side VAD
finalizes segments on its own; by the time our local endpoint fires, the
transcript is usually already here — collect() then costs ~0 instead of a
full batch STT round-trip.
"""

import asyncio
import base64
import json
import logging
import time

import websockets

from . import config

log = logging.getLogger("interviewer.stt")

URL = (
    "wss://api.sarvam.ai/speech-to-text/ws"
    "?language-code=en-IN&model=saarika:v2.5&sample_rate=16000"
    "&input_audio_codec=pcm_s16le&vad_signals=true"
)
RECONNECT_COOLDOWN_S = 5.0


class StreamingSTT:
    def __init__(self):
        self._ws = None
        self._recv_task: asyncio.Task | None = None
        self._segments: list[str] = []
        self._new_data = asyncio.Event()
        self._last_connect_attempt = 0.0

    async def connect(self) -> bool:
        if self._ws is not None:
            return True
        if time.monotonic() - self._last_connect_attempt < RECONNECT_COOLDOWN_S:
            return False
        self._last_connect_attempt = time.monotonic()
        try:
            self._ws = await websockets.connect(
                URL,
                additional_headers={"Api-Subscription-Key": config.SARVAM_API_KEY},
                open_timeout=5,
            )
        except Exception:
            log.exception("sarvam stt stream connect failed")
            return False
        self._recv_task = asyncio.create_task(self._recv_loop(self._ws))
        return True

    async def _recv_loop(self, ws):
        try:
            async for raw in ws:
                m = json.loads(raw)
                if m.get("type") == "data":
                    text = (m.get("data", {}).get("transcript") or "").strip()
                    if text:
                        self._segments.append(text)
                        self._new_data.set()
                elif m.get("type") == "error":
                    log.warning("sarvam stt stream error: %s", m.get("data"))
        except websockets.ConnectionClosed:
            log.info("sarvam stt stream closed")
        except Exception:
            log.exception("sarvam stt stream receive failed")
        finally:
            if self._ws is ws:
                self._ws = None

    async def send_audio(self, pcm: bytes):
        if self._ws is None and not await self.connect():
            return
        try:
            await self._ws.send(
                json.dumps(
                    {
                        "audio": {
                            "data": base64.b64encode(pcm).decode(),
                            "sample_rate": "16000",
                            "encoding": "audio/wav",
                        }
                    }
                )
            )
        except Exception:
            self._ws = None

    async def collect(self, timeout: float = 2.0) -> str:
        """Called at our local endpoint: returns everything transcribed for the
        just-finished utterance. Empty string means the stream produced nothing
        (caller should fall back to batch STT)."""
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "flush"}))
            except Exception:
                self._ws = None
        if self._segments:
            # transcript already arrived while the candidate spoke; give any
            # trailing segment a brief chance to land, then return
            await asyncio.sleep(0.15)
        else:
            self._new_data.clear()
            try:
                await asyncio.wait_for(self._new_data.wait(), timeout)
            except asyncio.TimeoutError:
                pass
        text = " ".join(self._segments).strip()
        self._segments = []
        self._new_data.clear()
        return text

    async def close(self):
        if self._recv_task:
            self._recv_task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
