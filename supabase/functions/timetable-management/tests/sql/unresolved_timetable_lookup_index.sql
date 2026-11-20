-- Regression test for the indexed legacy fallback used by teacher timetable reads.
-- The transaction is rolled back so the test leaves no timetable records behind.
BEGIN;

INSERT INTO public.timetable_weekly_versions(version,status,created_by)
VALUES (9991,'draft','unresolved-index-test');

INSERT INTO public.timetable_weekly_cells(
  version_id,teacher_source_name,matched_teacher_name,match_status,
  weekday,period,cell_status
)
SELECT v.id, sample.teacher_source_name, sample.matched_teacher_name,
       sample.match_status, 'الأحد', sample.period, 'teaching'
FROM public.timetable_weekly_versions v
CROSS JOIN (VALUES
  ('Matched Teacher','Matched Teacher','matched',1),
  ('Legacy Unmatched Teacher',NULL,'unmatched',2),
  ('Legacy Ambiguous Teacher',NULL,'ambiguous',3)
) AS sample(teacher_source_name,matched_teacher_name,match_status,period)
WHERE v.version=9991;

DO $test$
DECLARE
  test_version uuid;
  fallback_count integer;
  index_definition text;
  index_valid boolean;
  is_partial boolean;
BEGIN
  SELECT id INTO test_version
  FROM public.timetable_weekly_versions
  WHERE version=9991;

  SELECT count(*) INTO fallback_count
  FROM public.timetable_weekly_cells
  WHERE version_id=test_version
    AND (
      matched_teacher_name IS NULL
      OR match_status IS NULL
      OR match_status <> 'matched'
    );

  IF fallback_count <> 2 THEN
    RAISE EXCEPTION 'Expected 2 legacy fallback rows, found %', fallback_count;
  END IF;

  SELECT pg_get_indexdef(i.indexrelid),
         i.indisvalid,
         i.indpred IS NOT NULL
    INTO index_definition,index_valid,is_partial
  FROM pg_index i
  JOIN pg_class idx ON idx.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=idx.relnamespace
  WHERE n.nspname='public'
    AND idx.relname='timetable_weekly_cells_unresolved_lookup_idx';

  IF index_definition IS NULL OR NOT index_valid OR NOT is_partial THEN
    RAISE EXCEPTION 'Unresolved timetable partial index is missing or invalid';
  END IF;

  IF position('version_id, id' IN index_definition)=0
     OR position('matched_teacher_name IS NULL' IN index_definition)=0
     OR position('match_status IS NULL' IN index_definition)=0
     OR position('match_status <> ''matched''' IN index_definition)=0 THEN
    RAISE EXCEPTION 'Unresolved timetable index does not match the legacy fallback predicate: %', index_definition;
  END IF;
END;
$test$;

ROLLBACK;
