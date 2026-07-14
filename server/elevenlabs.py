"""ElevenLabs speech: Flash TTS + Scribe v2 Realtime streaming STT.

Mirrors the sarvam.py / stt_stream.py interfaces so main.py can switch
providers via SPEECH_PROVIDER.
"""

import asyncio
import base64
import hashlib
import io
import json
import logging
import time
import wave
from pathlib import Path

import httpx
import websockets

from . import config

log = logging.getLogger("interviewer.elevenlabs")

TTS_MODEL = "eleven_flash_v2_5"
TTS_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "tts_cache"
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

STT_BATCH_URL = "https://api.elevenlabs.io/v1/speech-to-text"
STT_STREAM_URL = (
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
    "?model_id=scribe_v2_realtime&audio_format=pcm_16000"
    "&language_code=en&commit_strategy=manual"
)
RECONNECT_COOLDOWN_S = 5.0

_client = httpx.AsyncClient(timeout=30.0)


def _headers() -> dict:
    return {"xi-api-key": config.ELEVENLABS_API_KEY}


async def synthesize(text: str) -> bytes:
    """Synthesize speech; returns MP3 bytes (browser decodeAudioData handles
    them the same as WAV). Repeated phrases served from disk cache."""
    if not config.ELEVENLABS_API_KEY:
        raise ValueError("ELEVENLABS_API_KEY not set in environment")
    key = hashlib.sha256(
        f"11labs|{TTS_MODEL}|{config.ELEVENLABS_VOICE_ID}|{text}".encode()
    ).hexdigest()
    cached = TTS_CACHE_DIR / f"{key}.mp3"
    if cached.exists():
        return cached.read_bytes()
    try:
        resp = await _client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{config.ELEVENLABS_VOICE_ID}"
            "?output_format=mp3_22050_32",
            headers=_headers(),
            json={"text": text, "model_id": TTS_MODEL},
        )
        resp.raise_for_status()
        audio = resp.content
        if not audio:
            log.error("ElevenLabs TTS returned empty content for text: %s", text[:50])
            raise ValueError("ElevenLabs TTS returned empty audio")
        if audio:
            cached.write_bytes(audio)
        return audio
    except Exception as e:
        log.error("ElevenLabs TTS failed: %s", str(e))
        raise


def _pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(config.SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


async def transcribe(pcm: bytes) -> str:
    """Batch STT fallback (Scribe v1)."""
    if not config.ELEVENLABS_API_KEY:
        raise ValueError("ELEVENLABS_API_KEY not set in environment")
    try:
        resp = await _client.post(
            STT_BATCH_URL,
            headers=_headers(),
            files={"file": ("audio.wav", _pcm_to_wav(pcm), "audio/wav")},
            data={"model_id": "scribe_v1"},
        )
        resp.raise_for_status()
        return (resp.json().get("text") or "").strip()
    except Exception as e:
        log.error("ElevenLabs batch STT failed: %s", str(e))
        raise


class StreamingSTT:
    """Same interface as stt_stream.StreamingSTT: connect / send_audio /
    collect / close. Uses manual commit: at our VAD endpoint, collect() sends
    a commit and waits for the committed transcript; partials arriving during
    speech serve as an instant fallback."""

    def __init__(self):
        self._ws = None
        self._recv_task: asyncio.Task | None = None
        self._committed: list[str] = []
        self._partial = ""
        self._commit_event = asyncio.Event()
        self._last_connect_attempt = 0.0

    async def connect(self) -> bool:
        if self._ws is not None:
            return True
        if time.monotonic() - self._last_connect_attempt < RECONNECT_COOLDOWN_S:
            return False
        self._last_connect_attempt = time.monotonic()
        try:
            self._ws = await websockets.connect(
                STT_STREAM_URL, additional_headers=_headers(), open_timeout=5
            )
        except Exception:
            log.exception("elevenlabs stt stream connect failed")
            return False
        self._recv_task = asyncio.create_task(self._recv_loop(self._ws))
        return True

    async def _recv_loop(self, ws):
        try:
            async for raw in ws:
                m = json.loads(raw)
                mtype = m.get("message_type", "")
                if mtype == "partial_transcript":
                    self._partial = (m.get("text") or "").strip()
                elif mtype.startswith("committed_transcript"):
                    text = (m.get("text") or "").strip()
                    if text:
                        self._committed.append(text)
                    self._partial = ""
                    self._commit_event.set()
                elif "error" in mtype or m.get("error"):
                    log.warning("elevenlabs stt stream: %s", m)
                    if mtype in ("auth_error", "quota_exceeded", "unaccepted_terms"):
                        break
        except websockets.ConnectionClosed:
            log.info("elevenlabs stt stream closed")
        except Exception:
            log.exception("elevenlabs stt stream receive failed")
        finally:
            if self._ws is ws:
                self._ws = None

    async def send_audio(self, pcm: bytes, commit: bool = False):
        if self._ws is None and not await self.connect():
            return
        try:
            await self._ws.send(
                json.dumps(
                    {
                        "message_type": "input_audio_chunk",
                        "audio_base_64": base64.b64encode(pcm).decode(),
                        "commit": commit,
                        "sample_rate": config.SAMPLE_RATE,
                    }
                )
            )
        except Exception:
            self._ws = None

    async def collect(self, timeout: float = 2.0) -> str:
        """Called at our VAD endpoint: commit the segment and return its text.
        Empty string means the caller should fall back to batch STT."""
        self._commit_event.clear()
        # commit rides on a short silence chunk
        await self.send_audio(b"\x00" * 3200, commit=True)
        if not self._committed:
            try:
                await asyncio.wait_for(self._commit_event.wait(), timeout)
            except asyncio.TimeoutError:
                pass
        text = " ".join(self._committed).strip() or self._partial
        self._committed = []
        self._partial = ""
        self._commit_event.clear()
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
