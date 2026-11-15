do $$
begin
  if to_regprocedure('public.reassign_timetable_substitution_absent_with_reason(jsonb)') is null then
    raise exception 'Absent-teacher reassignment RPC was not installed.';
  end if;
  if not has_function_privilege('service_role','public.reassign_timetable_substitution_absent_with_reason(jsonb)','EXECUTE') then
    raise exception 'service_role must be able to execute absent-teacher reassignment.';
  end if;
  if has_function_privilege('authenticated','public.reassign_timetable_substitution_absent_with_reason(jsonb)','EXECUTE') then
    raise exception 'authenticated must not execute absent-teacher reassignment directly.';
  end if;
end
$$;
