import { parseTimetableDay, validateSchoolTeacherCount } from "../timetable_grid.ts";
import { matchSystemTeacherName } from "../timetable_import.ts";
import { calculateTeacherWorkload, getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, type TimetableEntry, type SubstitutionTeacher } from "../substitution_policy.ts";

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


Deno.test("substitution ranking balances historical workload and adjacent assignments", () => {
  const assignments = [
    { substituteTeacherId: "heavy", weekday: "الأحد", period: 2, assignmentDate: "2026-11-08", status: "completed" as const, assignmentType: "substitution" },
    { substituteTeacherId: "heavy", weekday: "الاثنين", period: 3, assignmentDate: "2026-11-09", status: "completed" as const, assignmentType: "supervision" },
    { substituteTeacherId: "light", weekday: "الأحد", period: 6, assignmentDate: "2026-11-08", status: "completed" as const, assignmentType: "substitution" },
  ];
  const heavy = calculateTeacherWorkload("heavy", assignments, "الأحد", 3, "2026-11-15");
  const light = calculateTeacherWorkload("light", assignments, "الأحد", 3, "2026-11-15");
  assert(heavy.score > light.score, "Historical duty and substitution work must contribute to workload");
  equal(heavy.semesterAssignments, 2, "All historical active assignments count");
});

Deno.test("supervision assignments block same-slot substitution candidates", () => {
  const teachers: SubstitutionTeacher[] = [
    { id: "free", name: "معلم متاح", departmentId: "science" },
    { id: "duty", name: "معلم مناوب", departmentId: "science" },
  ];
  const timetable: TimetableEntry[] = [
    { teacherId: "free", weekday: "الأحد", period: 3, className: "", status: "free" },
    { teacherId: "duty", weekday: "الأحد", period: 3, className: "", status: "free" },
  ];
  const candidates = getAvailableSubstitutionCandidates({
    teachers, timetable,
    assignments: [{
      substituteTeacherId: "duty", weekday: "الأحد", period: 3,
      assignmentDate: "2026-11-15", status: "assigned", assignmentType: "supervision",
    }],
    absentTeacherId: "absent", weekday: "الأحد", period: 3,
    departmentId: "science", assignmentDate: "2026-11-15",
  });
  equal(candidates.length, 1, "A teacher with a duty in the same slot must be excluded");
  equal(candidates[0].id, "free", "Only the teacher without a conflicting duty remains");
});
