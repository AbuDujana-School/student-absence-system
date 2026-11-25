const reserveWorkflow = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));
const timetableEndpoint = await Deno.readTextFile(new URL("../supabase/functions/timetable-management/index.ts", import.meta.url));
const timetableSessionAuth = await Deno.readTextFile(new URL("../supabase/functions/timetable-management/session_auth.ts", import.meta.url));

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

Deno.test("supporting department cards automatically include all eligible teachers from every selected section", () => {
  assert(reserveWorkflow.includes('multiple class="hidden"'), "The department ID control must preserve multiple selections behind the visual picker");
  assert(reserveWorkflow.includes("timetableDailyOtherDepartmentChoices"), "Departments must be shown as visible selectable cards");
  assert(reserveWorkflow.includes("selectedOtherDepartmentIds"), "The UI must track the selected department set");
  assert(reserveWorkflow.includes("otherDepartmentIds:selectedOtherDepartmentIds()"), "Preview and save payloads must include all selected departments");
  const batchPreviewStart = reserveWorkflow.indexOf("async function fetchBatchPreview()");
  const batchPreviewEnd = reserveWorkflow.indexOf("window.timetableDailySetBusy", batchPreviewStart);
  const batchPreview = reserveWorkflow.slice(batchPreviewStart, batchPreviewEnd);
  assert(batchPreview.includes("otherDepartmentIds:selectedOtherDepartmentIds()"), "Batch preview must send every selected supporting department to the server");
  assert(batchPreview.includes("otherTeacherNames:selectedOtherTeacherNames()"), "Batch preview must send all eligible teachers from the selected sections");
  assert(reserveWorkflow.includes("reserveOtherDepartments.filter(item=>selectedIds.has(String(item.id)))"), "The summary must be built from every selected department");
  assert(reserveWorkflow.includes("data-other-department-id"), "Each department must have a visible checkbox");
  assert(reserveWorkflow.includes("new Set(selectedOtherTeacherNames())"), "All eligible teachers must be selected automatically");
  assert(reserveWorkflow.includes("سيُدرجون تلقائيًا ضمن البدلاء"), "The user must be told all teachers will be included automatically");
  assert(!reserveWorkflow.includes("data-other-teacher-name"), "Individual teacher checkboxes must no longer be required");
  assert(!reserveWorkflow.includes("timetableDailyAddOtherTeachersButton"), "The separate manual-add button must be removed");
  assert(reserveWorkflow.includes("reserveOtherDepartmentIds"), "Multiple department selections must survive draft persistence");
});
Deno.test("local department name is dynamic and smart generation opens a separate proposals screen", () => {
  assert(reserveWorkflow.includes('id="ttReserveLocalDepartmentTitle"'), "The local section card must expose its dynamic title");
  assert(reserveWorkflow.includes("currentReserveActorDepartmentName()"), "The local card must read the authenticated user's department");
  assert(reserveWorkflow.includes('title.textContent="التوزيع لمعلمي "+label'), "The section name must appear in the local distribution card");
  assert(reserveWorkflow.includes("ttReserveProposalHeader"), "Smart proposals must have a dedicated next-screen heading");
  assert(reserveWorkflow.includes("ttReserveProposalBack"), "The proposals screen must provide a clear back action");
  assert(reserveWorkflow.includes("proposalScreenActive=true"), "Successful smart generation must switch to the proposal screen");
  assert(reserveWorkflow.includes("tt-reserve-proposal-mode"), "The proposal screen must hide setup cards while showing suggestions");
  assert(reserveWorkflow.includes("absentCard.insertAdjacentElement(\"afterend\",choiceGrid)"), "The two department cards must follow absent-teacher selection");
});

Deno.test("server validates each supporting teacher against the explicitly selected departments", () => {
  assert(timetableEndpoint.includes("const otherDepartmentIds=Array.isArray(body.otherDepartmentIds)"), "The endpoint must accept the selected department ID array");
  assert(timetableEndpoint.includes("otherDepartmentIds.includes(String(teacher.departmentId||\"\")"), "Each external teacher must belong to one of the selected departments");
  assert(timetableEndpoint.includes("otherDepartmentIds.includes(String(substituteTeacher.departmentId||\"\")"), "Single and batch saves must validate the selected supporting teacher");
  assert(timetableEndpoint.includes("(includeOtherDepartments&&otherDepartmentIds.includes(String(teacher.departmentId||\"\")"), "The smart candidate pool must include only explicitly selected external teachers");
});

Deno.test("the custom absence reason may be left empty", () => {
  assert(reserveWorkflow.includes('choice==="أخرى"?(custom?"أخرى: "+custom:"أخرى"):choice'), "Selecting أخرى without text must remain valid");
  assert(reserveWorkflow.includes('const ABSENCE_REASON_OPTIONS=["طارئة","موعد مستشفى","مرضية","أخرى","دورة تدريبية"]'), "Requested reasons must appear first while preserving the existing training option");
});

Deno.test("custom coordinators receive their own dynamic section name but no external department list", () => {
  assert(timetableSessionAuth.includes('"timetable_substitution_departments"'), "Custom coordinators must be allowed to request the scoped section label");
  assert(timetableEndpoint.includes('principal.type !== "admin" && principal.type !== "teacher" && principal.type !== "custom"'), "The department lookup must recognize custom coordinators");
  assert(timetableEndpoint.includes('if(principal.type==="custom")return reply(200,{ok:true,departments:[],actorDepartmentName});'), "Custom coordinators must receive only their own department name");
  assert(timetableEndpoint.includes('const actorDepartmentName=String(actor?.departmentName||"").trim();'), "The department label must come from the authenticated directory");
});
