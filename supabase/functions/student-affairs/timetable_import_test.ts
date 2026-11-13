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
      [null, "الإسم", "الإختصار", "مدرس الفصل"],
      [null, "أحمد خالد محمد السالمي", "أحمد السالمي", ""],
      [null, "سعيد عبدالله", "سعيد", ""],
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
    { id: "t1", name: "أحمد خالد محمد السالمي" },
    { id: "t2", name: "سعيد عبدالله" },
  ]);
  if (result.teachers.length !== 2) throw new Error("Expected two imported teachers");
  if (result.teachers.find((t) => t.matchedTeacherId === "t1")?.records.length !== 3) {
    throw new Error("Expected all source records to remain attached to the matching teacher");
  }
  if (result.hasWeeklyPlacements || result.placements.length !== 0) {
    throw new Error("Weekly placements must not be inferred from weekly lesson counts");
  }
  if (!result.referenceData["الفصول"] || !result.referenceData["المواد"]) {
    throw new Error("Reference sheets should be retained");
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
  if (result.unassignedRecords.length !== 1) {
    throw new Error("Unmatched teacher lesson record should remain in the unassigned list");
  }
});
