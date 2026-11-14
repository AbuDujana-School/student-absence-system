import { parseTimetableDay, validateSchoolTeacherCount } from "../timetable_grid.ts";
import { matchSystemTeacherName, parseTimetableWorkbook } from "../timetable_import.ts";
import { canIncludeOtherDepartments, canUseTimetableAction } from "../session_auth.ts";
import { getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, calculateSubstitutionWorkloadScore, type TimetableEntry, type SubstitutionTeacher } from "../substitution_policy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(message + " Expected " + String(expected) + ", received " + String(actual));
}
function tabularDay(teachers: Array<{ name: string; statuses: string[] }>) {
  const rows: string[] = [];
  for (const teacher of teachers) {
    for (let period = 1; period <= 7; period++) {
      const status = teacher.statuses[period - 1] || "فراغ";
      const subject = status === "تدريس" ? "حصة دينية" : "التربية الإسلامية";
      const className = status === "تدريس" ? "1/12" : "-";
      rows.push([teacher.name, "الأحد", String(period), className, subject, status].join("\t"));
    }
  }
  return rows.join("\n");
}

Deno.test("daily parser preserves all seven periods and normalizes Islamic subject", () => {
  const parsed = parseTimetableDay("الأحد", tabularDay([
    { name: "معلم تجريبي أول", statuses: ["تدريس", "فراغ", "اجتماع", "غير واضح", "فراغ", "فراغ", "فراغ"] },
    { name: "معلم تجريبي ثان", statuses: ["فراغ", "تدريس", "فراغ", "فراغ", "فراغ", "فراغ", "فراغ"] },
  ]));
  equal(parsed.teachers.length, 2, "Teacher count");
  equal(parsed.totalCells, 14, "Cell count");
  equal(parsed.totals.teaching, 2, "Teaching cells");
  equal(parsed.totals.free, 10, "Free cells");
  equal(parsed.totals.meeting, 1, "Meeting cells");
  equal(parsed.totals.unclear, 1, "Unclear cells");
  equal(parsed.teachers[0].cells[0].subject, "التربية الإسلامية", "Canonical subject");
  equal(parsed.teachers[0].cells[2].status, "meeting", "Meeting status");
  equal(parsed.teachers[0].cells[3].status, "unclear", "Unclear status");
});

Deno.test("daily parser rejects incomplete teacher grids and wrong roster size", () => {
  const incomplete = ["معلم تجريبي\tالأحد\t1\t1/12\tالرياضيات\tتدريس"].join("\n");
  let rejected = false;
  try { parseTimetableDay("الأحد", incomplete); } catch { rejected = true; }
  assert(rejected, "Incomplete seven-period grid must be rejected");

  const parsed = parseTimetableDay("الأحد", tabularDay([
    { name: "معلم تجريبي", statuses: ["فراغ","فراغ","فراغ","فراغ","فراغ","فراغ","فراغ"] },
  ]));
  rejected = false;
  try { validateSchoolTeacherCount(parsed, 69); } catch { rejected = true; }
  assert(rejected, "Unexpected teacher count must be rejected");
});

Deno.test("teacher matching leaves ambiguous or unrelated names unresolved", () => {
  const exact = matchSystemTeacherName("أحمد سالم", [{ name: "أحمد سالم" }]);
  equal(exact.matchStatus, "matched", "Exact match");
  const ambiguous = matchSystemTeacherName("أحمد سالم", [{ name: "أحمد سالم" }, { name: "أحمد سالم" }]);
  equal(ambiguous.matchStatus, "ambiguous", "Duplicate exact matches");
  const unrelated = matchSystemTeacherName("اسم غير موجود", [{ name: "معلم آخر" }]);
  equal(unrelated.matchStatus, "unmatched", "Unrelated name");
  const typo = matchSystemTeacherName("أحمد سليم البلوشي", [{ name: "أحمد سالم البلوشي" }]);
  equal(typo.matchStatus, "matched", "High-confidence one-character name typo");
});

Deno.test("substitution candidates require one explicit free cell and respect assignments", () => {
  const teachers: SubstitutionTeacher[] = [
    { id: "absent", name: "المعلم الغائب", departmentId: "science" },
    { id: "free", name: "بديل متاح", departmentId: "science" },
    { id: "meeting", name: "اجتماع", departmentId: "science" },
    { id: "other", name: "قسم آخر", departmentId: "english" },
    { id: "assigned", name: "مكلف مسبقاً", departmentId: "science" },
    { id: "duplicate", name: "خانة مكررة", departmentId: "science" },
    { id: "missing", name: "لا توجد خانة", departmentId: "science" },
  ];
  const timetable: TimetableEntry[] = [
    { teacherId: "absent", weekday: "الأحد", period: 1, className: "1/12", status: "teaching" },
    { teacherId: "free", weekday: "الأحد", period: 1, className: "", status: "free" },
    { teacherId: "meeting", weekday: "الأحد", period: 1, className: "", status: "meeting" },
    { teacherId: "other", weekday: "الأحد", period: 1, className: "", status: "free" },
    { teacherId: "assigned", weekday: "الأحد", period: 1, className: "", status: "free" },
    { teacherId: "duplicate", weekday: "الأحد", period: 1, className: "", status: "free" },
    { teacherId: "duplicate", weekday: "الأحد", period: 1, className: "", status: "free" },
  ];
  const candidates = getAvailableSubstitutionCandidates({
    teachers, timetable,
    assignments: [{ substituteTeacherId: "assigned", weekday: "الأحد", period: 1, status: "assigned" }],
    absentTeacherId: "absent", weekday: "الأحد", period: 1, departmentId: "science",
  });
  equal(candidates.length, 1, "Only one candidate should remain");
  equal(candidates[0].id, "free", "Only explicitly free, unassigned same-department teacher");
  const lessons = getAbsentTeacherLessons(timetable, "absent", "الأحد");
  equal(lessons.length, 1, "Absent teacher teaching lesson count");
  equal(lessons[0].period, 1, "Absent teacher lesson period");
});

Deno.test("department coordinators only see absent teachers in their own department", () => {
  const directory = [
    { name: "معلم قسم العلوم", role: "teacher", departmentId: "science" },
    { name: "معلم قسم اللغة", role: "teacher", departmentId: "language" },
    { name: "حساب مخصص", role: "custom", departmentId: "science" },
  ];
  const cells = [
    { matchedTeacherName: "معلم قسم العلوم", status: "teaching" },
    { matchedTeacherName: "معلم قسم اللغة", status: "teaching" },
    { matchedTeacherName: "حساب مخصص", status: "teaching" },
    { matchedTeacherName: "معلم قسم العلوم", status: "free" },
  ];
  const scoped = getVisibleAbsentTeachers(cells, directory, "science", false);
  equal(scoped.length, 1, "Department-scoped absent teacher count");
  equal(scoped[0], "معلم قسم العلوم", "Only own-department teacher should be visible");
  const admin = getVisibleAbsentTeachers(cells, directory, "", true);
  equal(admin.length, 2, "Administrator sees all teaching teachers, excluding custom accounts");
});

Deno.test("cumulative workload score weights recent assignments and ignores cancelled work", () => {
  const recent = [
    { substituteTeacherId: "t1", weekday: "الأحد", period: 1, assignmentDate: "2026-11-13", status: "assigned" as const },
    { substituteTeacherId: "t1", weekday: "الاثنين", period: 2, assignmentDate: "2026-11-10", status: "confirmed" as const },
    { substituteTeacherId: "t1", weekday: "الثلاثاء", period: 3, assignmentDate: "2026-11-01", status: "cancelled" as const },
  ];
  const old = [
    { substituteTeacherId: "t2", weekday: "الأحد", period: 1, assignmentDate: "2026-08-01", status: "completed" as const },
  ];
  const recentScore = calculateSubstitutionWorkloadScore(recent, "2026-11-14");
  const oldScore = calculateSubstitutionWorkloadScore(old, "2026-11-14");
  assert(recentScore > oldScore, "Recent cumulative assignments should carry greater weight");
});

Deno.test("teachers assigned to an individual or department duty day are excluded", () => {
  const teachers = [
    { id: "personal-duty", name: "مناوب فردياً", departmentId: "science", dutyDay: "الأحد" },
    { id: "category-duty", name: "مناوب القسم", departmentId: "science", dutyDay: "الأحد" },
    { id: "available", name: "متاح", departmentId: "science", dutyDay: "الاثنين" },
    { id: "no-duty", name: "بدون مناوبة", departmentId: "science" },
  ];
  const timetable = teachers.map((teacher) => ({
    teacherId: teacher.id, weekday: "الأحد", period: 3, className: "", status: "free" as const,
  }));
  const ranked = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments: [], absentTeacherId: "absent",
    weekday: "الأحد", period: 3, departmentId: "science",
  });
  equal(ranked.length, 2, "Both personal and category duty teachers must be excluded");
  assert(ranked.some((teacher) => teacher.id === "available"), "Teacher assigned to another day remains eligible");
  assert(ranked.some((teacher) => teacher.id === "no-duty"), "Teacher without a duty day remains eligible");
});

Deno.test("candidate score is weekly teaching quota plus twice prior substitutions", () => {
  const teachers = [
    { id: "higher", name: "نصاب أعلى", departmentId: "science", weeklyQuota: 21 },
    { id: "lower", name: "نصاب أقل", departmentId: "science", weeklyQuota: 16 },
  ];
  const timetable = teachers.map((teacher) => ({
    teacherId: teacher.id, weekday: "الأحد", period: 2, className: "", status: "free" as const,
  }));
  const assignments = [
    { substituteTeacherId: "lower", weekday: "الاثنين", period: 1, assignmentType: "substitution", status: "assigned" as const },
    { substituteTeacherId: "lower", weekday: "الثلاثاء", period: 1, assignmentType: "substitution", status: "confirmed" as const },
    { substituteTeacherId: "lower", weekday: "الأربعاء", period: 1, assignmentType: "duty", status: "confirmed" as const },
  ];
  const ranked = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments, absentTeacherId: "absent",
    weekday: "الأحد", period: 2, departmentId: "science",
  });
  equal(ranked[0].id, "higher", "A score of 21 should rank ahead of a score of 20");
  equal(ranked.find((teacher) => teacher.id === "lower")?.substitutionsCount, 2, "Duty assignments are not counted as substitutions");
  equal(ranked.find((teacher) => teacher.id === "lower")?.workloadScore, 20, "16 + 2×2 should equal 20");
});

Deno.test("fairness never makes an occupied teacher eligible", () => {
  const teachers = [
    { id: "busy", name: "معلم مشغول", departmentId: "science" },
    { id: "free", name: "معلم متاح", departmentId: "science" },
  ];
  const timetable = [
    { teacherId: "busy", weekday: "الأحد", period: 1, className: "1/1", status: "teaching" as const },
    { teacherId: "free", weekday: "الأحد", period: 1, className: "", status: "free" as const },
  ];
  const ranked = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments: [], absentTeacherId: "absent",
    weekday: "الأحد", period: 1, departmentId: "science",
  });
  equal(ranked.length, 1, "Only free candidate remains");
  equal(ranked[0].id, "free", "Busy teacher must never be eligible");
});

Deno.test("workbook schema validation blocks drafts missing required core sheets", () => {
  const invalid = parseTimetableWorkbook({ "الفصول": [["الشعبة"], ["1/1"]] });
  equal(invalid.validation.valid, false, "Missing required sheets must block draft save");
  assert(invalid.validation.errors.some((message) => message.includes("المعلمون")), "Teacher sheet error should be reported");
  assert(invalid.validation.errors.some((message) => message.includes("الحصص")), "Lessons sheet error should be reported");
});

Deno.test("previous timetable versions affect fairness but do not block current-version availability", () => {
  const teachers = [{ id: "teacher", name: "معلم متاح", departmentId: "science" }];
  const timetable = [{ teacherId: "teacher", weekday: "الأحد", period: 2, className: "", status: "free" as const }];
  const ranked = getAvailableSubstitutionCandidates({
    teachers,
    timetable,
    assignments: [{
      substituteTeacherId: "teacher", weekday: "الأحد", period: 2,
      assignmentDate: "2026-11-13", versionId: "old-version", status: "assigned",
    }],
    absentTeacherId: "absent", weekday: "الأحد", period: 2,
    departmentId: "science", assignmentDate: "2026-11-14", versionId: "active-version",
  });
  equal(ranked.length, 1, "Old-version assignment must not block the active timetable cell");
  assert((ranked[0].workloadScore ?? 0) > 0, "Historical assignment must still increase cumulative workload");
});

Deno.test("same-date duty or substitution blocks a candidate across timetable versions", () => {
  const teachers = [{ id: "teacher", name: "معلم متاح", departmentId: "science" }];
  const timetable = [{ teacherId: "teacher", weekday: "الأحد", period: 2, className: "", status: "free" as const }];
  const ranked = getAvailableSubstitutionCandidates({
    teachers,
    timetable,
    assignments: [{
      substituteTeacherId: "teacher", weekday: "الأحد", period: 2,
      assignmentDate: "2026-11-14", versionId: "old-version", assignmentType: "duty", status: "confirmed",
    }],
    absentTeacherId: "absent", weekday: "الأحد", period: 2,
    departmentId: "science", assignmentDate: "2026-11-14", versionId: "active-version",
  });
  equal(ranked.length, 0, "An actual same-date duty must block the candidate even from an older timetable version");
});

Deno.test("only the system administrator can include teachers from other departments", () => {
  equal(canIncludeOtherDepartments("admin", true), true, "Administrator may request cross-department candidates");
  equal(canIncludeOtherDepartments("teacher", true), false, "Teacher cannot widen department scope by editing request payload");
  equal(canIncludeOtherDepartments("custom", true), false, "Coordinator cannot widen department scope by editing request payload");
  equal(canIncludeOtherDepartments("admin", "true"), false, "Non-boolean values are rejected");
});

Deno.test("department coordinators cannot browse full timetable imports or teacher directories", () => {
  for (const action of ["timetable_list_imports", "timetable_get_import", "timetable_list_owner_candidates", "timetable_mutate_record", "timetable_reassign_owner"]) {
    equal(canUseTimetableAction("teacher", action), false, "Teacher cannot access admin import action: " + action);
    equal(canUseTimetableAction("custom", action), false, "Coordinator cannot access admin import action: " + action);
    equal(canUseTimetableAction("admin", action), true, "Administrator retains access: " + action);
  }
  equal(canUseTimetableAction("custom", "timetable_substitution_preview"), true, "Authorized coordinator retains scoped substitution preview");
  equal(canUseTimetableAction("custom", "timetable_substitution_save"), true, "Authorized coordinator retains scoped substitution save");
});
