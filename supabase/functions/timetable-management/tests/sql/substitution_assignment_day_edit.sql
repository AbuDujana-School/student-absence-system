DO $test$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Muscat')::date;
BEGIN
  IF NOT public.timetable_substitution_assignment_day_is_open(v_today) THEN
    RAISE EXCEPTION 'Today must remain editable through the Muscat calendar day.';
  END IF;
  IF NOT public.timetable_substitution_assignment_day_is_open(v_today + 1) THEN
    RAISE EXCEPTION 'Future assignment dates must remain editable before their day.';
  END IF;
  IF public.timetable_substitution_assignment_day_is_open(v_today - 1) THEN
    RAISE EXCEPTION 'Past assignment dates must be archived and read-only.';
  END IF;
  PERFORM set_config('app.allow_reserve_edit_until_day_end','true',true);
  IF NOT public.timetable_substitution_period_is_open(v_today,1) THEN
    RAISE EXCEPTION 'The edit-only override must remain open through today even after a period ends.';
  END IF;
  IF NOT public.timetable_substitution_period_is_open(v_today + 1,1) THEN
    RAISE EXCEPTION 'The edit-only override must allow future assignment dates.';
  END IF;
  IF public.timetable_substitution_period_is_open(v_today - 1,1) THEN
    RAISE EXCEPTION 'The edit-only override must not reopen a past date.';
  END IF;
END
$test$;
