-- Preserve the immutable lateness event while allowing an audited cancellation.
-- Only cancellation metadata is mutable; student/date/snapshot fields remain immutable.
ALTER TABLE public.morning_assembly_lateness
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancelled_by_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.morning_assembly_lateness'::regclass
      AND conname = 'morning_assembly_lateness_cancellation_metadata_check'
  ) THEN
    ALTER TABLE public.morning_assembly_lateness
      ADD CONSTRAINT morning_assembly_lateness_cancellation_metadata_check
      CHECK (
        (cancelled_at IS NULL AND cancelled_by IS NULL AND cancelled_by_type IS NULL)
        OR
        (cancelled_at IS NOT NULL AND btrim(coalesce(cancelled_by, '')) <> ''
          AND cancelled_by_type IN ('admin', 'teacher', 'custom'))
      );
  END IF;
END $$;

DROP INDEX IF EXISTS public.morning_assembly_lateness_student_day_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS morning_assembly_lateness_student_day_active_uidx
  ON public.morning_assembly_lateness (student_id, late_date)
  WHERE cancelled_at IS NULL;

-- Keep the ledger inaccessible to browser roles and permit the Edge Function
-- to update cancellation metadata only, never the original event fields.
REVOKE ALL PRIVILEGES ON TABLE public.morning_assembly_lateness FROM anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.morning_assembly_lateness TO service_role;
GRANT UPDATE (cancelled_at, cancelled_by, cancelled_by_type)
  ON TABLE public.morning_assembly_lateness TO service_role;
