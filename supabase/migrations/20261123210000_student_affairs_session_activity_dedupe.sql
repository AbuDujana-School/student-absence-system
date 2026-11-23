-- Enforce one Student Affairs audit event per action type and authenticated app login session.
-- Only SHA-256 digests are stored; raw bearer tokens are never persisted.
alter table public.student_affairs_sessions
  add column if not exists app_session_hash text
  check (app_session_hash is null or app_session_hash ~ '^[a-f0-9]{64}$');

create index if not exists student_affairs_sessions_app_session_hash_idx
  on public.student_affairs_sessions (app_session_hash)
  where app_session_hash is not null;

alter table public.student_affairs_activity_events
  add column if not exists session_hash text
  check (session_hash is null or session_hash ~ '^[a-f0-9]{64}$');

-- Legacy rows remain NULL; all new tracked events are session-bound.
-- The unique index atomically suppresses repeated/concurrent actions in the same session.
create unique index if not exists student_affairs_activity_events_session_type_uidx
  on public.student_affairs_activity_events (session_hash, event_type);

comment on column public.student_affairs_sessions.app_session_hash is
  'SHA-256 digest of the general app login session that created this Student Affairs bridge session.';
comment on column public.student_affairs_activity_events.session_hash is
  'SHA-256 digest identifying the authenticated login session; unique with event_type to count each action at most once per session.';
