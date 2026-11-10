/**
 * Pure policy helpers for the student-affairs stage competition.
 * No database access, secrets, persistence, or authorization decisions live here.
 */

export const COMPETITION_GRADES = ["9", "10", "11", "12"];
export const COMPETITION_ATTENDANCE_STATUSES = ["absent", "late", "outside", "escape"];
export const COMPETITION_BEHAVIOR_TYPES = ["eating", "talking", "tools", "chaos", "sleeping", "homework", "other"];
export const COMPETITION_WEEKDAYS = [0, 1, 2, 3, 4]; // Sunday through Thursday (Oman school week).
export const COMPETITION_REQUIRED_PERIODS = [1, 2, 3, 4, 5, 6, 7, 8];

const ARABIC_GRADE_NAMES: Array<[RegExp, string]> = [
  [/التاسع|تاسع/, "9"],
  [/العاشر|عاشر/, "10"],
  [/الحادي\s*عشر|حادي\s*عشر/, "11"],
  [/الثاني\s*عشر|ثاني\s*عشر/, "12"]
];

function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T12:00:00.000Z");
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(value + "T12:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function gradeForClassName(className: unknown): string | null {
  const value = String(className || "").trim();
  if (!value) return null;

  for (const [pattern, grade] of ARABIC_GRADE_NAMES) {
    if (pattern.test(value)) return grade;
  }

  const parts = value.split(/[\/_\s-]+/).filter(Boolean);
  const numericGrades = parts.filter(part => COMPETITION_GRADES.includes(part));
  if (numericGrades.length === 1) return numericGrades[0];
  if (numericGrades.length > 1) return null;

  return COMPETITION_GRADES.includes(value) ? value : null;
}

export function getSchoolWeekRange(dateValue: unknown): { start: string; end: string; key: string } {
  const date = asIsoDate(dateValue);
  if (!date) throw new Error("تاريخ الأسبوع غير صالح");
  const weekday = new Date(date + "T12:00:00.000Z").getUTCDay();
  const start = shiftIsoDate(date, -weekday);
  return { start, end: shiftIsoDate(start, 4), key: start };
}

export function getSchoolDays(fromValue: unknown, toValue: unknown): string[] {
  const from = asIsoDate(fromValue);
  const to = asIsoDate(toValue);
  if (!from || !to || from > to) throw new Error("نطاق التاريخ غير صالح");
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = shiftIsoDate(cursor, 1)) {
    const weekday = new Date(cursor + "T12:00:00.000Z").getUTCDay();
    if (COMPETITION_WEEKDAYS.includes(weekday)) days.push(cursor);
  }
  return days;
}

type CompetitionRow = { date_str?: unknown; class_name?: unknown; period?: unknown; record_key?: unknown; records?: unknown };
type CoverageMap = Map<string, Map<string, Set<number>>>;
function recordMap(row: CompetitionRow): Record<string, any> {
  return row?.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {};
}

export function countAttendanceIncidents(rows: CompetitionRow[]): number {
  const unique = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str);
    const className = String(row?.class_name || "").trim();
    if (!date || !className) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const status = typeof raw === "string" ? raw : String((raw as {status?: unknown} | null)?.status || "");
      if (!COMPETITION_ATTENDANCE_STATUSES.includes(status)) continue;
      unique.add([className, date, String(student), status].join("\u001f"));
    }
  }
  return unique.size;
}

export function countBehaviorIncidents(rows: CompetitionRow[]): number {
  const unique = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str);
    const className = String(row?.class_name || "").trim();
    if (!date || !className) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const type = raw && typeof raw === "object" ? String((raw as {type?: unknown}).type || "") : String(raw || "");
      if (!COMPETITION_BEHAVIOR_TYPES.includes(type)) continue;
      unique.add([className, date, String(student), type].join("\u001f"));
    }
  }
  return unique.size;
}

export function getSessionCoverage(rows: CompetitionRow[]): CoverageMap {
  const coverage = new Map<string, Map<string, Set<number>>>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str);
    const className = String(row?.class_name || "").trim();
    const keyPeriod = String(row?.record_key || "").match(/_p?(\d+)$/)?.[1];
    const period = Number(row?.period || keyPeriod || 0);
    if (!date || !className || !COMPETITION_REQUIRED_PERIODS.includes(period)) continue;
    if (!coverage.has(date)) coverage.set(date, new Map());
    const byClass = coverage.get(date)!;
    if (!byClass.has(className)) byClass.set(className, new Set());
    byClass.get(className)!.add(period);
  }
  return coverage;
}

export function isTeamDayComplete(classNames: string[], dateValue: unknown, attendanceCoverage: CoverageMap, behaviorCoverage: CoverageMap): boolean {
  const date = asIsoDate(dateValue);
  const classes = [...new Set((Array.isArray(classNames) ? classNames : []).map(x => String(x || "").trim()).filter(Boolean))];
  if (!date || !classes.length) return false;
  const attendance = attendanceCoverage instanceof Map ? attendanceCoverage.get(date) : null;
  const behavior = behaviorCoverage instanceof Map ? behaviorCoverage.get(date) : null;
  const hasAllPeriods = (coverage: Map<string, Set<number>> | null | undefined, className: string): boolean => {
    const periods = coverage instanceof Map ? coverage.get(className) : null;
    return COMPETITION_REQUIRED_PERIODS.every(period => periods?.has(period));
  };
  return classes.every(name => hasAllPeriods(attendance, name) && hasAllPeriods(behavior, name));
}

type CompetitionTeam = { grade?: string; complete: boolean; attendanceRate: number | null; behaviorRate: number | null; [key: string]: unknown };
export function calculateRelativeCompetitionScores(teams: any[]): any[] {
  const list = Array.isArray(teams) ? teams : [];
  if (!list.length || list.some(team => team?.complete !== true)) return list.map(team => ({ ...team, score: null, attendancePoints: null, behaviorPoints: null, rank: null, resultStatus: "incomplete" }));
  const attendanceRates = list.map((team: any) => Number(team.attendanceRate)), behaviorRates = list.map((team: any) => Number(team.behaviorRate));
  if ([...attendanceRates, ...behaviorRates].some(rate => !Number.isFinite(rate) || rate < 0)) throw new Error("معدلات المنافسة غير صالحة");
  const relativePoints = (rate: number, rates: number[]) => { const best = Math.min(...rates), worst = Math.max(...rates); return best === worst ? 50 : 50 * (worst - rate) / (worst - best); };
  const scored = list.map((team: any) => {
    const attendancePoints = relativePoints(Number(team.attendanceRate), attendanceRates), behaviorPoints = relativePoints(Number(team.behaviorRate), behaviorRates);
    return { ...team, attendancePoints: Number(attendancePoints.toFixed(2)), behaviorPoints: Number(behaviorPoints.toFixed(2)), score: Number((attendancePoints + behaviorPoints).toFixed(2)), resultStatus: "complete" };
  });
  scored.sort((a: any, b: any) => b.score - a.score || String(a.teamName || a.grade || "").localeCompare(String(b.teamName || b.grade || ""), "ar"));
  let rank = 0, previousScore: number | null = null;
  for (const team of scored) { if (previousScore === null || team.score !== previousScore) rank += 1; team.rank = rank; previousScore = team.score; }
  return scored;
}
export function awardWeeklyCompetitionPoints(teams: any[]): Record<string, number> {
  const list = Array.isArray(teams) ? teams : [], awards: Record<string, number> = {};
  if (!list.length || list.some(team => team?.complete !== true || !Number.isFinite(Number(team.rank)))) {
    for (const team of list) if (team?.teamId) awards[String(team.teamId)] = 0;
    return awards;
  }
  const pointsByRank: Record<number, number> = { 1: 10, 2: 6, 3: 3 };
  for (const team of list) { const id = String(team.teamId || team.grade || ""); if (id) awards[id] = pointsByRank[Number(team.rank)] || 0; }
  return awards;
}

/**
 * Team rates are the arithmetic mean of each assigned class's incident count per school day.
 * Every class contributes equally; student enrollment does not weight the team result.
 * Missing session records never count as zero incidents.
 */
type BuildTeamRatesInput = { grade: string; classNames: string[]; rosters?: Record<string, string[]>; attendanceRows: CompetitionRow[]; behaviorRows: CompetitionRow[]; from: string; to: string };
export function buildTeamRates({ grade, classNames, attendanceRows, behaviorRows, from, to }: BuildTeamRatesInput): any {
  const days = getSchoolDays(from, to), classes = [...new Set((Array.isArray(classNames) ? classNames : []).map(x => String(x || "").trim()).filter(Boolean))];
  const classSet = new Set(classes);
  const inRangeRows = (rows: CompetitionRow[]): CompetitionRow[] => (Array.isArray(rows) ? rows : []).filter((row: CompetitionRow) => {
    const date = asIsoDate(row?.date_str); return date && date >= from && date <= to && classSet.has(String(row?.class_name || "").trim());
  });
  const scopedAttendanceRows = inRangeRows(attendanceRows), scopedBehaviorRows = inRangeRows(behaviorRows);
  const attendanceCoverage = getSessionCoverage(scopedAttendanceRows), behaviorCoverage = getSessionCoverage(scopedBehaviorRows);
  const completeDays = days.filter(day => isTeamDayComplete(classes, day, attendanceCoverage, behaviorCoverage));
  const complete = classes.length > 0 && days.length > 0 && completeDays.length === days.length;
  const classMetrics = classes.map(className => {
    const attendance = scopedAttendanceRows.filter(row => String(row.class_name || "").trim() === className);
    const behavior = scopedBehaviorRows.filter(row => String(row.class_name || "").trim() === className);
    const attendanceIncidents = countAttendanceIncidents(attendance), behaviorIncidents = countBehaviorIncidents(behavior);
    return { className, attendanceIncidents, behaviorIncidents,
      attendanceRate: complete ? attendanceIncidents / days.length : null, behaviorRate: complete ? behaviorIncidents / days.length : null,
      complete: complete && days.every(day => isTeamDayComplete([className], day, attendanceCoverage, behaviorCoverage)) };
  });
  const average = (key: "attendanceRate" | "behaviorRate") => complete && classMetrics.length ? classMetrics.reduce((sum, item) => sum + Number(item[key] || 0), 0) / classMetrics.length : null;
  return { grade: String(grade || ""), classNames: classes, classCount: classes.length, schoolDays: days, completeDays,
    attendanceIncidents: classMetrics.reduce((sum, item) => sum + item.attendanceIncidents, 0), behaviorIncidents: classMetrics.reduce((sum, item) => sum + item.behaviorIncidents, 0),
    attendanceRate: average("attendanceRate"), behaviorRate: average("behaviorRate"), classMetrics, complete };
}
