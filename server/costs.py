"""Ops-side cost estimation. Combines the raw usage counters recorded on a
session (server/store.py) with public list pricing (server/config.py) to
produce a dollar breakdown. This is an estimate, not a billed amount — real
accounts may have negotiated or tiered rates that differ from the rate card.
"""

from . import config


def estimate(usage: dict, llm_model: str, speech_provider: str) -> dict:
    usage = usage or {}
    prompt_tok = usage.get("llm_prompt_tokens", 0)
    completion_tok = usage.get("llm_completion_tokens", 0)
    stt_s = usage.get("stt_seconds", 0.0)
    tts_s = usage.get("tts_seconds", 0.0)

    in_rate, out_rate = config.LLM_PRICE_PER_1M_TOKENS.get(llm_model, (0.0, 0.0))
    llm_cost = (prompt_tok / 1_000_000) * in_rate + (completion_tok / 1_000_000) * out_rate
    stt_cost = (stt_s / 60) * config.STT_PRICE_PER_MIN.get(speech_provider, 0.0)
    tts_cost = (tts_s / 60) * config.TTS_PRICE_PER_MIN.get(speech_provider, 0.0)

    return {
        "llm_cost": round(llm_cost, 5),
        "stt_cost": round(stt_cost, 5),
        "tts_cost": round(tts_cost, 5),
        "total_cost": round(llm_cost + stt_cost + tts_cost, 5),
        "llm_prompt_tokens": prompt_tok,
        "llm_completion_tokens": completion_tok,
        "stt_seconds": round(stt_s, 1),
        "tts_seconds": round(tts_s, 1),
        "llm_model": llm_model,
        "speech_provider": speech_provider,
    }
