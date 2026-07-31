"""FastAPI server: WebSocket voice loop with barge-in.

Client sends binary 16 kHz mono 16-bit PCM frames. Server sends JSON:
  {type: "agent_text", text}          - sentence the agent is about to say
  {type: "agent_audio", wav}          - base64 WAV for that sentence
  {type: "transcript", text}          - what the candidate said (for the UI)
  {type: "interrupt"}                 - stop playback immediately (barge-in)
  {type: "status", state}             - listening | thinking | speaking
  {type: "end"}                       - interview concluded
"""

import asyncio
import base64
import hashlib
import io
import logging
import time
import uuid
import wave
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from . import accounts, applications, auth, candidates, config, costs, db, documents, postings, speech, staff_invites, store, supa_auth
from .agent import InterviewSession, build_system_prompt
from .speech import StreamingSTT
from .vad import UtteranceDetector

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("interviewer")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await supa_auth.connect()
    await accounts.seed_admin_if_empty(
        config.ADMIN_EMAIL, config.ADMIN_PASSWORD, config.ADMIN_TEAM, config.ADMIN_NAME
    )
    yield
    await db.disconnect()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=config.SESSION_SECRET,
    session_cookie="idc_session",
    max_age=config.SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
    same_site="lax",
    https_only=config.SESSION_HTTPS_ONLY,
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def index(request: Request):
    if auth.current_user(request) is None:
        return RedirectResponse("/login")
    return RedirectResponse("/welcome")


@app.get("/login")
async def login_page(request: Request):
    if auth.current_user(request) is not None:
        return RedirectResponse("/welcome")
    return FileResponse("static/login.html")


@app.get("/welcome")
async def welcome_page(request: Request):
    if auth.current_user(request) is None:
        return RedirectResponse("/login")
    return FileResponse("static/welcome.html")


@app.get("/test-room")
async def test_room_page(request: Request):
    if auth.current_user(request) is None:
        return RedirectResponse("/login")
    return FileResponse("static/index.html")


@app.get("/ops")
async def ops_page(request: Request):
    if auth.current_user(request) is None:
        return RedirectResponse("/login")
    return FileResponse("static/ops.html")


@app.get("/team")
async def team_page(request: Request):
    user = auth.current_user(request)
    if user is None:
        return RedirectResponse("/login")
    if not user.get("is_admin"):
        return RedirectResponse("/welcome")
    return FileResponse("static/team.html")


@app.get("/hr")
async def hr_page(request: Request):
    user = auth.current_user(request)
    if user is None:
        return RedirectResponse("/login")
    if user.get("team") != "hr" and not user.get("is_admin"):
        return RedirectResponse("/welcome")
    return FileResponse("static/hr.html")


@app.get("/interview/{session_id}")
async def join_page(session_id: str):
    return FileResponse("static/join.html")


@app.get("/apply")
async def apply_list_page():
    return FileResponse("static/apply.html")


@app.get("/apply/general")
async def apply_general_page():
    return FileResponse("static/apply_general.html")


@app.get("/apply/{job_id}")
async def apply_form_page(job_id: str):
    return FileResponse("static/apply_form.html")


@app.get("/signup/team")
async def team_signup_page():
    return FileResponse("static/team_signup.html")


@app.get("/portal/login")
async def portal_login_page():
    return FileResponse("static/portal_login.html")


@app.get("/portal/signup")
async def portal_signup_page():
    return FileResponse("static/portal_signup.html")


@app.get("/portal")
async def portal_page(request: Request):
    user = auth.current_user(request)
    if user is None or user.get("kind") != "candidate":
        return RedirectResponse("/portal/login")
    return FileResponse("static/portal.html")


class LoginBody(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
async def api_login(request: Request, body: LoginBody):
    account = await accounts.verify(body.email, body.password)
    if account is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    request.session["user"] = {
        "kind": "staff",
        "user_id": account["user_id"],
        "email": account["email"],
        "name": account["name"],
        "team": account["team"],
        "is_admin": account.get("is_admin", False),
    }
    return {"ok": True, "redirect": "/welcome"}


@app.post("/api/auth/logout")
async def api_logout(request: Request):
    request.session.clear()
    return {"ok": True, "redirect": "/login"}


@app.get("/api/auth/me")
async def api_me(user: dict = Depends(auth.require_user)):
    return user


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/change-password")
async def change_password(body: ChangePasswordBody, user: dict = Depends(auth.require_user)):
    if await accounts.verify(user["email"], body.current_password) is None:
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    await accounts.set_password(user["user_id"], body.new_password)
    return {"ok": True}


@app.get("/api/accounts")
async def list_accounts(user: dict = Depends(auth.require_admin)):
    return await accounts.list_all()


class InviteAccountBody(BaseModel):
    email: str
    team: str
    is_admin: bool = False


@app.post("/api/accounts/invite")
async def invite_account(request: Request, body: InviteAccountBody, user: dict = Depends(auth.require_admin)):
    if await accounts.get(body.email) is not None:
        raise HTTPException(status_code=400, detail="That email is already taken")
    invite = await staff_invites.create(body.email, body.team, body.is_admin, user["user_id"])
    invite_url = str(request.base_url).rstrip("/") + f"/signup/team?token={invite['token']}"
    return {**invite, "invite_url": invite_url}


@app.get("/api/accounts/invites")
async def list_invites(user: dict = Depends(auth.require_admin)):
    return await staff_invites.list_pending()


@app.delete("/api/accounts/invites/{invite_id}")
async def revoke_invite(invite_id: str, user: dict = Depends(auth.require_admin)):
    ok = await staff_invites.revoke(invite_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


@app.get("/api/accounts/invite/{token}")
async def get_invite(token: str):
    """Public — lets the signup page show who's being invited before submit."""
    invite = await staff_invites.get_by_token(token)
    if invite is None:
        raise HTTPException(status_code=404, detail="This invite link is invalid or has expired")
    return {"email": invite["email"], "team": invite["team"]}


class TeamSignupBody(BaseModel):
    token: str
    name: str
    password: str


@app.post("/api/accounts/signup")
async def team_signup(request: Request, body: TeamSignupBody):
    invite = await staff_invites.get_by_token(body.token)
    if invite is None:
        raise HTTPException(status_code=404, detail="This invite link is invalid or has expired")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    account = await accounts.create(
        invite["email"], body.password, invite["team"], body.name.strip(), is_admin=invite["is_admin"]
    )
    await staff_invites.accept(body.token)
    request.session["user"] = {
        "kind": "staff",
        "user_id": account["user_id"],
        "email": account["email"],
        "name": account["name"],
        "team": account["team"],
        "is_admin": account.get("is_admin", False),
    }
    return {"ok": True, "redirect": "/welcome"}


@app.post("/api/accounts/{user_id}/reset-password")
async def reset_account_password(user_id: str, user: dict = Depends(auth.require_admin)):
    if await accounts.get_by_id(user_id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    password = accounts.generate_password()
    await accounts.set_password(user_id, password)
    return {"password": password}


@app.delete("/api/accounts/{user_id}")
async def delete_account(user_id: str, user: dict = Depends(auth.require_admin)):
    if user_id == user["user_id"]:
        raise HTTPException(status_code=400, detail="You can't remove your own account")
    target = await accounts.get_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Not found")
    if target.get("is_admin") and await accounts.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="Can't remove the last admin")
    await accounts.delete(user_id)
    return {"ok": True}


@app.get("/api/interviews/{session_id}/public")
async def interview_public_info(session_id: str):
    """Minimal, candidate-safe view of a session — no JD/transcript. Includes
    the candidate's own name (from their application) so the join page can
    greet them — nothing sensitive, it's the candidate's own info."""
    rec = await store.get(session_id)
    if rec is None:
        return {"error": "not found"}
    rec = await _with_applicant(rec, include_resume=False)
    return {
        "role": rec["role"],
        "duration_min": rec["duration_min"],
        "status": rec["status"],
        "applicant_name": rec.get("applicant_name"),
    }


def _wav_duration_s(wav: bytes) -> float:
    with wave.open(io.BytesIO(wav), "rb") as w:
        return w.getnframes() / float(w.getframerate())


app.mount("/static", StaticFiles(directory="static"), name="static")


async def _with_applicant(rec: dict, *, include_resume: bool) -> dict:
    """Joins in applicant_name/email (and optionally resume_text) from the
    linked application record, if this session was scheduled from one —
    read-time join instead of duplicating applicant data onto every
    interview record."""
    application_id = rec.get("application_id")
    if not application_id:
        return rec
    app_rec = await applications.get(application_id)
    if app_rec is None:
        return rec
    rec = {
        **rec,
        "applicant_name": app_rec["applicant_name"],
        "applicant_email": app_rec["applicant_email"],
    }
    if include_resume:
        rec["resume_text"] = app_rec.get("resume_text", "")
    return rec


@app.get("/api/ops/sessions")
async def ops_sessions(user: dict = Depends(auth.require_user)):
    return [await _with_applicant(rec, include_resume=False) for rec in await store.list_all()]


@app.get("/api/ops/sessions/{session_id}")
async def ops_session(session_id: str, user: dict = Depends(auth.require_user)):
    rec = await store.get(session_id)
    if rec is None:
        return {"error": "not found"}
    if rec.get("provider") != "realtime":
        # realtime sessions bill through OpenAI's Realtime API, not the
        # pipeline STT/LLM/TTS calls this estimate is built from
        llm_model = config.DEEPSEEK_MODEL if config.LLM_PROVIDER == "deepseek" else config.OPENAI_MODEL
        rec = {**rec, "cost": costs.estimate(rec.get("usage", {}), llm_model, speech.ACTIVE_PROVIDER)}
    return await _with_applicant(rec, include_resume=True)


async def _create_interview_session(
    role: str,
    jd_text: str,
    duration_min: int,
    provider: str,
    extra_docs: list[tuple[str, str]],
    topics: str = "",
    job_id: str | None = None,
    application_id: str | None = None,
) -> str:
    """Build the system prompt and persist a new interview record — including
    the prompt itself, so /ws can rebuild the call handler from the DB alone
    and a server restart before the candidate joins doesn't orphan the
    session. Shared by the manual /api/session flow and the "schedule from an
    approved application" flow."""
    duration = duration_min or config.INTERVIEW_DURATION_MIN
    resolved_role = role.strip()
    resolved_provider = provider if provider in ("pipeline", "realtime") else "pipeline"
    resolved_topics = topics.strip()
    prompt = build_system_prompt(
        role=resolved_role,
        duration_min=duration,
        jd_text=jd_text.strip(),
        extra_docs=extra_docs,
        topics=resolved_topics,
    )
    session_id = uuid.uuid4().hex
    if job_id is None:
        # Same JD text (whitespace differences aside) -> same job_id, so reposting
        # the same job description for multiple candidates groups their sessions
        # together in the ops dashboard. No JD text -> job_id is just this
        # session's own id (nothing to group it with).
        jd_normalized = " ".join(jd_text.split())
        job_id = hashlib.sha256(jd_normalized.encode("utf-8")).hexdigest()[:12] if jd_normalized else session_id
    await store.create(
        session_id,
        role=resolved_role,
        duration_min=duration,
        jd_present=bool(jd_text.strip()),
        job_id=job_id,
        jd_text=jd_text.strip(),
        topics=resolved_topics,
        provider=resolved_provider,
        application_id=application_id,
        system_prompt=prompt,
    )
    return session_id


@app.post("/api/session")
async def create_session(
    user: dict = Depends(auth.require_user),
    role: str = Form(""),
    duration_min: int = Form(0),
    jd_text: str = Form(""),
    topics: str = Form(""),
    provider: str = Form("pipeline"),
    jd_file: UploadFile | None = None,
    resume_file: UploadFile | None = None,
    docs: list[UploadFile] = [],
):
    """Create an interview session from a role, JD, and resume (all mandatory)
    plus optional extra documents and an optional topics override. Returns a
    session id for /ws. There is no generic single-role fallback — that used
    to silently produce interviews whose topics didn't match the JD."""
    if jd_file is not None and jd_file.filename:
        jd_text = documents.extract_text(jd_file.filename, await jd_file.read())
    if not role.strip():
        raise HTTPException(status_code=400, detail="Role is required")
    if not jd_text.strip():
        raise HTTPException(status_code=400, detail="A job description is required")
    if resume_file is None or not resume_file.filename:
        raise HTTPException(status_code=400, detail="A candidate resume is required")
    resume_text = documents.extract_text(resume_file.filename, await resume_file.read())
    extra = [(resume_file.filename, resume_text)]
    for f in docs:
        extra.append((f.filename, documents.extract_text(f.filename, await f.read())))

    session_id = await _create_interview_session(
        role=role,
        jd_text=jd_text,
        duration_min=duration_min,
        provider=provider,
        extra_docs=extra,
        topics=topics,
    )
    return {"session_id": session_id}


@app.post("/api/applications/{application_id}/schedule")
async def schedule_from_application(
    application_id: str,
    duration_min: int = Form(0),
    topics: str = Form(""),
    provider: str = Form("pipeline"),
    docs: list[UploadFile] = [],
    user: dict = Depends(auth.require_user),
):
    """Ops creates an interview session from an already-approved application,
    reusing its resume and the parent posting's role/JD, instead of manually
    re-entering them. Duration/topics/engine/extra docs are still ops's call
    per candidate — same as the manual /api/session flow's team notes/rubric
    upload, just for the application-prefilled path."""
    app_rec = await applications.get(application_id)
    if app_rec is None:
        raise HTTPException(status_code=404, detail="Application not found")
    if app_rec["status"] != "approved":
        raise HTTPException(status_code=400, detail="Only approved applications can be scheduled")
    if app_rec.get("session_id"):
        raise HTTPException(status_code=400, detail="This application already has a scheduled interview")
    posting = await postings.get(app_rec["job_id"])
    if posting is None:
        raise HTTPException(status_code=404, detail="The job posting for this application no longer exists")

    extra = [(app_rec["resume_filename"], app_rec["resume_text"])]
    for f in docs:
        if f.filename:
            extra.append((f.filename, documents.extract_text(f.filename, await f.read())))

    session_id = await _create_interview_session(
        role=posting["role"],
        jd_text=posting["jd_text"],
        duration_min=duration_min or posting.get("duration_min", 0),
        provider=provider,
        extra_docs=extra,
        topics=topics or posting.get("topics", ""),
        job_id=posting["id"],
        application_id=application_id,
    )
    return {"session_id": session_id}


@app.get("/api/postings")
async def list_postings(user: dict = Depends(auth.require_user)):
    # readable by any logged-in team member — ops needs this to prefill
    # role/duration/topics when scheduling from an approved application;
    # only creating/publishing/closing postings is HR-gated
    return await postings.list_all()


@app.post("/api/postings/request")
async def request_posting(
    role: str = Form(...),
    notes: str = Form(""),
    user: dict = Depends(auth.require_user),
):
    """Ops asks HR to open a posting for a role — no JD yet, just a heads-up."""
    if not role.strip():
        raise HTTPException(status_code=400, detail="Role is required")
    return await postings.request(role.strip(), notes.strip(), user["user_id"])


@app.post("/api/postings/check-duplicate")
async def check_duplicate_posting(
    jd_text: str = Form(""),
    exclude_id: str = Form(""),
    jd_file: UploadFile | None = None,
    user: dict = Depends(auth.require_hr),
):
    """Lets the HR create/publish forms warn before submit if this JD already
    matches an open posting, instead of only finding out after submitting."""
    if jd_file is not None and jd_file.filename:
        jd_text = documents.extract_text(jd_file.filename, await jd_file.read())
    match = await postings.find_open_by_jd(jd_text, exclude_id=exclude_id.strip() or None)
    if match is None:
        return {"duplicate": False}
    return {"duplicate": True, "posting_id": match["id"], "role": match["role"]}


@app.post("/api/postings")
async def create_posting(
    role: str = Form(""),
    jd_text: str = Form(""),
    duration_min: int = Form(0),
    topics: str = Form(""),
    jd_file: UploadFile | None = None,
    user: dict = Depends(auth.require_hr),
):
    """HR/admin creates and immediately publishes a posting candidates can apply to."""
    if jd_file is not None and jd_file.filename:
        jd_text = documents.extract_text(jd_file.filename, await jd_file.read())
    if not role.strip():
        raise HTTPException(status_code=400, detail="Role is required")
    if not jd_text.strip():
        raise HTTPException(status_code=400, detail="A job description is required")
    dup = await postings.find_open_by_jd(jd_text)
    if dup is not None:
        raise HTTPException(status_code=409, detail={
            "message": f'A posting for "{dup["role"]}" with this exact job description is already open.',
            "posting_id": dup["id"],
            "role": dup["role"],
        })
    return await postings.create(
        role=role.strip(),
        jd_text=jd_text.strip(),
        duration_min=duration_min or config.INTERVIEW_DURATION_MIN,
        created_by=user["user_id"],
        topics=topics.strip(),
    )


@app.post("/api/postings/{posting_id}/publish")
async def publish_posting(
    posting_id: str,
    jd_text: str = Form(""),
    duration_min: int = Form(0),
    topics: str = Form(""),
    jd_file: UploadFile | None = None,
    user: dict = Depends(auth.require_hr),
):
    """Turn a requested posting into an open one by filling in the JD."""
    if jd_file is not None and jd_file.filename:
        jd_text = documents.extract_text(jd_file.filename, await jd_file.read())
    if not jd_text.strip():
        raise HTTPException(status_code=400, detail="A job description is required")
    dup = await postings.find_open_by_jd(jd_text, exclude_id=posting_id)
    if dup is not None:
        raise HTTPException(status_code=409, detail={
            "message": f'A posting for "{dup["role"]}" with this exact job description is already open.',
            "posting_id": dup["id"],
            "role": dup["role"],
        })
    posting = await postings.publish(posting_id, jd_text.strip(), duration_min, topics.strip())
    if posting is None:
        raise HTTPException(status_code=404, detail="Posting not found")
    return posting


@app.post("/api/postings/{posting_id}/close")
async def close_posting(posting_id: str, user: dict = Depends(auth.require_hr)):
    posting = await postings.close(posting_id)
    if posting is None:
        raise HTTPException(status_code=404, detail="Posting not found")
    return posting


@app.get("/api/postings/public")
async def list_public_postings():
    """Candidate-safe view of open postings for the public /apply list page."""
    return [
        {"id": p["id"], "role": p["role"], "jd_excerpt": p["jd_text"][:280]}
        for p in await postings.list_all()
        if p["status"] == "open"
    ]


@app.get("/api/postings/{posting_id}/public")
async def public_posting_detail(posting_id: str):
    p = await postings.get(posting_id)
    if p is None or p["status"] != "open":
        return {"error": "not found"}
    return {"id": p["id"], "role": p["role"], "jd_text": p["jd_text"]}


@app.post("/api/applications")
async def submit_application(
    job_id: str = Form(""),
    applicant_name: str = Form(""),
    applicant_email: str = Form(""),
    applicant_phone: str = Form(""),
    cover_note: str = Form(""),
    resume_file: UploadFile | None = None,
):
    """Public, no-login application submission — either against a specific
    open posting, or a general/speculative application (blank job_id, from
    /apply/general) for candidates who don't see a matching role listed."""
    job_id = job_id.strip()
    if job_id:
        posting = await postings.get(job_id)
        if posting is None or posting["status"] != "open":
            raise HTTPException(status_code=404, detail="This job posting is no longer accepting applications")
    else:
        job_id = applications.GENERAL_JOB_ID
    if not applicant_name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    if not applicant_email.strip():
        raise HTTPException(status_code=400, detail="Email is required")
    if resume_file is None or not resume_file.filename:
        raise HTTPException(status_code=400, detail="A resume is required")
    resume_text = documents.extract_text(resume_file.filename, await resume_file.read())
    app_rec = await applications.create(
        job_id=job_id,
        applicant_name=applicant_name.strip(),
        applicant_email=applicant_email.strip(),
        resume_filename=resume_file.filename,
        resume_text=resume_text,
        applicant_phone=applicant_phone.strip(),
        cover_note=cover_note.strip(),
    )
    return {"application_id": app_rec["id"]}


@app.get("/api/applications")
async def list_applications(user: dict = Depends(auth.require_user)):
    # readable by any logged-in team member (not just HR) so ops can see
    # approved applications ready to schedule; only HR can review/decide
    return await applications.list_all()


@app.get("/api/applications/{application_id}")
async def get_application(application_id: str, user: dict = Depends(auth.require_user)):
    app_rec = await applications.get(application_id)
    if app_rec is None:
        raise HTTPException(status_code=404, detail="Not found")
    return app_rec


class ReviewBody(BaseModel):
    reason: str = ""


@app.post("/api/applications/{application_id}/approve")
async def approve_application(application_id: str, user: dict = Depends(auth.require_hr)):
    app_rec = await applications.set_status(application_id, "approved", reviewed_by=user["user_id"])
    if app_rec is None:
        raise HTTPException(status_code=404, detail="Not found")
    return app_rec


@app.post("/api/applications/{application_id}/reject")
async def reject_application(application_id: str, body: ReviewBody, user: dict = Depends(auth.require_hr)):
    app_rec = await applications.set_status(application_id, "rejected", reviewed_by=user["user_id"], rejection_reason=body.reason)
    if app_rec is None:
        raise HTTPException(status_code=404, detail="Not found")
    return app_rec


# ---------- Candidate portal ----------

class PortalSignupBody(BaseModel):
    name: str
    email: str
    password: str


@app.post("/api/portal/auth/signup")
async def portal_signup(request: Request, body: PortalSignupBody):
    existing = await candidates.get_by_email(body.email)
    if existing is not None and existing["auth_user_id"] is not None:
        raise HTTPException(status_code=400, detail="An account with that email already exists")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    user_id = await supa_auth.create_user(body.email, body.password)
    candidate = await candidates.upsert(body.email, body.name.strip(), auth_user_id=user_id)
    request.session["user"] = {
        "kind": "candidate",
        "user_id": user_id,
        "candidate_id": candidate["id"],
        "email": candidate["email"],
        "name": candidate["name"],
    }
    return {"ok": True, "redirect": "/portal"}


class PortalLoginBody(BaseModel):
    email: str
    password: str


@app.post("/api/portal/auth/login")
async def portal_login(request: Request, body: PortalLoginBody):
    signed_in = await supa_auth.sign_in(body.email, body.password)
    if signed_in is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    candidate = await candidates.get_by_auth_id(signed_in["user_id"])
    if candidate is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    request.session["user"] = {
        "kind": "candidate",
        "user_id": signed_in["user_id"],
        "candidate_id": candidate["id"],
        "email": candidate["email"],
        "name": candidate["name"],
    }
    return {"ok": True, "redirect": "/portal"}


class PortalRequestCodeBody(BaseModel):
    email: str


@app.post("/api/portal/auth/request-code")
async def portal_request_code(body: PortalRequestCodeBody):
    """Always returns the same response whether or not the email has an
    account, so this can't be used to enumerate registered candidates."""
    candidate = await candidates.get_by_email(body.email)
    if candidate is not None and candidate["auth_user_id"] is not None:
        await supa_auth.request_otp(body.email)
    return {"ok": True, "message": "If that email has an account, a code was sent."}


class PortalVerifyCodeBody(BaseModel):
    email: str
    code: str


@app.post("/api/portal/auth/verify-code")
async def portal_verify_code(request: Request, body: PortalVerifyCodeBody):
    verified = await supa_auth.verify_otp(body.email, body.code)
    if verified is None:
        raise HTTPException(status_code=401, detail="Invalid or expired code")
    candidate = await candidates.get_by_auth_id(verified["user_id"])
    if candidate is None:
        raise HTTPException(status_code=401, detail="Invalid or expired code")
    request.session["user"] = {
        "kind": "candidate",
        "user_id": verified["user_id"],
        "candidate_id": candidate["id"],
        "email": candidate["email"],
        "name": candidate["name"],
    }
    return {"ok": True, "redirect": "/portal"}


@app.get("/api/portal/auth/me")
async def portal_me(user: dict = Depends(auth.require_candidate)):
    return user


@app.get("/api/portal/applications")
async def portal_applications(user: dict = Depends(auth.require_candidate)):
    apps = await applications.list_for_candidate(user["candidate_id"])
    result = []
    for a in apps:
        entry = {
            "id": a["id"],
            "role": a["role"],
            "status": a["status"],
            "created_at": a["created_at"],
            "reviewed_at": a["reviewed_at"],
            "rejection_reason": a["rejection_reason"],
            "session_id": a["session_id"],
        }
        if a["session_id"]:
            # candidate-safe: interview status + id only, never duration_min
            # or anything else off the record
            rec = await store.get(a["session_id"])
            if rec is not None:
                entry["interview_status"] = rec["status"]
        result.append(entry)
    return result


class CallHandler:
    def __init__(self, ws: WebSocket, session_id: str, setup: dict | None = None):
        self.ws = ws
        self.session_id = session_id
        setup = setup or {}
        self.session = InterviewSession(
            system_prompt=setup.get("prompt"),
            duration_min=setup.get("duration_min"),
            topics=setup.get("topics"),
        )
        self.vad = UtteranceDetector()
        self.stt = StreamingSTT()
        self.speak_task: asyncio.Task | None = None
        self.spoken_so_far = ""
        # unanswered candidate speech; accumulates when the endpoint fires
        # mid-thought and they keep talking before the agent has replied
        self.pending_text = ""
        # running totals for the ops-side cost estimate (server/costs.py)
        self._stt_seconds = 0.0
        self._tts_seconds = 0.0

    async def send(self, **payload):
        await self.ws.send_json(payload)

    async def speak_response(self, user_text: str | None):
        """Stream LLM sentences through TTS to the client."""
        self.spoken_so_far = ""
        queue: asyncio.Queue = asyncio.Queue()

        async def produce():
            try:
                # pipeline: kick off TTS for each sentence as the LLM emits it,
                # so synthesis of sentence N overlaps generation of sentence N+1
                async for sentence in self.session.respond(user_text):
                    queue.put_nowait(
                        ("sentence", sentence, asyncio.create_task(speech.synthesize(sentence)))
                    )
                queue.put_nowait(("done", None, None))
            except Exception as exc:
                queue.put_nowait(("error", exc, None))

        producer = asyncio.create_task(produce())
        try:
            await self.send(type="status", state="thinking")
            if user_text is not None:
                # deliberate pause so replies don't feel instant/robotic
                await asyncio.sleep(config.REPLY_DELAY_MS / 1000)
            first = True
            t0 = time.monotonic()
            while True:
                try:
                    item_type, payload, tts_task = await asyncio.wait_for(
                        queue.get(), timeout=config.LLM_RESPONSE_TIMEOUT_S
                    )
                except asyncio.TimeoutError:
                    log.warning("agent response timed out for session %s", self.session_id)
                    raise RuntimeError("LLM response timed out")

                if item_type == "error":
                    raise payload
                if item_type == "done":
                    break

                sentence = payload
                wav = await tts_task
                self._tts_seconds += _wav_duration_s(wav)
                await store.set_usage(self.session_id, tts_seconds=self._tts_seconds)
                if first:
                    log.info("latency: to-first-audio %.2fs", time.monotonic() - t0)
                    await self.send(type="status", state="speaking")
                    first = False
                self.spoken_so_far += sentence + " "
                await self.send(type="agent_text", text=sentence)
                await self.send(
                    type="agent_audio", wav=base64.b64encode(wav).decode()
                )
            self.pending_text = ""
            await self._record_agent_turn()
            if self.session.ended:
                await store.set_status(self.session_id, "completed")
                await self.send(type="end")
            else:
                await self.send(type="status", state="listening")
        except asyncio.CancelledError:
            if self.spoken_so_far.strip():
                # the candidate heard a partial reply: their previous turn was
                # (partially) answered, so don't merge it into the next one
                self.session.note_partial_reply(self.spoken_so_far)
                self.pending_text = ""
            await self._record_agent_turn(interrupted=True)
            raise
        except Exception as e:
            log.exception("agent response failed: %s", str(e))
            await self.send(
                type="status",
                state="listening",
                error=f"Agent failed: {type(e).__name__}: {str(e)}"
            )
            # Don't silently fail — let the candidate know something went wrong
            await self.send(
                type="agent_text",
                text="I'm having trouble connecting. Can you hear me?"
            )
        finally:
            producer.cancel()
            while not queue.empty():
                item = queue.get_nowait()
                if item[0] != "done" and len(item) > 2 and item[2] is not None:
                    item[2].cancel()

    async def _record_agent_turn(self, interrupted: bool = False):
        text = self.spoken_so_far.strip()
        if text:
            await store.append_message(self.session_id, "agent", text, interrupted=interrupted)
            self.spoken_so_far = ""
        await store.set_usage(
            self.session_id,
            llm_prompt_tokens=self.session.usage["prompt_tokens"],
            llm_completion_tokens=self.session.usage["completion_tokens"],
        )

    def interrupt(self):
        if self.speak_task and not self.speak_task.done():
            self.speak_task.cancel()

    async def on_utterance(self, pcm: bytes):
        # instant feedback: the candidate stopped talking, show "thinking"
        # while STT runs instead of leaving them in "listening" dead air
        await self.send(type="status", state="thinking")
        t0 = time.monotonic()
        text = await self.stt.collect()
        if text:
            log.info("latency: streaming stt collect %.2fs", time.monotonic() - t0)
        else:
            # streaming produced nothing (connection died, or transcript lost)
            # — fall back to batch STT on the VAD-buffered utterance
            try:
                text = await speech.transcribe(pcm)
                log.info("latency: batch stt fallback %.2fs (%.1fs audio)",
                         time.monotonic() - t0, len(pcm) / 32000)
            except Exception:
                log.exception("STT failed")
                await self.send(type="status", state="listening")
                return
        if not text:
            await self.send(type="status", state="listening")
            return
        self._stt_seconds += len(pcm) / 32000  # 16kHz, 16-bit mono PCM
        await store.set_usage(self.session_id, stt_seconds=self._stt_seconds)
        log.info("candidate: %s", text)
        await store.append_message(self.session_id, "candidate", text)
        await self.send(type="transcript", text=text)
        # if the candidate resumed talking mid-pipeline and this utterance is a
        # continuation, fold the previous un-answered fragment into one turn
        self.pending_text = f"{self.pending_text} {text}".strip() if self.pending_text else text
        self.speak_task = asyncio.create_task(self.speak_response(self.pending_text))

    async def _hard_timeout_watchdog(self):
        """Safety net under the prompt's own time-awareness: force-end the
        call if it runs well past the planned duration, in case the model
        keeps going despite the elapsed-time notes."""
        deadline_s = (self.session.duration_min + config.HARD_TIMEOUT_GRACE_MIN) * 60
        await asyncio.sleep(deadline_s)
        if self.session.ended:
            return
        log.warning("session %s hit hard timeout, forcing close", self.session_id)
        self.interrupt()
        self.session.ended = True
        try:
            await self.send(
                type="agent_text",
                text="We're out of time for today — thanks so much for chatting with me.",
            )
            wav = await speech.synthesize(
                "We're out of time for today — thanks so much for chatting with me."
            )
            await self.send(type="agent_audio", wav=base64.b64encode(wav).decode())
            await self.send(type="end")
        except Exception:
            log.exception("hard timeout goodbye failed")
        await store.set_status(self.session_id, "completed")

    async def run(self):
        await self.ws.accept()
        await store.set_status(self.session_id, "live")
        await self.stt.connect()  # open the streaming STT channel up front
        watchdog = asyncio.create_task(self._hard_timeout_watchdog())
        # agent opens the interview
        self.speak_task = asyncio.create_task(self.speak_response(None))

        try:
            await self._loop()
        finally:
            watchdog.cancel()

    async def _loop(self):
        while True:
            msg = await self.ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            pcm = msg.get("bytes")
            if not pcm:
                continue
            await self.stt.send_audio(pcm)
            speech_started, utterance = self.vad.feed(pcm)
            if (
                speech_started
                and self.speak_task
                and not self.speak_task.done()
                and self.spoken_so_far
            ):
                # barge-in: candidate talking over an agent that is audibly
                # speaking. While the agent is still thinking, let it be —
                # if the candidate is adding to their answer, the completed
                # utterance below will cancel and re-respond with the merge.
                self.interrupt()
                await self.send(type="interrupt")
            if utterance and not self.session.ended:
                # ignore speech while a response is still being generated
                if self.speak_task and not self.speak_task.done():
                    self.interrupt()
                    await self.send(type="interrupt")
                await self.on_utterance(utterance)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, session: str = ""):
    # every session must originate from /api/session, which requires a role
    # and a JD — no ad-hoc/anonymous session is created here, since that
    # used to silently start generic, JD-less interviews. The setup a call
    # handler needs (system_prompt/duration_min/topics/provider) is persisted
    # on the interview row at creation time, so this lookup survives a server
    # restart between session creation and the candidate joining — it used to
    # live only in an in-memory dict and was lost on restart.
    rec = await store.get(session)
    if rec is None:
        await ws.close(code=4404, reason="Unknown session — create one via /api/session first")
        return

    setup = {
        "prompt": rec["system_prompt"],
        "duration_min": rec["duration_min"],
        "topics": rec["topics"],
    }
    provider = rec.get("provider") or ("realtime" if config.LLM_PROVIDER == "realtime" else "pipeline")

    if provider == "realtime":
        from .realtime_handler import RealtimeCallHandler
        handler = RealtimeCallHandler(ws, session, setup)
        try:
            await handler.run()
        except WebSocketDisconnect:
            pass
        finally:
            await store.set_status(session, "disconnected")
        return

    handler = CallHandler(ws, session, setup)
    try:
        await handler.run()
    except WebSocketDisconnect:
        pass
    finally:
        handler.interrupt()
        await handler.stt.close()
        await store.set_status(session, "disconnected")
