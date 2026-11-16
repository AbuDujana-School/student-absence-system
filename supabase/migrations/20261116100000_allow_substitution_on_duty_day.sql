-- A teacher's duty day does not prevent them from covering a reserve lesson.
-- Keep all timetable, duty settings, teacher and permission data unchanged.
-- Remove only the obsolete database guard that rejected reserve assignments on duty days.

drop trigger if exists timetable_substitution_duty_day_guard
  on public.timetable_assignments;

drop function if exists public.guard_timetable_substitution_duty_day();
