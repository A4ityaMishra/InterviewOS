"""Streaming LLM client. OpenAI by default; DeepSeek via its
OpenAI-compatible endpoint (set LLM_PROVIDER=deepseek)."""

from typing import AsyncIterator

from openai import AsyncOpenAI

from . import config

_client: AsyncOpenAI | None = None
_model: str = ""


def _get_client() -> AsyncOpenAI:
    global _client, _model
    if _client is None:
        if config.LLM_PROVIDER == "deepseek":
            key = config.DEEPSEEK_API_KEY
            if not key:
                raise ValueError("DEEPSEEK_API_KEY not set in environment")
            _client = AsyncOpenAI(
                api_key=key, base_url="https://api.deepseek.com"
            )
            _model = config.DEEPSEEK_MODEL
        else:
            key = config.OPENAI_API_KEY
            if not key:
                raise ValueError("OPENAI_API_KEY not set in environment")
            _client = AsyncOpenAI(api_key=key)
            _model = config.OPENAI_MODEL
    return _client


async def stream_chat(messages: list[dict]) -> AsyncIterator[str]:
    """Yields text deltas."""
    stream = await _get_client().chat.completions.create(
        model=_model,
        messages=messages,
        stream=True,
        temperature=0.6,
        max_tokens=300,
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content if chunk.choices else None
        if delta:
            yield delta
