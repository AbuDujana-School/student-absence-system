-- Direct, atomic student roster reconciliation for the general admin.
-- Removing roster membership never deletes or rewrites attendance, behavior notes, or notices.
CREATE TABLE IF NOT EXISTS public.student_roster_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_name text NOT NULL,
  student_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('added', 'removed')),
  actor_name text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.student_roster_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.student_roster_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.student_roster_audit TO service_role;

CREATE OR REPLACE FUNCTION public.admin_save_student_roster(
  p_class_name text,
  p_student_names jsonb,
  p_actor_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_names text[] := ARRAY[]::text[];
  v_added integer := 0;
  v_removed integer := 0;
  v_total integer := 0;
BEGIN
  IF length(btrim(coalesce(p_class_name, ''))) = 0
     OR length(p_class_name) > 120
     OR length(btrim(coalesce(p_actor_name, ''))) = 0
     OR length(p_actor_name) > 160
     OR jsonb_typeof(p_student_names) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_student_names) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'STUDENT_ROSTER_INVALID_INPUT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_student_names) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
       OR length(btrim(item.value #>> '{}')) = 0
       OR length(btrim(item.value #>> '{}')) > 160
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'STUDENT_ROSTER_INVALID_STUDENT_NAME';
  END IF;

  SELECT coalesce(array_agg(student_name ORDER BY student_name), ARRAY[]::text[])
  INTO v_names
  FROM (
    SELECT DISTINCT btrim(item.value #>> '{}') AS student_name
    FROM jsonb_array_elements(p_student_names) AS item(value)
  ) requested;

  -- Serialize roster reconciliation with transfers so that a save cannot race a move.
  LOCK TABLE public.students IN SHARE ROW EXCLUSIVE MODE;

  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE name = p_class_name) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_ROSTER_CLASS_NOT_FOUND';
  END IF;

  WITH removed AS (
    DELETE FROM public.students
    WHERE class_name = p_class_name
      AND NOT (student_name = ANY(v_names))
    RETURNING student_name
  )
  INSERT INTO public.student_roster_audit(class_name, student_name, action, actor_name)
  SELECT p_class_name, student_name, 'removed', p_actor_name
  FROM removed;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  WITH added AS (
    INSERT INTO public.students(class_name, student_name)
    SELECT p_class_name, requested.student_name
    FROM unnest(v_names) AS requested(student_name)
    ON CONFLICT (class_name, student_name) DO NOTHING
    RETURNING student_name
  )
  INSERT INTO public.student_roster_audit(class_name, student_name, action, actor_name)
  SELECT p_class_name, student_name, 'added', p_actor_name
  FROM added;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  SELECT count(*) INTO v_total
  FROM public.students
  WHERE class_name = p_class_name;

  RETURN jsonb_build_object(
    'class_name', p_class_name,
    'added_count', v_added,
    'removed_count', v_removed,
    'total_count', v_total
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_save_student_roster(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_student_roster(text, jsonb, text) TO service_role;
COMMENT ON FUNCTION public.admin_save_student_roster(text, jsonb, text)
IS 'Atomically saves one class roster for the general admin. Removed rows only lose roster membership; attendance, behavior notes, and official notices are retained. Transfers must use admin_transfer_student.';
