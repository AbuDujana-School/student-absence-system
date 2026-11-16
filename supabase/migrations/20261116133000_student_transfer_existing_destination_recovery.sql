-- Recover a roster move where the destination membership was added manually.
BEGIN;
CREATE OR REPLACE FUNCTION public.admin_transfer_student(
  p_student_name text, p_from_class text, p_to_class text, p_actor_name text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_student_id bigint; v_destination_student_id bigint;
  v_source_count integer := 0; v_destination_count integer := 0;
  v_row record; v_target_id bigint; v_target_records jsonb; v_target_key text;
  v_attendance_count integer := 0; v_behavior_count integer := 0; v_notice_count integer := 0;
  v_membership_rows integer := 0;
BEGIN
  IF length(btrim(coalesce(p_student_name, ''))) = 0
     OR length(btrim(coalesce(p_from_class, ''))) = 0
     OR length(btrim(coalesce(p_to_class, ''))) = 0
     OR length(btrim(coalesce(p_actor_name, ''))) = 0
     OR length(p_student_name) > 160 OR length(p_from_class) > 120
     OR length(p_to_class) > 120 OR p_from_class = p_to_class THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'STUDENT_TRANSFER_INVALID_INPUT';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext(p_student_name),
    hashtext(least(p_from_class, p_to_class) || E'\x1f' || greatest(p_from_class, p_to_class))
  );
  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE name = p_from_class)
     OR NOT EXISTS (SELECT 1 FROM public.classes WHERE name = p_to_class) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_CLASS_NOT_FOUND';
  END IF;
  -- Serialize roster writes while reconciling source and destination memberships.
  LOCK TABLE public.students IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_source_count FROM public.students
  WHERE class_name = p_from_class AND student_name = p_student_name;
  IF v_source_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_SOURCE_NOT_FOUND';
  ELSIF v_source_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_SOURCE_DUPLICATE';
  END IF;
  SELECT id INTO v_student_id FROM public.students
  WHERE class_name = p_from_class AND student_name = p_student_name FOR UPDATE;
  SELECT count(*) INTO v_destination_count FROM public.students
  WHERE class_name = p_to_class AND student_name = p_student_name;
  IF v_destination_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_DESTINATION_DUPLICATE';
  ELSIF v_destination_count = 1 THEN
    SELECT id INTO v_destination_student_id FROM public.students
    WHERE class_name = p_to_class AND student_name = p_student_name FOR UPDATE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.student_affairs_notice_issues src
    JOIN public.student_affairs_notice_issues dst
      ON dst.class_name = p_to_class AND dst.student_name = p_student_name
     AND dst.issue_number = src.issue_number
    WHERE src.class_name = p_from_class AND src.student_name = p_student_name
  ) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_NOTICE_CONFLICT'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance src JOIN public.attendance dst
      ON dst.record_key = src.date_str::text || '_' || p_to_class || '_p' || src.period::text
    WHERE src.class_name = p_from_class AND src.records ? p_student_name AND dst.records ? p_student_name
  ) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_ATTENDANCE_CONFLICT'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.behaviors src JOIN public.behaviors dst
      ON dst.record_key = src.date_str::text || '_' || p_to_class || '_p' || src.period::text
    WHERE src.class_name = p_from_class AND src.records ? p_student_name AND dst.records ? p_student_name
  ) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_BEHAVIOR_CONFLICT'; END IF;
  FOR v_row IN
    SELECT id,date_str,period,teacher_name,records FROM public.attendance
    WHERE class_name = p_from_class AND records ? p_student_name FOR UPDATE
  LOOP
    IF jsonb_typeof(v_row.records) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_INVALID_ATTENDANCE_RECORD';
    END IF;
    v_target_key := v_row.date_str::text || '_' || p_to_class || '_p' || v_row.period::text;
    v_target_id := NULL; v_target_records := NULL;
    SELECT id,records INTO v_target_id,v_target_records FROM public.attendance
    WHERE record_key = v_target_key FOR UPDATE;
    IF v_target_id IS NOT NULL THEN
      IF jsonb_typeof(v_target_records) <> 'object' OR v_target_records ? p_student_name THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_ATTENDANCE_CONFLICT';
      END IF;
      UPDATE public.attendance SET records = records || jsonb_build_object(p_student_name,v_row.records -> p_student_name),
        updated_at = now() WHERE id = v_target_id;
    ELSE
      INSERT INTO public.attendance(record_key,date_str,class_name,period,teacher_name,records,updated_at)
      VALUES(v_target_key,v_row.date_str,p_to_class,v_row.period,v_row.teacher_name,
        jsonb_build_object(p_student_name,v_row.records -> p_student_name),now());
    END IF;
    UPDATE public.attendance SET records = records - p_student_name,updated_at = now() WHERE id = v_row.id;
    v_attendance_count := v_attendance_count + 1;
  END LOOP;
  FOR v_row IN
    SELECT id,date_str,period,teacher_name,records FROM public.behaviors
    WHERE class_name = p_from_class AND records ? p_student_name FOR UPDATE
  LOOP
    IF jsonb_typeof(v_row.records) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_INVALID_BEHAVIOR_RECORD';
    END IF;
    v_target_key := v_row.date_str::text || '_' || p_to_class || '_p' || v_row.period::text;
    v_target_id := NULL; v_target_records := NULL;
    SELECT id,records INTO v_target_id,v_target_records FROM public.behaviors
    WHERE record_key = v_target_key FOR UPDATE;
    IF v_target_id IS NOT NULL THEN
      IF jsonb_typeof(v_target_records) <> 'object' OR v_target_records ? p_student_name THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_BEHAVIOR_CONFLICT';
      END IF;
      UPDATE public.behaviors SET records = records || jsonb_build_object(p_student_name,v_row.records -> p_student_name),
        updated_at = now() WHERE id = v_target_id;
    ELSE
      INSERT INTO public.behaviors(record_key,date_str,class_name,period,teacher_name,records,updated_at)
      VALUES(v_target_key,v_row.date_str,p_to_class,v_row.period,v_row.teacher_name,
        jsonb_build_object(p_student_name,v_row.records -> p_student_name),now());
    END IF;
    UPDATE public.behaviors SET records = records - p_student_name,updated_at = now() WHERE id = v_row.id;
    v_behavior_count := v_behavior_count + 1;
  END LOOP;
  UPDATE public.student_affairs_notice_issues SET class_name = p_to_class
  WHERE class_name = p_from_class AND student_name = p_student_name;
  GET DIAGNOSTICS v_notice_count = ROW_COUNT;
  IF v_destination_student_id IS NOT NULL THEN
    DELETE FROM public.students WHERE id = v_student_id AND class_name = p_from_class AND student_name = p_student_name;
    GET DIAGNOSTICS v_membership_rows = ROW_COUNT;
  ELSE
    UPDATE public.students SET class_name = p_to_class
    WHERE id = v_student_id AND class_name = p_from_class AND student_name = p_student_name;
    GET DIAGNOSTICS v_membership_rows = ROW_COUNT;
  END IF;
  IF v_membership_rows <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STUDENT_TRANSFER_MEMBERSHIP_CHANGED';
  END IF;
  INSERT INTO public.student_transfer_audit(
    student_name,from_class,to_class,transferred_by,attendance_records,behavior_records,notice_records
  ) VALUES(p_student_name,p_from_class,p_to_class,p_actor_name,v_attendance_count,v_behavior_count,v_notice_count);
  RETURN jsonb_build_object('student_name',p_student_name,'from_class',p_from_class,'to_class',p_to_class,
    'attendance_records',v_attendance_count,'behavior_records',v_behavior_count,'notice_records',v_notice_count,
    'destination_membership_reused',v_destination_student_id IS NOT NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_transfer_student(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_transfer_student(text,text,text,text) TO service_role;
COMMENT ON FUNCTION public.admin_transfer_student(text,text,text,text)
IS 'Atomically transfers one student and only that student history. Reuses an existing destination membership and removes only the stale source membership; called only by the admin-authenticated Edge Function.';
COMMIT;
