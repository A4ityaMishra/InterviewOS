"""Candidate application persistence — Postgres via server/db.py (see
db/schema.sql). Upstream of the interview record an approved application
eventually turns into.
"""

from . import candidates, db

# sentinel job_id for speculative applications submitted via /apply/general —
# not backed by a posting record, so there's no JD to prefill an interview
# from. Stored as NULL in applications.job_id; translated at this module's
# boundary so callers never see the NULL/sentinel distinction.
GENERAL_JOB_ID = "general"

_SELECT = """
    select a.id, a.job_id, a.candidate_id, c.name as applicant_name, c.email as applicant_email,
           c.phone as applicant_phone, a.resume_filename, a.resume_text, a.cover_note,
           a.status, a.created_at, a.reviewed_at, a.reviewed_by, sp.name as reviewed_by_name,
           a.rejection_reason, p.role as posting_role,
           (select i.id from interviews i where i.application_id = a.id limit 1) as session_id
    from applications a
    join candidates c on c.id = a.candidate_id
    left join staff_profiles sp on sp.user_id = a.reviewed_by
    left join postings p on p.id = a.job_id
"""


def _row_to_dict(row) -> dict:
    return {
        "id": str(row["id"]),
        "job_id": row["job_id"] or GENERAL_JOB_ID,
        "role": row["posting_role"] or "General application",
        "applicant_name": row["applicant_name"],
        "applicant_email": row["applicant_email"],
        "applicant_phone": row["applicant_phone"],
        "resume_filename": row["resume_filename"],
        "resume_text": row["resume_text"],
        "cover_note": row["cover_note"],
        "status": row["status"],
        "created_at": row["created_at"].timestamp(),
        "reviewed_at": row["reviewed_at"].timestamp() if row["reviewed_at"] else None,
        "reviewed_by": str(row["reviewed_by"]) if row["reviewed_by"] else None,
        "reviewed_by_name": row["reviewed_by_name"],
        "rejection_reason": row["rejection_reason"] or None,
        "session_id": str(row["session_id"]) if row["session_id"] else None,
    }


async def create(
    job_id: str,
    applicant_name: str,
    applicant_email: str,
    resume_filename: str,
    resume_text: str,
    applicant_phone: str = "",
    cover_note: str = "",
) -> dict:
    candidate = await candidates.upsert(applicant_email, applicant_name, applicant_phone)
    stored_job_id = None if job_id in (GENERAL_JOB_ID, "") else job_id
    application_id = await db.fetchval(
        """insert into applications
           (job_id, candidate_id, resume_filename, resume_text, cover_note, status)
           values ($1, $2, $3, $4, $5, 'pending') returning id""",
        stored_job_id, candidate["id"], resume_filename, resume_text, cover_note,
    )
    return await get(str(application_id))


async def set_status(application_id: str, status: str, reviewed_by: str, rejection_reason: str = "") -> dict | None:
    if await get(application_id) is None:
        return None
    await db.execute(
        """update applications set status = $2, reviewed_by = $3, reviewed_at = now(),
             rejection_reason = case when $2 = 'rejected' then $4 else rejection_reason end
           where id = $1""",
        application_id, status, reviewed_by, rejection_reason or None,
    )
    return await get(application_id)


async def get(application_id: str) -> dict | None:
    row = await db.fetchrow(_SELECT + " where a.id = $1", application_id)
    return _row_to_dict(row) if row else None


async def list_all() -> list[dict]:
    rows = await db.fetch(_SELECT + " order by a.created_at desc")
    return [_row_to_dict(r) for r in rows]


async def list_for_candidate(candidate_id: str) -> list[dict]:
    rows = await db.fetch(
        _SELECT + " where a.candidate_id = $1 order by a.created_at desc", candidate_id
    )
    return [_row_to_dict(r) for r in rows]
