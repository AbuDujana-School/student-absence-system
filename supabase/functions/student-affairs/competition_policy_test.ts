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
    { date_str: "2026-11-08", class_name: "1/9", records: { "طالب أ": "absent", "طالب ب": "late" } },
    { date_str: "2026-11-08", class_name: "1/9", records: { "طالب أ": "absent", "طالب ب": "escape" } }
  ];
  if (countAttendanceIncidents(rows) !== 3) throw new Error("attendance deduplication failed");
});

Deno.test("behavior incidents deduplicate repeated same-type entries per student per day", () => {
  const rows = [
    { date_str: "2026-11-08", class_name: "1/9", records: { "طالب أ": { type: "talking" }, "طالب ب": { type: "normal" } } },
    { date_str: "2026-11-08", class_name: "1/9", records: { "طالب أ": { type: "talking" }, "طالب ب": { type: "sleeping" } } }
  ];
  if (countBehaviorIncidents(rows) !== 2) throw new Error("behavior deduplication failed");
});

Deno.test("team day is incomplete unless every class has attendance and behavior sessions", () => {
  const attendance = getSessionCoverage([{ date_str: "2026-11-08", class_name: "1/9" }, { date_str: "2026-11-08", class_name: "2/9" }]);
  const behavior = getSessionCoverage([{ date_str: "2026-11-08", class_name: "1/9" }]);
  if (isTeamDayComplete(["1/9", "2/9"], "2026-11-08", attendance, behavior)) throw new Error("missing behavior session must not be treated as zero violations");
});

Deno.test("relative scoring rewards lower rates and preserves ties", () => {
  const result = calculateRelativeCompetitionScores([
    { grade: "9", complete: true, attendanceRate: 1, behaviorRate: 2 },
    { grade: "10", complete: true, attendanceRate: 2, behaviorRate: 4 },
    { grade: "11", complete: true, attendanceRate: 3, behaviorRate: 6 }
  ]);
  if (result[0].grade !== "9" || result[0].score !== 100 || result[2].score !== 0) throw new Error("relative score ordering failed");
  const ties = calculateRelativeCompetitionScores([
    { grade: "9", complete: true, attendanceRate: 0, behaviorRate: 0 },
    { grade: "10", complete: true, attendanceRate: 0, behaviorRate: 0 }
  ]);
  if (ties.some(team => team.score !== 100 || team.rank !== 1)) throw new Error("equal zero-rate teams must tie at 100 points");
});

Deno.test("team rates use only the selected class and requested date range", () => {
  const team = buildTeamRates({
    grade: "9",
    classNames: ["1/9"],
    rosters: { "1/9": ["طالب أ", "طالب ب"] },
    from: "2026-11-08",
    to: "2026-11-08",
    attendanceRows: [
      { date_str: "2026-11-08", class_name: "1/9", records: { "طالب أ": "absent" } },
      { date_str: "2026-11-09", class_name: "1/9", records: { "طالب ب": "late" } },
      { date_str: "2026-11-08", class_name: "2/9", records: { "طالب ب": "late" } }
    ],
    behaviorRows: [
      { date_str: "2026-11-08", class_name: "1/9", records: { "طالب ب": { type: "talking" } } }
    ]
  });
  if (!team.complete || team.attendanceIncidents !== 1 || team.behaviorIncidents !== 1 || team.studentDays !== 2) {
    throw new Error("team metrics must be scoped to class and date");
  }
});
