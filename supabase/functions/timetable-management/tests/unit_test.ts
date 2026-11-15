import { parseTimetableDay, validateSchoolTeacherCount } from "../timetable_grid.ts";
import { matchSystemTeacherName, parseTimetableWorkbook, validateWorkbookSchema } from "../timetable_import.ts";
import { canAccessTeacherTimetablePortal, canIncludeOtherDepartments, canUseTimetableAction, resolveTimetablePrincipal } from "../session_auth.ts";
import { buildBatchSubstitutionPlan, getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, calculateSubstitutionWorkloadScore, getSubstitutionPeriodPoints, isValidSubstitutionDate, type TimetableEntry, type SubstitutionTeacher } from "../substitution_policy.ts";

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

Deno.test("daily parser preserves incomplete teacher grids with warnings and rejects wrong roster size", () => {
  const incomplete = ["معلم تجريبي\tالأحد\t1\t1/12\tالرياضيات\tتدريس"].join("\n");
  const partial = parseTimetableDay("الأحد", incomplete);
  equal(partial.teachers.length, 1, "Teacher row must be preserved");
  equal(partial.teachers[0].cells.length, 7, "Missing periods must be represented");
  equal(partial.teachers[0].cells[0].status, "teaching", "Explicit teaching cell must be preserved");
  assert(partial.teachers[0].cells.slice(1).every(cell => cell.status === "unclear"), "Missing periods must be marked unclear, never free");
  assert(partial.warnings.length > 0, "Incomplete teacher grid must carry a warning");

  const parsed = parseTimetableDay("الأحد", tabularDay([
    { name: "معلم تجريبي", statuses: ["فراغ","فراغ","فراغ","فراغ","فراغ","فراغ","فراغ"] },
  ]));
  let rejected = false;
  try { validateSchoolTeacherCount(parsed, 69); } catch { rejected = true; }
  assert(rejected, "Unexpected teacher count must still be rejected by the explicit roster validator");
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
    { substituteTeacherId: "lower", weekday: "الخميس", period: 1, assignmentType: "supervision", status: "confirmed" as const },
    { substituteTeacherId: "lower", weekday: "الخميس", period: 2, assignmentDate: "2026-11-15", assignmentType: "substitution", status: "assigned" as const },
  ];
  const ranked = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments, absentTeacherId: "absent",
    weekday: "الأحد", period: 2, departmentId: "science", assignmentDate: "2026-11-14",
  });
  equal(ranked[0].id, "lower", "The lower score of 20 should rank ahead of 21");
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

Deno.test("only admins and explicitly reserve-authorized teachers can include other departments", () => {
  equal(canIncludeOtherDepartments("admin", true), true, "Administrator may request cross-department candidates");
  equal(canIncludeOtherDepartments("teacher", true), false, "Teacher without reserve permission cannot widen department scope");
  equal(canIncludeOtherDepartments("teacher", true, true), true, "Reserve-authorized teacher may request cross-department substitutes");
  equal(canIncludeOtherDepartments("custom", true, true), false, "Custom users cannot widen department scope");
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

Deno.test("cumulative substitution score excludes future, cancelled, duty and supervision rows", () => {
  const assignments = [
    { substituteTeacherId: "t1", weekday: "الأحد", period: 1, assignmentDate: "2026-11-13", assignmentType: "substitution", status: "completed" as const },
    { substituteTeacherId: "t1", weekday: "الأحد", period: 2, assignmentDate: "2026-11-15", assignmentType: "substitution", status: "assigned" as const },
    { substituteTeacherId: "t1", weekday: "الاثنين", period: 2, assignmentDate: "2026-11-12", assignmentType: "duty", status: "confirmed" as const },
    { substituteTeacherId: "t1", weekday: "الثلاثاء", period: 2, assignmentDate: "2026-11-11", assignmentType: "supervision", status: "confirmed" as const },
    { substituteTeacherId: "t1", weekday: "الأربعاء", period: 2, assignmentDate: "2026-11-10", assignmentType: "substitution", status: "cancelled" as const },
  ];
  const score = calculateSubstitutionWorkloadScore(assignments, "2026-11-14");
  equal(score, 1 + 2 + 3 + 4, "Only the one prior active substitution contributes to total and recency score");
});

Deno.test("workbook schema validation rejects malformed rows, unsupported cells and resource overages", () => {
  const malformed = validateWorkbookSchema({
    "جدول الأحد": [
      ["اسم المعلم", "الحصة"],
      "صف غير صالح",
      ["معلم", { unsupported: true }],
      ["نص طويل".repeat(2000)],
    ],
  });
  equal(malformed.valid, false, "Malformed workbook must be rejected");
  assert(malformed.errors.some(issue => issue.code === "invalid_row"), "Invalid row must be reported");
  assert(malformed.errors.some(issue => issue.code === "invalid_cell"), "Unsupported cell must be reported");
  assert(malformed.errors.some(issue => issue.code === "cell_too_long"), "Oversized cell text must be reported");

  const tooManyRows = validateWorkbookSchema({ "جدول": Array.from({ length: 5001 }, () => ["x"]) });
  equal(tooManyRows.valid, false, "Workbook exceeding the row limit must be rejected");
  assert(tooManyRows.rowCount > 5000, "Row count must be reported");
});

Deno.test("daily parser preserves elective-group notes from the source text", () => {
  const parsed = parseTimetableDay("الأحد", [
    "اليوم الأول: الأحد",
    "اسم المعلم: معلم تجريبي",
    "الحصة الأولى:",
    "- الصف والشعبة: 1/12",
    "- المادة: الأحياء",
    "- الحالة: تدريس",
    "- ملاحظة المجموعة: مجموعة مادة اختيارية",
  ].join("\n"));
  equal(parsed.teachers[0].cells[0].sourceGroupNote, "مجموعة مادة اختيارية", "Elective group note");
});

Deno.test("confirmed teacher alias tolerates OCR spacing inside the source name", () => {
  const result = matchSystemTeacherName("س فيزيا ء", [{ name: "محمد البشير" }]);
  equal(result.matchStatus, "matched", "OCR-spaced confirmed alias");
  equal(result.teacherName, "محمد البشير", "Canonical teacher name");
});

Deno.test("personal timetable portal selection is enforced for global and custom modes", () => {
  equal(canAccessTeacherTimetablePortal(false, [], "معلم أ"), false, "Disabled portal denies everyone");
  equal(canAccessTeacherTimetablePortal(true, [], "معلم أ"), true, "Empty selection is global mode");
  equal(canAccessTeacherTimetablePortal(true, ["معلم أ"], "معلم أ"), true, "Selected teacher is allowed");
  equal(canAccessTeacherTimetablePortal(true, ["معلم أ"], "معلم ب"), false, "Unselected teacher is denied");
});


Deno.test("weighted points exactly follow the eight-period school scale", () => {
  const expected=[1,1,2,2,4,3,5,7];
  expected.forEach((points,index)=>equal(getSubstitutionPeriodPoints(index+1),points,"Period "+(index+1)));
  equal(getSubstitutionPeriodPoints(9),0,"Periods outside the school day have no points");
});

Deno.test("points balance is the first fairness priority", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"more-points",name:"رصيد أعلى",departmentId:"science",pointsBalance:4,dailyTeachingCount:0},
    {id:"fewer-points",name:"رصيد أقل",departmentId:"science",pointsBalance:-2,dailyTeachingCount:7},
  ];
  const timetable=teachers.map(t=>({teacherId:t.id,weekday:"الأحد",period:2,className:"",status:"free" as const}));
  const ranked=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:2,
    departmentId:"science",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(ranked[0].id,"fewer-points","Lowest points balance takes priority even when daily teaching load is higher");
});

Deno.test("three consecutive lessons are avoided before adjacent-period preference", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"triple",name:"يصبح ثلاثياً",departmentId:"science",pointsBalance:0},
    {id:"adjacent",name:"حصة مجاورة",departmentId:"science",pointsBalance:0},
    {id:"far",name:"بعيد",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[
    {teacherId:"triple",weekday:"الأحد",period:1,className:"1/1",status:"teaching"},
    {teacherId:"triple",weekday:"الأحد",period:2,className:"1/2",status:"teaching"},
    {teacherId:"triple",weekday:"الأحد",period:3,className:"",status:"free"},
    {teacherId:"adjacent",weekday:"الأحد",period:2,className:"1/2",status:"teaching"},
    {teacherId:"adjacent",weekday:"الأحد",period:3,className:"",status:"free"},
    {teacherId:"far",weekday:"الأحد",period:3,className:"",status:"free"},
    {teacherId:"far",weekday:"الأحد",period:5,className:"1/5",status:"teaching"},
    {teacherId:"far",weekday:"الأحد",period:6,className:"1/6",status:"teaching"},
    {teacherId:"adjacent",weekday:"الأحد",period:5,className:"1/5",status:"teaching"},
  ];
  const ranked=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:3,
    departmentId:"science",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(ranked[0].id,"adjacent","Avoid three consecutive periods");
  equal(ranked[1].id,"far","Non-adjacent teacher follows");
  equal(ranked[2].id,"triple","Three-consecutive teacher is last");
});

Deno.test("batch plan excludes all selected absentees and prefers one assignment per substitute", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"absent-a",name:"غائب أ",departmentId:"science",pointsBalance:0},
    {id:"absent-b",name:"غائب ب",departmentId:"science",pointsBalance:0},
    {id:"candidate-a",name:"بديل أ",departmentId:"science",pointsBalance:0},
    {id:"candidate-b",name:"بديل ب",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[];
  for(const teacher of teachers){
    for(let period=1;period<=7;period++){
      const teaching=(teacher.id==="absent-a"&&period===1)||(teacher.id==="absent-b"&&period===2);
      timetable.push({teacherId:teacher.id,weekday:"الأحد",period,className:teaching?"1/1":"",status:teaching?"teaching":"free"});
    }
  }
  const plan=buildBatchSubstitutionPlan({
    teachers,timetable,assignments:[],absentTeachers:[
      {id:"absent-a",name:"غائب أ",departmentId:"science"},
      {id:"absent-b",name:"غائب ب",departmentId:"science"},
    ],weekday:"الأحد",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(plan.assignedCount,2,"Both absent lessons should be covered");
  equal(new Set(plan.assignments.map(a=>a.substituteTeacherName)).size,2,"Use one lesson per substitute before assigning a second");
  assert(!plan.assignments.some(a=>a.substituteTeacherName==="غائب أ"||a.substituteTeacherName==="غائب ب"),"Selected absent teachers must never be substitutes");
});


Deno.test("reserve permission grants substitution actions only", async () => {
  const token="a".repeat(64);
  const principal=await resolveTimetablePrincipal("Bearer "+token,{
    async findSession(){return {principal_type:"teacher",principal_name:"معلم مخوّل",expires_at:"2026-11-16T00:00:00.000Z"};},
    async hasAdminCredential(){return false;},
    async findTeacher(name){return {name,role:"teacher"};},
    async hasTimetableAccess(){return false;},
    async hasSubstitutionAccess(){return true;},
  },Date.parse("2026-11-15T12:00:00.000Z"));
  equal(principal?.name,"معلم مخوّل","Reserve-enabled teacher should authenticate for substitution");
  equal(canUseTimetableAction("teacher","timetable_substitution_batch_preview"),true,"Batch preview is allowed");
  equal(canUseTimetableAction("teacher","timetable_substitution_batch_save"),true,"Batch save is allowed");
  equal(canUseTimetableAction("teacher","timetable_save_day"),false,"Reserve must not grant timetable editing");
});


Deno.test("substitution date validation accepts real ISO dates and rejects invalid calendar dates", () => {
  equal(isValidSubstitutionDate("2026-11-15"),true,"Valid ISO date");
  equal(isValidSubstitutionDate("2024-02-29"),true,"Valid leap day");
  equal(isValidSubstitutionDate("2026-02-29"),false,"Invalid non-leap day");
  equal(isValidSubstitutionDate("2026-02-30"),false,"Date overflow must be rejected");
  equal(isValidSubstitutionDate("15-11-2026"),false,"Localized date format is not accepted by the API");
});
