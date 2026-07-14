"""Sarvam AI speech-to-text and text-to-speech clients."""

import base64
import hashlib
import io
import wave
from pathlib import Path

import httpx

from . import config

TTS_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "tts_cache"
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTS_VOICE = "anushka"
TTS_MODEL = "bulbul:v2"

STT_URL = "https://api.sarvam.ai/speech-to-text"
TTS_URL = "https://api.sarvam.ai/text-to-speech"

_client = httpx.AsyncClient(timeout=30.0)


def _pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(config.SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


async def transcribe(pcm: bytes) -> str:
    """Transcribe 16 kHz mono PCM. Returns the transcript ('' on silence)."""
    if not config.SARVAM_API_KEY:
        raise ValueError("SARVAM_API_KEY not set in environment")
    resp = await _client.post(
        STT_URL,
        headers={"api-subscription-key": config.SARVAM_API_KEY},
        files={"file": ("audio.wav", _pcm_to_wav(pcm), "audio/wav")},
        data={"model": "saarika:v2.5", "language_code": "en-IN"},
    )
    resp.raise_for_status()
    return (resp.json().get("transcript") or "").strip()


async def synthesize(text: str) -> bytes:
    """Synthesize speech. Returns WAV bytes. Repeated phrases (the agent's
    short acknowledgements especially) are served from a disk cache."""
    key = hashlib.sha256(f"{TTS_MODEL}|{TTS_VOICE}|{text}".encode()).hexdigest()
    cached = TTS_CACHE_DIR / f"{key}.wav"
    if cached.exists():
        return cached.read_bytes()
    try:
        wav = await _synthesize(text)
        if wav:
            cached.write_bytes(wav)
        return wav
    except Exception as e:
        import logging
        logging.error("TTS synthesis failed for text='%s': %s", text[:50], str(e))
        raise


async def _synthesize(text: str) -> bytes:
    if not config.SARVAM_API_KEY:
        raise ValueError("SARVAM_API_KEY not set in environment")
    resp = await _client.post(
        TTS_URL,
        headers={
            "api-subscription-key": config.SARVAM_API_KEY,
            "Content-Type": "application/json",
        },
        json={
            "text": text,
            "target_language_code": "en-IN",
            "speaker": TTS_VOICE,
            "model": TTS_MODEL,
            "pace": 1.0,
            "speech_sample_rate": 22050,
        },
    )
    resp.raise_for_status()
    audios = resp.json().get("audios", [])
    if not audios:
        import logging
        logging.error("TTS API returned no audio for text: %s", text[:50])
        raise ValueError("TTS API returned empty audio response")
    return base64.b64decode(audios[0]) if audios else b""
