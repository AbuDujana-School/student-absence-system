/**
 * Pure policy helpers for weekly teacher-led excellence competition.
 * Every assigned class has equal weight; student enrollment never weights a team.
 */
export const COMPETITION_GRADES = ["9", "10", "11", "12"];
export const COMPETITION_ATTENDANCE_STATUSES = ["absent", "late", "outside", "escape"];
export const COMPETITION_BEHAVIOR_TYPES = ["eating", "talking", "tools", "chaos", "sleeping", "homework", "other"];
export const COMPETITION_WEEKDAYS = [0, 1, 2, 3, 4];
export const COMPETITION_REQUIRED_PERIODS = [1, 2, 3, 4, 5, 6, 7, 8];
const ARABIC_GRADE_NAMES: Array<[RegExp, string]> = [
  [/التاسع|تاسع/, "9"], [/العاشر|عاشر/, "10"], [/الحادي\s*عشر|حادي\s*عشر/, "11"], [/الثاني\s*عشر|ثاني\s*عشر/, "12"]
];
function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T12:00:00.000Z");
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}
function shiftIsoDate(value: string, days: number): string {
  const date = new Date(value + "T12:00:00.000Z"); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function gradeForClassName(className: unknown): string | null {
  const value = String(className || "").trim(); if (!value) return null;
  for (const [pattern, grade] of ARABIC_GRADE_NAMES) if (pattern.test(value)) return grade;
  const parts = value.split(/[\/_\s-]+/).filter(Boolean), numericGrades = parts.filter(part => COMPETITION_GRADES.includes(part));
  if (numericGrades.length === 1) return numericGrades[0]; if (numericGrades.length > 1) return null;
  return COMPETITION_GRADES.includes(value) ? value : null;
}
export function getSchoolWeekRange(dateValue: unknown): { start: string; end: string; key: string } {
  const date = asIsoDate(dateValue); if (!date) throw new Error("تاريخ الأسبوع غير صالح");
  const start = shiftIsoDate(date, -new Date(date + "T12:00:00.000Z").getUTCDay());
  return { start, end: shiftIsoDate(start, 4), key: start };
}
export function getSchoolDays(fromValue: unknown, toValue: unknown): string[] {
  const from = asIsoDate(fromValue), to = asIsoDate(toValue); if (!from || !to || from > to) throw new Error("نطاق التاريخ غير صالح");
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = shiftIsoDate(cursor, 1)) if (COMPETITION_WEEKDAYS.includes(new Date(cursor + "T12:00:00.000Z").getUTCDay())) days.push(cursor);
  return days;
}
type CompetitionRow = { date_str?: unknown; class_name?: unknown; period?: unknown; record_key?: unknown; records?: unknown };
type CoverageMap = Map<string, Map<string, Set<number>>>;
function recordMap(row: CompetitionRow): Record<string, any> { return row?.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {}; }
export function countAttendanceIncidents(rows: CompetitionRow[]): number {
  const unique = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str), cls = String(row?.class_name || "").trim(); if (!date || !cls) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const status = typeof raw === "string" ? raw : String((raw as {status?: unknown} | null)?.status || "");
      if (COMPETITION_ATTENDANCE_STATUSES.includes(status)) unique.add([cls, date, student, status].join("\u001f"));
    }
  }
  return unique.size;
}
function behaviorTypes(raw: unknown): string[] {
  const item = raw && typeof raw === "object" ? raw as { type?: unknown; types?: unknown } : { type: raw };
  const values = Array.isArray(item.types) ? item.types : Array.isArray(item.type) ? item.type : (item.type ? [item.type] : []);
  return [...new Set(values.map(value => String(value || "")).filter(type => COMPETITION_BEHAVIOR_TYPES.includes(type)))];
}
export function countBehaviorIncidents(rows: CompetitionRow[]): number {
  const unique = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str), cls = String(row?.class_name || "").trim(); if (!date || !cls) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      for (const type of behaviorTypes(raw)) unique.add([cls, date, student, type].join("\u001f"));
    }
  }
  return unique.size;
}
export function countAttendanceByStatus(rows: CompetitionRow[]): Record<string, number> {
  const unique = new Map<string, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str), cls = String(row?.class_name || "").trim();
    if (!date || !cls) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const status = typeof raw === "string" ? raw : String((raw as {status?: unknown} | null)?.status || "");
      if (COMPETITION_ATTENDANCE_STATUSES.includes(status)) unique.set([cls, date, student, status].join("\u001f"), status);
    }
  }
  const counts: Record<string, number> = { absent: 0, late: 0, outside: 0, escape: 0 };
  for (const status of unique.values()) counts[status] = (counts[status] || 0) + 1;
  return counts;
}
export function countBehaviorByType(rows: CompetitionRow[]): Record<string, number> {
  const unique = new Map<string, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str), cls = String(row?.class_name || "").trim();
    if (!date || !cls) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      for (const type of behaviorTypes(raw)) unique.set([cls, date, student, type].join("\u001f"), type);
    }
  }
  const counts: Record<string, number> = {};
  for (const type of COMPETITION_BEHAVIOR_TYPES) counts[type] = 0;
  for (const type of unique.values()) counts[type] = (counts[type] || 0) + 1;
  return counts;
}
/** Counts students with incidents on at least two distinct school days; names never leave this policy layer. */
export function countRepeatStudents(rows: CompetitionRow[], domain: "attendance" | "behavior"): number {
  const datesByStudent = new Map<string, Set<string>>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str), cls = String(row?.class_name || "").trim();
    if (!date || !cls) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const types = domain === "attendance"
        ? [typeof raw === "string" ? raw : String((raw as {status?: unknown} | null)?.status || "")]
        : behaviorTypes(raw);
      const valid = domain === "attendance" ? types.some(type => COMPETITION_ATTENDANCE_STATUSES.includes(type)) : types.some(type => COMPETITION_BEHAVIOR_TYPES.includes(type));
      if (!valid) continue;
      const key = [cls, student].join("\u001f");
      if (!datesByStudent.has(key)) datesByStudent.set(key, new Set());
      datesByStudent.get(key)!.add(date);
    }
  }
  return [...datesByStudent.values()].filter(dates => dates.size >= 2).length;
}
export function getSessionCoverage(rows: CompetitionRow[]): CoverageMap {
  const coverage: CoverageMap = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str), cls = String(row?.class_name || "").trim();
    const keyPeriod = String(row?.record_key || "").match(/_p?(\d+)$/)?.[1], period = Number(row?.period || keyPeriod || 0);
    if (!date || !cls || !COMPETITION_REQUIRED_PERIODS.includes(period)) continue;
    if (!coverage.has(date)) coverage.set(date, new Map());
    const byClass = coverage.get(date)!; if (!byClass.has(cls)) byClass.set(cls, new Set()); byClass.get(cls)!.add(period);
  }
  return coverage;
}
export function isTeamDayComplete(classes: string[], dateValue: unknown, attendance: CoverageMap, behavior: CoverageMap): boolean {
  const date = asIsoDate(dateValue), names = [...new Set((Array.isArray(classes) ? classes : []).map(x => String(x || "").trim()).filter(Boolean))];
  if (!date || !names.length) return false;
  const a = attendance.get(date), b = behavior.get(date);
  const hasAll = (map: Map<string, Set<number>> | undefined, name: string) => COMPETITION_REQUIRED_PERIODS.every(period => map?.get(name)?.has(period));
  return names.every(name => hasAll(a, name) && hasAll(b, name));
}
type BuildTeamRatesInput = { grade: string; classNames: string[]; attendanceRows: CompetitionRow[]; behaviorRows: CompetitionRow[]; from: string; to: string };
export function buildTeamRates({ grade, classNames, attendanceRows, behaviorRows, from, to }: BuildTeamRatesInput): any {
  const days = getSchoolDays(from, to), classes = [...new Set((Array.isArray(classNames) ? classNames : []).map(x => String(x || "").trim()).filter(Boolean))], allowed = new Set(classes);
  const filter = (rows: CompetitionRow[]) => rows.filter(row => { const date = asIsoDate(row?.date_str); return !!date && date >= from && date <= to && allowed.has(String(row?.class_name || "").trim()); });
  const attendance = filter(attendanceRows), behavior = filter(behaviorRows), aCoverage = getSessionCoverage(attendance), bCoverage = getSessionCoverage(behavior);
  const completeDays = days.filter(day => isTeamDayComplete(classes, day, aCoverage, bCoverage));
  const classMetrics = classes.map(className => {
    const aRows = attendance.filter(row => String(row.class_name || "").trim() === className), bRows = behavior.filter(row => String(row.class_name || "").trim() === className);
    const complete = days.length > 0 && days.every(day => isTeamDayComplete([className], day, aCoverage, bCoverage));
    const attendanceIncidents = countAttendanceIncidents(aRows), behaviorIncidents = countBehaviorIncidents(bRows);
    return {
      className, complete, attendanceIncidents, behaviorIncidents,
      attendanceStatusCounts: countAttendanceByStatus(aRows),
      behaviorTypeCounts: countBehaviorByType(bRows),
      repeatAttendanceStudents: countRepeatStudents(aRows, "attendance"),
      repeatBehaviorStudents: countRepeatStudents(bRows, "behavior"),
      attendanceRate: days.length ? attendanceIncidents / days.length : null,
      behaviorRate: days.length ? behaviorIncidents / days.length : null
    };
  });
  const complete = classes.length > 0 && days.length > 0 && classMetrics.every(item => item.complete);
  const mean = (key: "attendanceRate" | "behaviorRate") => complete ? classMetrics.reduce((sum, item) => sum + Number(item[key]), 0) / classMetrics.length : null;
  return { grade: String(grade || ""), classNames: classes, classCount: classes.length, schoolDays: days, completeDays, classMetrics,
    attendanceIncidents: classMetrics.reduce((sum, item) => sum + item.attendanceIncidents, 0), behaviorIncidents: classMetrics.reduce((sum, item) => sum + item.behaviorIncidents, 0),
    attendanceRate: mean("attendanceRate"), behaviorRate: mean("behaviorRate"), complete };
}
export function calculateRelativeCompetitionScores(teams: any[]): any[] {
  const list = Array.isArray(teams) ? teams : [];
  if (!list.length || list.some(team => team?.complete !== true)) return list.map(team => ({ ...team, score: null, attendancePoints: null, behaviorPoints: null, rank: null, resultStatus: "incomplete" }));
  const a = list.map(team => Number(team.attendanceRate)), b = list.map(team => Number(team.behaviorRate));
  if ([...a, ...b].some(rate => !Number.isFinite(rate) || rate < 0)) throw new Error("معدلات المنافسة غير صالحة");
  const aMin = Math.min(...a), aMax = Math.max(...a), bMin = Math.min(...b), bMax = Math.max(...b);
  const points = (rate: number, min: number, max: number) => max === min ? 50 : 50 * (max - rate) / (max - min);
  const scored = list.map(team => {
    const attendancePoints = points(Number(team.attendanceRate), aMin, aMax), behaviorPoints = points(Number(team.behaviorRate), bMin, bMax);
    return { ...team, attendancePoints: Number(attendancePoints.toFixed(2)), behaviorPoints: Number(behaviorPoints.toFixed(2)), score: Number((attendancePoints + behaviorPoints).toFixed(2)), resultStatus: "complete" };
  });
  scored.sort((x, y) => y.score - x.score || String(x.teamName || x.grade || "").localeCompare(String(y.teamName || y.grade || ""), "ar"));
  let rank = 0, previous: number | null = null;
  for (const team of scored) {
    // Dense ranking: tied teams share a place; the next distinct score gets the next place.
    if (previous === null || team.score !== previous) rank += 1;
    team.rank = rank;
    previous = team.score;
  }
  return scored;
}
/** Ranks monthly/term standings by accumulated weekly podium points, not by a fresh period score. */
export function rankCompetitionTeamsByAccumulatedPoints(teams: any[], pointTotals: Record<string, number>): any[] {
  const ordered = [...(Array.isArray(teams) ? teams : [])].sort((a, b) =>
    Number(pointTotals?.[String(b.teamId || "")] || 0) - Number(pointTotals?.[String(a.teamId || "")] || 0) ||
    Number(b.score || 0) - Number(a.score || 0) ||
    String(a.teamName || a.grade || "").localeCompare(String(b.teamName || b.grade || ""), "ar")
  );
  let rank = 0;
  let previousPoints: number | null = null;
  return ordered.map(team => {
    const points = Number(pointTotals?.[String(team.teamId || "")] || 0);
    if (previousPoints === null || points !== previousPoints) rank += 1;
    previousPoints = points;
    return { ...team, rank };
  });
}

/** Weekly awards: 10, 6, 3 for the first three ranks; all remaining ranks get zero. */
export function awardWeeklyCompetitionPoints(teams: any[]): any[] {
  return (Array.isArray(teams) ? teams : []).map(team => ({ ...team, weeklyAwardPoints: team?.complete === true ? (team.rank === 1 ? 10 : team.rank === 2 ? 6 : team.rank === 3 ? 3 : 0) : null }));
}
