"""Staff accounts. Identity/passwords live in Supabase Auth (server/supa_auth.py);
team/name/is_admin live in the staff_profiles table, joined to auth.users by id.
"""

import argparse
import asyncio
import secrets

from . import db, supa_auth


def generate_password(length: int = 14) -> str:
    return secrets.token_urlsafe(length)[:length]


def _row_to_account(row) -> dict:
    return {
        "user_id": str(row["user_id"]),
        "email": row["email"],
        "team": row["team"],
        "name": row["name"],
        "is_admin": row["is_admin"],
        "created_at": row["created_at"].timestamp(),
    }


_SELECT = """
    select sp.user_id, au.email, sp.team, sp.name, sp.is_admin, sp.created_at
    from staff_profiles sp join auth.users au on au.id = sp.user_id
"""


async def create(email: str, password: str, team: str, name: str, is_admin: bool = False) -> dict:
    user_id = await supa_auth.create_user(email.strip().lower(), password)
    await db.execute(
        "insert into staff_profiles (user_id, team, name, is_admin) values ($1, $2, $3, $4)",
        user_id, team, name, is_admin,
    )
    return await get_by_id(user_id)


async def get(email: str) -> dict | None:
    row = await db.fetchrow(_SELECT + " where lower(au.email) = lower($1)", email.strip())
    return _row_to_account(row) if row else None


async def get_by_id(user_id: str) -> dict | None:
    row = await db.fetchrow(_SELECT + " where sp.user_id = $1", user_id)
    return _row_to_account(row) if row else None


async def verify(email: str, password: str) -> dict | None:
    signed_in = await supa_auth.sign_in(email.strip().lower(), password)
    if signed_in is None:
        return None
    return await get_by_id(signed_in["user_id"])


async def list_all() -> list[dict]:
    rows = await db.fetch(_SELECT + " order by sp.created_at")
    return [_row_to_account(r) for r in rows]


async def set_password(user_id: str, new_password: str) -> bool:
    if await get_by_id(user_id) is None:
        return False
    await supa_auth.set_password(user_id, new_password)
    return True


async def delete(user_id: str) -> bool:
    if await get_by_id(user_id) is None:
        return False
    await db.execute("delete from staff_profiles where user_id = $1", user_id)
    await supa_auth.delete_user(user_id)
    return True


async def count_admins() -> int:
    return await db.fetchval("select count(*) from staff_profiles where is_admin = true")


async def seed_admin_if_empty(email: str, password: str, team: str, name: str) -> None:
    """Called once at app startup. No-op if any staff account already exists
    or the admin env vars weren't set."""
    if not email or not password:
        return
    if await db.fetchval("select count(*) from staff_profiles"):
        return
    await create(email, password, team, name, is_admin=True)


async def _cli_async():
    parser = argparse.ArgumentParser(prog="python -m server.accounts")
    sub = parser.add_subparsers(dest="cmd", required=True)

    add_p = sub.add_parser("add", help="Add a teammate account")
    add_p.add_argument("email")
    add_p.add_argument("password")
    add_p.add_argument("--team", default="technical", help="technical | sales | hr")
    add_p.add_argument("--name", default="")
    add_p.add_argument("--admin", action="store_true", help="Grant admin access")

    remove_p = sub.add_parser("remove", help="Remove an account")
    remove_p.add_argument("email")

    sub.add_parser("list", help="List accounts")

    args = parser.parse_args()
    await db.connect()
    await supa_auth.connect()
    if args.cmd == "add":
        await create(args.email, args.password, args.team, args.name or args.email, is_admin=args.admin)
        print(f"Added account: {args.email} (team={args.team}, admin={args.admin})")
    elif args.cmd == "remove":
        account = await get(args.email)
        ok = await delete(account["user_id"]) if account else False
        print("Removed." if ok else "No such account.")
    elif args.cmd == "list":
        for a in await list_all():
            admin_tag = " [admin]" if a["is_admin"] else ""
            print(f"{a['email']:<30} team={a['team']:<12} name={a['name']}{admin_tag}")


if __name__ == "__main__":
    asyncio.run(_cli_async())
