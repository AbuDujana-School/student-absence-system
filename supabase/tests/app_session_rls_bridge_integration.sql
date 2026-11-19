begin;

-- Fixtures use synthetic tokens and identities only; the transaction is rolled back.
insert into public.app_sessions (token_hash, principal_type, principal_name, expires_at)
values
  (encode(extensions.digest(repeat('a', 64), 'sha256'), 'hex'), 'teacher', 'RLS Bridge Test Teacher', now() + interval '1 hour'),
  (encode(extensions.digest(repeat('b', 64), 'sha256'), 'hex'), 'admin', 'RLS Bridge Expired Admin', now() - interval '1 hour');

select set_config(
  'request.headers',
  jsonb_build_object('x-app-session', repeat('a', 64))::text,
  true
);

set local role anon;

do $test$
declare
  principal record;
begin
  if has_table_privilege(current_user, 'public.app_sessions', 'SELECT') then
    raise exception 'anon must not read app_sessions directly';
  end if;

  select * into principal from private.current_app_session_principal();
  if principal.principal_type is distinct from 'teacher'
     or principal.principal_name is distinct from 'RLS Bridge Test Teacher' then
    raise exception 'valid x-app-session did not resolve the expected principal';
  end if;
end;
$test$;

reset role;

-- Missing, malformed, expired, and revoked tokens must all fail closed.
select set_config('request.headers', '{}'::text, true);
do $test$
begin
  if exists (select 1 from private.current_app_session_principal()) then
    raise exception 'missing app session unexpectedly resolved';
  end if;
end;
$test$;

select set_config(
  'request.headers',
  jsonb_build_object('x-app-session', 'not-a-token')::text,
  true
);
do $test$
begin
  if exists (select 1 from private.current_app_session_principal()) then
    raise exception 'malformed app session unexpectedly resolved';
  end if;
end;
$test$;

select set_config(
  'request.headers',
  jsonb_build_object('x-app-session', repeat('b', 64))::text,
  true
);
do $test$
begin
  if exists (select 1 from private.current_app_session_principal()) then
    raise exception 'expired app session unexpectedly resolved';
  end if;
end;
$test$;

select set_config(
  'request.headers',
  jsonb_build_object('x-app-session', repeat('a', 64))::text,
  true
);
delete from public.app_sessions
where token_hash = encode(extensions.digest(repeat('a', 64), 'sha256'), 'hex');
do $test$
begin
  if exists (select 1 from private.current_app_session_principal()) then
    raise exception 'revoked app session unexpectedly resolved';
  end if;
end;
$test$;

rollback;
