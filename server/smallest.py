"""Smallest.ai Waves TTS (Lightning v3.1) + Pulse streaming STT.

TTS:  wss://api.smallest.ai/waves/v1/tts/live
      Send JSON synthesis request → receive base64 PCM chunks → WAV.

STT:  wss://api.smallest.ai/waves/v1/pulse/get_text?language=en&sample_rate=16000&encoding=linear16
      Send raw PCM binary frames → send {"type":"finalize"} → receive {transcript, is_final}.
      Batch transcribe() falls back to OpenAI Whisper (reuses OPENAI_API_KEY).
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

log = logging.getLogger("interviewer.smallest")

TTS_WS_URL = "wss://api.smallest.ai/waves/v1/tts/live"
STT_WS_URL = (
    "wss://api.smallest.ai/waves/v1/pulse/get_text"
    "?language=en&sample_rate=16000&encoding=linear16"
)
WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions"
RECONNECT_COOLDOWN_S = 5.0

TTS_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "tts_cache"
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

_http = httpx.AsyncClient(timeout=30.0)


def _pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

async def synthesize(text: str) -> bytes:
    """TTS via Smallest.ai Waves Lightning v3.1 WebSocket. Returns WAV bytes."""
    if not config.SMALLEST_API_KEY:
        raise ValueError("SMALLEST_API_KEY not set in environment")

    key = hashlib.sha256(
        f"smallest-v31|{config.SMALLEST_VOICE_ID}|{config.SMALLEST_SAMPLE_RATE}|{text}".encode()
    ).hexdigest()
    cached = TTS_CACHE_DIR / f"{key}.wav"
    if cached.exists():
        return cached.read_bytes()

    headers = {"Authorization": f"Bearer {config.SMALLEST_API_KEY}"}
    pcm_chunks: list[bytes] = []

    async with websockets.connect(TTS_WS_URL, additional_headers=headers, open_timeout=10) as ws:
        await ws.send(json.dumps({
            "voice_id": config.SMALLEST_VOICE_ID,
            "text": text,
            "model": "lightning_v3.1",
            "sample_rate": config.SMALLEST_SAMPLE_RATE,
            "language": "en",
            "speed": 1.0,
        }))
        async for raw in ws:
            if isinstance(raw, bytes):
                pcm_chunks.append(raw)
                continue
            msg = json.loads(raw)
            status = msg.get("status", "")
            if status == "chunk":
                audio_b64 = (msg.get("data") or {}).get("audio") or ""
                if audio_b64:
                    pcm_chunks.append(base64.b64decode(audio_b64))
            elif status == "complete":
                break

    if not pcm_chunks:
        raise ValueError("Smallest.ai TTS returned no audio")

    wav = _pcm_to_wav(b"".join(pcm_chunks), config.SMALLEST_SAMPLE_RATE)
    cached.write_bytes(wav)
    return wav


# ---------------------------------------------------------------------------
# Batch STT fallback (OpenAI Whisper)
# ---------------------------------------------------------------------------

async def transcribe(pcm: bytes) -> str:
    """Batch STT via OpenAI Whisper (reuses OPENAI_API_KEY)."""
    if not config.OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY not set in environment")
    mic_wav = _pcm_to_wav(pcm, config.SAMPLE_RATE)
    resp = await _http.post(
        WHISPER_URL,
        headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
        files={"file": ("audio.wav", mic_wav, "audio/wav")},
        data={"model": "whisper-1"},
    )
    resp.raise_for_status()
    return (resp.json().get("text") or "").strip()


# ---------------------------------------------------------------------------
# Streaming STT — Smallest.ai Pulse
# ---------------------------------------------------------------------------

class StreamingSTT:
    """Pulse streaming STT over WebSocket.

    Interface matches sarvam.stt_stream.StreamingSTT:
    connect / send_audio / collect / close.

    Mic PCM (16 kHz int16) is sent as raw binary frames. collect() sends a
    {"type":"finalize"} to flush the buffer and waits for the is_final
    transcript. If nothing arrives within the timeout, returns "" so the
    caller falls back to batch Whisper.
    """

    def __init__(self):
        self._ws = None
        self._recv_task: asyncio.Task | None = None
        self._finals: list[str] = []
        self._partial = ""
        self._finalize_event = asyncio.Event()
        self._last_connect_attempt = 0.0

    async def connect(self) -> bool:
        if self._ws is not None:
            return True
        if time.monotonic() - self._last_connect_attempt < RECONNECT_COOLDOWN_S:
            return False
        self._last_connect_attempt = time.monotonic()
        try:
            self._ws = await websockets.connect(
                STT_WS_URL,
                additional_headers={"Authorization": f"Bearer {config.SMALLEST_API_KEY}"},
                open_timeout=5,
            )
        except Exception:
            log.exception("smallest pulse stt connect failed")
            return False
        self._recv_task = asyncio.create_task(self._recv_loop(self._ws))
        return True

    async def _recv_loop(self, ws):
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                msg = json.loads(raw)
                transcript = (msg.get("transcript") or "").strip()
                is_final = msg.get("is_final", False)
                if is_final:
                    if transcript:
                        self._finals.append(transcript)
                    self._finalize_event.set()
                else:
                    self._partial = transcript
        except websockets.ConnectionClosed:
            log.info("smallest pulse stt stream closed")
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("smallest pulse stt recv loop error")
        finally:
            if self._ws is ws:
                self._ws = None

    async def send_audio(self, pcm: bytes):
        if self._ws is None and not await self.connect():
            return
        try:
            await self._ws.send(pcm)
        except Exception:
            self._ws = None

    async def collect(self, timeout: float = 2.0) -> str:
        """Finalize the current utterance and return the transcript.
        Returns '' if nothing arrives (caller falls back to Whisper batch)."""
        self._finalize_event.clear()
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "finalize"}))
            except Exception:
                self._ws = None

        if not self._finals:
            try:
                await asyncio.wait_for(self._finalize_event.wait(), timeout)
            except asyncio.TimeoutError:
                pass

        text = " ".join(self._finals).strip() or self._partial
        self._finals = []
        self._partial = ""
        self._finalize_event.clear()
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
