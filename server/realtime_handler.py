"""OpenAI Realtime API call handler (gpt-4o-mini-realtime-preview).

Replaces the local VAD → STT → LLM → TTS pipeline with a single bidirectional
WebSocket to OpenAI. Browser sends 16 kHz PCM; we resample to 24 kHz for the
Realtime API. Output PCM16 is wrapped in WAV headers before being sent back to
the browser as agent_audio frames — same wire format as the regular path, so
call.js needs no changes.

Enable with LLM_PROVIDER=realtime in your .env.
"""

import asyncio
import base64
import io
import json
import logging
import time
import wave

import numpy as np
import websockets
from fastapi import WebSocket

from . import config, store

log = logging.getLogger("interviewer.realtime")

OUTPUT_SAMPLE_RATE = 24000
_END_FUNCTION = "end_interview"

_REALTIME_TOOL = {
    "type": "function",
    "name": _END_FUNCTION,
    "description": (
        "Call this function on your very last turn, after delivering the goodbye, "
        "to signal the interview has concluded. Do not call it on any other turn."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def _resample_to_24k(pcm16: bytes) -> bytes:
    """Linear interpolation resample from SAMPLE_RATE → 24 kHz."""
    samples = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
    new_len = int(len(samples) * OUTPUT_SAMPLE_RATE / config.SAMPLE_RATE)
    if new_len == 0:
        return b""
    resampled = np.interp(
        np.linspace(0, len(samples) - 1, new_len),
        np.arange(len(samples)),
        samples,
    )
    return resampled.astype(np.int16).tobytes()


def _pcm16_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(OUTPUT_SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _build_realtime_prompt(base_prompt: str) -> str:
    """Replace the [END_INTERVIEW] token instruction with the tool-call version."""
    return base_prompt.replace(
        "On your FINAL turn only, append the exact token [END_INTERVIEW] at the very end.",
        f"On your FINAL turn only, call the `{_END_FUNCTION}` tool after saying goodbye. "
        "Do NOT speak or type '[END_INTERVIEW]' — use the function call instead.",
    )


class RealtimeCallHandler:
    def __init__(self, ws: WebSocket, session_id: str, setup: dict | None = None):
        self.ws = ws
        self.session_id = session_id
        setup = setup or {}
        self.duration_min = setup.get("duration_min") or config.INTERVIEW_DURATION_MIN
        # setup["prompt"] is always set by /api/session, which requires a
        # role and JD — no generic role-less prompt is built here.
        self._system_prompt = _build_realtime_prompt(setup["prompt"])
        self._rt_ws = None
        self.ended = False
        self._started = time.monotonic()
        self._first_audio_sent = False

    async def send(self, **payload):
        await self.ws.send_json(payload)

    async def _rt_send(self, event: dict):
        try:
            await self._rt_ws.send(json.dumps(event))
        except Exception:
            log.exception("realtime send failed")

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    async def run(self):
        await self.ws.accept()
        store.set_status(self.session_id, "live")

        try:
            self._rt_ws = await websockets.connect(
                f"wss://api.openai.com/v1/realtime?model={config.OPENAI_REALTIME_MODEL}",
                additional_headers={
                    "Authorization": f"Bearer {config.OPENAI_API_KEY}",
                    "OpenAI-Beta": "realtime=v1",
                },
                open_timeout=10,
            )
        except Exception:
            log.exception("failed to connect to OpenAI Realtime")
            await self.send(type="status", state="listening",
                            error="Realtime connection failed — check OPENAI_API_KEY")
            return

        recv_task = asyncio.create_task(self._recv_loop())
        watchdog = asyncio.create_task(self._hard_timeout_watchdog())
        try:
            await self._browser_loop()
        finally:
            recv_task.cancel()
            watchdog.cancel()
            try:
                await self._rt_ws.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # OpenAI Realtime → browser
    # ------------------------------------------------------------------

    async def _recv_loop(self):
        audio_buf = bytearray()
        agent_text = ""
        fn_call_id: str | None = None
        speaking = False

        try:
            async for raw in self._rt_ws:
                event = json.loads(raw)
                etype = event.get("type", "")

                if etype == "session.created":
                    await self._configure_session()

                elif etype == "input_audio_buffer.speech_started":
                    # barge-in: candidate is talking while agent is speaking
                    await self._rt_send({"type": "response.cancel"})
                    await self.send(type="interrupt")
                    await self.send(type="status", state="thinking")
                    speaking = False
                    audio_buf.clear()
                    agent_text = ""

                elif etype == "conversation.item.input_audio_transcription.completed":
                    text = (event.get("transcript") or "").strip()
                    if text:
                        store.append_message(self.session_id, "candidate", text)
                        await self.send(type="transcript", text=text)

                elif etype == "response.output_item.added":
                    item = event.get("item", {})
                    if item.get("type") == "function_call" and item.get("name") == _END_FUNCTION:
                        fn_call_id = item.get("call_id")
                    elif item.get("type") == "message":
                        agent_text = ""

                elif etype == "response.audio.delta":
                    if not speaking:
                        speaking = True
                        await self.send(type="status", state="speaking")
                    chunk = base64.b64decode(event.get("delta") or "")
                    audio_buf.extend(chunk)
                    # flush ~200 ms of audio at a time to keep latency low
                    chunk_bytes = OUTPUT_SAMPLE_RATE // 5 * 2
                    while len(audio_buf) >= chunk_bytes:
                        wav = _pcm16_to_wav(bytes(audio_buf[:chunk_bytes]))
                        await self.send(type="agent_audio", wav=base64.b64encode(wav).decode())
                        del audio_buf[:chunk_bytes]

                elif etype == "response.audio.done":
                    if audio_buf:
                        wav = _pcm16_to_wav(bytes(audio_buf))
                        await self.send(type="agent_audio", wav=base64.b64encode(wav).decode())
                        audio_buf.clear()

                elif etype == "response.audio_transcript.delta":
                    agent_text += event.get("delta") or ""

                elif etype == "response.audio_transcript.done":
                    full = (event.get("transcript") or agent_text).strip()
                    if full:
                        store.append_message(self.session_id, "agent", full)
                        await self.send(type="agent_text", text=full)
                    agent_text = ""

                elif etype == "response.function_call_arguments.done":
                    # end_interview() was called — submit output and mark done
                    if fn_call_id:
                        await self._rt_send({
                            "type": "conversation.item.create",
                            "item": {
                                "type": "function_call_output",
                                "call_id": fn_call_id,
                                "output": '{"status":"ok"}',
                            },
                        })
                        fn_call_id = None
                    self.ended = True

                elif etype == "response.done":
                    speaking = False
                    if self.ended:
                        store.set_status(self.session_id, "completed")
                        await self.send(type="end")
                    else:
                        await self.send(type="status", state="listening")

                elif etype == "error":
                    err = event.get("error", {})
                    log.error("realtime api error: %s", err)
                    await self.send(type="status", state="listening",
                                    error=f"Realtime error: {err.get('message', err)}")

        except websockets.ConnectionClosed:
            log.info("realtime ws closed by OpenAI")
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("realtime recv loop error")

    # ------------------------------------------------------------------
    # Browser → OpenAI Realtime
    # ------------------------------------------------------------------

    async def _browser_loop(self):
        """Forward browser PCM frames (16 kHz) to OpenAI Realtime (24 kHz)."""
        while True:
            msg = await self.ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            pcm = msg.get("bytes")
            if not pcm:
                continue
            resampled = _resample_to_24k(pcm)
            if resampled:
                await self._rt_send({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(resampled).decode(),
                })

    # ------------------------------------------------------------------
    # Session config + greeting
    # ------------------------------------------------------------------

    async def _configure_session(self):
        await self._rt_send({
            "type": "session.update",
            "session": {
                "modalities": ["audio", "text"],
                "instructions": self._system_prompt,
                "voice": config.REALTIME_VOICE,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {"model": "whisper-1"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": int(config.ENDPOINT_SILENCE_MS),
                },
                "tools": [_REALTIME_TOOL],
                "tool_choice": "auto",
                "temperature": 0.6,
                "max_response_output_tokens": 400,
            },
        })
        # Inject the opening trigger as a user text message so the agent
        # speaks first without waiting for audio from the browser.
        await self._rt_send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "[The candidate has just joined the call. Greet them and begin.]",
                }],
            },
        })
        await self._rt_send({"type": "response.create"})
        await self.send(type="status", state="thinking")

    # ------------------------------------------------------------------
    # Hard timeout
    # ------------------------------------------------------------------

    async def _hard_timeout_watchdog(self):
        deadline_s = (self.duration_min + config.HARD_TIMEOUT_GRACE_MIN) * 60
        await asyncio.sleep(deadline_s)
        if self.ended:
            return
        log.warning("session %s hit hard timeout (realtime)", self.session_id)
        self.ended = True
        try:
            await self._rt_send({"type": "response.cancel"})
            await self._rt_send({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": (
                            "[Hard timeout reached — wrap up in this turn, "
                            "say a brief goodbye, and call end_interview().]"
                        ),
                    }],
                },
            })
            await self._rt_send({"type": "response.create"})
        except Exception:
            log.exception("hard timeout inject failed")
        store.set_status(self.session_id, "completed")
