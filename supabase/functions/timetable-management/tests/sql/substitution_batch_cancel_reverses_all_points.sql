-- Verify batch deletion forces reversal of all ledger points, even beyond 14 hours.
do $$
declare
  v_definition text := pg_get_functiondef('public.cancel_timetable_substitution_batch(jsonb)'::regprocedure);
  v_reason_position integer;
begin
  v_reason_position := position('force_points_reversal' in v_definition);
  if v_reason_position = 0
     or position('true' in substring(v_definition from v_reason_position)) = 0 then
    raise exception 'Batch reserve cancellation must force full points reversal.';
  end if;
end;
$$;
