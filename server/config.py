import logging
import os
from dotenv import load_dotenv

load_dotenv()
_log = logging.getLogger("interviewer.config")

SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "")

# Speech provider: sarvam or elevenlabs
SPEECH_PROVIDER = os.getenv("SPEECH_PROVIDER", "sarvam").lower()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
# default voice: "Rachel" — swap for any voice id from your ElevenLabs library
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openai").lower()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# Smallest.ai Waves TTS (used when SPEECH_PROVIDER=smallest)
SMALLEST_API_KEY = os.getenv("SMALLEST_API_KEY", "")
SMALLEST_VOICE_ID = os.getenv("SMALLEST_VOICE_ID", "jessica")
SMALLEST_SAMPLE_RATE = int(os.getenv("SMALLEST_SAMPLE_RATE", "24000"))

# OpenAI Realtime (used when LLM_PROVIDER=realtime)
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-mini-realtime-preview")
REALTIME_VOICE = os.getenv("REALTIME_VOICE", "alloy")

AGENT_NAME = os.getenv("AGENT_NAME", "Sarah")

INTERVIEW_DURATION_MIN = int(os.getenv("INTERVIEW_DURATION_MIN", "20"))

# Audio: client sends 16 kHz mono 16-bit PCM
SAMPLE_RATE = 16000
VAD_FRAME_MS = 30
VAD_AGGRESSIVENESS = 3  # strictest: fewest false "speech" detections
ENDPOINT_SILENCE_MS = int(os.getenv("ENDPOINT_SILENCE_MS", "1600"))
MIN_SPEECH_MS = 250  # ignore blips shorter than this
# minimum frame RMS (int16 scale) to count as speech; raise if barge-in
# still triggers on background noise, lower for very quiet mics
SPEECH_RMS_THRESHOLD = int(os.getenv("SPEECH_RMS_THRESHOLD", "350"))

# Deliberate pause before the agent starts replying — near-0ms felt robotic in
# testing; a small pause reads as "thinking" rather than a canned response.
REPLY_DELAY_MS = int(os.getenv("REPLY_DELAY_MS", "500"))
# Hard stop: force-end the call if it runs this far past the planned duration,
# regardless of what the LLM is doing (safety net under the prompt's own pacing).
HARD_TIMEOUT_GRACE_MIN = int(os.getenv("HARD_TIMEOUT_GRACE_MIN", "10"))
# How long to wait for the model to produce the next chunk before treating the
# response as hung and falling back to an error state.
LLM_RESPONSE_TIMEOUT_S = int(os.getenv("LLM_RESPONSE_TIMEOUT_S", "45"))

# ---------- Cost estimation (ops dashboard only) ----------
# USD list pricing, used to estimate per-interview spend. These are public
# rate-card numbers, not pulled from a billing API — treat the ops "est.
# cost" figure as an estimate, since real accounts can have negotiated or
# tiered pricing that differs from the public rate card.
#
# LLM token counts are exact (read straight off the API response), so only
# their $ conversion here is approximate. STT/TTS $ is a bigger unknown:
# none of these providers expose a per-request credits/cost field over their
# streaming APIs, only a dashboard-level running total, so STT_PRICE_PER_MIN
# / TTS_PRICE_PER_MIN below can't be cross-checked per session — only by
# periodically comparing our summed estimate against the provider dashboard
# total (e.g. Smallest.ai's usage page) over some date range and nudging
# these constants to match if they've drifted.
LLM_PRICE_PER_1M_TOKENS = {  # model -> (input $/1M tok, output $/1M tok)
    "gpt-4o-mini": (0.15, 0.60),
    "deepseek-chat": (0.14, 0.28),
}
STT_PRICE_PER_MIN = {  # speech provider -> $/minute of audio transcribed
    "smallest": 0.009,
    "sarvam": 0.006,
    "elevenlabs": 0.02,
}
TTS_PRICE_PER_MIN = {  # speech provider -> $/minute of audio synthesized
    "smallest": 0.09,
    "sarvam": 0.02,
    "elevenlabs": 0.13,
}

# ---------- Auth / sessions ----------
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-insecure-secret-change-me")
if SESSION_SECRET == "dev-insecure-secret-change-me":
    _log.warning(
        "SESSION_SECRET is using the insecure default — set a real secret "
        "in .env before deploying."
    )
SESSION_MAX_AGE_DAYS = int(os.getenv("SESSION_MAX_AGE_DAYS", "14"))
# set true in production behind HTTPS; false lets local http:// dev set cookies
SESSION_HTTPS_ONLY = os.getenv("SESSION_HTTPS_ONLY", "false").lower() == "true"

# First-run admin account, seeded once if data/accounts.json is empty/missing.
# Add more teammates afterward with: python -m server.accounts add <user> <pass> --team ... --name "..."
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
ADMIN_NAME = os.getenv("ADMIN_NAME", "Admin")
ADMIN_TEAM = os.getenv("ADMIN_TEAM", "technical")
