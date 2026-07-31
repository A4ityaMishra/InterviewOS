"""Admin-generated staff signup invites — the admin picks who gets access and
to which team; the invitee sets their own password when they accept.
"""

import secrets

from . import db

EXPIRY_DAYS = 7


def _row_to_dict(row) -> dict:
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "team": row["team"],
        "is_admin": row["is_admin"],
        "invited_by": str(row["invited_by"]),
        "token": row["token"],
        "created_at": row["created_at"].timestamp(),
        "expires_at": row["expires_at"].timestamp(),
        "accepted_at": row["accepted_at"].timestamp() if row["accepted_at"] else None,
    }


async def create(email: str, team: str, is_admin: bool, invited_by: str) -> dict:
    token = secrets.token_urlsafe(32)
    row = await db.fetchrow(
        """insert into staff_invites (email, team, is_admin, invited_by, token, expires_at)
           values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
           returning *""",
        email.strip().lower(), team, is_admin, invited_by, token, EXPIRY_DAYS,
    )
    return _row_to_dict(row)


async def get_by_token(token: str) -> dict | None:
    row = await db.fetchrow(
        "select * from staff_invites where token = $1 and accepted_at is null and expires_at > now()",
        token,
    )
    return _row_to_dict(row) if row else None


async def accept(token: str) -> None:
    await db.execute("update staff_invites set accepted_at = now() where token = $1", token)


async def list_pending() -> list[dict]:
    rows = await db.fetch(
        "select * from staff_invites where accepted_at is null and expires_at > now() "
        "order by created_at desc"
    )
    return [_row_to_dict(r) for r in rows]


async def revoke(invite_id: str) -> bool:
    result = await db.execute(
        "delete from staff_invites where id = $1 and accepted_at is null", invite_id
    )
    return result != "DELETE 0"
