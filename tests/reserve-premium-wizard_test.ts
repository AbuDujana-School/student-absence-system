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
  assert(reserveWorkflow.includes("Array.isArray(timetableDailyAbsentTeachers)&&timetableDailyAbsentTeachers.length>0"), "The stepper must read the live shared absentee selection state");
  assert(reserveWorkflow.includes("tt-premium-step-icon"), "The wizard must use prominent step icons");
  assert(reserveWorkflow.includes("installPremiumReserveExperience(panel)"), "The premium workflow must be installed on the live reserve panel");
});

Deno.test("visible canonical date navigation defaults to Muscat today and provides yesterday/today/tomorrow shortcuts", () => {
  assert(reserveWorkflow.includes('const distributionDate=$("substitutionDate");'), "Quick navigation must attach to the visible canonical date picker");
  assert(reserveWorkflow.includes('nav.id="subxCanonicalDateQuickNav"'), "The visible date card must include its own quick navigation");
  assert(reserveWorkflow.includes('data-date-offset="-1"'), "Yesterday shortcut is missing");
  assert(reserveWorkflow.includes('data-date-offset="0"'), "Today shortcut is missing");
  assert(reserveWorkflow.includes('data-date-offset="1"'), "Tomorrow shortcut is missing");
  assert(reserveWorkflow.includes('getOmanLocalDate==="function"?getOmanLocalDate()'), "Quick navigation must use the Muscat-local date supplied by the app");
  assert(reserveWorkflow.includes('if(!date.value)date.value=today;'), "The visible date must default to Muscat today only when empty");
  assert(reserveWorkflow.includes('distributionDate.dispatchEvent(new Event("change",{bubbles:true}))'), "Changing the visible date must refresh the existing date-driven workflow");
});

Deno.test("supporting teachers can be selected from multiple departments", () => {
  assert(reserveWorkflow.includes('multiple class="hidden"'), "The department ID control must preserve multiple selections behind the visual picker");
  assert(reserveWorkflow.includes("timetableDailyOtherDepartmentChoices"), "Departments must be shown as visible selectable cards");
  assert(reserveWorkflow.includes("selectedOtherDepartmentIds"), "The UI must track the selected department set");
  assert(reserveWorkflow.includes("otherDepartmentIds:selectedOtherDepartmentIds()"), "Preview and save payloads must include all selected departments");
  const batchPreviewStart = reserveWorkflow.indexOf("async function fetchBatchPreview()");
  const batchPreviewEnd = reserveWorkflow.indexOf("window.timetableDailySetBusy", batchPreviewStart);
  const batchPreview = reserveWorkflow.slice(batchPreviewStart, batchPreviewEnd);
  assert(batchPreview.includes("otherDepartmentIds:selectedOtherDepartmentIds()"), "Batch preview must send every selected supporting department to the server");
  assert(reserveWorkflow.includes("reserveOtherDepartments.filter(item=>selectedIds.includes(String(item.id)))"), "Teacher cards must be rendered for every selected department");
  assert(reserveWorkflow.includes("data-select-all-department"), "Each department must provide a select-all control");
  assert(reserveWorkflow.includes("data-clear-department"), "Each department must provide a clear-all control");
  assert(reserveWorkflow.includes("data-other-teacher-name"), "Individual supporting teachers must remain selectable");
  assert(reserveWorkflow.includes("reserveOtherDepartmentIds"), "Multiple department selections must survive draft persistence");
});

Deno.test("server validates each supporting teacher against the explicitly selected departments", () => {
  assert(timetableEndpoint.includes("const otherDepartmentIds=Array.isArray(body.otherDepartmentIds)"), "The endpoint must accept the selected department ID array");
  assert(timetableEndpoint.includes("otherDepartmentIds.includes(String(teacher.departmentId||\"\")"), "Each external teacher must belong to one of the selected departments");
  assert(timetableEndpoint.includes("otherDepartmentIds.includes(String(substituteTeacher.departmentId||\"\")"), "Single and batch saves must validate the selected supporting teacher");
  assert(timetableEndpoint.includes("(includeOtherDepartments&&otherDepartmentIds.includes(String(teacher.departmentId||\"\")"), "The smart candidate pool must include only explicitly selected external teachers");
});

Deno.test("the primary reserve route displays the authenticated coordinator department dynamically", () => {
  assert(reserveWorkflow.includes("result.actorDepartmentName"), "The reserve screen must read the department returned for the authenticated actor");
  assert(reserveWorkflow.includes("التوزيع لمعلمي قسم "), "The primary route title must include the resolved department name");
  assert(reserveWorkflow.includes("try{await loadOtherDepartments();}catch{}"), "The authenticated department must load on explicit entry to the primary reserve route");
  assert(timetableEndpoint.includes("actorDepartmentName:principal.type===\"admin\"?\"\":String(actor?.departmentName||\"\").trim()"), "The endpoint must derive the department from the authenticated teacher directory record");
});

Deno.test("the custom absence reason may be left empty", () => {
  assert(reserveWorkflow.includes('choice==="أخرى"?(custom?"أخرى: "+custom:"أخرى"):choice'), "Selecting أخرى without text must remain valid");
  assert(reserveWorkflow.includes('const ABSENCE_REASON_OPTIONS=["طارئة","موعد مستشفى","مرضية","أخرى","دورة تدريبية"]'), "Requested reasons must appear first while preserving the existing training option");
});
