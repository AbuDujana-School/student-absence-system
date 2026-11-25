DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Muscat')::date;
BEGIN
  IF NOT public.timetable_substitution_assignment_editable_until_day_end(v_today) THEN
    RAISE EXCEPTION 'A saved reserve assignment must remain editable throughout its assigned Muscat day.';
  END IF;
  IF NOT public.timetable_substitution_assignment_editable_until_day_end(v_today + 1) THEN
    RAISE EXCEPTION 'A future reserve assignment must be editable before its assigned day.';
  END IF;
  IF public.timetable_substitution_assignment_editable_until_day_end(v_today - 1) THEN
    RAISE EXCEPTION 'A past reserve assignment must be read-only.';
  END IF;
END;
$$;
