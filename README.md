# InterviewOS

Voice-based AI technical interviewer. An AI interviewer ("Sarah" by default)
conducts spoken, conversational interviews (no coding) — probes knowledge
depth, handles clarifications and pleasantries, asks follow-ups, paces itself
against a topic plan and duration target, and concludes on its own. Runs
behind a login-gated ops workflow with named team accounts.

## Stack

- **STT/TTS**: Sarvam AI (`saarika:v2.5` / `bulbul:v2`), ElevenLabs (Scribe v2 / Flash v2.5), or Smallest.ai Waves (TTS) — pick via `SPEECH_PROVIDER`
- **LLM**: OpenAI (`gpt-4o-mini` default), DeepSeek (OpenAI-compatible), or OpenAI Realtime speech-to-speech via `LLM_PROVIDER=realtime`
- **Server**: FastAPI + WebSocket, server-side VAD (webrtcvad + energy gate) for turn endpointing
- **Client**: browser mic → 16 kHz PCM over WebSocket (AudioWorklet); queued WAV/MP3 playback with barge-in
- **Auth**: local bcrypt-hashed accounts + session cookies (Starlette `SessionMiddleware`) — no SSO
- **Storage**: JSON files under `data/` (one per interview, plus an account store) — no database

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in API keys, SESSION_SECRET, and ADMIN_* credentials
uvicorn server.main:app --reload
```

Open `http://localhost:8000` → redirects to `/login`. Sign in with
`ADMIN_USERNAME`/`ADMIN_PASSWORD` from `.env` (seeded once, only if
`data/accounts.json` is empty). From `/welcome`, go to the **Ops Dashboard**
to create an interview, or **Test Room** for an internal single-page setup
flow. Add teammates via `/team` (admin-only) or:

```bash
python -m server.accounts add <user> <pass> --team technical --name "Full Name" [--admin]
```

## Creating an interview

**Role, job description, and candidate resume are all required** — there is
no generic/fallback interview; a session cannot be created without them. The
LLM builds its topic plan directly from the JD and resume text, not from
hardcoded defaults.

- **Role** — free text (e.g. "Backend Software Engineer")
- **Job description** — paste text or attach a PDF/DOCX/TXT file
- **Resume** — PDF/DOCX/TXT upload, used to personalize questions
- **Topics** *(optional)* — comma-separated topics you specifically want
  asked; leave blank and the interviewer derives topics entirely from the JD
- **Extra documents** *(optional)* — team notes, rubrics, etc.

The candidate then joins via the generated `/interview/<session_id>` link —
no login required on their end.

## Turn-taking design

- The server runs VAD on the incoming mic stream and ends the candidate's
  turn after `ENDPOINT_SILENCE_MS` (default 1600 ms) of silence — tune this
  for feel; too short cuts people off mid-thought, too long feels laggy.
- The LLM response is streamed and split into sentences; each sentence is
  TTS'd and shipped immediately, so the agent starts speaking after roughly
  STT + first-sentence latency instead of waiting for the full reply.
- **Barge-in**: if the candidate starts speaking while the agent is talking,
  generation is cancelled and the client flushes playback instantly. Cut-off
  fragments are merged back into one turn (not double-counted against the
  topic/exchange pacing) when the candidate resumes.

## Deployment

Ships as a container (`Dockerfile`, `railway.json` for Railway). Needs a
persistent filesystem (JSON storage + TTS/doc caches under `data/`) and
WebSocket support. Health check: `GET /health`.

## Environment variables

See `.env.example` for the full list (LLM/speech provider keys, VAD/timing
tuning, session/auth config, first-run admin credentials). There are no
`INTERVIEW_ROLE`/`INTERVIEW_TOPICS` env vars — those are supplied per-session
through the ops UI, not configured globally.
