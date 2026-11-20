-- Correct the notice period date comparison.
-- The monitoring window may (and normally does) end before the notice issue date.
-- This migration changes only the RPC function; it does not update or delete ledger rows.

CREATE OR REPLACE FUNCTION public.issue_student_affairs_notices(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_item jsonb;
  v_result jsonb := '[]'::jsonb;
  v_row public.student_affairs_notice_issues%rowtype;
  v_class text;
  v_student text;
  v_next_number integer;
  v_delivered boolean;
  v_last_issued_on date;
  v_new_events jsonb;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION 'Invalid notice batch';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_class := btrim(coalesce(v_item->>'class_name', ''));
    v_student := btrim(coalesce(v_item->>'student_name', ''));
    v_delivered := coalesce((v_item->>'delivered')::boolean, false);

    IF v_class = '' OR v_student = ''
      OR coalesce(v_item->>'issued_by_name', '') = ''
      OR coalesce(v_item->>'issued_by_type', '') NOT IN ('admin', 'teacher', 'custom')
      OR jsonb_typeof(v_item->'events') <> 'array'
      OR jsonb_array_length(v_item->'events') < 1
      OR jsonb_typeof(v_item->'selected_types') <> 'array'
      OR (v_item->>'threshold')::integer NOT BETWEEN 1 AND 10
      OR (v_item->>'period_end')::date > (v_item->>'issued_on')::date THEN
      RAISE EXCEPTION 'Invalid notice item';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_class || chr(31) || v_student, 0));

    SELECT max(issued_on)
      INTO v_last_issued_on
      FROM public.student_affairs_notice_issues
      WHERE class_name = v_class AND student_name = v_student;

    -- Re-check the monitoring window under the per-student lock. This prevents
    -- concurrent official print requests from duplicating the same notice/events.
    SELECT coalesce(jsonb_agg(candidate.event), '[]'::jsonb)
      INTO v_new_events
      FROM jsonb_array_elements(v_item->'events') AS candidate(event)
      WHERE (v_last_issued_on IS NULL OR (candidate.event->>'date')::date > v_last_issued_on)
        AND NOT EXISTS (
          SELECT 1
            FROM public.student_affairs_notice_issues prior
            CROSS JOIN LATERAL jsonb_array_elements(prior.events) AS old(event)
           WHERE prior.class_name = v_class
             AND prior.student_name = v_student
             AND old.event->>'type' = candidate.event->>'type'
             AND old.event->>'date' = candidate.event->>'date'
             AND old.event->>'period' = candidate.event->>'period'
             AND coalesce(old.event->>'note', '') = coalesce(candidate.event->>'note', '')
        );

    IF jsonb_array_length(v_new_events) < (v_item->>'threshold')::integer THEN
      CONTINUE;
    END IF;

    SELECT coalesce(max(issue_number), 0) + 1
      INTO v_next_number
      FROM public.student_affairs_notice_issues
      WHERE class_name = v_class AND student_name = v_student;

    INSERT INTO public.student_affairs_notice_issues (
      class_name, student_name, issue_number, issued_on, issued_by_type, issued_by_name,
      delivered, delivered_at, threshold, period_start, period_end, selected_types, events
    ) VALUES (
      v_class, v_student, v_next_number, (v_item->>'issued_on')::date,
      v_item->>'issued_by_type', btrim(v_item->>'issued_by_name'),
      v_delivered, CASE WHEN v_delivered THEN now() ELSE NULL END,
      (v_item->>'threshold')::smallint,
      CASE WHEN v_last_issued_on IS NULL THEN nullif(v_item->>'period_start', '')::date ELSE v_last_issued_on + 1 END,
      (v_item->>'period_end')::date,
      v_item->'selected_types', v_new_events
    )
    RETURNING * INTO v_row;

    v_result := v_result || jsonb_build_array(to_jsonb(v_row));
  END LOOP;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.issue_student_affairs_notices(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_student_affairs_notices(jsonb) TO service_role;

COMMENT ON FUNCTION public.issue_student_affairs_notices(jsonb) IS
  'Atomically issues official notices. Monitoring period_end may be before issued_on; the function rejects only periods ending after the issue date.';
