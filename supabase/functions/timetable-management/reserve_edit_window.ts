export function isSubstitutionDayOpen(assignmentDate: unknown, now = Date.now()): boolean {
  const date = String(assignmentDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) return false;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
  if (date < today) return false;
  const endOfAssignmentDay = Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 4 * 60 * 60 * 1000;
  return now < endOfAssignmentDay;
}
