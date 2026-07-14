"""Voice-activity-based utterance endpointing.

Feed raw 16 kHz mono 16-bit PCM bytes; emits complete utterances once the
speaker has been silent for ENDPOINT_SILENCE_MS. Also reports the instant
speech starts, so the caller can implement barge-in.
"""

import numpy as np
import webrtcvad

from . import config

FRAME_BYTES = config.SAMPLE_RATE * config.VAD_FRAME_MS // 1000 * 2
# consecutive voiced frames required before we treat it as real speech —
# guards against noise blips triggering barge-in and killing agent responses
ONSET_FRAMES = 4  # ~120 ms

def _rms(frame: bytes) -> float:
    samples = np.frombuffer(frame, dtype=np.int16).astype(np.float64)
    return float(np.sqrt(np.mean(samples * samples)))


class UtteranceDetector:
    def __init__(self):
        self.vad = webrtcvad.Vad(config.VAD_AGGRESSIVENESS)
        self._pending = b""
        self._utterance = bytearray()
        self._in_speech = False
        self._silence_ms = 0
        self._speech_ms = 0
        self._onset_count = 0
        # keep a little pre-speech audio so first syllables aren't clipped
        self._preroll = bytearray()
        self._preroll_max = FRAME_BYTES * 10  # ~300 ms

    def feed(self, pcm: bytes):
        """Returns (speech_started: bool, finished_utterance: bytes | None)."""
        self._pending += pcm
        speech_started = False
        finished = None

        while len(self._pending) >= FRAME_BYTES:
            frame = self._pending[:FRAME_BYTES]
            self._pending = self._pending[FRAME_BYTES:]
            # energy gate: webrtcvad flags its first frames as speech while it
            # calibrates, and can flag noise; require speech-level energy too
            is_speech = (
                _rms(frame) >= config.SPEECH_RMS_THRESHOLD
                and self.vad.is_speech(frame, config.SAMPLE_RATE)
            )

            if not self._in_speech:
                self._preroll.extend(frame)
                if len(self._preroll) > self._preroll_max:
                    del self._preroll[: len(self._preroll) - self._preroll_max]
                self._onset_count = self._onset_count + 1 if is_speech else 0
                if self._onset_count >= ONSET_FRAMES:
                    self._in_speech = True
                    self._onset_count = 0
                    self._speech_ms = ONSET_FRAMES * config.VAD_FRAME_MS
                    self._silence_ms = 0
                    self._utterance = bytearray(self._preroll)
                    self._preroll.clear()
                    speech_started = True
            else:
                self._utterance.extend(frame)
                if is_speech:
                    self._speech_ms += config.VAD_FRAME_MS
                    self._silence_ms = 0
                else:
                    self._silence_ms += config.VAD_FRAME_MS
                    if self._silence_ms >= config.ENDPOINT_SILENCE_MS:
                        self._in_speech = False
                        if self._speech_ms >= config.MIN_SPEECH_MS:
                            finished = bytes(self._utterance)
                        self._utterance = bytearray()

        return speech_started, finished
