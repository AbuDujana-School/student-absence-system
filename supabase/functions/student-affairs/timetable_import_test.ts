import {
  normalizeArabicName,
  parseTimetableWorkbook,
  type CellValue,
} from "./timetable_import.ts";

function rows(...values: CellValue[][]): CellValue[][] {
  return values;
}

Deno.test("normalizes Arabic name variants and spacing", () => {
  if (normalizeArabicName("  أَحْمَدُ  السَّالِمِيّ ") !== normalizeArabicName("احمد السالمي")) {
    throw new Error("Arabic normalization should ignore diacritics, alef variants and repeated spaces");
  }
});

Deno.test("imports lesson contracts by teacher without inventing weekly placements", () => {
  const workbook = {
    "المعلمون": rows(
      [null, "الإسم", "الإختصار", "مدرس الفصل", "MWD (1)", "EXH (2)", "DAYS (3)", "<a,b> (4)", "التفريغ"],
      [null, "أحمد خالد محمد السالمي", "أحمد السالمي", "", "-", "3", "-", "1 - 2", "الأحد: 1, 4-6"],
      [null, "سعيد عبدالله", "سعيد", "", "-", "-", "-", "-", ""],
    ),
    "الحصص": rows(
      ["المعلم", "الشعب", "المجموعة", "المادة", "المدة", "الحصص/الأسبوع", "الغرف الدراسية المتاحة", "الدورة"],
      ["احمد خالد محمد السالمى", "الحادي عشر/1", "الفصل بالكامل", "الرياضيات", "مفردة", "5", "11/1", "كل الأسابيع"],
      ["سعيد عبدالله", "الحادي عشر/2", "الفصل بالكامل", "العلوم", "مزدوجة", "2", "", "كل الأسابيع"],
    ),
    "الفصول": rows(["الشعبة الدراسية", "الإختصار"], ["الحادي عشر/1", "1/11"]),
    "الغرف الدراسية": rows([null, "الاسم", "الإختصار"], [null, "11/1", "11/1"]),
    "المواد": rows([null, "المادة", "الإختصار"], [null, "الرياضيات", "رياضيات"]),
    "العقود الفصول": rows(["الشعب", "المعلم", "المجموعة", "المادة", "المدة", "الحصص/الأسبوع"], ["الحادي عشر/1", null, null, null, null, "5"], [null, "أحمد خالد محمد السالمي", "الفصل بالكامل", "الرياضيات", "مفردة", "5"]),
    "العقد": rows(["المعلم", "الشعب", "المجموعة", "المادة", "المدة", "الحصص/الأسبوع"], ["أحمد خالد محمد السالمي", null, null, null, null, "5"], [null, "الحادي عشر/1", "الفصل بالكامل", "الرياضيات", "مفردة", "5"]),
  };
  const result = parseTimetableWorkbook(workbook, [
    { id: "t1", name: "أحمد خالد محمد السالمي", departmentId: "الرياضيات", departmentName: "الرياضيات" },
    { id: "t2", name: "سعيد عبدالله", departmentId: "العلوم", departmentName: "العلوم" },
  ]);
  if (result.teachers.length !== 2) throw new Error("Expected two imported teachers");
  const matchedTeacher = result.teachers.find((t) => t.matchedTeacherId === "t1");
  if (matchedTeacher?.records.length !== 3) {
    throw new Error("Expected all source records to remain attached to the matching teacher");
  }
  if (matchedTeacher.matchedDepartmentId !== "الرياضيات" || matchedTeacher.matchedDepartmentName !== "الرياضيات") {
    throw new Error("The matched teacher's department scope should be carried into the imported timetable");
  }
  if (result.hasWeeklyPlacements || result.placements.length !== 0) {
    throw new Error("Weekly placements must not be inferred from weekly lesson counts");
  }
  if (!result.referenceData["الفصول"] || !result.referenceData["المواد"]) {
    throw new Error("Reference sheets should be retained");
  }
  const rawTeacher = result.referenceData["المعلمون"]?.[0]?.values;
  if (!rawTeacher || rawTeacher["MWD (1)"] !== "-" || rawTeacher["التفريغ"] !== "الأحد: 1, 4-6") {
    throw new Error("Teacher scheduling constraints must be preserved exactly as imported");
  }
  if (result.teachers.find((t) => t.matchedTeacherId === "t1")?.records[0]?.periodsPerWeek !== 5) {
    throw new Error("Weekly lesson count should be parsed without inferring a weekday/period placement");
  }
});

Deno.test("detects actual weekday and period fields only when both exist", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": rows(["الإسم", "الإختصار"], ["معلم تجريبي", "تجريبي"]),
    "الحصص": rows(
      ["المعلم", "الشعب", "المادة", "اليوم", "رقم الحصة", "الحصص/الأسبوع"],
      ["معلم تجريبي", "صف 1", "رياضيات", "الأحد", "3", "1"],
    ),
  });
  if (!result.hasWeeklyPlacements || result.placements.length !== 1) {
    throw new Error("A row with explicit weekday and period should be treated as a placement");
  }
  if (result.placements[0].weekday !== "الأحد" || result.placements[0].period !== 3) {
    throw new Error("Placement coordinates were not parsed correctly");
  }
});

Deno.test("keeps unmatched teacher records visible for manual review", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": rows(["الإسم", "الإختصار"], ["اسم غير موجود بالنظام", "غير معروف"]),
    "الحصص": rows(
      ["المعلم", "الشعب", "المادة", "الحصص/الأسبوع"],
      ["اسم غير موجود بالنظام", "صف 2", "علوم", "2"],
    ),
  }, [{ id: "t1", name: "معلم آخر" }]);
  if (!result.unmatchedTeacherNames.includes("اسم غير موجود بالنظام")) {
    throw new Error("Unmatched names should be reported");
  }
  const unmatchedTeacher = result.teachers.find((teacher) => teacher.sourceName === "اسم غير موجود بالنظام");
  if (!unmatchedTeacher || unmatchedTeacher.matchStatus !== "unmatched" || unmatchedTeacher.records.length !== 1) {
    throw new Error("Unmatched teacher and its lesson should remain visible together for manual review");
  }
});


Deno.test("does not silently assign a shared short-name alias to the wrong teacher", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": rows(
      ["الإسم", "الإختصار"],
      ["سعيد أحمد", "سعيد"],
      ["سعيد علي", "سعيد"],
    ),
    "الحصص": rows(
      ["المعلم", "الشعب", "المادة", "الحصص/الأسبوع"],
      ["سعيد", "صف 3", "علوم", "2"],
    ),
  }, [
    { id: "t1", name: "سعيد أحمد" },
    { id: "t2", name: "سعيد علي" },
  ]);
  if (!result.ambiguousTeacherNames.includes("سعيد")) {
    throw new Error("Shared aliases should be reported as ambiguous");
  }
  if (result.unassignedRecords.length !== 1 || result.unassignedRecords[0].teacherMatchStatus !== "ambiguous") {
    throw new Error("Ambiguous records must remain unassigned for administrator review");
  }
});


Deno.test("prefers exact full teacher name over another teacher matching a short alias", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": rows(
      ["الإسم", "الإختصار"],
      ["أحمد خالد", "سعيد"],
    ),
    "الحصص": rows(
      ["المعلم", "الشعب", "المادة", "الحصص/الأسبوع"],
      ["أحمد خالد", "صف 4", "رياضيات", "3"],
    ),
  }, [
    { id: "t1", name: "أحمد خالد" },
    { id: "t2", name: "سعيد" },
  ]);
  const imported = result.teachers.find((teacher) => teacher.sourceName === "أحمد خالد");
  if (!imported || imported.matchStatus !== "matched" || imported.matchedTeacherId !== "t1") {
    throw new Error("Exact full-name match should take precedence over a short-alias collision");
  }
});

Deno.test("matches detailed names to abbreviated system names without confusing duplicate aliases", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": rows(
      ["الإسم", "الإختصار"],
      ["محمد جمعة ناصر السعدي", "محمد السعدي"],
      ["محمد عبدالله حمود السعدي", "محمد السعدي"],
      ["كردي ربيع بكري حسين", "كردي حسين"],
      ["عاطف محمد محمد إمام", "عاطف إمام"],
      ["اسم غير معروف", "اسم غير معروف"],
    ),
    "الحصص": rows(
      ["المعلم", "الشعب", "المادة", "الحصص/الأسبوع"],
      ["محمد جمعة ناصر السعدي", "صف 1", "عربي", "2"],
      ["محمد عبدالله حمود السعدي", "صف 2", "رياضيات", "2"],
      ["كردي ربيع بكري حسين", "صف 3", "علوم", "2"],
      ["عاطف محمد محمد إمام", "صف 4", "حصة دينية", "2"],
      ["اسم غير معروف", "صف 5", "إنجليزي", "2"],
    ),
  }, [
    { id: "t1", name: "محمد جمعة الساعدي" },
    { id: "t2", name: "محمد عبدالله السعدي" },
    { id: "t3", name: "كردي ربيع" },
    { id: "t4", name: "عاطف محمد" },
  ]);

  const bySource = new Map(result.teachers.map((teacher) => [teacher.sourceName, teacher]));
  if (bySource.get("محمد جمعة ناصر السعدي")?.matchedTeacherId !== "t1") {
    throw new Error("The first detailed محمد السعدي record should map to the matching short system name");
  }
  if (bySource.get("محمد عبدالله حمود السعدي")?.matchedTeacherId !== "t2") {
    throw new Error("The detailed عبدالله token should disambiguate محمد عبدالله السعدي");
  }
  if (bySource.get("كردي ربيع بكري حسين")?.matchedTeacherId !== "t3") {
    throw new Error("A detailed full name should match a system first+middle-name abbreviation");
  }
  if (bySource.get("عاطف محمد محمد إمام")?.matchedTeacherId !== "t4") {
    throw new Error("A detailed full name should match a system first+middle-name abbreviation");
  }
  if (bySource.get("اسم غير معروف")?.matchStatus !== "unmatched") {
    throw new Error("Unknown identities must remain unlinked");
  }
  const religiousLesson = bySource.get("عاطف محمد محمد إمام")?.records[0];
  if (religiousLesson?.subject !== "تربية إسلامية") {
    throw new Error("The religious lesson label should be normalized to the approved subject name");
  }
  if (bySource.get("محمد جمعة ناصر السعدي")?.records[0]?.subject !== "اللغة العربية") {
    throw new Error("Arabic subject shorthand should be normalized");
  }
  if (bySource.get("محمد عبدالله حمود السعدي")?.records[0]?.subject !== "الرياضيات") {
    throw new Error("Mathematics subject shorthand should be normalized");
  }
  if (bySource.get("اسم غير معروف")?.records[0]?.subject !== "اللغة الإنجليزية") {
    throw new Error("English subject shorthand should be normalized");
  }
});

Deno.test("uses the school's confirmed teacher identity mappings without collapsing duplicate short aliases", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": rows(
      ["الإسم", "الإختصار"],
      ["س فيزياء", "س فيزياء"],
      ["محمد جمعة ناصر السعدي", "محمد السعدي"],
      ["محمد عبدالله حمود السعدي", "محمد السعدي"],
    ),
    "الحصص": rows(
      ["المعلم", "الشعب", "المادة", "الحصص/الأسبوع"],
      ["س فيزياء", "صف 6", "فيزياء", "2"],
      ["محمد جمعة ناصر السعدي", "صف 7", "عربي", "2"],
      ["محمد عبدالله حمود السعدي", "صف 8", "مهارات حياتية", "2"],
      ["محمد السعدي", "صف 9", "عربي", "1"],
    ),
  }, [
    { id: "physics", name: "محمد البشير", departmentId: "الفيزياء", departmentName: "الفيزياء" },
    { id: "arabic", name: "محمد جمعة الساعدي", departmentId: "اللغة العربية", departmentName: "اللغة العربية" },
    { id: "life-skills", name: "محمد عبدالله الساعدي", departmentId: "مواد المهارات الحياتية", departmentName: "مواد المهارات الحياتية" },
  ]);

  const bySource = new Map(result.teachers.map((teacher) => [teacher.sourceName, teacher]));
  if (bySource.get("س فيزياء")?.matchedTeacherId !== "physics") {
    throw new Error("The confirmed physics placeholder must map to the existing محمد البشير account");
  }
  if (bySource.get("محمد جمعة ناصر السعدي")?.matchedTeacherId !== "arabic") {
    throw new Error("محمد جمعة ناصر السعدي must map to the Arabic teacher محمد جمعة الساعدي");
  }
  if (bySource.get("محمد عبدالله حمود السعدي")?.matchedTeacherId !== "life-skills") {
    throw new Error("محمد عبدالله حمود الساعدي must map to the life-skills teacher محمد عبدالله الساعدي");
  }
  if (!result.ambiguousTeacherNames.includes("محمد السعدي")) {
    throw new Error("The shared short alias محمد السعدي must remain ambiguous when used alone");
  }
  if (!result.unassignedRecords.some((record) => record.teacherSourceName === "محمد السعدي" && record.teacherMatchStatus === "ambiguous")) {
    throw new Error("A lesson with only the shared short alias must remain unassigned");
  }
});
