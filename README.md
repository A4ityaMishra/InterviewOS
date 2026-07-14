# IDC Interviewer

Voice-based AI technical interviewer. Conversational (no coding) — it probes
knowledge depth, handles clarifications and pleasantries, asks follow-ups, and
concludes the interview on its own.

## Stack

- **STT/TTS**: Sarvam AI (`saarika:v2.5` / `bulbul:v2`)
- **LLM**: OpenAI by default, DeepSeek via `LLM_PROVIDER=deepseek`
- **Server**: FastAPI + WebSocket, server-side VAD (webrtcvad) for endpointing
- **Client**: browser mic → 16 kHz PCM over WebSocket; queued WAV playback with barge-in

## Turn-taking design

- The server runs VAD on the incoming mic stream and ends the candidate's turn
  after `ENDPOINT_SILENCE_MS` (default 650 ms) of silence — tune this for feel.
- The LLM response is streamed and split into sentences; each sentence is TTS'd
  and shipped immediately, so the agent starts speaking after roughly
  STT + first-sentence latency instead of waiting for the full reply.
- **Barge-in**: if the candidate starts speaking while the agent is talking,
  generation is cancelled and the client flushes playback instantly. The agent
  is told how far it got so the conversation stays coherent.

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in SARVAM_API_KEY and OPENAI_API_KEY
uvicorn server.main:app --port 8000
```

Open http://localhost:8000, click **Start interview**, allow the mic.

## Configure the interview

Set in `.env`: `INTERVIEW_ROLE`, `INTERVIEW_TOPICS` (comma-separated),
`INTERVIEW_DURATION_MIN`. The agent paces itself using elapsed-time notes
injected into the conversation.
