"""Candidate identity — Postgres via server/db.py (see db/schema.sql).

Shared by the public /apply flow (which creates/updates a candidate row
without any login) and the candidate portal (which links a Supabase Auth
identity onto that same row via auth_user_id).
"""

from . import db


def _row_to_dict(row) -> dict:
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "phone": row["phone"],
        "auth_user_id": str(row["auth_user_id"]) if row["auth_user_id"] else None,
        "created_at": row["created_at"].timestamp(),
    }


async def get_by_email(email: str) -> dict | None:
    row = await db.fetchrow(
        "select * from candidates where lower(email) = lower($1)", email.strip()
    )
    return _row_to_dict(row) if row else None


async def get_by_auth_id(auth_user_id: str) -> dict | None:
    row = await db.fetchrow("select * from candidates where auth_user_id = $1", auth_user_id)
    return _row_to_dict(row) if row else None


async def upsert(email: str, name: str, phone: str = "", auth_user_id: str | None = None) -> dict:
    """Insert a new candidate, or update an existing one matched by email.
    Only overwrites phone/auth_user_id when a non-empty value is given, so an
    application submission (no auth_user_id) doesn't clobber a portal link
    made earlier, and a portal signup (no phone) doesn't clobber a phone
    number captured on a prior application."""
    row = await db.fetchrow(
        """insert into candidates (email, name, phone, auth_user_id)
           values ($1, $2, $3, $4)
           on conflict (email) do update set
             name = excluded.name,
             phone = case when excluded.phone <> '' then excluded.phone else candidates.phone end,
             auth_user_id = coalesce(excluded.auth_user_id, candidates.auth_user_id)
           returning *""",
        email.strip().lower(), name, phone, auth_user_id,
    )
    return _row_to_dict(row)


async def link_auth_user(candidate_id: str, auth_user_id: str) -> None:
    await db.execute(
        "update candidates set auth_user_id = $2 where id = $1", candidate_id, auth_user_id
    )
