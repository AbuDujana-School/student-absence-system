
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.competition_weekly_results (
  week_start date primary key,
  week_end date not null,
  status text not null check (status in ('complete','incomplete')),
  finalized_at timestamptz not null default now(),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.competition_weekly_results enable row level security;
revoke all on table public.competition_weekly_results from anon, authenticated;
grant select, insert, update on table public.competition_weekly_results to service_role;

insert into public.school_settings(key, value)
values ('competition_term_calendar', '[
  {"label":"الفصل الدراسي الأول 2026/2027","start":"2026-09-06","end":"2027-01-21"},
  {"label":"الفصل الدراسي الثاني 2026/2027","start":"2027-01-31","end":"2027-07-13"}
]'::jsonb)
on conflict (key) do nothing;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'student_affairs_project_url') then
    perform vault.create_secret('https://ylsocrvwqibptuwfzbke.supabase.co', 'student_affairs_project_url', 'Project URL for scheduled excellence competition finalization');
  end if;
  if not exists (select 1 from vault.secrets where name = 'competition_cron_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'competition_cron_secret', 'Private header token for scheduled excellence competition finalization');
  end if;
end
$$;

create or replace function public.student_affairs_get_competition_cron_secret()
returns text language sql security definer set search_path = ''
as $function$
  select decrypted_secret from vault.decrypted_secrets where name = 'competition_cron_secret' limit 1;
$function$;
revoke all on function public.student_affairs_get_competition_cron_secret() from public, anon, authenticated;
grant execute on function public.student_affairs_get_competition_cron_secret() to service_role;

do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname in ('student-affairs-competition-finalize-1350','student-affairs-competition-finalize-1400')
  loop perform cron.unschedule(job.jobid); end loop;
end
$$;

select cron.schedule('student-affairs-competition-finalize-1350','50,55 9 * * 4',$cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='student_affairs_project_url') || '/functions/v1/student-affairs',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='competition_cron_secret')),
    body := '{"action":"competition_finalize"}'::jsonb, timeout_milliseconds := 300000
  );
$cron$);
select cron.schedule('student-affairs-competition-finalize-1400','*/5 10 * * 4',$cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='student_affairs_project_url') || '/functions/v1/student-affairs',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='competition_cron_secret')),
    body := '{"action":"competition_finalize"}'::jsonb, timeout_milliseconds := 300000
  );
$cron$);
