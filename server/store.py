"""Interview transcript persistence: one JSON file per interview under data/.

Single-process safe. Swap for a real DB when scaling out.
"""

import json
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "interviews"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _path(interview_id: str) -> Path:
    return DATA_DIR / f"{interview_id}.json"


def create(
    interview_id: str,
    role: str,
    duration_min: int,
    jd_present: bool,
    job_id: str,
    jd_text: str = "",
    topics: str = "",
    provider: str = "pipeline",
):
    _write(
        interview_id,
        {
            "id": interview_id,
            "job_id": job_id,  # shared across sessions created from the same JD
            "role": role,
            "duration_min": duration_min,
            "jd_present": jd_present,
            "jd_text": jd_text,
            "topics": topics,
            "provider": provider,  # pipeline | realtime
            "created_at": time.time(),
            "status": "created",  # created | live | completed | disconnected
            "ended_at": None,
            "messages": [],
            # raw usage counters for the ops cost estimate — see server/costs.py
            "usage": {
                "llm_prompt_tokens": 0,
                "llm_completion_tokens": 0,
                "stt_seconds": 0.0,
                "tts_seconds": 0.0,
            },
        },
    )


def set_usage(interview_id: str, **fields):
    """Overwrite the given usage counters with their latest absolute totals
    (callers track running totals themselves, so this is idempotent)."""
    data = get(interview_id)
    if data is None:
        return
    data.setdefault("usage", {}).update(fields)
    _write(interview_id, data)


def append_message(interview_id: str, speaker: str, text: str, interrupted: bool = False):
    data = get(interview_id)
    if data is None:
        return
    msg = {"speaker": speaker, "text": text, "ts": time.time()}
    if interrupted:
        msg["interrupted"] = True
    data["messages"].append(msg)
    _write(interview_id, data)


def set_status(interview_id: str, status: str):
    data = get(interview_id)
    if data is None:
        return
    # don't let a late disconnect overwrite a clean completion
    if data["status"] == "completed" and status == "disconnected":
        return
    data["status"] = status
    if status in ("completed", "disconnected") and not data.get("ended_at"):
        data["ended_at"] = time.time()
    _write(interview_id, data)


def get(interview_id: str) -> dict | None:
    p = _path(interview_id)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def list_all() -> list[dict]:
    items = []
    for p in DATA_DIR.glob("*.json"):
        d = json.loads(p.read_text())
        items.append(
            {
                "id": d["id"],
                "job_id": d.get("job_id", d["id"]),
                "role": d["role"],
                "created_at": d["created_at"],
                "status": d["status"],
                "duration_min": d["duration_min"],
                "provider": d.get("provider", "pipeline"),
                "message_count": len(d["messages"]),
                "last_activity": d["messages"][-1]["ts"] if d["messages"] else d["created_at"],
            }
        )
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return items


def _write(interview_id: str, data: dict):
    _path(interview_id).write_text(json.dumps(data, ensure_ascii=False, indent=1))
