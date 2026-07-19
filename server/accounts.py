"""Local account store: data/accounts.json maps username -> account dict.

Single-process safe, same pattern as server/store.py. Swap for a real DB
if this ever needs concurrent multi-writer access.
"""

import argparse
import json
import secrets
import time
from pathlib import Path

import bcrypt

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
PATH = DATA_DIR / "accounts.json"


def _read_all() -> dict:
    if not PATH.exists():
        return {}
    return json.loads(PATH.read_text())


def _write_all(data: dict):
    PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1))


def generate_password(length: int = 14) -> str:
    return secrets.token_urlsafe(length)[:length]


def create(username: str, password: str, team: str, name: str, is_admin: bool = False) -> dict:
    accounts = _read_all()
    key = username.strip().lower()
    account = {
        "username": key,
        "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        "team": team,
        "name": name,
        "is_admin": is_admin,
        "created_at": time.time(),
    }
    accounts[key] = account
    _write_all(accounts)
    return account


def get(username: str) -> dict | None:
    return _read_all().get(username.strip().lower())


def verify(username: str, password: str) -> dict | None:
    account = get(username)
    if account is None:
        return None
    if not bcrypt.checkpw(password.encode(), account["password_hash"].encode()):
        return None
    return account


def list_all() -> list[dict]:
    return list(_read_all().values())


def set_password(username: str, new_password: str) -> bool:
    accounts = _read_all()
    key = username.strip().lower()
    if key not in accounts:
        return False
    accounts[key]["password_hash"] = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
    _write_all(accounts)
    return True


def delete(username: str) -> bool:
    accounts = _read_all()
    key = username.strip().lower()
    if key not in accounts:
        return False
    del accounts[key]
    _write_all(accounts)
    return True


def count_admins() -> int:
    return sum(1 for a in list_all() if a.get("is_admin"))


def seed_admin_if_empty(username: str, password: str, team: str, name: str):
    """Called once at app startup. No-op if accounts already exist or the
    admin env vars weren't set."""
    if not username or not password:
        return
    if _read_all():
        return
    create(username, password, team, name, is_admin=True)


def _cli():
    parser = argparse.ArgumentParser(prog="python -m server.accounts")
    sub = parser.add_subparsers(dest="cmd", required=True)

    add_p = sub.add_parser("add", help="Add or replace a teammate account")
    add_p.add_argument("username")
    add_p.add_argument("password")
    add_p.add_argument("--team", default="technical")
    add_p.add_argument("--name", default="")
    add_p.add_argument("--admin", action="store_true", help="Grant admin access")

    remove_p = sub.add_parser("remove", help="Remove an account")
    remove_p.add_argument("username")

    sub.add_parser("list", help="List accounts (no password hashes shown)")

    args = parser.parse_args()
    if args.cmd == "add":
        create(args.username, args.password, args.team, args.name or args.username, is_admin=args.admin)
        print(f"Added/updated account: {args.username} (team={args.team}, admin={args.admin})")
    elif args.cmd == "remove":
        ok = delete(args.username)
        print("Removed." if ok else "No such account.")
    elif args.cmd == "list":
        for a in list_all():
            admin_tag = " [admin]" if a.get("is_admin") else ""
            print(f"{a['username']:<20} team={a['team']:<12} name={a['name']}{admin_tag}")


if __name__ == "__main__":
    _cli()
