"""Job posting persistence: one JSON file per posting under data/postings/.

Same pattern as server/store.py. A posting is what candidates apply against
via the public /apply flow; its id becomes the job_id on any interview
session created from an approved application.
"""

import json
import re
import time
import uuid
from pathlib import Path

from . import config

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "postings"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _path(posting_id: str) -> Path:
    return DATA_DIR / f"{posting_id}.json"


def _make_id(role: str) -> str:
    """role-slug-xxxx — readable in HR/ops instead of a raw uuid4 hex, with a
    short random suffix so re-posting the same role name doesn't collide."""
    slug = re.sub(r"[^a-z0-9]+", "-", role.strip().lower()).strip("-")[:60] or "role"
    for _ in range(5):
        posting_id = f"{slug}-{uuid.uuid4().hex[:4]}"
        if not _path(posting_id).exists():
            return posting_id
    return f"{slug}-{uuid.uuid4().hex[:12]}"


def request(role: str, notes: str, created_by: str) -> dict:
    """Ops asks HR to post a role — no JD yet, just role + why. Duration is
    ops's call at scheduling time, not something to decide this early."""
    posting_id = _make_id(role)
    data = {
        "id": posting_id,
        "role": role,
        "jd_text": "",
        "topics": "",
        "duration_min": config.INTERVIEW_DURATION_MIN,
        "status": "requested",  # requested | open | closed
        "created_by": created_by,
        "notes": notes,
        "created_at": time.time(),
        "opened_at": None,
        "closed_at": None,
    }
    _write(posting_id, data)
    return data


def create(role: str, jd_text: str, duration_min: int, created_by: str, topics: str = "") -> dict:
    """HR/admin creates and immediately publishes a posting."""
    posting_id = _make_id(role)
    now = time.time()
    data = {
        "id": posting_id,
        "role": role,
        "jd_text": jd_text,
        "topics": topics,
        "duration_min": duration_min,
        "status": "open",
        "created_by": created_by,
        "notes": "",
        "created_at": now,
        "opened_at": now,
        "closed_at": None,
    }
    _write(posting_id, data)
    return data


def publish(posting_id: str, jd_text: str, duration_min: int, topics: str = "") -> dict | None:
    """Turn a requested posting into an open one by filling in the JD."""
    data = get(posting_id)
    if data is None:
        return None
    data["jd_text"] = jd_text
    data["topics"] = topics
    if duration_min:
        data["duration_min"] = duration_min
    data["status"] = "open"
    data["opened_at"] = time.time()
    _write(posting_id, data)
    return data


def close(posting_id: str) -> dict | None:
    data = get(posting_id)
    if data is None:
        return None
    data["status"] = "closed"
    data["closed_at"] = time.time()
    _write(posting_id, data)
    return data


def find_open_by_jd(jd_text: str, exclude_id: str | None = None) -> dict | None:
    """Find an already-open posting with the same JD text (whitespace
    differences aside), so HR doesn't accidentally publish a duplicate role.
    Closed postings are ignored — reposting the same JD to reopen a role is fine."""
    normalized = " ".join(jd_text.split())
    if not normalized:
        return None
    for p in list_all():
        if p["id"] == exclude_id or p["status"] != "open":
            continue
        if " ".join(p["jd_text"].split()) == normalized:
            return p
    return None


def get(posting_id: str) -> dict | None:
    p = _path(posting_id)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def list_all() -> list[dict]:
    items = [json.loads(p.read_text()) for p in DATA_DIR.glob("*.json")]
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return items


def _write(posting_id: str, data: dict):
    _path(posting_id).write_text(json.dumps(data, ensure_ascii=False, indent=1))
