const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const reserveWorkflow = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function section(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Missing source section: ${startMarker}`);
  return html.slice(start, end);
}

Deno.test("supporting-department refresh preserves valid selections across all selected departments", () => {
  const load = section("async function timetableLoadOtherDepartmentOptions(", "function timetableGetOtherDepartmentTeacherNames()");
  assert(load.includes("select.multiple?Array.from(select.selectedOptions||[]).map(o=>String(o.value||\"\"))"), "The loader must capture every selected department");
  assert(load.includes("const selectedIds=select.multiple?previousIds:(previous?[previous]:[]);"), "The loader must preserve multi-select department IDs");
  assert(load.includes("departments.filter(item=>selectedIds.includes(String(item.id)))"), "Eligible teachers must be derived from every selected department");
  assert(load.includes("window.substitutionSelectedOtherTeacherNames=new Set([...previousNames].filter(name=>allowedNames.has(name)))"), "Only teachers still eligible in the selected departments may survive a refresh");
  assert(load.includes("if(select.multiple){Array.from(select.options).forEach(o=>o.selected=previousIds.includes(String(o.value)));}"), "The selected departments must be restored after options refresh");
  assert(load.includes('checkbox.type==="checkbox"?checkbox.checked===true:true'), "The legacy toggle and the new multi-select must both remain supported");
});

Deno.test("distribution reads canonical selected-teacher state scoped to all selected departments", () => {
  const getter = section("function getSubstitutionSelectedOtherTeacherNames()", "async function timetableToggleOtherDepartments(");
  assert(getter.includes("window.substitutionSelectedOtherTeacherNames"), "The selected teacher Set must remain the source of truth");
  assert(getter.includes("substitutionOtherDepartmentIds()"), "The getter must resolve all selected departments");
  assert(getter.includes("ids.has(String(d.id))"), "The allowed teacher set must include only selected departments");
  assert(getter.includes("filter(n=>allowed.has(n))"), "Only eligible selected teachers may be sent to distribution");
  assert(getter.includes("if(box.checked)selected.add(n);else selected.delete(n)"), "Current rendered checkboxes must update the canonical Set in both directions");
});

Deno.test("changing selected supporting departments rerenders teachers and removes ineligible selections", () => {
  const render = section("function renderSubstitutionOtherTeacherChoices()", "function getSubstitutionSelectedOtherTeacherNames()");
  const controls = section("function bindOtherDepartmentControls()", "window.openSubstitutionView");
  assert(render.includes("const ids=substitutionOtherDepartmentIds()"), "The picker must read the complete selected department list");
  assert(render.includes("ids.map(id=>window.substitutionOtherDepartmentsData.find"), "Teacher choices must be built from all selected departments");
  assert(render.includes("filter(n=>allowed.has(n))"), "Teachers no longer eligible in selected departments must be removed");
  assert(render.includes("host.dataset.departmentIds=ids.join(\",\")"), "Rendered controls must be tagged with the exact selected department set");
  assert(controls.includes("renderSubstitutionOtherTeacherChoices()"), "Changing departments must refresh the teacher choices");
  assert(controls.includes("substitutionOtherDepartmentIds().length"), "The UI must recognize one or more selected departments");
});

Deno.test("stale checkbox DOM cannot override selections for a different department set", () => {
  const getter = section("function getSubstitutionSelectedOtherTeacherNames()", "async function timetableToggleOtherDepartments(");
  assert(getter.includes("host.dataset.departmentIds===Array.from(ids).join(\",\")"), "Checkboxes may be read only when rendered for the current selected department set");
  assert(getter.includes("window.substitutionSelectedOtherTeacherNames=selected"), "The reconciled selection must be written back to canonical state");
  assert(getter.includes("return [...selected]"), "The getter must return the reconciled canonical selection");
});

Deno.test("renderPlan initializes unassigned rows before composing the empty-plan message", () => {
  const render = section("  function renderPlan(){", "\n  window.substitutionSavePlan");
  const declaration = render.indexOf("const unassignedRows=Array.isArray(currentPlan.unassigned)?currentPlan.unassigned:[];");
  const firstUse = render.indexOf("const noPlanMessage=unassignedRows.length");
  assert(declaration >= 0 && firstUse >= 0 && declaration < firstUse,
    "unassignedRows must be initialized before noPlanMessage reads its length");
  assert(render.indexOf("const unassignedRows=", declaration + 1) === -1,
    "renderPlan must declare unassignedRows only once");
});


Deno.test("reserve review renders isolated absent-teacher and period cards with the top five ranked candidates", () => {
  const render = section("  function renderPlan(){", "\n  window.substitutionSavePlan");
  assert(render.includes("subx-review-absent-head"), "Each absent teacher must have a distinct dark summary header");
  assert(render.includes("subx-review-period-pill"), "Each lesson must have its own clearly visible period card");
  assert(render.includes("const visibleOptions=candidates.slice(0,5);"), "Only the first five server-ranked eligible candidates should appear in the initial card");
  assert(render.includes("reserveCandidateBusyText(option)"), "Candidate cards must display occupied periods supplied by the server");
  assert(render.includes("new Intl.NumberFormat('en-US')"), "Displayed period numbers must use English digits");
  assert(render.includes("currentPlan.existingAssignments"), "The absent-teacher period summary must account for saved assignments");
  assert(render.includes("unassignedRows"), "The absent-teacher period summary must account for uncovered lessons");
  assert(!render.includes("السبب:"), "Absence reasons must not crowd the review card header or existing-assignment summary");
});

Deno.test("selecting a candidate collapses only that lesson and keeps the official save actions pending", () => {
  const select = section("function selectSubstitutionPlanCandidate(", "\n  function reopenSubstitutionCandidateOptions(");
  assert(select.includes("item.candidateOptions||[]"), "A selectable substitute must come from the server-provided eligible candidates");
  assert(select.includes("item.substituteTeacherName=selected.teacherName"), "The selected substitute must update the existing plan payload");
  assert(select.includes("expandedPlanRows.delete(rowIndex)"), "Selecting a substitute must collapse that lesson");
  assert(select.includes("pdf.disabled=true") && select.includes("wa.disabled=true"), "PDF and WhatsApp remain disabled until the changed plan is saved");
  const reopen = section("function reopenSubstitutionCandidateOptions(", "\n  function renderSubstitutionCandidateSearchResults(");
  assert(reopen.includes("expandedPlanRows.add(rowIndex)"), "The Change action must reopen the same lesson options");
});

Deno.test("additional teacher search stays within the remaining server-ranked eligible candidates", () => {
  const search = section("function renderSubstitutionCandidateSearchResults()", "\n  function openSubstitutionCandidateSearch(");
  assert(search.includes("(item.candidateOptions||[]).slice(5)"), "The search modal must show candidates after the first five");
  assert(search.includes("reserveCandidateBusyText(option)"), "The search results must show each candidate's occupied periods");
  assert(search.includes("toLocaleLowerCase('ar')"), "The additional-candidate list must support Arabic name search");
  const open = section("function openSubstitutionCandidateSearch(", "\n  window.subxCloseCandidateSearch=");
  assert(open.includes("candidateSearchRowIndex=rowIndex"), "The search modal must retain the targeted lesson");
  assert(open.includes("الحصة "), "The search modal must identify the exact period being edited");
});

Deno.test("review redesign preserves the existing atomic save, WhatsApp, and official A4 print pipelines", () => {
  const save = section("window.substitutionSavePlan=async function(){", "\n  function buildShareMessage(){");
  const share = section("window.substitutionShareWhatsapp=function(){", "\n  window.substitutionPrintPdf=function(){");
  const print = section("window.substitutionPrintPdf=function(){", "\n  window.substitutionLoadStats=async function(){");
  assert(save.includes("timetable_substitution_batch_save"), "Approval must continue through the existing atomic server action");
  assert(share.includes("buildShareMessage()"), "WhatsApp must use the existing current-plan message builder");
  assert(print.includes("window.printOfficialReserveReport(orderedGroups,selectedDate(),weekdayFor(selectedDate()));"), "PDF must continue through the official reserve report template");
});

Deno.test("department options use a softer modern glass treatment and the smart action is a responsive circle", () => {
  assert(reserveWorkflow.includes("subxReservePolishedChoiceStyles"), "The dedicated polished choice styles must be installed once");
  assert(reserveWorkflow.includes("background:linear-gradient(145deg,rgba(255,255,255,.97),rgba(242,248,250,.94))"), "The main choices must use soft glass surfaces instead of saturated gradients");
  assert(reserveWorkflow.includes("border-radius:50%!important"), "The smart distribution action must remain circular");
  assert(reserveWorkflow.includes("clamp(116px,35vw,146px)"), "The circular action must scale with the phone viewport");
  assert(reserveWorkflow.includes("subx-smart-generate-label"), "The smart action must carry its own clear Arabic label");
});

Deno.test("WhatsApp uses the requested department/date/absent-teacher/lesson message layout", () => {
  const share = section("function buildShareMessage(){", "\n  window.substitutionShareWhatsapp=function(){");
  assert(share.includes("data-reserve-department-title"), "The department title must be read dynamically from the active school department");
  assert(share.includes("✨ *كـشـف تـوزيـع حـصـص الاحـتـيـاط* ✨"), "The share must use the approved report title");
  assert(share.includes('message+="📚 *المادة:* "+tick+department+tick+"\\n";'), "The selected department must be shown as the subject");
  assert(share.includes('message+="🗓️ *التاريخ:* *"+weekday+"، "+formattedDate+"*\\n\\n";'), "The Arabic weekday and date must be shown in bold");
  assert(share.includes('message+="👤 *"+formatArabicDigits(index+1)+". المعلم الغائب:* "+tick+group.name+tick+"\\n\\n";'), "Each absent teacher must be numbered in Arabic and shown in inline code");
  assert(share.includes('message+="🔹 *الحصة "+periodLabel+"* | الصف "+tick+String(row.className||\'غير محدد\')+tick+"\\n";'), "Each lesson must use the requested bullet and class formatting");
  assert(share.includes('message+="   ↳ *الاحتياط:* *"+String(row.substitute||\'لم يحدد\')+"*\\n\\n";'), "Each substitute must appear bold on its own indented line");
  assert(share.includes("formatArabicDigits(new Intl.NumberFormat('en-US'"), "Period digits must be converted to Arabic digits");
  assert(share.includes("🙏 *شكرًا لتعاونكم وحرصكم الدائم، ونتمنى لكم يومًا دراسيًا موفقًا ومثمرًا.* 🌟"), "The requested closing line must be included");
  assert(!share.includes("*توزيع حصص الاحتياط*") && !share.includes("- الحصة *"), "The previous compact message layout must not return");
  assert(!share.includes("dailyTeachingCount"), "The WhatsApp message must not append teaching-load details");
  assert(!share.includes("إدارة المدرسة"), "The WhatsApp message must not append the old closing line");
});


Deno.test("substitution candidates expose transparent cumulative score and workload reasons",()=>{
  const renderStart=reserveWorkflow.indexOf("window.timetableDailyRenderLessons = function () {");
  const renderEnd=reserveWorkflow.indexOf('host.querySelectorAll("[data-tt-approve]")',renderStart);
  assert(renderStart>=0&&renderEnd>renderStart,"Reserve lesson renderer must exist");
  const render=reserveWorkflow.slice(renderStart,renderEnd);
  assert(render.includes("شفافية ترتيب المرشحين"),"Every ranked candidate must have an expandable transparency card");
  assert(render.includes("candidate.candidateScore"),"Candidate priority score must be displayed");
  assert(render.includes("candidate.pointsBalance"),"Cumulative effort balance must be displayed");
  assert(render.includes("candidate.dailyTeachingCount"),"Daily teaching load must be displayed");
  assert(render.includes("candidate.streakStatus"),"Consecutive-period status must be displayed");
  assert(render.includes("candidate.reasons"),"The reason for the candidate ranking must be displayed");
});

Deno.test("manual candidate changes re-run the batch planner and preserve manual choices",()=>{
  const previewStart=reserveWorkflow.indexOf("async function fetchBatchPreview()");
  const previewEnd=reserveWorkflow.indexOf("window.timetableDailySetBusy = function",previewStart);
  const preview=reserveWorkflow.slice(previewStart,previewEnd);
  assert(preview.includes("manualAssignments: reserveManualChoices"),"Manual choices must be sent to the server-side batch planner");
  const selectStart=reserveWorkflow.indexOf('host.querySelectorAll("[data-tt-substitute]")');
  const selectEnd=reserveWorkflow.indexOf('host.querySelectorAll("[data-tt-approve]")',selectStart);
  const select=reserveWorkflow.slice(selectStart,selectEnd);
  assert(select.includes("window.timetableDailyRefreshAll()"),"A manual choice must refresh the remaining virtual allocations");
});
