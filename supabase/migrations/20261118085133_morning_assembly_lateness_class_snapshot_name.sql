do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='morning_assembly_lateness' and column_name='class_snapshot'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='morning_assembly_lateness' and column_name='class_name_snapshot'
  ) then
    alter table public.morning_assembly_lateness rename column class_snapshot to class_name_snapshot;
  end if;
end $$;