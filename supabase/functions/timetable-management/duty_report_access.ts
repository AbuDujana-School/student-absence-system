export const DUTY_SCHOOL_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"] as const;

type DutyPermissions = Record<string, unknown>;
type DutyPeriod = { start?: unknown; end?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validDutyDay(value: unknown): value is string {
  return typeof value === "string" && (DUTY_SCHOOL_DAYS as readonly string[]).includes(value);
}

export function assignedDutyDay(
  permissionsValue: unknown,
  subjectDaysValue: unknown,
): string {
  const permissions: DutyPermissions = isRecord(permissionsValue) ? permissionsValue : {};
  const subjectDays = isRecord(subjectDaysValue) ? subjectDaysValue : {};
  // Match the application rule: an explicit personal duty day overrides category rotation.
  if (validDutyDay(permissions.dutyDay)) return permissions.dutyDay;
  const category = String(permissions.category || "").trim();
  const categoryDay = category ? subjectDays[category] : "";
  return validDutyDay(categoryDay) ? categoryDay : "";
}

/** A reporter is either directly granted duty access or a teacher assigned to today's duty day. */
export function isDutyReportEligibleOnDay(
  principalType: string,
  permissionsValue: unknown,
  subjectDaysValue: unknown,
  weekday: string,
): boolean {
  const permissions: DutyPermissions = isRecord(permissionsValue) ? permissionsValue : {};
  if (permissions.duty === true || permissions.admin === true) return true;
  if (principalType !== "teacher" || permissions.dutyToday === false) return false;
  return validDutyDay(weekday) && assignedDutyDay(permissions, subjectDaysValue) === weekday;
}

function omanDateParts(now: Date): { date: string; weekday: string; minutes: number } {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Muscat",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Muscat",
    weekday: "long",
  }).format(now);
  const weekdays: Record<string, string> = {
    Sunday: "الأحد",
    Monday: "الاثنين",
    Tuesday: "الثلاثاء",
    Wednesday: "الأربعاء",
    Thursday: "الخميس",
    Friday: "الجمعة",
    Saturday: "السبت",
  };
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Muscat",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const timeValues = Object.fromEntries(timeParts.map((part) => [part.type, part.value]));
  return {
    date: String(values.year) + "-" + String(values.month).padStart(2, "0") + "-" + String(values.day).padStart(2, "0"),
    weekday: weekdays[weekdayName] || "",
    minutes: Number(timeValues.hour) * 60 + Number(timeValues.minute),
  };
}

function parseDutyTime(value: unknown): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Authorize the narrow timetable lookup for the active duty reporter.
 * Teachers assigned by personal dutyDay/category must request today's actual
 * period while it is open; explicit duty/admin grants retain the existing override.
 */
export function canReadDutyReportPeriod(input: {
  principalType: string;
  permissions: unknown;
  subjectDays: unknown;
  date: unknown;
  weekday: unknown;
  period: unknown;
  periods: unknown;
  graceMinutes: unknown;
  now?: Date;
}): boolean {
  const permissions: DutyPermissions = isRecord(input.permissions) ? input.permissions : {};
  if (permissions.duty === true || permissions.admin === true) return true;
  if (input.principalType !== "teacher" || permissions.dutyToday === false) return false;

  const now = input.now instanceof Date ? input.now : new Date();
  if (!Number.isFinite(now.getTime())) return false;
  const current = omanDateParts(now);
  const date = String(input.date || "").trim();
  const weekday = String(input.weekday || "").trim();
  const period = Number(input.period);
  if (date !== current.date || weekday !== current.weekday || !validDutyDay(weekday)) return false;
  if (assignedDutyDay(permissions, input.subjectDays) !== weekday) return false;
  if (!Number.isInteger(period) || period < 1 || period > 8) return false;

  const periods = Array.isArray(input.periods) ? input.periods : [];
  const selected = periods[period - 1] as DutyPeriod | undefined;
  if (!isRecord(selected)) return false;
  const start = parseDutyTime(selected.start);
  const end = parseDutyTime(selected.end);
  if (start === null || end === null || end <= start) return false;

  const rawGrace = Number(input.graceMinutes);
  const grace = Number.isFinite(rawGrace) ? Math.max(0, Math.min(30, rawGrace)) : 5;
  return current.minutes >= start + grace && current.minutes <= end;
}
