"""Job posting persistence — Postgres via server/db.py (see db/schema.sql).

A posting is what candidates apply against via the public /apply flow; its id
becomes the job_id on any interview session created from an approved
application.
"""

import re
import uuid

from . import config, db


def _make_id(role: str) -> str:
    """role-slug-xxxx — readable in HR/ops instead of a raw uuid4 hex, with a
    short random suffix so re-posting the same role name doesn't collide."""
    return re.sub(r"[^a-z0-9]+", "-", role.strip().lower()).strip("-")[:60] or "role"


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "role": row["role"],
        "jd_text": row["jd_text"],
        "topics": row["topics"],
        "duration_min": row["duration_min"],
        "status": row["status"],
        "created_by": str(row["created_by"]),
        "created_by_name": row["created_by_name"],
        "notes": row["notes"],
        "created_at": row["created_at"].timestamp(),
        "opened_at": row["opened_at"].timestamp() if row["opened_at"] else None,
        "closed_at": row["closed_at"].timestamp() if row["closed_at"] else None,
    }


_SELECT = """
    select p.*, sp.name as created_by_name
    from postings p left join staff_profiles sp on sp.user_id = p.created_by
"""


async def _unique_id(role: str) -> str:
    slug = _make_id(role)
    for _ in range(5):
        posting_id = f"{slug}-{uuid.uuid4().hex[:4]}"
        if await db.fetchval("select 1 from postings where id = $1", posting_id) is None:
            return posting_id
    return f"{slug}-{uuid.uuid4().hex[:12]}"


async def request(role: str, notes: str, created_by: str) -> dict:
    """Ops asks HR to post a role — no JD yet, just role + why. Duration is
    ops's call at scheduling time, not something to decide this early."""
    posting_id = await _unique_id(role)
    await db.execute(
        """insert into postings (id, role, duration_min, status, created_by, notes)
           values ($1, $2, $3, 'requested', $4, $5)""",
        posting_id, role, config.INTERVIEW_DURATION_MIN, created_by, notes,
    )
    return await get(posting_id)


async def create(role: str, jd_text: str, duration_min: int, created_by: str, topics: str = "") -> dict:
    """HR/admin creates and immediately publishes a posting."""
    posting_id = await _unique_id(role)
    await db.execute(
        """insert into postings (id, role, jd_text, topics, duration_min, status, created_by, opened_at)
           values ($1, $2, $3, $4, $5, 'open', $6, now())""",
        posting_id, role, jd_text, topics, duration_min, created_by,
    )
    return await get(posting_id)


async def publish(posting_id: str, jd_text: str, duration_min: int, topics: str = "") -> dict | None:
    """Turn a requested posting into an open one by filling in the JD."""
    if await get(posting_id) is None:
        return None
    await db.execute(
        """update postings set jd_text = $2, topics = $3,
             duration_min = case when $4 > 0 then $4 else duration_min end,
             status = 'open', opened_at = now()
           where id = $1""",
        posting_id, jd_text, topics, duration_min,
    )
    return await get(posting_id)


async def close(posting_id: str) -> dict | None:
    if await get(posting_id) is None:
        return None
    await db.execute(
        "update postings set status = 'closed', closed_at = now() where id = $1", posting_id
    )
    return await get(posting_id)


async def find_open_by_jd(jd_text: str, exclude_id: str | None = None) -> dict | None:
    """Find an already-open posting with the same JD text (whitespace
    differences aside), so HR doesn't accidentally publish a duplicate role.
    Closed postings are ignored — reposting the same JD to reopen a role is fine."""
    normalized = " ".join(jd_text.split())
    if not normalized:
        return None
    for p in await list_all():
        if p["id"] == exclude_id or p["status"] != "open":
            continue
        if " ".join(p["jd_text"].split()) == normalized:
            return p
    return None


async def get(posting_id: str) -> dict | None:
    row = await db.fetchrow(_SELECT + " where p.id = $1", posting_id)
    return _row_to_dict(row) if row else None


async def list_all() -> list[dict]:
    rows = await db.fetch(_SELECT + " order by p.created_at desc")
    return [_row_to_dict(r) for r in rows]
