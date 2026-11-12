-- Retry weekly excellence finalization every five minutes until the earliest pending week is complete.
-- The Edge Function itself selects the correct closed week and stops writing once it is complete.
do $$
declare job record;
begin
  for job in
    select jobid
    from cron.job
    where jobname in (
      'student-affairs-competition-finalize-1350',
      'student-affairs-competition-finalize-1400',
      'student-affairs-competition-finalize-retry'
    )
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'student-affairs-competition-finalize-retry',
  '*/5 * * * *',
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
