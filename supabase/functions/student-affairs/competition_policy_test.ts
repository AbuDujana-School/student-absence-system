import {
  buildTeamRates,
  calculateRelativeCompetitionScores,
  countAttendanceIncidents,
  countBehaviorIncidents,
  getSchoolDays,
  getSchoolWeekRange,
  gradeForClassName,
  isTeamDayComplete,
  getSessionCoverage
} from "./competition_policy.ts";

const periods = [1, 2, 3, 4, 5, 6, 7, 8];
function sessions(className: string, records: Record<string, unknown> = {}, date: string = "2026-11-08") {
  return periods.map(period => ({ date_str: date, class_name: className, period, records: period === 1 ? records : {} }));
}

Deno.test("gradeForClassName supports the repository's class/grade format", () => {
  if (gradeForClassName("1/9") !== "9") throw new Error("1/9 must resolve to grade 9");
  if (gradeForClassName("8/12") !== "12") throw new Error("8/12 must resolve to grade 12");
  if (gradeForClassName("التاسع 2") !== "9") throw new Error("Arabic grade names must resolve");
  if (gradeForClassName("قسم الإدارة") !== null) throw new Error("non-stage classes must not resolve");
});

Deno.test("school week is Sunday through Thursday", () => {
  const range = getSchoolWeekRange("2026-11-10");
  if (range.start !== "2026-11-08" || range.end !== "2026-11-12") throw new Error("incorrect school week range");
  const days = getSchoolDays(range.start, range.end);
  if (days.length !== 5 || days[0] !== range.start || days[4] !== range.end) throw new Error("school days must contain five weekdays");
});

Deno.test("attendance incidents deduplicate the same student and status across periods", () => {
  const rows = [
    { date_str: "2026-11-08", class_name: "1/9", period: 1, records: { "طالب أ": "absent", "طالب ب": "late" } },
    { date_str: "2026-11-08", class_name: "1/9", period: 2, records: { "طالب أ": "absent", "طالب ب": "escape" } }
  ];
  if (countAttendanceIncidents(rows) !== 3) throw new Error("attendance deduplication failed");
});

Deno.test("behavior incidents deduplicate repeated same-type entries per student per day", () => {
  const rows: Array<{date_str: string; class_name: string; period: number; records: Record<string, unknown>}> = [
    { date_str: "2026-11-08", class_name: "1/9", period: 1, records: { "طالب أ": { type: "talking" }, "طالب ب": { type: "normal" } } },
    { date_str: "2026-11-08", class_name: "1/9", period: 2, records: { "طالب أ": { type: "talking" }, "طالب ب": { type: "sleeping" } } }
  ];
  rows.push({
    date_str: "2026-11-08",
    class_name: "1/9",
    period: 3,
    records: { "طالب ج": { type: "unexpected-value" }, "طالب د": { type: "normal" } }
  });
  if (countBehaviorIncidents(rows) !== 2) throw new Error("behavior deduplication or approved-type filtering failed");
});

Deno.test("a team day requires all eight lesson records for every class and domain", () => {
  const attendance = getSessionCoverage([...sessions("1/9"), ...sessions("2/9")]);
  const behavior = getSessionCoverage(sessions("1/9"));
  if (isTeamDayComplete(["1/9", "2/9"], "2026-11-08", attendance, behavior)) throw new Error("missing class behavior sessions must not be treated as zero violations");
  const completeBehavior = getSessionCoverage([...sessions("1/9"), ...sessions("2/9")]);
  if (!isTeamDayComplete(["1/9", "2/9"], "2026-11-08", attendance, completeBehavior)) throw new Error("eight complete sessions per class should qualify");
});

Deno.test("weekly awards are 10, 6, 3 and zero after third place", () => {
  const result = calculateRelativeCompetitionScores([
    { grade: "A", complete: true, attendanceRate: 1, behaviorRate: 1 },
    { grade: "B", complete: true, attendanceRate: 2, behaviorRate: 2 },
    { grade: "C", complete: true, attendanceRate: 3, behaviorRate: 3 },
    { grade: "D", complete: true, attendanceRate: 4, behaviorRate: 4 }
  ]);
  if (result.map(team => team.weeklyPoints).join(",") !== "10,6,3,0") throw new Error("weekly awards incorrect");
  const ties = calculateRelativeCompetitionScores([
    { grade: "A", complete: true, attendanceRate: 0, behaviorRate: 0 },
    { grade: "B", complete: true, attendanceRate: 0, behaviorRate: 0 },
    { grade: "C", complete: true, attendanceRate: 2, behaviorRate: 2 }
  ]);
  if (ties[0].rank !== 1 || ties[1].rank !== 1 || ties[0].weeklyPoints !== 10 || ties[1].weeklyPoints !== 10 || ties[2].rank !== 3 || ties[2].weeklyPoints !== 3) throw new Error("ties must share awards and ranks");
});

Deno.test("team rates use only the selected class and requested date range", () => {
  const team = buildTeamRates({
    grade: "9",
    classNames: ["1/9"],
    from: "2026-11-08",
    to: "2026-11-08",
    attendanceRows: [
      ...sessions("1/9", { "طالب أ": "absent" }),
      { date_str: "2026-11-09", class_name: "1/9", period: 1, records: { "طالب ب": "late" } },
      { date_str: "2026-11-08", class_name: "2/9", period: 1, records: { "طالب ب": "late" } }
    ],
    behaviorRows: [
      ...sessions("1/9", { "طالب ب": { type: "talking" } })
    ]
  });
  if (!team.complete || team.attendanceIncidents !== 1 || team.behaviorIncidents !== 1 || team.attendanceRate !== 1 || team.behaviorRate !== 1 || team.classCount !== 1) {
    throw new Error("team metrics must be scoped to class and date");
  }
});

Deno.test("attendance scoring ignores unknown statuses and malformed dates", () => {
  const rows = [
    { date_str: "2026-11-08", class_name: "1/9", period: 1, records: { "طالب أ": "absent", "طالب ب": "present", "طالب ج": "unknown" } },
    { date_str: "2026-02-30", class_name: "1/9", period: 2, records: { "طالب د": "late" } }
  ];
  if (countAttendanceIncidents(rows) !== 1) throw new Error("only approved incidents on valid dates should count");
});

Deno.test("session coverage rejects missing periods and ignores out-of-range periods", () => {
  const rows = sessions("1/9").filter(row => row.period !== 6);
  rows.push({ date_str: "2026-11-08", class_name: "1/9", period: 9, records: {} });
  const coverage = getSessionCoverage(rows);
  const attendance = getSessionCoverage(sessions("1/9"));
  if (isTeamDayComplete(["1/9"], "2026-11-08", coverage, attendance)) {
    throw new Error("a ninth period must not replace a missing required period");
  }
});

Deno.test("incomplete teams never receive provisional points or ranks", () => {
  const result = calculateRelativeCompetitionScores([
    { grade: "9", complete: true, attendanceRate: 1, behaviorRate: 1 },
    { grade: "10", complete: false, attendanceRate: null, behaviorRate: null }
  ]);
  if (result.some(team => team.score !== null || team.rank !== null || team.resultStatus !== "incomplete")) {
    throw new Error("incomplete competition must not publish scores or ranks");
  }
});

Deno.test("invalid rates are rejected instead of silently ranked", () => {
  let rejected = false;
  try {
    calculateRelativeCompetitionScores([
      { grade: "9", complete: true, attendanceRate: -1, behaviorRate: 0 },
      { grade: "10", complete: true, attendanceRate: 1, behaviorRate: 1 }
    ]);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("negative incident rates must be rejected");
});

Deno.test("each assigned class has equal weight and enrolment is not used", () => {
  const team = buildTeamRates({
    grade: "فريق", classNames: ["1/9", "2/9"], from: "2026-11-08", to: "2026-11-08",
    attendanceRows: [...sessions("1/9", { "طالب أ": "absent", "طالب ب": "late", "طالب ج": "escape", "طالب د": "outside" }), ...sessions("2/9", { "طالب هـ": "absent" })],
    behaviorRows: [...sessions("1/9", { "طالب أ": { type: "talking" }, "طالب ب": { type: "sleeping" } }), ...sessions("2/9")]
  });
  if (!team.complete || team.classCount !== 2 || team.attendanceRate !== 2.5 || team.behaviorRate !== 1) throw new Error("team rate must average class rates equally");
  if (team.classMetrics[0].attendanceRate !== 4 || team.classMetrics[1].attendanceRate !== 1) throw new Error("class rates should remain separately available");
});
