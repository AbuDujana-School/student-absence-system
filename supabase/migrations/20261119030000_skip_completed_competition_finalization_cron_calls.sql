-- Keep the five-minute retry cadence for incomplete competition weeks,
-- but avoid invoking the Edge Function after the eligible week is already complete.
-- This preserves retry behavior while removing no-op Edge/RPC requests.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'student-affairs-competition-finalize-retry'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'student-affairs-competition-finalize-retry',
  '*/5 * * * *',
  $cron$
    do $competition_finalize$
    declare
      should_finalize boolean := false;
    begin
      with params as (
        select
          (now() at time zone 'Asia/Muscat')::date as today,
          (now() at time zone 'Asia/Muscat')::time as local_time
      ),
      terms as (
        select
          (item->>'start')::date as start_date,
          (item->>'end')::date as end_date
        from school_settings s
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end
        ) item
        where s.key = 'competition_term_calendar'
          and item->>'start' ~ '^\\d{4}-\\d{2}-\\d{2}$'
          and item->>'end' ~ '^\\d{4}-\\d{2}-\\d{2}$'
      ),
      current_term as (
        select t.start_date, t.end_date, p.today, p.local_time
        from terms t
        cross join params p
        order by
          case
            when t.start_date <= p.today and p.today <= t.end_date then 0
            when t.start_date > p.today then 1
            else 2
          end,
          case when t.start_date > p.today then t.start_date end asc nulls last,
          case when t.start_date <= p.today then t.start_date end desc nulls last
        limit 1
      ),
      eligible as (
        select *,
          case
            when extract(dow from today)::int > 4
              or (extract(dow from today)::int = 4 and local_time >= time '13:50')
            then today - extract(dow from today)::int
            else today - extract(dow from today)::int - 7
          end as eligible_start
        from current_term
      ),
      pending as (
        select r.week_start, r.week_end
        from competition_weekly_results r
        cross join eligible e
        where r.status = 'incomplete'
          and r.week_start >= e.start_date
          and r.week_end <= e.end_date
          and r.week_start <= e.eligible_start
        order by r.week_start asc
        limit 1
      ),
      target as (
        select
          coalesce(p.week_start, e.eligible_start) as target_start,
          coalesce(p.week_end, e.eligible_start + 4) as target_end,
          e.start_date,
          e.end_date
        from eligible e
        left join pending p on true
      )
      select
        coalesce(
          target_start >= start_date
          and target_end <= end_date
          and not exists (
            select 1
            from competition_weekly_results r
            where r.week_start = target.target_start
              and r.status = 'complete'
          ),
          false
        )
      into should_finalize
      from target;

      if should_finalize then
        perform net.http_post(
          url := (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'student_affairs_project_url'
          ) || '/functions/v1/student-affairs',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'competition_cron_secret'
            )
          ),
          body := '{"action":"competition_finalize"}'::jsonb,
          timeout_milliseconds := 300000
        );
      end if;
    end
    $competition_finalize$;
  $cron$
);
