DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Muscat')::date;
BEGIN
  IF NOT public.timetable_substitution_day_is_open(v_today) THEN
    RAISE EXCEPTION 'Today must remain editable until Muscat midnight';
  END IF;
  IF NOT public.timetable_substitution_day_is_open(v_today + 1) THEN
    RAISE EXCEPTION 'A future assignment date must remain editable throughout that date';
  END IF;
  IF public.timetable_substitution_day_is_open(v_today - 1) THEN
    RAISE EXCEPTION 'A past assignment date must already be archived';
  END IF;
END;
$$;
