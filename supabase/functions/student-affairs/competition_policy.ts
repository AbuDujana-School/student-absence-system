/**
 * Pure policy helpers for the student-affairs stage competition.
 * No database access, secrets, persistence, or authorization decisions live here.
 */

export const COMPETITION_GRADES = ["9", "10", "11", "12"];
export const COMPETITION_ATTENDANCE_STATUSES = ["absent", "late", "outside", "escape"];
export const COMPETITION_WEEKDAYS = [0, 1, 2, 3, 4]; // Sunday through Thursday (Oman school week).

const ARABIC_GRADE_NAMES = [
  [/التاسع|تاسع/, "9"],
  [/العاشر|عاشر/, "10"],
  [/الحادي\s*عشر|حادي\s*عشر/, "11"],
  [/الثاني\s*عشر|ثاني\s*عشر/, "12"]
];

function asIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T12:00:00.000Z");
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function shiftIsoDate(value, days) {
  const date = new Date(value + "T12:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function gradeForClassName(className) {
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

export function getSchoolWeekRange(dateValue) {
  const date = asIsoDate(dateValue);
  if (!date) throw new Error("تاريخ الأسبوع غير صالح");
  const weekday = new Date(date + "T12:00:00.000Z").getUTCDay();
  const start = shiftIsoDate(date, -weekday);
  return { start, end: shiftIsoDate(start, 4), key: start };
}

export function getSchoolDays(fromValue, toValue) {
  const from = asIsoDate(fromValue);
  const to = asIsoDate(toValue);
  if (!from || !to || from > to) throw new Error("نطاق التاريخ غير صالح");
  const days = [];
  for (let cursor = from; cursor <= to; cursor = shiftIsoDate(cursor, 1)) {
    const weekday = new Date(cursor + "T12:00:00.000Z").getUTCDay();
    if (COMPETITION_WEEKDAYS.includes(weekday)) days.push(cursor);
  }
  return days;
}

function recordMap(row) {
  return row?.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {};
}

export function countAttendanceIncidents(rows) {
  const unique = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str);
    const className = String(row?.class_name || "").trim();
    if (!date || !className) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const status = typeof raw === "string" ? raw : String(raw?.status || "");
      if (!COMPETITION_ATTENDANCE_STATUSES.includes(status)) continue;
      unique.add([className, date, String(student), status].join("\u001f"));
    }
  }
  return unique.size;
}

export function countBehaviorIncidents(rows) {
  const unique = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str);
    const className = String(row?.class_name || "").trim();
    if (!date || !className) continue;
    for (const [student, raw] of Object.entries(recordMap(row))) {
      const type = raw && typeof raw === "object" ? String(raw.type || "") : String(raw || "");
      if (!type || type === "normal") continue;
      unique.add([className, date, String(student), type].join("\u001f"));
    }
  }
  return unique.size;
}

export function getSessionCoverage(rows) {
  const coverage = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = asIsoDate(row?.date_str);
    const className = String(row?.class_name || "").trim();
    if (!date || !className) continue;
    if (!coverage.has(date)) coverage.set(date, new Set());
    coverage.get(date).add(className);
  }
  return coverage;
}

export function isTeamDayComplete(classNames, dateValue, attendanceCoverage, behaviorCoverage) {
  const date = asIsoDate(dateValue);
  const classes = [...new Set((Array.isArray(classNames) ? classNames : []).map(x => String(x || "").trim()).filter(Boolean))];
  if (!date || !classes.length) return false;
  const attendance = attendanceCoverage instanceof Map ? attendanceCoverage.get(date) : null;
  const behavior = behaviorCoverage instanceof Map ? behaviorCoverage.get(date) : null;
  return classes.every(name => attendance?.has(name) && behavior?.has(name));
}

export function calculateRelativeCompetitionScores(teams) {
  const list = Array.isArray(teams) ? teams : [];
  if (!list.length || list.some(team => team?.complete !== true)) {
    return list.map(team => ({ ...team, score: null, attendancePoints: null, behaviorPoints: null, rank: null, resultStatus: "incomplete" }));
  }

  const attendanceRates = list.map(team => Number(team.attendanceRate));
  const behaviorRates = list.map(team => Number(team.behaviorRate));
  if ([...attendanceRates, ...behaviorRates].some(rate => !Number.isFinite(rate) || rate < 0)) {
    throw new Error("معدلات المنافسة غير صالحة");
  }

  const attendanceWorst = Math.max(...attendanceRates);
  const attendanceBest = Math.min(...attendanceRates);
  const behaviorWorst = Math.max(...behaviorRates);
  const behaviorBest = Math.min(...behaviorRates);

  const pointsFor = (rate, best, worst) => worst === best ? 50 : 50 * (worst - rate) / (worst - best);
  const scored = list.map(team => {
    const attendancePoints = pointsFor(Number(team.attendanceRate), attendanceBest, attendanceWorst);
    const behaviorPoints = pointsFor(Number(team.behaviorRate), behaviorBest, behaviorWorst);
    return {
      ...team,
      attendancePoints: Number(attendancePoints.toFixed(2)),
      behaviorPoints: Number(behaviorPoints.toFixed(2)),
      score: Number((attendancePoints + behaviorPoints).toFixed(2)),
      resultStatus: "complete"
    };
  });

  scored.sort((a, b) => b.score - a.score || String(a.grade || "").localeCompare(String(b.grade || ""), "en"));
  let rank = 0;
  let previousScore = null;
  for (const team of scored) {
    if (previousScore === null || team.score !== previousScore) rank += 1;
    team.rank = rank;
    previousScore = team.score;
  }
  return scored;
}

/**
 * Rates are calculated per 1,000 student-days. Callers must provide roster counts
 * and session coverage before marking a team complete; missing sessions are never
 * silently interpreted as zero incidents.
 */
export function buildTeamRates({ grade, classNames, rosters, attendanceRows, behaviorRows, from, to }) {
  const days = getSchoolDays(from, to);
  const classes = [...new Set((Array.isArray(classNames) ? classNames : []).map(x => String(x || "").trim()).filter(Boolean))];
  const rosterMap = rosters && typeof rosters === "object" ? rosters : {};
  const studentCount = classes.reduce((sum, name) => sum + (Array.isArray(rosterMap[name]) ? new Set(rosterMap[name].map(x => String(x || "").trim()).filter(Boolean)).size : 0), 0);
  const hasEveryRoster = classes.length > 0 && classes.every(name => Array.isArray(rosterMap[name]));
  const attendanceCoverage = getSessionCoverage(attendanceRows);
  const behaviorCoverage = getSessionCoverage(behaviorRows);
  const attendanceCount = countAttendanceIncidents(attendanceRows);
  const behaviorCount = countBehaviorIncidents(behaviorRows);
  const completeDays = days.filter(day => isTeamDayComplete(classes, day, attendanceCoverage, behaviorCoverage));
  const complete = hasEveryRoster && studentCount > 0 && days.length > 0 && completeDays.length === days.length;
  const studentDays = studentCount * completeDays.length;

  return {
    grade: String(grade || ""),
    classNames: classes,
    studentCount,
    schoolDays: days,
    completeDays,
    attendanceIncidents: attendanceCount,
    behaviorIncidents: behaviorCount,
    studentDays,
    attendanceRate: complete && studentDays ? attendanceCount * 1000 / studentDays : null,
    behaviorRate: complete && studentDays ? behaviorCount * 1000 / studentDays : null,
    complete
  };
}
