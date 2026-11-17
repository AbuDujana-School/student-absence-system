import { buildDutyReportContext } from "../duty_report_context.ts";

function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + ": expected " + JSON.stringify(expected) + ", received " + JSON.stringify(actual));
  }
}

const cells = [
  { id: "cell-english", weekday: "الثلاثاء", period: 7, cell_status: "teaching", class_sections: ["7/12"], subject: "لغة انجليزية", matched_teacher_name: "مجيد العجمي" },
  { id: "cell-arabic", weekday: "الثلاثاء", period: 7, cell_status: "teaching", class_sections: ["8/12"], subject: "لغة عربية", matched_teacher_name: "أحمد سالم" },
];
const assignments = [
  { assignment_type: "substitution", status: "assigned", source_cell_id: "cell-english", class_sections: ["7/12"], absent_teacher_name: "مجيد العجمي", teacher_name: "سالم الغاربي" },
  { assignment_type: "substitution", status: "assigned", source_cell_id: "cell-english", class_sections: ["8/12"], absent_teacher_name: "مجيد العجمي", teacher_name: "بديل صف آخر" },
  { assignment_type: "substitution", status: "cancelled", source_cell_id: "cell-arabic", class_sections: ["8/12"], absent_teacher_name: "أحمد سالم", teacher_name: "بديل ملغى" },
  { assignment_type: "duty", status: "assigned", source_cell_id: "cell-arabic", class_sections: ["8/12"], absent_teacher_name: "أحمد سالم", teacher_name: "مناوب" },
];

Deno.test("duty context maps teacher, subject and substitute to the exact class lesson", () => {
  const result = buildDutyReportContext(["7/12", "8/12"], cells, assignments);
  equal(result[0], {
    className: "7/12",
    lessons: [{ teacherName: "مجيد العجمي", subject: "لغة انجليزية", substituteNames: ["سالم الغاربي"] }],
  }, "Class 7/12 should show only its own lesson and assigned substitute");
  equal(result[1], {
    className: "8/12",
    lessons: [{ teacherName: "أحمد سالم", subject: "لغة عربية", substituteNames: [] }],
  }, "Cancelled and non-substitution assignments must not appear");
});

Deno.test("Arabic class digits resolve consistently", () => {
  const result = buildDutyReportContext(["٧/١٢"], cells, assignments);
  equal(result[0].lessons[0].teacherName, "مجيد العجمي", "Arabic digits should match the timetable class");
});

Deno.test("a substitute with no class sections is accepted only through the exact source cell", () => {
  const result = buildDutyReportContext(["7/12"], cells, [
    { assignment_type: "substitution", status: "confirmed", source_cell_id: "cell-english", class_sections: [], absent_teacher_name: "مجيد العجمي", teacher_name: "بديل المصدر" },
    { assignment_type: "substitution", status: "confirmed", source_cell_id: "", class_sections: [], absent_teacher_name: "مجيد العجمي", teacher_name: "بديل غير مرتبط" },
  ]);
  equal(result[0].lessons[0].substituteNames, ["بديل المصدر"], "An empty assignment class list needs an exact source-cell link");
});

Deno.test("classes without a timetable lesson do not inherit another class teacher", () => {
  const result = buildDutyReportContext(["9/12"], cells, assignments);
  equal(result[0].lessons, [], "No unrelated class lesson should leak into this class");
});
