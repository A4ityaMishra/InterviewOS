"""Supabase Auth wrapper — staff identity/passwords live here, not in our
own Postgres tables. Two clients: a service-role client for admin operations
(create/delete a user, force-set a password) and an anon-key client for the
password-grant sign-in a login form actually performs.
"""

from supabase import AsyncClient, create_async_client

from . import config

_admin: AsyncClient | None = None
_anon: AsyncClient | None = None


async def connect() -> None:
    global _admin, _anon
    _admin = await create_async_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)
    _anon = await create_async_client(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)


async def sign_in(email: str, password: str) -> dict | None:
    """Returns {"user_id": str, "email": str} on success, None on bad credentials."""
    try:
        res = await _anon.auth.sign_in_with_password({"email": email, "password": password})
    except Exception:
        return None
    if res.user is None:
        return None
    return {"user_id": res.user.id, "email": res.user.email}


async def create_user(email: str, password: str) -> str:
    """Creates a pre-confirmed Supabase Auth user and returns its id. Used by
    staff account creation (direct or invite-accept) and candidate signup —
    none of these need an email-confirmation click first."""
    res = await _admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    return res.user.id


async def set_password(user_id: str, new_password: str) -> None:
    await _admin.auth.admin.update_user_by_id(user_id, {"password": new_password})


async def request_otp(email: str) -> None:
    """Emails a one-time sign-in code. should_create_user=False so this only
    works for people who already have an account — signup is the one path
    that creates an auth user, so there's a single source of truth for "does
    this email have an account"."""
    try:
        await _anon.auth.sign_in_with_otp({"email": email, "options": {"should_create_user": False}})
    except Exception:
        pass


async def verify_otp(email: str, code: str) -> dict | None:
    """Returns {"user_id": str, "email": str} on a correct, unexpired code, None otherwise."""
    try:
        res = await _anon.auth.verify_otp({"email": email, "token": code, "type": "email"})
    except Exception:
        return None
    if res.user is None:
        return None
    return {"user_id": res.user.id, "email": res.user.email}


async def delete_user(user_id: str) -> None:
    await _admin.auth.admin.delete_user(user_id)


async def get_user_by_email(email: str) -> dict | None:
    """Linear scan via list_users — staff accounts are few (<100), so this
    is simpler than paginating a filtered admin query."""
    page = 1
    while True:
        res = await _admin.auth.admin.list_users(page=page, per_page=200)
        for u in res:
            if u.email and u.email.lower() == email.lower():
                return {"user_id": u.id, "email": u.email}
        if len(res) < 200:
            return None
        page += 1
