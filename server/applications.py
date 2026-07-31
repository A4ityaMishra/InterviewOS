"""Candidate application persistence: one JSON file per application under
data/applications/. Same pattern as server/store.py. Upstream of the
interview record an approved application eventually turns into.
"""

import json
import time
import uuid
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "applications"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# sentinel job_id for speculative applications submitted via /apply/general —
# not backed by a posting record, so there's no JD to prefill an interview
# from; approved general applications are scheduled manually via /ops like
# any other candidate sourced outside the posting flow
GENERAL_JOB_ID = "general"


def _path(application_id: str) -> Path:
    return DATA_DIR / f"{application_id}.json"


def create(
    job_id: str,
    applicant_name: str,
    applicant_email: str,
    resume_filename: str,
    resume_text: str,
    applicant_phone: str = "",
    cover_note: str = "",
) -> dict:
    application_id = uuid.uuid4().hex
    data = {
        "id": application_id,
        "job_id": job_id,
        "applicant_name": applicant_name,
        "applicant_email": applicant_email,
        "applicant_phone": applicant_phone,
        "resume_filename": resume_filename,
        "resume_text": resume_text,
        "cover_note": cover_note,
        "status": "pending",  # pending | approved | rejected
        "created_at": time.time(),
        "reviewed_at": None,
        "reviewed_by": None,
        "rejection_reason": None,
        "session_id": None,  # set once ops schedules an interview from this application
    }
    _write(application_id, data)
    return data


def set_status(application_id: str, status: str, reviewed_by: str, rejection_reason: str = "") -> dict | None:
    data = get(application_id)
    if data is None:
        return None
    data["status"] = status
    data["reviewed_by"] = reviewed_by
    data["reviewed_at"] = time.time()
    if status == "rejected":
        data["rejection_reason"] = rejection_reason or None
    _write(application_id, data)
    return data


def set_session_id(application_id: str, session_id: str) -> dict | None:
    data = get(application_id)
    if data is None:
        return None
    data["session_id"] = session_id
    _write(application_id, data)
    return data


def get(application_id: str) -> dict | None:
    p = _path(application_id)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def list_all() -> list[dict]:
    items = [json.loads(p.read_text()) for p in DATA_DIR.glob("*.json")]
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return items


def _write(application_id: str, data: dict):
    _path(application_id).write_text(json.dumps(data, ensure_ascii=False, indent=1))
