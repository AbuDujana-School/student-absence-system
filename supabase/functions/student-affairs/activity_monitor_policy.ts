/** Convert inclusive Oman-local calendar dates into a half-open UTC timestamp range. */
const OMAN_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

export function omanActivityDateRange(from: string, to: string): {
  startInclusive: string;
  endExclusive: string;
} {
  const start = new Date(`${from}T00:00:00+04:00`);
  const end = new Date(`${to}T00:00:00+04:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new RangeError("Invalid Oman activity date range");
  }
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
  };
}

export function omanTodayIsoDate(now: Date = new Date()): string {
  return new Date(now.getTime() + OMAN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}
