import { parseTimetableDay, validateSchoolTeacherCount } from "../timetable_grid.ts";
import { matchSystemTeacherName, parseTimetableWorkbook, validateWorkbookSchema } from "../timetable_import.ts";
import { canAccessTeacherTimetablePortal, canIncludeOtherDepartments, canUseTimetableAction, resolveTimetablePrincipal } from "../session_auth.ts";
import { buildBatchSubstitutionPlan, countTeacherTeachingPeriods, getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, calculateSubstitutionWorkloadScore, getSubstitutionPeriodPoints, getSubstitutionDailyLoadFactor, isValidSubstitutionDate, type TimetableEntry, type SubstitutionTeacher, type SubstitutionAssignment } from "../substitution_policy.ts";

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

Deno.test("teachers remain eligible for substitution on personal or department duty days", () => {
  const teachers = [
    { id: "personal-duty", name: "مناوب فردياً", departmentId: "science", dutyDay: "الأحد" },
    { id: "department-duty", name: "مناوب القسم", departmentId: "science", dutyDay: "الأحد" },
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
  equal(ranked.length, 4, "Duty day must not disqualify any otherwise eligible teacher");
  assert(ranked.some((teacher) => teacher.id === "personal-duty"), "Teacher with a personal duty day remains eligible");
  assert(ranked.some((teacher) => teacher.id === "department-duty"), "Teacher with a department duty day remains eligible");
  assert(ranked.every((teacher) => teacher.departmentId === "science"), "Department scope remains enforced");
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
  equal(ranked.find((teacher) => teacher.id === "lower")?.substitutionsCount, 2, "Duty assignments are not counted as substitutions");
  equal(ranked.find((teacher) => teacher.id === "lower")?.workloadScore, 20, "Legacy workload diagnostics remain available");
  equal(ranked[0].candidateScore, ranked[1].candidateScore, "Weekly quota alone must not alter the new daily-effort score");
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
  const expected=[1,1,1.5,1.5,3,2.5,4,5];
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
  equal(ranked[0].id,"fewer-points","Lowest cumulative effort balance ranks first when effort is equal");
});

Deno.test("weekly teaching quota is considered after points and before same-day teaching load", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"high-weekly",name:"نصاب أسبوعي مرتفع",departmentId:"science",pointsBalance:0,weeklyQuota:38,dailyTeachingCount:0},
    {id:"low-weekly",name:"نصاب أسبوعي أقل",departmentId:"science",pointsBalance:0,weeklyQuota:16,dailyTeachingCount:6},
  ];
  const timetable=teachers.map(t=>({teacherId:t.id,weekday:"الأحد",period:3,className:"",status:"free" as const}));
  const ranked=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:3,
    departmentId:"science",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(ranked[0].candidateScore,ranked[1].candidateScore,"Weekly quota is not part of the candidate score");
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
  const triple=ranked.find(t=>t.id==="triple")!;
  const safe=ranked.find(t=>t.id==="far")!;
  equal(triple.streakPenalty,15,"Three consecutive periods add 15 ranking points");
  equal(triple.candidateScore,(safe.candidateScore??0)+15,"Three-consecutive penalty is applied to ranking only");
  equal(ranked[ranked.length-1].id,"triple","The exhausting three-period option ranks last");
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


Deno.test("batch planner prioritizes the absent teacher's own subject department before cross-department support", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"absent",name:"معلم المادة الغائب",departmentId:"science",pointsBalance:0},
    {id:"cross",name:"بديل من قسم آخر",departmentId:"english",pointsBalance:-100},
    {id:"same",name:"بديل من نفس المادة",departmentId:"science",pointsBalance:100},
  ];
  const timetable=[
    {teacherId:"absent",weekday:"الأحد",period:3,className:"10/1",subject:"العلوم",status:"teaching" as const},
    {teacherId:"cross",weekday:"الأحد",period:3,className:"",status:"free" as const},
    {teacherId:"same",weekday:"الأحد",period:3,className:"",status:"free" as const},
  ];
  const plan=buildBatchSubstitutionPlan({
    teachers,timetable,assignments:[],absentTeachers:[{id:"absent",name:"معلم المادة الغائب",departmentId:"science"}],
    weekday:"الأحد",assignmentDate:"2026-11-16",versionId:"active",
    includeOtherDepartments:true,otherDepartmentTeacherIds:["cross"],
  });
  equal(plan.assignedCount,1,"The absent lesson should be covered");
  equal(plan.assignments[0].substituteTeacherName,"بديل من نفس المادة","Same-department teacher must outrank cross-department support even with a higher points balance");
  equal(plan.assignments[0].candidateOptions[0].teacherName,"بديل من نفس المادة","Dropdown must show same-department candidate before cross-department support");
  equal(plan.assignments[0].candidateOptions[1].teacherName,"بديل من قسم آخر","Cross-department candidate follows same-department options");
});

Deno.test("reserve permission grants substitution actions only", async () => {
  const token="a".repeat(64);
  const principal=await resolveTimetablePrincipal("Bearer "+token,{
    async findSession(){return {principal_type:"teacher",principal_name:"معلم مخوّل",expires_at:"2026-11-16T00:00:00.000Z"};},
    async hasAdminCredential(){return false;},
    async findTeacher(name){return {name,role:"teacher",reserveAccess:true};},
    async hasTimetableAccess(){return false;},
  },Date.parse("2026-11-15T12:00:00.000Z"),"timetable_substitution_batch_preview");
  equal(principal?.name,"معلم مخوّل","Reserve-enabled teacher should authenticate for substitution");
  equal(principal?.reserveAccess,true,"Live reserve permission should be carried with the teacher identity");
  equal(canUseTimetableAction("teacher","timetable_substitution_batch_preview"),false,"General teacher access alone must not grant reserve actions");
  equal(canUseTimetableAction("teacher","timetable_substitution_batch_save"),false,"General teacher access alone must not grant batch save");
  equal(canUseTimetableAction("teacher","timetable_substitution_batch_preview",false,principal?.reserveAccess),true,"Reserve permission grants batch preview");
  equal(canUseTimetableAction("teacher","timetable_substitution_batch_save",false,principal?.reserveAccess),true,"Reserve permission grants batch save");
  equal(canUseTimetableAction("teacher","timetable_save_day"),false,"Reserve must not grant timetable editing");
});


Deno.test("substitution date validation accepts real ISO dates and rejects invalid calendar dates", () => {
  equal(isValidSubstitutionDate("2026-11-15"),true,"Valid ISO date");
  equal(isValidSubstitutionDate("2024-02-29"),true,"Valid leap day");
  equal(isValidSubstitutionDate("2026-02-29"),false,"Invalid non-leap day");
  equal(isValidSubstitutionDate("2026-02-30"),false,"Date overflow must be rejected");
  equal(isValidSubstitutionDate("15-11-2026"),false,"Localized date format is not accepted by the API");
});


Deno.test("weekly teaching quota is considered after equal point and daily-cover balances", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"high-quota",name:"نصاب مرتفع",departmentId:"science",pointsBalance:2,weeklyQuota:30,dailyTeachingCount:2},
    {id:"low-quota",name:"نصاب أقل",departmentId:"science",pointsBalance:2,weeklyQuota:18,dailyTeachingCount:2},
  ];
  const timetable=teachers.map(t=>({teacherId:t.id,weekday:"الأحد",period:3,className:"",status:"free" as const}));
  const ranked=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:3,
    departmentId:"science",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(ranked[0].candidateScore,ranked[1].candidateScore,"Weekly quota is intentionally excluded from the formula");
});


Deno.test("duplicate shared-class rows for an absent teacher produce one replacement per period", () => {
  const lessons=getAbsentTeacherLessons([
    {teacherId:"absent",weekday:"الأحد",period:3,className:"10/1",subject:"العلوم",status:"teaching"},
    {teacherId:"absent",weekday:"الأحد",period:3,className:"10/2",subject:"العلوم",status:"teaching"},
    {teacherId:"absent",weekday:"الأحد",period:4,className:"10/3",subject:"العلوم",status:"teaching"},
  ],"absent","الأحد");
  equal(lessons.length,2,"Duplicate period rows must not create duplicate substitute assignments");
  equal(lessons[0].className,"10/1، 10/2","Shared class names should be combined for the report");
});

Deno.test("weekly teaching quota counts distinct periods rather than duplicate shared rows", () => {
  const counts=countTeacherTeachingPeriods([
    {teacherId:"teacher",weekday:"الأحد",period:1,className:"10/1",status:"teaching"},
    {teacherId:"teacher",weekday:"الأحد",period:1,className:"10/2",status:"teaching"},
    {teacherId:"teacher",weekday:"الأحد",period:2,className:"10/3",status:"teaching"},
    {teacherId:"teacher",weekday:"الأحد",period:3,className:"",status:"free"},
  ]);
  equal(counts.get("teacher"),2,"A teacher's shared class at the same period counts once");
});


Deno.test("batch planner completes the first absent teacher before processing the next", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"absent-a",name:"الغائب الأول",departmentId:"science",pointsBalance:0},
    {id:"absent-b",name:"الغائب الثاني",departmentId:"science",pointsBalance:0},
    {id:"candidate-a",name:"بديل أ",departmentId:"science",pointsBalance:0},
    {id:"candidate-b",name:"بديل ب",departmentId:"science",pointsBalance:0},
    {id:"candidate-c",name:"بديل ج",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[];
  for(const teacher of teachers){
    for(let period=1;period<=4;period++){
      const teaching=(teacher.id==="absent-a"&&(period===2||period===4))||(teacher.id==="absent-b"&&period===1);
      timetable.push({teacherId:teacher.id,weekday:"الأحد",period,className:teaching?"1/1":"",status:teaching?"teaching":"free"});
    }
  }
  const plan=buildBatchSubstitutionPlan({
    teachers,timetable,assignments:[],
    absentTeachers:[
      {id:"absent-a",name:"الغائب الأول",departmentId:"science"},
      {id:"absent-b",name:"الغائب الثاني",departmentId:"science"},
    ],
    weekday:"الأحد",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(plan.assignedCount,3,"All three absent lessons should be covered");
  equal(plan.assignments.map(item=>item.absentTeacherName).join("|"),"الغائب الأول|الغائب الأول|الغائب الثاني","Every lesson for the first absent teacher must be allocated before the next absent teacher");
  equal(plan.assignments.map(item=>item.period).join("|"),"2|4|1","Each absent teacher's lessons remain in period order");
});

Deno.test("batch planner repeats a substitute only when necessary and never exceeds two daily covers", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"absent-a",name:"الغائب الأول",departmentId:"science",pointsBalance:0},
    {id:"absent-b",name:"الغائب الثاني",departmentId:"science",pointsBalance:0},
    {id:"candidate-a",name:"بديل أ",departmentId:"science",pointsBalance:0},
    {id:"candidate-b",name:"بديل ب",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[];
  for(const teacher of teachers){
    for(let period=1;period<=4;period++){
      const teaching=(teacher.id==="absent-a"&&(period===2||period===4))||(teacher.id==="absent-b"&&period===1);
      timetable.push({teacherId:teacher.id,weekday:"الأحد",period,className:teaching?"1/1":"",status:teaching?"teaching":"free"});
    }
  }
  const plan=buildBatchSubstitutionPlan({
    teachers,timetable,assignments:[],
    absentTeachers:[
      {id:"absent-a",name:"الغائب الأول",departmentId:"science"},
      {id:"absent-b",name:"الغائب الثاني",departmentId:"science"},
    ],
    weekday:"الأحد",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(plan.assignedCount,3,"All absent lessons should be assigned when two candidates can each take up to two covers");
  const firstTwo=plan.assignments.slice(0,2).map(item=>item.substituteTeacherName);
  equal(new Set(firstTwo).size,2,"Do not repeat a substitute while another one-cover candidate is available");
  const counts=new Map<string,number>();
  plan.assignments.forEach(item=>counts.set(item.substituteTeacherName,(counts.get(item.substituteTeacherName)||0)+1));
  assert([...counts.values()].some(count=>count===2),"A second daily cover is used only when all candidates already have one");
  assert([...counts.values()].every(count=>count<=2),"No substitute may exceed two covers in one day");
  equal(plan.assignments.map(item=>item.absentTeacherName).join("|"),"الغائب الأول|الغائب الأول|الغائب الثاني","The first absent teacher must be completed before the second");
});

Deno.test("batch planner skips already-saved absent-teacher lessons instead of duplicating them", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"absent",name:"غائب",departmentId:"science",pointsBalance:0},
    {id:"candidate",name:"بديل",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[
    {teacherId:"absent",weekday:"الأحد",period:1,className:"10/1",status:"teaching"},
    {teacherId:"candidate",weekday:"الأحد",period:1,className:"",status:"free"},
    {teacherId:"absent",weekday:"الأحد",period:2,className:"10/2",status:"teaching"},
    {teacherId:"candidate",weekday:"الأحد",period:2,className:"",status:"free"},
  ];
  const plan=buildBatchSubstitutionPlan({
    teachers,timetable,assignments:[{
      substituteTeacherId:"candidate",absentTeacherId:"absent",weekday:"الأحد",period:1,
      assignmentDate:"2026-11-15",versionId:"active",assignmentType:"substitution",status:"assigned",
    }],
    absentTeachers:[{id:"absent",name:"غائب",departmentId:"science"}],
    weekday:"الأحد",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(plan.assignedCount,1,"Only the not-yet-assigned lesson should be proposed");
  equal(plan.assignments[0].period,2,"The already-saved lesson must not be duplicated");
});


Deno.test("manual override options retain teachers who already have one daily cover", () => {
  const teachers:SubstitutionTeacher[]=[
    {id:"absent",name:"غائب",departmentId:"science",pointsBalance:0},
    {id:"fresh",name:"بديل جديد",departmentId:"science",pointsBalance:3},
    {id:"one-cover",name:"بديل بحصة",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[];
  for(const teacher of teachers){
    for(let period=1;period<=3;period++){
      timetable.push({teacherId:teacher.id,weekday:"الأحد",period,className:"",status:teacher.id==="absent"&&period===1?"teaching":"free"});
    }
  }
  const plan=buildBatchSubstitutionPlan({
    teachers,timetable,assignments:[{
      substituteTeacherId:"one-cover",weekday:"الأحد",period:3,assignmentDate:"2026-11-15",
      versionId:"active",assignmentType:"substitution",status:"assigned",
    }],
    absentTeachers:[{id:"absent",name:"غائب",departmentId:"science"}],
    weekday:"الأحد",assignmentDate:"2026-11-15",versionId:"active",
  });
  equal(plan.assignments[0].substituteTeacherName,"بديل جديد","The automatic suggestion should prefer a teacher with no daily cover");
  assert(plan.assignments[0].candidateOptions.some(option=>option.teacherName==="بديل بحصة"&&option.dailySubstitutionCount===1),"A one-cover teacher remains available for manual override up to the two-cover cap");
  equal(plan.assignments[0].candidateOptions[0].teacherName,"بديل جديد","Dropdown must put the first daily-cover tier ahead of second daily-cover options");
  equal(plan.assignments[0].candidateOptions[1].teacherName,"بديل بحصة","Second daily-cover option remains available after first-cover candidates");
});


Deno.test("daily load factors match the approved 2, 3, 4 and 5+ thresholds",()=>{
  equal(getSubstitutionDailyLoadFactor(2).factor,1,"Two periods");
  equal(getSubstitutionDailyLoadFactor(3).factor,1.25,"Three periods");
  equal(getSubstitutionDailyLoadFactor(4).factor,1.6,"Four periods");
  equal(getSubstitutionDailyLoadFactor(5).factor,2.2,"Five periods");
  equal(getSubstitutionDailyLoadFactor(5).overloaded,true,"Five periods require emergency fallback");
});

Deno.test("candidate score equals cumulative balance plus actual weighted effort",()=>{
  const teacher:SubstitutionTeacher={id:"t",name:"معلم",departmentId:"science",pointsBalance:3};
  const timetable:TimetableEntry[]=[
    {teacherId:"t",weekday:"الأحد",period:1,className:"1/1",status:"teaching"},
    {teacherId:"t",weekday:"الأحد",period:3,className:"1/2",status:"teaching"},
    {teacherId:"t",weekday:"الأحد",period:5,className:"1/3",status:"teaching"},
    {teacherId:"t",weekday:"الأحد",period:7,className:"",status:"free"},
  ];
  const ranked=getAvailableSubstitutionCandidates({teachers:[teacher],timetable,assignments:[],
    absentTeacherId:"absent",weekday:"الأحد",period:7,departmentId:"science"});
  equal(ranked[0].effortPoints,5,"Period 7 weight 4 multiplied by 3-period factor 1.25");
  equal(ranked[0].candidateScore,8,"Cumulative 3 plus actual effort 5; no organizational penalty");
});

Deno.test("same-day reserve adds ten ranking points without increasing actual effort credit",()=>{
  const teachers:SubstitutionTeacher[]=[
    {id:"fresh",name:"بدون احتياط",departmentId:"science",pointsBalance:0},
    {id:"used",name:"احتياط سابق",departmentId:"science",pointsBalance:0},
  ];
  const timetable:TimetableEntry[]=[
    {teacherId:"fresh",weekday:"الأحد",period:3,className:"",status:"free"},
    {teacherId:"used",weekday:"الأحد",period:3,className:"",status:"free"},
  ];
  const assignments:SubstitutionAssignment[]=[{
    substituteTeacherId:"used",weekday:"الأحد",period:1,assignmentDate:"2026-11-15",
    versionId:"active",assignmentType:"substitution",status:"assigned",
  }];
  const ranked=getAvailableSubstitutionCandidates({teachers,timetable,assignments,absentTeacherId:"absent",
    weekday:"الأحد",period:3,departmentId:"science",assignmentDate:"2026-11-15",versionId:"active"});
  equal(ranked[0].id,"fresh","Teacher without a same-day reserve ranks first");
  equal(ranked.find(t=>t.id==="used")?.sameDayPenalty,10,"Same-day penalty is ten");
  equal(ranked.find(t=>t.id==="used")?.effortPoints,1.5,"Organizational penalty is not part of effort credit");
});

Deno.test("emergency compensation balance creates a modest future priority",()=>{
  const teachers:SubstitutionTeacher[]=[
    {id:"normal",name:"رصيد عادي",departmentId:"science",pointsBalance:0},
    {id:"compensating",name:"رصيد تعويض",departmentId:"science",pointsBalance:0,compensationBalance:2},
  ];
  const timetable=teachers.map(t=>({teacherId:t.id,weekday:"الأحد",period:3,className:"",status:"free" as const}));
  const ranked=getAvailableSubstitutionCandidates({teachers,timetable,assignments:[],absentTeacherId:"absent",
    weekday:"الأحد",period:3,departmentId:"science"});
  equal(ranked[0].id,"compensating","Emergency compensation gives a modest priority");
  equal(ranked.find(t=>t.id==="compensating")?.candidateScore,0,"Two compensation points reduce the ranking score by 1.5");
});

Deno.test("five-or-more daily teaching periods are excluded unless every alternative is overloaded",()=>{
  const teachers:SubstitutionTeacher[]=[
    {id:"heavy",name:"نصاب ثقيل",departmentId:"science"},
    {id:"normal",name:"نصاب مناسب",departmentId:"science"},
  ];
  const timetable:TimetableEntry[]=[];
  for(const p of [1,2,3,4,5])timetable.push({teacherId:"heavy",weekday:"الأحد",period:p,className:"1/1",status:"teaching"});
  timetable.push({teacherId:"heavy",weekday:"الأحد",period:6,className:"",status:"free"});
  timetable.push({teacherId:"normal",weekday:"الأحد",period:6,className:"",status:"free"});
  let ranked=getAvailableSubstitutionCandidates({teachers,timetable,assignments:[],absentTeacherId:"absent",
    weekday:"الأحد",period:6,departmentId:"science"});
  equal(ranked.length,1,"The five-period teacher is omitted while a lighter alternative exists");
  equal(ranked[0].id,"normal","Normal-load teacher remains eligible");

  ranked=getAvailableSubstitutionCandidates({teachers:[teachers[0]],timetable,assignments:[],absentTeacherId:"absent",
    weekday:"الأحد",period:6,departmentId:"science"});
  equal(ranked.length,1,"An overloaded teacher is available only as a last resort");
  equal(ranked[0].emergencyFallback,true,"Emergency fallback is explicitly marked");
});

Deno.test("four consecutive periods rank behind a non-exhausting available teacher",()=>{
  const teachers:SubstitutionTeacher[]=[
    {id:"streak",name:"تتالي مرهق",departmentId:"science"},
    {id:"safe",name:"متاح بسلاسة",departmentId:"science"},
  ];
  const timetable:TimetableEntry[]=[];
  for(const p of [1,2,3,4])timetable.push({teacherId:"streak",weekday:"الأحد",period:p,className:"1/1",status:"teaching"});
  timetable.push({teacherId:"streak",weekday:"الأحد",period:5,className:"",status:"free"});
  timetable.push({teacherId:"safe",weekday:"الأحد",period:1,className:"1/1",status:"teaching"});
  timetable.push({teacherId:"safe",weekday:"الأحد",period:5,className:"",status:"free"});
  const ranked=getAvailableSubstitutionCandidates({teachers,timetable,assignments:[],absentTeacherId:"absent",
    weekday:"الأحد",period:5,departmentId:"science"});
  equal(ranked.length,1,"A four-period continuous run is held back when a non-exhausting teacher exists");
  equal(ranked[0].id,"safe","Safe alternative ranks first");
});

Deno.test("manual batch selection updates virtual allocation and reranks later unapproved lessons",()=>{
  const teachers:SubstitutionTeacher[]=[
    {id:"absent",name:"الغائب",departmentId:"science",pointsBalance:0},
    {id:"a",name:"بديل أ",departmentId:"science",pointsBalance:0},
    {id:"b",name:"بديل ب",departmentId:"science",pointsBalance:5},
  ];
  const timetable:TimetableEntry[]=[];
  for(const teacher of teachers){
    for(const period of [1,2]){
      const teaching=teacher.id==="absent";
      timetable.push({teacherId:teacher.id,weekday:"الأحد",period,className:teaching?"1/1":"",status:teaching?"teaching":"free"});
    }
  }
  const common={teachers,timetable,assignments:[],absentTeachers:[{id:"absent",name:"الغائب",departmentId:"science"}],
    weekday:"الأحد",assignmentDate:"2026-11-15",versionId:"active"};
  const automatic=buildBatchSubstitutionPlan(common);
  equal(automatic.assignments[0].substituteTeacherName,"بديل أ","Lowest cumulative points wins the first period");
  equal(automatic.assignments[1].substituteTeacherName,"بديل ب","The virtual first allocation affects the next period");
  const manual=buildBatchSubstitutionPlan({...common,manualAssignments:{"الغائب\u00001":"بديل ب"}});
  equal(manual.assignments[0].substituteTeacherName,"بديل ب","The valid manual choice is retained");
  equal(manual.assignments[1].substituteTeacherName,"بديل أ","The remaining lesson is reranked after the manual allocation");
});
