# Changelog

Notable changes to InterviewOS. Newest first.

## Unreleased

- Reverted an in-progress attempt at a per-staff "Config" tab (personal LLM/speech
  API keys + provider/model selection). The `staff_provider_configs` table and the
  new `interviews` columns it added were applied to and then dropped from the live
  Supabase project; no trace left in the schema. Revisit if there's a real need for
  HR/Ops to bring their own vendor keys.

## 2026-07-31

- Removed the Firebase Hosting rewrite (`interviewos.web.app`) — sessions created
  through it intermittently failed cookie signature validation on Cloud Run even
  though the same revision served both the login and the failing check. Root cause
  wasn't pinned down; reverted to the direct Cloud Run URL, which is reliable.
  Live at https://interviewos-7y22ym2paa-el.a.run.app.
- Added Cloud Run CI/CD via GitHub Actions + Workload Identity Federation — every
  push to `master` now auto-builds and redeploys, no stored service-account keys.
- First production deploy: new GCP project (`interviewos-prod-91767`), Cloud Run
  service running the existing Dockerfile, secrets in Google Secret Manager.
- Migrated all storage from local JSON files to Supabase (Postgres + Supabase Auth),
  schema normalized to BCNF (`db/schema.sql`).
- Added a candidate portal (`/portal`) — candidates sign up/sign in (password or
  emailed one-time code), track application status, and get a "Join your interview"
  link once one is scheduled. Duration is never exposed to candidates.
- Added admin-generated staff invite links (`/team` → "Add teammate") replacing
  admin-issued generated passwords — invitees set their own password.
- Added a `kind` discriminator to staff vs. candidate sessions so a candidate
  session can no longer reach staff-only endpoints.

## Earlier

- Candidate applications + HR approval flow, ops dashboard rework, session auth,
  team management, cost estimation, and the original voice interview pipeline
  (STT via Sarvam/ElevenLabs/Smallest, LLM via OpenAI/DeepSeek/Realtime, barge-in
  turn-taking). See `git log` for the full history.
