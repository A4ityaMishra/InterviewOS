"""Session-based auth helpers. See server/accounts.py for the account store."""

from fastapi import HTTPException, Request


def current_user(request: Request) -> dict | None:
    return request.session.get("user")


def require_user(request: Request) -> dict:
    """FastAPI dependency for staff API routes: 401 JSON if not logged in as
    staff. A candidate-portal session (kind="candidate") does not satisfy
    this — without the check, a signed-in candidate's session would pass
    require_user and reach staff-only endpoints like /api/ops/sessions."""
    user = current_user(request)
    if user is None or user.get("kind") != "staff":
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_candidate(request: Request) -> dict:
    """FastAPI dependency for candidate-portal API routes."""
    user = current_user(request)
    if user is None or user.get("kind") != "candidate":
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(request: Request) -> dict:
    """FastAPI dependency for admin-only API routes: 401 if logged out, 403 if
    logged in but not an admin."""
    user = require_user(request)
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_hr(request: Request) -> dict:
    """FastAPI dependency for HR-gated API routes: 401 if logged out, 403 if
    logged in but neither HR team nor admin (admins bypass, same as elsewhere)."""
    user = require_user(request)
    if user.get("team") != "hr" and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="HR access required")
    return user
