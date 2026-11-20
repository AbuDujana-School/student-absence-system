-- Runs only against disposable CI PostgreSQL, never the school database.
DO $$
DECLARE
  v_result jsonb;
  v_rejected boolean := false;
BEGIN
  v_result := public.issue_student_affairs_notices(
    '[{
      "class_name":"CI-NOTICE-ONLY",
      "student_name":"Synthetic Student",
      "issued_on":"2026-11-20",
      "issued_by_type":"teacher",
      "issued_by_name":"CI Synthetic Teacher",
      "delivered":false,
      "threshold":1,
      "period_start":"2026-11-01",
      "period_end":"2026-11-19",
      "selected_types":["absent"],
      "events":[{"type":"absent","date":"2026-11-19","period":"1","note":""}]
    }]'::jsonb
  );
  IF jsonb_array_length(v_result) <> 1 THEN
    RAISE EXCEPTION 'A valid historical monitoring window was not committed';
  END IF;

  BEGIN
    PERFORM public.issue_student_affairs_notices(
      '[{
        "class_name":"CI-NOTICE-ONLY",
        "student_name":"Synthetic Student",
        "issued_on":"2026-11-20",
        "issued_by_type":"teacher",
        "issued_by_name":"CI Synthetic Teacher",
        "delivered":false,
        "threshold":1,
        "period_start":"2026-11-01",
        "period_end":"2026-11-21",
        "selected_types":["absent"],
        "events":[{"type":"absent","date":"2026-11-21","period":"1","note":""}]
      }]'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_rejected := SQLERRM = 'Invalid notice item';
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'A monitoring period after issuance was not rejected';
  END IF;

  IF (SELECT count(*) FROM public.student_affairs_notice_issues WHERE class_name='CI-NOTICE-ONLY' AND student_name='Synthetic Student') <> 1 THEN
    RAISE EXCEPTION 'Invalid test payload created or modified a notice row';
  END IF;

  DELETE FROM public.student_affairs_notice_issues
   WHERE class_name='CI-NOTICE-ONLY' AND student_name='Synthetic Student';
END $$;
SELECT 'notice issue period validation passed' AS result;
