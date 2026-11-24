const reserveWorkflow = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));
const timetableEndpoint = await Deno.readTextFile(new URL("../supabase/functions/timetable-management/index.ts", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve workspace presents a premium four-step date-first flow", () => {
  for (const step of ["1", "2", "3", "4"]) {
    assert(reserveWorkflow.includes('data-premium-step="' + step + '"'), "Missing reserve wizard step " + step);
  }
  assert(reserveWorkflow.includes("ttPremiumDateCard"), "The date must have its own first-step card");
  assert(reserveWorkflow.includes("ttPremiumAbsentCard"), "Absentee selection must be a separate progressive step");
  assert(reserveWorkflow.includes("absentCard.hidden=!hasDate"), "Absentee selection must remain hidden until a date is selected");
  assert(reserveWorkflow.includes("tt-premium-step-icon"), "The wizard must use prominent step icons");
  assert(reserveWorkflow.includes("installPremiumReserveExperience(panel)"), "The premium workflow must be installed on the live reserve panel");
});

Deno.test("supporting teachers can be selected from multiple departments", () => {
  assert(reserveWorkflow.includes('multiple size="5"'), "The department selector must allow multiple selections");
  assert(reserveWorkflow.includes("selectedOtherDepartmentIds"), "The UI must track the selected department set");
  assert(reserveWorkflow.includes("otherDepartmentIds:selectedOtherDepartmentIds()"), "Preview and save payloads must include all selected departments");
  assert(reserveWorkflow.includes("departments.flatMap"), "Teacher choices must combine the selected departments");
  assert(reserveWorkflow.includes("reserveOtherDepartmentIds"), "Multiple department selections must survive draft persistence");
});

Deno.test("server validates each supporting teacher against the explicitly selected departments", () => {
  assert(timetableEndpoint.includes("const otherDepartmentIds=Array.isArray(body.otherDepartmentIds)"), "The endpoint must accept the selected department ID array");
  assert(timetableEndpoint.includes("otherDepartmentIds.includes(String(teacher.departmentId||\"\")"), "Each external teacher must belong to one of the selected departments");
  assert(timetableEndpoint.includes("otherDepartmentIds.includes(String(substituteTeacher.departmentId||\"\")"), "Single and batch saves must validate the selected supporting teacher");
  assert(timetableEndpoint.includes("(includeOtherDepartments&&otherDepartmentIds.includes(String(teacher.departmentId||\"\")"), "The smart candidate pool must include only explicitly selected external teachers");
});

Deno.test("the custom absence reason may be left empty", () => {
  assert(reserveWorkflow.includes('choice==="أخرى"?(custom?"أخرى: "+custom:"أخرى"):choice'), "Selecting أخرى without text must remain valid");
  assert(reserveWorkflow.includes('const ABSENCE_REASON_OPTIONS=["طارئة","موعد مستشفى","مرضية","أخرى"]'), "Absence reasons must follow the requested order");
});
