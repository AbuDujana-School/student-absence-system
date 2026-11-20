-- Speeds up the NULL-safe legacy fallback used by personal timetable reads.
-- The predicate intentionally matches TEACHER_TIMETABLE_FALLBACK_FILTER exactly.
-- It retains unresolved rows in superseded versions; no school records are changed.
CREATE INDEX IF NOT EXISTS timetable_weekly_cells_unresolved_lookup_idx
  ON public.timetable_weekly_cells (version_id, id)
  WHERE (
    matched_teacher_name IS NULL
    OR match_status IS NULL
    OR match_status <> 'matched'
  );
