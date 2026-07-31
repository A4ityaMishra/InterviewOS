"""Interview transcript persistence — Postgres via server/db.py (see db/schema.sql)."""

from . import db


def _row_to_dict(row, messages: list[dict]) -> dict:
    return {
        "id": str(row["id"]),
        "job_id": row["job_id"],
        "application_id": str(row["application_id"]) if row["application_id"] else None,
        "role": row["role"],
        "duration_min": row["duration_min"],
        "jd_present": row["jd_present"],
        "jd_text": row["jd_text"],
        "topics": row["topics"],
        "provider": row["provider"],
        "system_prompt": row["system_prompt"],
        "created_at": row["created_at"].timestamp(),
        "status": row["status"],
        "ended_at": row["ended_at"].timestamp() if row["ended_at"] else None,
        "messages": messages,
        "usage": {
            "llm_prompt_tokens": row["llm_prompt_tokens"],
            "llm_completion_tokens": row["llm_completion_tokens"],
            "stt_seconds": row["stt_seconds"],
            "tts_seconds": row["tts_seconds"],
        },
    }


async def create(
    interview_id: str,
    role: str,
    duration_min: int,
    jd_present: bool,
    job_id: str,
    jd_text: str = "",
    topics: str = "",
    provider: str = "pipeline",
    application_id: str | None = None,
    system_prompt: str = "",
):
    await db.execute(
        """insert into interviews
           (id, job_id, application_id, role, duration_min, jd_present, jd_text,
            topics, provider, system_prompt, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'created')""",
        interview_id, job_id, application_id, role, duration_min, jd_present,
        jd_text, topics, provider, system_prompt,
    )


async def set_usage(interview_id: str, **fields):
    """Overwrite the given usage counters with their latest absolute totals
    (callers track running totals themselves, so this is idempotent)."""
    if not fields:
        return
    cols = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
    await db.execute(
        f"update interviews set {cols} where id = $1", interview_id, *fields.values()
    )


async def append_message(interview_id: str, speaker: str, text: str, interrupted: bool = False):
    await db.execute(
        "insert into interview_messages (interview_id, speaker, body, ts, interrupted) "
        "values ($1, $2, $3, now(), $4)",
        interview_id, speaker, text, interrupted,
    )


async def set_status(interview_id: str, status: str):
    # don't let a late disconnect overwrite a clean completion
    await db.execute(
        """update interviews set status = $2,
             ended_at = case when $2 in ('completed', 'disconnected') and ended_at is null
                             then now() else ended_at end
           where id = $1 and not (status = 'completed' and $2 = 'disconnected')""",
        interview_id, status,
    )


async def get(interview_id: str) -> dict | None:
    row = await db.fetchrow("select * from interviews where id = $1", interview_id)
    if row is None:
        return None
    msg_rows = await db.fetch(
        "select speaker, body, ts, interrupted from interview_messages "
        "where interview_id = $1 order by id", interview_id
    )
    messages = []
    for m in msg_rows:
        msg = {"speaker": m["speaker"], "text": m["body"], "ts": m["ts"].timestamp()}
        if m["interrupted"]:
            msg["interrupted"] = True
        messages.append(msg)
    return _row_to_dict(row, messages)


async def list_all() -> list[dict]:
    rows = await db.fetch(
        """select i.*, coalesce(mc.message_count, 0) as message_count,
                  coalesce(mc.last_activity, i.created_at) as last_activity
           from interviews i
           left join (
             select interview_id, count(*) as message_count, max(ts) as last_activity
             from interview_messages group by interview_id
           ) mc on mc.interview_id = i.id
           order by i.created_at desc"""
    )
    return [
        {
            "id": str(r["id"]),
            "job_id": r["job_id"],
            "application_id": str(r["application_id"]) if r["application_id"] else None,
            "role": r["role"],
            "created_at": r["created_at"].timestamp(),
            "status": r["status"],
            "duration_min": r["duration_min"],
            "provider": r["provider"],
            "message_count": r["message_count"],
            "last_activity": r["last_activity"].timestamp(),
        }
        for r in rows
    ]
