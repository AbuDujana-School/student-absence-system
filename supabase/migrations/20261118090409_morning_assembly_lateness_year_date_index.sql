create index if not exists morning_assembly_lateness_year_date_idx
on public.morning_assembly_lateness (academic_year, late_date desc, recorded_at desc);
