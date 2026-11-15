begin;
do $test$
begin
  if public.timetable_substitution_period_points(1)<>1
    or public.timetable_substitution_period_points(2)<>1
    or public.timetable_substitution_period_points(3)<>2
    or public.timetable_substitution_period_points(4)<>2
    or public.timetable_substitution_period_points(5)<>4
    or public.timetable_substitution_period_points(6)<>3
    or public.timetable_substitution_period_points(7)<>5
    or public.timetable_substitution_period_points(8)<>7
    or public.timetable_substitution_period_points(9)<>0 then
    raise exception 'Substitution period point weights are incorrect.';
  end if;
  if not exists(select 1 from pg_proc where proname='create_timetable_substitution_batch') then
    raise exception 'Atomic batch substitution RPC is missing.';
  end if;
  if not exists(select 1 from pg_trigger where tgname='timetable_substitution_points_ledger_trigger' and not tgisinternal) then
    raise exception 'Substitution points ledger trigger is missing.';
  end if;
end;
$test$;
rollback;
