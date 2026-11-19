-- Allow the manifest RPC to run with invoker rights.
-- The private schema is not exposed through PostgREST; callers receive SELECT-only
-- access to the revision metadata and cannot change it.

GRANT USAGE ON SCHEMA private TO anon, authenticated;
GRANT SELECT ON TABLE private.app_sync_revisions TO anon, authenticated;

DROP POLICY IF EXISTS app_sync_revisions_read_manifest ON private.app_sync_revisions;
CREATE POLICY app_sync_revisions_read_manifest
ON private.app_sync_revisions
FOR SELECT
TO anon, authenticated
USING (true);

CREATE OR REPLACE FUNCTION public.get_app_sync_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
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
