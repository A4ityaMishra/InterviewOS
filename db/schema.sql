-- InterviewOS — Supabase/Postgres schema (BCNF).
--
-- Run this once in the Supabase SQL editor (or via `psql`) against a fresh
-- project. auth.users is Supabase-managed (Supabase Auth); everything below
-- is our own schema, reachable directly via SQL (not just PostgREST).

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- Staff (technical / sales / hr), 1:1 with a Supabase Auth user.
create table staff_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  team        text not null check (team in ('technical', 'sales', 'hr')),
  name        text not null,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Applicant identity, normalized out of applications — name/phone depend on
-- the person, not on any one application. auth_user_id is reserved and
-- unused today: it lets a future candidate-portal login attach to an
-- existing candidate row without another migration.
create table candidates (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  name         text not null,
  phone        text not null default '',
  auth_user_id uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create table postings (
  id           text primary key,               -- role-slug-xxxx
  role         text not null,
  jd_text      text not null default '',
  topics       text not null default '',
  duration_min integer not null,
  status       text not null check (status in ('requested', 'open', 'closed')),
  created_by   uuid not null references auth.users(id),
  notes        text not null default '',
  created_at   timestamptz not null default now(),
  opened_at    timestamptz,
  closed_at    timestamptz
);

create table applications (
  id               uuid primary key default gen_random_uuid(),
  job_id           text references postings(id),   -- null = general application
  candidate_id     uuid not null references candidates(id),
  resume_filename  text not null,
  resume_text      text not null default '',
  cover_note       text not null default '',
  status           text not null check (status in ('pending', 'approved', 'rejected')),
  created_at       timestamptz not null default now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid references auth.users(id),
  rejection_reason text not null default ''
);
-- "is this application already scheduled" is answered by querying
-- interviews.application_id — no redundant applications.session_id column
-- that could drift from the interview that actually references it.

create table interviews (
  id                    uuid primary key default gen_random_uuid(),
  job_id                text not null,   -- opaque grouping key; NOT an FK —
                                          -- the manual/no-posting flow derives
                                          -- it from a JD hash and can't always
                                          -- resolve to a postings row
  application_id        uuid references applications(id),
  role                  text not null,
  duration_min          integer not null,
  jd_present            boolean not null default false,
  jd_text               text not null default '',
  topics                text not null default '',
  provider              text not null check (provider in ('pipeline', 'realtime')),
  system_prompt         text not null default '',   -- persists what used to live
                                                      -- only in the in-memory
                                                      -- _sessions dict, so a
                                                      -- server restart no longer
                                                      -- orphans an unjoined session
  status                text not null check (status in ('created', 'live', 'completed', 'disconnected')),
  created_at            timestamptz not null default now(),
  ended_at              timestamptz,
  llm_prompt_tokens     integer not null default 0,
  llm_completion_tokens integer not null default 0,
  stt_seconds           double precision not null default 0,
  tts_seconds           double precision not null default 0
);

-- messages[] was a multivalued attribute on the old interview JSON — its own
-- table for 1NF/BCNF.
create table interview_messages (
  id            bigserial primary key,
  interview_id  uuid not null references interviews(id) on delete cascade,
  speaker       text not null check (speaker in ('agent', 'candidate')),
  body          text not null,
  ts            timestamptz not null,
  interrupted   boolean not null default false
);

create index on applications (job_id);
create index on applications (candidate_id);
create index on applications (status);
create index on postings (status);
create index on interviews (job_id);
create index on interviews (application_id);
create index on interview_messages (interview_id);

alter table candidates add constraint candidates_auth_user_id_key unique (auth_user_id);

-- Admin-generated staff signup invites: the admin picks the email/team/role,
-- the invitee sets their own password when they accept.
create table staff_invites (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  team         text not null check (team in ('technical', 'sales', 'hr')),
  is_admin     boolean not null default false,
  invited_by   uuid not null references auth.users(id),
  token        text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz
);
create index on staff_invites (token);
