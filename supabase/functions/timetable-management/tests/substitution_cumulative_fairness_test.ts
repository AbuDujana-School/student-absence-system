import {
  calculateSubstitutionWorkloadScore,
  getAvailableSubstitutionCandidates,
  getSubstitutionDailyLoadFactor,
  getSubstitutionPeriodPoints,
  type CandidateQuery,
  type SubstitutionAssignment,
  type SubstitutionTeacher,
  type TimetableEntry,
} from "../substitution_policy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
function teacher(id: string, pointsBalance = 0, weeklyQuota = 4): SubstitutionTeacher {
  return { id, name: id, departmentId: "science", pointsBalance, weeklyQuota };
}
function freeCell(id: string, period = 5): TimetableEntry {
  return { teacherId: id, weekday: "الأحد", period, className: "", status: "free" };
}
function teaching(id: string, period: number): TimetableEntry {
  return { teacherId: id, weekday: "الأحد", period, className: "10/1", status: "teaching" };
}
function query(
  teachers: SubstitutionTeacher[],
  timetable: TimetableEntry[],
  assignments: SubstitutionAssignment[] = [],
): CandidateQuery {
  return {
    teachers, timetable, assignments, absentTeacherId: "absent",
    weekday: "الأحد", period: 5, departmentId: "science",
    assignmentDate: "2026-11-29", versionId: "test-version",
  };
}

Deno.test("approved lesson weights and daily quota multipliers remain exact", () => {
  const weights = [1, 1, 1.5, 1.5, 3, 2.5, 4, 5];
  weights.forEach((weight, index) => equal(getSubstitutionPeriodPoints(index + 1), weight, `period ${index + 1}`));
  equal(getSubstitutionPeriodPoints(9), 0, "unsupported period");
  equal(getSubstitutionDailyLoadFactor(2).factor, 1, "two-period quota");
  equal(getSubstitutionDailyLoadFactor(3).factor, 1.25, "three-period quota");
  equal(getSubstitutionDailyLoadFactor(4).factor, 1.6, "four-period quota");
  equal(getSubstitutionDailyLoadFactor(5).factor, 2.2, "five-period quota");
});

Deno.test("cumulative history includes lifetime, rolling windows and same-day adjacency", () => {
  const rows: SubstitutionAssignment[] = [
    { substituteTeacherId: "t", weekday: "الأحد", period: 2, assignmentDate: "2026-11-29", status: "assigned" },
    { substituteTeacherId: "t", weekday: "الأحد", period: 4, assignmentDate: "2026-11-28", status: "completed" },
    { substituteTeacherId: "t", weekday: "الأحد", period: 1, assignmentDate: "2026-10-20", status: "assigned" },
    { substituteTeacherId: "t", weekday: "الأحد", period: 3, assignmentDate: "2026-08-01", status: "assigned" },
    { substituteTeacherId: "t", weekday: "الأحد", period: 1, assignmentDate: "2026-11-30", status: "assigned" },
    { substituteTeacherId: "t", weekday: "الأحد", period: 1, assignmentDate: "2026-11-29", status: "cancelled" },
  ];
  // Four active rows total; 3 in 90 days, 2 in 30 days, 1 in 7 days,
  // and one same-day assignment adjacent to target period 3.
  equal(calculateSubstitutionWorkloadScore(rows, "2026-11-29", 3), 4 + 3 * 2 + 2 * 3 + 2 * 4 + 1 * 8 + 1 * 4,
    "weighted cumulative workload");
});

Deno.test("lower cumulative balance is preferred when candidates are otherwise equivalent", () => {
  const teachers = [teacher("high", 12), teacher("low", 2)];
  const timetable = teachers.map((t) => freeCell(t.id));
  const ranked = getAvailableSubstitutionCandidates(query(teachers, timetable));
  equal(ranked[0]?.id, "low", "fairness ranking");
});

Deno.test("effort points use actual daily teaching load and do not absorb ranking penalties", () => {
  const t = teacher("four-period");
  const timetable = [1, 2, 3, 4].map((p) => teaching(t.id, p)).concat(freeCell(t.id));
  const ranked = getAvailableSubstitutionCandidates(query([t], timetable));
  equal(ranked[0]?.effortPoints, 4.8, "period-five effort at four teaching periods");
  equal(ranked[0]?.streakPenalty, 0, "no streak penalty");
});

Deno.test("five-or-more-period teachers are fallback only when no lighter candidate exists", () => {
  const normal = teacher("normal");
  const overloaded = teacher("overloaded");
  const timetable = [
    freeCell(normal.id), freeCell(overloaded.id),
    ...[1, 2, 3, 4, 6].map((p) => teaching(overloaded.id, p)),
  ];
  const ranked = getAvailableSubstitutionCandidates(query([overloaded, normal], timetable));
  equal(ranked.length, 1, "only normal-load candidates remain");
  equal(ranked[0]?.id, "normal", "normal-load candidate wins");
});

Deno.test("four consecutive periods are avoided when a non-exhausting option exists", () => {
  const exhausted = teacher("exhausted");
  const rested = teacher("rested");
  const timetable = [
    freeCell(exhausted.id), freeCell(rested.id),
    teaching(exhausted.id, 1), teaching(exhausted.id, 2),
    teaching(exhausted.id, 3), teaching(rested.id, 1),
  ];
  const ranked = getAvailableSubstitutionCandidates(query([exhausted, rested], timetable));
  equal(ranked.length, 1, "exhausting candidate is excluded from preferred pool");
  equal(ranked[0]?.id, "rested", "non-exhausting candidate wins");
});

Deno.test("same-day substitution cap is a hard eligibility gate", () => {
  const once = teacher("already-covered");
  const fresh = teacher("fresh");
  const timetable = [freeCell(once.id), freeCell(fresh.id)];
  const assignments: SubstitutionAssignment[] = [
    { substituteTeacherId: once.id, weekday: "الأحد", period: 2, assignmentDate: "2026-11-29", versionId: "test-version", assignmentType: "substitution", status: "assigned" },
  ];
  const ranked = getAvailableSubstitutionCandidates(query([once, fresh], timetable, assignments));
  equal(ranked.length, 1, "only one-per-day candidates");
  equal(ranked[0]?.id, "fresh", "fresh candidate selected");
});
