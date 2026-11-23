DO $do$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.student_affairs_activity_events'::regclass) THEN
    RAISE EXCEPTION 'activity ledger RLS is not enabled';
  END IF;
  IF has_table_privilege('anon','public.student_affairs_activity_events','SELECT')
    OR has_table_privilege('anon','public.student_affairs_activity_events','INSERT')
    OR has_table_privilege('authenticated','public.student_affairs_activity_events','SELECT')
    OR has_table_privilege('authenticated','public.student_affairs_activity_events','INSERT') THEN
    RAISE EXCEPTION 'browser roles can access the activity ledger';
  END IF;
  IF NOT has_table_privilege('service_role','public.student_affairs_activity_events','SELECT')
    OR NOT has_table_privilege('service_role','public.student_affairs_activity_events','INSERT')
    OR has_table_privilege('service_role','public.student_affairs_activity_events','UPDATE')
    OR has_table_privilege('service_role','public.student_affairs_activity_events','DELETE') THEN
    RAISE EXCEPTION 'activity ledger is not append-only for service_role';
  END IF;
END $do$;

SET ROLE service_role;
INSERT INTO public.student_affairs_activity_events(event_type,actor_type,actor_name,metadata)
VALUES
  ('absence_report_view','teacher','synthetic-activity-teacher','{"from":"2026-11-23","to":"2026-11-23"}'),
  ('combined_report_view','teacher','synthetic-activity-teacher','{"from":"2026-11-23","to":"2026-11-23","source":"student_affairs_combined_view"}');
DO $do$
BEGIN
  IF (SELECT count(*) FROM public.student_affairs_activity_events WHERE actor_name='synthetic-activity-teacher') <> 2 THEN
    RAISE EXCEPTION 'service_role could not append/read synthetic activity';
  END IF;
END $do$;
RESET ROLE;

SELECT 'isolated Student Affairs activity ledger checks passed' AS result;
