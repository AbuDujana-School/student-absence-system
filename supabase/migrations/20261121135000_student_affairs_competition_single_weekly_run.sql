-- Finalize the Student Affairs weekly discipline championship once per week.
-- pg_cron uses UTC on Supabase; 09:50 UTC is 13:50 in Oman (UTC+4).
-- The finalizer stores one shared snapshot in competition_weekly_results.
-- Readers on every device receive that same persisted weekly result.
do $$
declare job record;
begin
  for job in
    select jobid
    from cron.job
    where jobname in (
      'student-affairs-competition-finalize-1350',
      'student-affairs-competition-finalize-1400',
      'student-affairs-competition-finalize-retry',
      'student-affairs-competition-finalize-weekly'
    )
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'student-affairs-competition-finalize-weekly',
  '50 9 * * 4',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name='student_affairs_project_url') || '/functions/v1/student-affairs',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='competition_cron_secret')
      ),
      body := '{"action":"competition_finalize"}'::jsonb,
      timeout_milliseconds := 300000
    );
  $cron$
);
