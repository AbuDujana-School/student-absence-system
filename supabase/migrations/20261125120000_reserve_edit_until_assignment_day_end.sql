-- Reserve assignments remain editable for the full assignment date in Asia/Muscat.
-- Coordinators may prepare future dates; past dates are read-only.
-- The same date-based rule is used by create, update, and cancel RPCs via this helper.
CREATE OR REPLACE FUNCTION public.timetable_substitution_period_edit_deadline(
  p_assignment_date date,
  p_period integer
)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_assignment_date IS NULL OR p_period IS NULL OR p_period NOT BETWEEN 1 AND 8 THEN NULL
    ELSE ((p_assignment_date + 1)::timestamp without time zone) AT TIME ZONE 'Asia/Muscat'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.timetable_substitution_period_is_open(
  p_assignment_date date,
  p_period integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(
    p_assignment_date >= (now() AT TIME ZONE 'Asia/Muscat')::date
    AND now() < public.timetable_substitution_period_edit_deadline(p_assignment_date, p_period),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.timetable_substitution_period_edit_deadline(date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.timetable_substitution_period_is_open(date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.timetable_substitution_period_edit_deadline(date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.timetable_substitution_period_is_open(date, integer) TO service_role;
