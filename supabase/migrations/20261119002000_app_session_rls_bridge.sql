-- Resolve the general application bearer session inside PostgreSQL RLS.
-- The browser keeps the Supabase anon JWT in Authorization and sends its opaque
-- application token separately in x-app-session. Only the SHA-256 digest is
-- compared with app_sessions; the raw token is never stored or returned here.
create or replace function private.current_app_session_principal()
returns table (
  principal_type text,
  principal_name text
)
language sql
stable
security definer
set search_path = ''
as $function$
  with request_headers as (
    select coalesce(
      nullif(pg_catalog.current_setting('request.headers', true), ''),
      '{}'
    )::jsonb as value
  ),
  presented_token as (
    select pg_catalog.lower(
      pg_catalog.btrim(coalesce(value ->> 'x-app-session', ''))
    ) as value
    from request_headers
  )
  select s.principal_type, s.principal_name
  from public.app_sessions as s
  cross join presented_token as token
  where token.value ~ '^[a-f0-9]{64}$'
    and s.token_hash = pg_catalog.encode(
      extensions.digest(token.value, 'sha256'),
      'hex'
    )
    and s.expires_at > pg_catalog.statement_timestamp()
  order by s.created_at desc
  limit 1;
$function$;

-- This helper is intentionally not exposed through PostgREST. RLS policies
-- invoke it internally after PostgREST has populated request.headers.
revoke all on function private.current_app_session_principal() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.current_app_session_principal() to anon, authenticated;

comment on function private.current_app_session_principal() is
  'Returns the active general-app principal identified by the x-app-session request header; compares only SHA-256 token digests.';
