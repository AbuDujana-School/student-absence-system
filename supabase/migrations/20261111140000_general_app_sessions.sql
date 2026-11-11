-- General application sessions are deliberately separate from Student Affairs sessions.
-- This migration must be applied only in an isolated test database until reviewed.
create table if not exists public.app_sessions (
  token_hash text primary key
    check (token_hash ~ '^[a-f0-9]{64}$'),
  principal_type text not null
    check (principal_type in ('admin', 'teacher', 'custom')),
  principal_name text not null
    check (length(btrim(principal_name)) > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_expires_at_idx
  on public.app_sessions (expires_at);

alter table public.app_sessions enable row level security;

-- No browser role may read, create, update, or revoke general app sessions.
revoke all on table public.app_sessions from public, anon, authenticated;
grant all on table public.app_sessions to service_role;

comment on table public.app_sessions is
  'Server-only general application sessions. Stores SHA-256 bearer token digests, never raw bearer tokens. Separate from Student Affairs sessions.';
comment on column public.app_sessions.token_hash is
  'Lowercase SHA-256 digest of a 256-bit random application bearer token.';
