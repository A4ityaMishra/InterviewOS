"""Session-based auth helpers. See server/accounts.py for the account store."""

from fastapi import HTTPException, Request


def current_user(request: Request) -> dict | None:
    return request.session.get("user")


def require_user(request: Request) -> dict:
    """FastAPI dependency for API routes: 401 JSON if not logged in."""
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(request: Request) -> dict:
    """FastAPI dependency for admin-only API routes: 401 if logged out, 403 if
    logged in but not an admin."""
    user = require_user(request)
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
