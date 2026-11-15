import { parseTimetableWorkbook } from "../timetable_import.ts";

Deno.test("workbook import preserves explicit teaching placement and matches an exact teacher", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": [
      ["الاسم", "الاختصار", "التفريغ"],
      ["أحمد خالد محمد السالمي", "أحمد السالمي", ""],
    ],
    "الحصص": [
      ["المعلم", "الشعبة", "المادة", "اليوم", "الحصة"],
      ["أحمد خالد محمد السالمي", "1/12", "رياضيات", "الأحد", 1],
    ],
  }, [{ name: "أحمد خالد محمد السالمي", departmentId: "math" }]);

  if (result.teachers.length !== 1) throw new Error("Expected one imported teacher");
  if (result.teachers[0].matchStatus !== "matched") throw new Error("Exact teacher match was not retained");
  if (result.placements.length !== 1 || result.placements[0].period !== 1) {
    throw new Error("Explicit weekly placement was not parsed");
  }
  if (result.placements[0].subject !== "الرياضيات") throw new Error("Subject normalization changed");
});

Deno.test("workbook import does not invent placements from weekly totals or teacher notes", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": [
      ["الاسم", "الاختصار", "التفريغ"],
      ["معلم تجريبي", "م ت", "الأحد: 1-2"],
    ],
    "الحصص": [
      ["المعلم", "الشعبة", "المادة", "الحصص/الأسبوع"],
      ["معلم تجريبي", "1/12", "الرياضيات", 4],
    ],
  }, [{ name: "معلم تجريبي", departmentId: "math" }]);

  if (result.hasWeeklyPlacements || result.placements.length !== 0) {
    throw new Error("The parser inferred placements from non-placement data");
  }
  if (result.teachers[0].teacherPeriodNotes.length !== 2) {
    throw new Error("Teacher period notes were not preserved as unconfirmed notes");
  }
});


Deno.test("workbook import normalizes Arabic and English weekday labels", () => {
  const result = parseTimetableWorkbook({
    "المعلمون": [
      ["الاسم", "الاختصار", "التفريغ"],
      ["معلم تجريبي", "م ت", ""],
    ],
    "الحصص": [
      ["المعلم", "الشعبة", "المادة", "اليوم", "الحصة"],
      ["معلم تجريبي", "11/1", "الرياضيات", "الاحد", 1],
      ["معلم تجريبي", "11/1", "العلوم", "Wednesday", 2],
    ],
  }, [{ name: "معلم تجريبي", departmentId: "science" }]);
  if (result.placements.length !== 2) throw new Error("Weekday variants must remain explicit placements");
  if (result.placements[0].weekday !== "الأحد") throw new Error("Arabic weekday spelling was not normalized");
  if (result.placements[1].weekday !== "الأربعاء") throw new Error("English weekday was not normalized");
});
