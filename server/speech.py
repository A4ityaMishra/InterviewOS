"""Speech provider facade: pick Sarvam or ElevenLabs via SPEECH_PROVIDER.

Exposes: synthesize(text) -> audio bytes, transcribe(pcm) -> str (batch
fallback), and StreamingSTT (connect / send_audio / collect / close).
"""

import logging

from . import config

log = logging.getLogger("interviewer.speech")

if config.SPEECH_PROVIDER == "elevenlabs" and config.ELEVENLABS_API_KEY:
    from .elevenlabs import StreamingSTT, synthesize, transcribe  # noqa: F401

    log.info("speech provider: elevenlabs")
else:
    if config.SPEECH_PROVIDER == "elevenlabs":
        log.warning(
            "SPEECH_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty — "
            "falling back to sarvam"
        )
    from .sarvam import synthesize, transcribe  # noqa: F401
    from .stt_stream import StreamingSTT  # noqa: F401

    log.info("speech provider: sarvam")
