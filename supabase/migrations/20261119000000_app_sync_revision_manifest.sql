-- Revision manifest for safe, table-scoped cloud synchronization.
-- The private revision table stores metadata only; no school records are copied or changed.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.app_sync_revisions (
  table_name text PRIMARY KEY CHECK (table_name IN (
    'classes','students','teachers','attendance','behaviors','school_settings','duty_reports'
  )),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE private.app_sync_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.app_sync_revisions FROM PUBLIC, anon, authenticated;

INSERT INTO private.app_sync_revisions (table_name, revision)
VALUES
  ('classes', 1),
  ('students', 1),
  ('teachers', 1),
  ('attendance', 1),
  ('behaviors', 1),
  ('school_settings', 1),
  ('duty_reports', 1)
ON CONFLICT (table_name) DO NOTHING;

CREATE OR REPLACE FUNCTION private.bump_app_sync_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, private
AS $function$
BEGIN
  INSERT INTO private.app_sync_revisions AS current_revision (table_name, revision, updated_at)
  VALUES (TG_TABLE_NAME, 1, clock_timestamp())
  ON CONFLICT (table_name) DO UPDATE
    SET revision = current_revision.revision + 1,
        updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.bump_app_sync_revision() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS app_sync_revision_classes ON public.classes;
CREATE TRIGGER app_sync_revision_classes
AFTER INSERT OR UPDATE OR DELETE ON public.classes
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

DROP TRIGGER IF EXISTS app_sync_revision_students ON public.students;
CREATE TRIGGER app_sync_revision_students
AFTER INSERT OR UPDATE OR DELETE ON public.students
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

DROP TRIGGER IF EXISTS app_sync_revision_teachers ON public.teachers;
CREATE TRIGGER app_sync_revision_teachers
AFTER INSERT OR UPDATE OR DELETE ON public.teachers
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

DROP TRIGGER IF EXISTS app_sync_revision_attendance ON public.attendance;
CREATE TRIGGER app_sync_revision_attendance
AFTER INSERT OR UPDATE OR DELETE ON public.attendance
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

DROP TRIGGER IF EXISTS app_sync_revision_behaviors ON public.behaviors;
CREATE TRIGGER app_sync_revision_behaviors
AFTER INSERT OR UPDATE OR DELETE ON public.behaviors
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

DROP TRIGGER IF EXISTS app_sync_revision_school_settings ON public.school_settings;
CREATE TRIGGER app_sync_revision_school_settings
AFTER INSERT OR UPDATE OR DELETE ON public.school_settings
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

DROP TRIGGER IF EXISTS app_sync_revision_duty_reports ON public.duty_reports;
CREATE TRIGGER app_sync_revision_duty_reports
AFTER INSERT OR UPDATE OR DELETE ON public.duty_reports
FOR EACH STATEMENT EXECUTE FUNCTION private.bump_app_sync_revision();

CREATE OR REPLACE FUNCTION public.get_app_sync_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, private
AS $function$
  SELECT COALESCE(
    jsonb_object_agg(table_name, revision ORDER BY table_name),
    '{}'::jsonb
  )
  FROM private.app_sync_revisions;
$function$;

REVOKE ALL ON FUNCTION public.get_app_sync_manifest() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_app_sync_manifest() TO anon, authenticated;
