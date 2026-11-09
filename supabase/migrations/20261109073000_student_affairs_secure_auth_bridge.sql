create extension if not exists pgcrypto;
create extension if not exists supabase_vault with schema vault;
create schema if not exists private;

create table if not exists public.student_affairs_credentials (
  principal_type text not null check (principal_type in ('admin','teacher','custom')),
  principal_name text not null,
  pin_salt text not null,
  pin_hash text not null,
  source_hash text,
  source_salt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_type, principal_name)
);

create table if not exists public.student_affairs_sessions (
  token_hash text primary key,
  principal_type text not null check (principal_type in ('admin','teacher','custom')),
  principal_name text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.student_affairs_credentials enable row level security;
alter table public.student_affairs_sessions enable row level security;
revoke all on public.student_affairs_credentials from anon, authenticated;
revoke all on public.student_affairs_sessions from anon, authenticated;
grant all on public.student_affairs_credentials to service_role;
grant all on public.student_affairs_sessions to service_role;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'student_affairs_pin_pepper') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'student_affairs_pin_pepper', 'Server-only pepper for the School Student Affairs authentication bridge');
  end if;
end
$$;

create or replace function public.student_affairs_get_pin_pepper()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'student_affairs_pin_pepper'
  limit 1
$$;

revoke all on function public.student_affairs_get_pin_pepper() from public, anon, authenticated;
grant execute on function public.student_affairs_get_pin_pepper() to service_role;
