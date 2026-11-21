-- Verify batch deletion forces reversal of all ledger points, even beyond 14 hours.
do $$
declare
  v_definition text := pg_get_functiondef('public.cancel_timetable_substitution_batch(jsonb)'::regprocedure);
  v_cancel_definition text := pg_get_functiondef('public.cancel_timetable_substitution(jsonb)'::regprocedure);
  v_reason_position integer;
begin
  v_reason_position := position('force_points_reversal' in v_definition);
  if v_reason_position = 0
     or position('true' in substring(v_definition from v_reason_position)) = 0 then
    raise exception 'Batch reserve cancellation must force full points reversal.';
  end if;
  if position('v_assignment.status=''completed''' in v_cancel_definition) = 0
     or position('force_points_reversal' in v_cancel_definition) = 0 then
    raise exception 'Completed reserve lessons may only be cancelled through a forced full-group deletion.';
  end if;
end;
$$;
