const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function section(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Missing source section: ${startMarker}`);
  return html.slice(start, end);
}

Deno.test("supporting-department refresh preserves selected sections and derives every eligible teacher automatically", () => {
  const load = section("async function timetableLoadOtherDepartmentOptions(", "function timetableGetOtherDepartmentTeacherNames()");
  assert(load.includes("const previousIds=select.multiple?Array.from(select.selectedOptions||[]).map(o=>String(o.value||\"\")):[];"), "The loader must capture every selected department");
  assert(load.includes("const validIds=previousIds.filter(id=>departments.some(item=>String(item.id)===id));"), "The loader must preserve only valid selected department IDs");
  assert(load.includes("window.substitutionActorDepartmentName=String(response.actorDepartmentName||\"\").trim();"), "The current department name must come from the authenticated server response");
  assert(load.includes("window.substitutionSelectedOtherTeacherNames=new Set(departments.filter(item=>(window.substitutionSelectedOtherDepartmentIds||[]).includes(String(item.id))).flatMap"), "Every teacher in every selected department must be included automatically");
  assert(load.includes("select.multiple)Array.from(select.options).forEach(o=>o.selected=(window.substitutionSelectedOtherDepartmentIds||[]).includes(String(o.value)))"), "Selected department cards must remain synchronized with the hidden multi-select");
});

Deno.test("distribution automatically includes all eligible teachers from every selected department", () => {
  const getter = section("function getSubstitutionSelectedOtherTeacherNames()", "async function timetableToggleOtherDepartments(");
  assert(getter.includes("substitutionOtherDepartmentIds()"), "The getter must resolve all selected department IDs");
  assert(getter.includes("departments.filter(item=>ids.has(String(item.id)))"), "The getter must derive teachers from every selected department");
  assert(getter.includes("flatMap(item=>(item.teachers||[]).map(teacher=>String(teacher.name||\"\").trim())"), "All eligible teachers must be included without per-teacher checkboxes");
  assert(!getter.includes("data-other-department-teacher"), "Individual teacher selection must no longer be required");
});

Deno.test("supporting departments render as visual subject cards with large checkboxes", () => {
  const render = section("function renderSubstitutionOtherTeacherChoices()", "async function timetableToggleOtherDepartments(");
  assert(render.includes("subx-department-choice-grid"), "Supporting sections must render as a visual card grid");
  assert(render.includes("data-other-department-card"), "Each department card must have its own checkbox");
  assert(render.includes("substitutionDepartmentIcon(department.name)"), "Cards must show a subject-appropriate icon");
  assert(render.includes("سيُدرج جميع المعلمين تلقائيًا"), "The interface must explain automatic inclusion of every eligible teacher");
  assert(render.includes("option.selected=box.checked"), "Checking a card must update the selected department IDs");
  assert(render.includes("update();clearPlan();"), "Changing sections must invalidate a previous plan");
});

Deno.test("the absentee screen places the two department cards above smart generation", () => {
  const adapter=section("<script id=\"substitution-single-screen-adapter\">", "</script>");
  assert(adapter.includes("screens.absentees.append(deptWrap)"), "Supporting departments must be selected before opening the smart proposal screen");
  assert(adapter.includes("screens.absentees.append(generateButton)"), "The wide smart-distribution button must sit below the department cards");
  assert(adapter.includes("if(n==='absentees')loadReserveDepartmentCards()"), "The authenticated department name must load on the absentee screen");
  assert(adapter.includes("window.substitutionActorDepartmentName"), "The first department card must display the dynamic authenticated department");
  assert(adapter.includes("go('smart')"), "Algorithm suggestions must open in the next independent screen");
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

Deno.test("legacy preview and save preserve multi-department scope", () => {
  const preview=section("async function timetablePreviewSubstitutions()", "function timetableRenderSubstitutionLessons(");
  const save=section("async function timetableSaveSubstitution(", "/* Smart daily timetable dashboard");
  assert(preview.includes("otherDepartmentIds"), "Legacy preview must send all selected department IDs");
  assert(preview.includes("timetableGetOtherDepartmentTeacherNames()"), "Legacy preview must include teachers from all selected departments");
  assert(save.includes("otherDepartmentIds"), "Legacy save must validate against the full selected department set");
});
