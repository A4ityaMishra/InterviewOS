"""Postgres access (Supabase) via a small asyncpg pool.

Business data (interviews, postings, applications, candidates, staff
profiles) lives in plain Postgres tables — see db/schema.sql — and is
queried with hand-written parameterized SQL rather than an ORM.
"""

import asyncpg

from . import config

_pool: asyncpg.Pool | None = None


async def connect() -> None:
    global _pool
    # Supabase's pooled connection (Supavisor, transaction mode) doesn't
    # support server-side prepared statements — disable asyncpg's statement
    # cache or every second query fails with DuplicatePreparedStatementError.
    _pool = await asyncpg.create_pool(
        config.DATABASE_URL, min_size=1, max_size=10, statement_cache_size=0
    )


async def disconnect() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db.connect() has not been called yet")
    return _pool


async def fetch(query: str, *args):
    return await pool().fetch(query, *args)


async def fetchrow(query: str, *args):
    return await pool().fetchrow(query, *args)


async def fetchval(query: str, *args):
    return await pool().fetchval(query, *args)


async def execute(query: str, *args) -> str:
    return await pool().execute(query, *args)
