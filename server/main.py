"""FastAPI server: WebSocket voice loop with barge-in.

Client sends binary 16 kHz mono 16-bit PCM frames. Server sends JSON:
  {type: "agent_text", text}          - sentence the agent is about to say
  {type: "agent_audio", wav}          - base64 WAV for that sentence
  {type: "transcript", text}          - what the candidate said (for the UI)
  {type: "interrupt"}                 - stop playback immediately (barge-in)
  {type: "status", state}             - listening | thinking | speaking
  {type: "end"}                       - interview concluded
"""

import asyncio
import base64
import logging
import time
import uuid

from fastapi import FastAPI, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, documents, speech, store
from .agent import InterviewSession, build_system_prompt
from .speech import StreamingSTT
from .vad import UtteranceDetector

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("interviewer")

app = FastAPI()


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/ops")
async def ops_page():
    return FileResponse("static/ops.html")


@app.get("/interview/{session_id}")
async def join_page(session_id: str):
    return FileResponse("static/join.html")


@app.get("/api/interviews/{session_id}/public")
async def interview_public_info(session_id: str):
    """Minimal, candidate-safe view of a session — no JD/transcript."""
    rec = store.get(session_id)
    if rec is None:
        return {"error": "not found"}
    return {"role": rec["role"], "duration_min": rec["duration_min"], "status": rec["status"]}


app.mount("/static", StaticFiles(directory="static"), name="static")

# session_id -> {"prompt", "duration_min"} for pending websocket connects.
# Transcripts and statuses are persisted to disk via server.store.
_sessions: dict[str, dict] = {}


@app.get("/api/ops/sessions")
async def ops_sessions():
    return store.list_all()


@app.get("/api/ops/sessions/{session_id}")
async def ops_session(session_id: str):
    rec = store.get(session_id)
    return rec if rec is not None else {"error": "not found"}


@app.post("/api/session")
async def create_session(
    role: str = Form(""),
    duration_min: int = Form(0),
    jd_text: str = Form(""),
    jd_file: UploadFile | None = None,
    docs: list[UploadFile] = [],
):
    """Create an interview session from a JD (file or pasted text) plus
    optional supporting documents. Returns a session id for /ws."""
    if jd_file is not None and jd_file.filename:
        jd_text = documents.extract_text(jd_file.filename, await jd_file.read())
    extra = []
    for f in docs:
        extra.append((f.filename, documents.extract_text(f.filename, await f.read())))

    duration = duration_min or config.INTERVIEW_DURATION_MIN
    resolved_role = role or config.INTERVIEW_ROLE
    prompt = build_system_prompt(
        role=resolved_role,
        duration_min=duration,
        jd_text=jd_text.strip(),
        extra_docs=extra,
        topics=config.INTERVIEW_TOPICS,
    )
    session_id = uuid.uuid4().hex
    _sessions[session_id] = {
        "prompt": prompt,
        "duration_min": duration,
        "topics": config.INTERVIEW_TOPICS,
    }
    store.create(
        session_id,
        role=resolved_role,
        duration_min=duration,
        jd_present=bool(jd_text.strip()),
    )
    return {"session_id": session_id}


class CallHandler:
    def __init__(self, ws: WebSocket, session_id: str, setup: dict | None = None):
        self.ws = ws
        self.session_id = session_id
        setup = setup or {}
        self.session = InterviewSession(
            system_prompt=setup.get("prompt"),
            duration_min=setup.get("duration_min"),
            topics=setup.get("topics"),
        )
        self.vad = UtteranceDetector()
        self.stt = StreamingSTT()
        self.speak_task: asyncio.Task | None = None
        self.spoken_so_far = ""
        # unanswered candidate speech; accumulates when the endpoint fires
        # mid-thought and they keep talking before the agent has replied
        self.pending_text = ""

    async def send(self, **payload):
        await self.ws.send_json(payload)

    async def speak_response(self, user_text: str | None):
        """Stream LLM sentences through TTS to the client."""
        self.spoken_so_far = ""
        queue: asyncio.Queue = asyncio.Queue()

        async def produce():
            # pipeline: kick off TTS for each sentence as the LLM emits it,
            # so synthesis of sentence N overlaps generation of sentence N+1
            async for sentence in self.session.respond(user_text):
                queue.put_nowait(
                    (sentence, asyncio.create_task(speech.synthesize(sentence)))
                )
            queue.put_nowait(None)

        producer = asyncio.create_task(produce())
        try:
            await self.send(type="status", state="thinking")
            if user_text is not None:
                # deliberate pause so replies don't feel instant/robotic
                await asyncio.sleep(config.REPLY_DELAY_MS / 1000)
            first = True
            t0 = time.monotonic()
            while (item := await queue.get()) is not None:
                sentence, tts_task = item
                wav = await tts_task
                if first:
                    log.info("latency: to-first-audio %.2fs", time.monotonic() - t0)
                    await self.send(type="status", state="speaking")
                    first = False
                self.spoken_so_far += sentence + " "
                await self.send(type="agent_text", text=sentence)
                await self.send(
                    type="agent_audio", wav=base64.b64encode(wav).decode()
                )
            self.pending_text = ""
            self._record_agent_turn()
            if self.session.ended:
                store.set_status(self.session_id, "completed")
                await self.send(type="end")
            else:
                await self.send(type="status", state="listening")
        except asyncio.CancelledError:
            if self.spoken_so_far.strip():
                # the candidate heard a partial reply: their previous turn was
                # (partially) answered, so don't merge it into the next one
                self.session.note_partial_reply(self.spoken_so_far)
                self.pending_text = ""
            self._record_agent_turn(interrupted=True)
            raise
        except Exception as e:
            log.exception("agent response failed: %s", str(e))
            await self.send(
                type="status",
                state="listening",
                error=f"Agent failed: {type(e).__name__}: {str(e)}"
            )
            # Don't silently fail — let the candidate know something went wrong
            await self.send(
                type="agent_text",
                text="I'm having trouble connecting. Can you hear me?"
            )
        finally:
            producer.cancel()
            while not queue.empty():
                item = queue.get_nowait()
                if item is not None:
                    item[1].cancel()

    def _record_agent_turn(self, interrupted: bool = False):
        text = self.spoken_so_far.strip()
        if text:
            store.append_message(self.session_id, "agent", text, interrupted=interrupted)
            self.spoken_so_far = ""

    def interrupt(self):
        if self.speak_task and not self.speak_task.done():
            self.speak_task.cancel()

    async def on_utterance(self, pcm: bytes):
        # instant feedback: the candidate stopped talking, show "thinking"
        # while STT runs instead of leaving them in "listening" dead air
        await self.send(type="status", state="thinking")
        t0 = time.monotonic()
        text = await self.stt.collect()
        if text:
            log.info("latency: streaming stt collect %.2fs", time.monotonic() - t0)
        else:
            # streaming produced nothing (connection died, or transcript lost)
            # — fall back to batch STT on the VAD-buffered utterance
            try:
                text = await speech.transcribe(pcm)
                log.info("latency: batch stt fallback %.2fs (%.1fs audio)",
                         time.monotonic() - t0, len(pcm) / 32000)
            except Exception:
                log.exception("STT failed")
                await self.send(type="status", state="listening")
                return
        if not text:
            await self.send(type="status", state="listening")
            return
        log.info("candidate: %s", text)
        store.append_message(self.session_id, "candidate", text)
        await self.send(type="transcript", text=text)
        # if the candidate resumed talking mid-pipeline and this utterance is a
        # continuation, fold the previous un-answered fragment into one turn
        self.pending_text = f"{self.pending_text} {text}".strip() if self.pending_text else text
        self.speak_task = asyncio.create_task(self.speak_response(self.pending_text))

    async def _hard_timeout_watchdog(self):
        """Safety net under the prompt's own time-awareness: force-end the
        call if it runs well past the planned duration, in case the model
        keeps going despite the elapsed-time notes."""
        deadline_s = (self.session.duration_min + config.HARD_TIMEOUT_GRACE_MIN) * 60
        await asyncio.sleep(deadline_s)
        if self.session.ended:
            return
        log.warning("session %s hit hard timeout, forcing close", self.session_id)
        self.interrupt()
        self.session.ended = True
        try:
            await self.send(
                type="agent_text",
                text="We're out of time for today — thanks so much for chatting with me.",
            )
            wav = await speech.synthesize(
                "We're out of time for today — thanks so much for chatting with me."
            )
            await self.send(type="agent_audio", wav=base64.b64encode(wav).decode())
            await self.send(type="end")
        except Exception:
            log.exception("hard timeout goodbye failed")
        store.set_status(self.session_id, "completed")

    async def run(self):
        await self.ws.accept()
        store.set_status(self.session_id, "live")
        await self.stt.connect()  # open the streaming STT channel up front
        watchdog = asyncio.create_task(self._hard_timeout_watchdog())
        # agent opens the interview
        self.speak_task = asyncio.create_task(self.speak_response(None))

        try:
            await self._loop()
        finally:
            watchdog.cancel()

    async def _loop(self):
        while True:
            msg = await self.ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            pcm = msg.get("bytes")
            if not pcm:
                continue
            await self.stt.send_audio(pcm)
            speech_started, utterance = self.vad.feed(pcm)
            if (
                speech_started
                and self.speak_task
                and not self.speak_task.done()
                and self.spoken_so_far
            ):
                # barge-in: candidate talking over an agent that is audibly
                # speaking. While the agent is still thinking, let it be —
                # if the candidate is adding to their answer, the completed
                # utterance below will cancel and re-respond with the merge.
                self.interrupt()
                await self.send(type="interrupt")
            if utterance and not self.session.ended:
                # ignore speech while a response is still being generated
                if self.speak_task and not self.speak_task.done():
                    self.interrupt()
                    await self.send(type="interrupt")
                await self.on_utterance(utterance)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, session: str = ""):
    if session not in _sessions:
        session = uuid.uuid4().hex
        _sessions[session] = {}
        store.create(session, role=config.INTERVIEW_ROLE,
                     duration_min=config.INTERVIEW_DURATION_MIN, jd_present=False)
    handler = CallHandler(ws, session, _sessions.get(session))
    try:
        await handler.run()
    except WebSocketDisconnect:
        pass
    finally:
        handler.interrupt()
        await handler.stt.close()
        store.set_status(session, "disconnected")
