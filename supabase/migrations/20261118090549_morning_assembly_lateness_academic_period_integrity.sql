do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.morning_assembly_lateness'::regclass
      and conname = 'morning_assembly_lateness_academic_year_format_check'
  ) then
    alter table public.morning_assembly_lateness
      add constraint morning_assembly_lateness_academic_year_format_check
      check (
        case
          when academic_year ~ '^[0-9]{4}/[0-9]{4}$' then
            split_part(academic_year, '/', 2)::integer = split_part(academic_year, '/', 1)::integer + 1
          else false
        end
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.morning_assembly_lateness'::regclass
      and conname = 'morning_assembly_lateness_academic_period_check'
  ) then
    alter table public.morning_assembly_lateness
      add constraint morning_assembly_lateness_academic_period_check
      check (
        case
          when academic_year ~ '^[0-9]{4}/[0-9]{4}$' then
            (
              extract(month from late_date)::integer between 9 and 12
              and extract(year from late_date)::integer = split_part(academic_year, '/', 1)::integer
            )
            or
            (
              extract(month from late_date)::integer between 1 and 6
              and extract(year from late_date)::integer = split_part(academic_year, '/', 2)::integer
            )
          else false
        end
      );
  end if;
end $$;
