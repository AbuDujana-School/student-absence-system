-- Synthetic-only integration test. Runs in the disposable CI PostgreSQL database.
DO $test$
DECLARE
  v_result jsonb;
  v_count integer;
BEGIN
  DELETE FROM public.student_affairs_notice_issues
   WHERE class_name = '__notice_period_validation_test__';

  -- A monitoring period ending the day before issue date is valid.
  v_result := public.issue_student_affairs_notices(
    '[{
      "class_name":"__notice_period_validation_test__",
      "student_name":"__valid_prior_period__",
      "issued_on":"2026-11-20",
      "issued_by_type":"admin",
      "issued_by_name":"synthetic-admin",
      "delivered":false,
      "threshold":1,
      "period_start":"2026-11-01",
      "period_end":"2026-11-19",
      "selected_types":["late"],
      "events":[{"type":"late","date":"2026-11-19","period":"1","note":""}]
    }]'::jsonb
  );

  IF jsonb_array_length(v_result) <> 1 THEN
    RAISE EXCEPTION 'Prior monitoring period was not committed';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.student_affairs_notice_issues
   WHERE class_name = '__notice_period_validation_test__'
     AND student_name = '__valid_prior_period__'
     AND issued_on = DATE '2026-11-20'
     AND period_end = DATE '2026-11-19';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one synthetic notice with prior period end';
  END IF;

  -- A monitoring period ending after the issue date must still be rejected.
  BEGIN
    PERFORM public.issue_student_affairs_notices(
      '[{
        "class_name":"__notice_period_validation_test__",
        "student_name":"__invalid_future_period__",
        "issued_on":"2026-11-20",
        "issued_by_type":"admin",
        "issued_by_name":"synthetic-admin",
        "delivered":false,
        "threshold":1,
        "period_start":"2026-11-01",
        "period_end":"2026-11-21",
        "selected_types":["late"],
        "events":[{"type":"late","date":"2026-11-21","period":"1","note":""}]
      }]'::jsonb
    );
    RAISE EXCEPTION 'Expected future monitoring period to be rejected';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'Expected future monitoring period to be rejected' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'Invalid notice item' THEN
      RAISE;
    END IF;
  END;

  DELETE FROM public.student_affairs_notice_issues
   WHERE class_name = '__notice_period_validation_test__';

  SELECT count(*) INTO v_count
    FROM public.student_affairs_notice_issues
   WHERE class_name = '__notice_period_validation_test__';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Synthetic notice cleanup failed';
  END IF;
END
$test$;

SELECT 'notice period validation integration checks passed' AS result;
