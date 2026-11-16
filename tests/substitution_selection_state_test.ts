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

Deno.test("supporting-teacher selections survive a same-department options refresh", () => {
  const load = section("async function timetableLoadOtherDepartmentOptions(", "function renderSubstitutionOtherTeacherChoices()");
  assert(load.includes("previousSelectionDepartment"), "The loader must remember which department owns the current selection");
  assert(load.includes("previous&&previous===previousSelectionDepartment"), "Selections may only survive a refresh for the same selected department");
  assert(load.includes("new Set([...previousNames].filter(name=>allowedNames.has(name)))"), "A refreshed list must retain only teachers still eligible in that department");
  assert(load.includes('if(!checkbox.checked)'), "Turning off supporting departments must remain an explicit selection reset");
});

Deno.test("distribution reads the canonical selected-teacher state, not only transient checkbox DOM", () => {
  const getter = section("function getSubstitutionSelectedOtherTeacherNames()", "async function timetableToggleOtherDepartments(");
  assert(getter.includes("window.substitutionSelectedOtherTeacherNames instanceof Set"), "The selected teacher Set must remain the source of truth");
  assert(getter.includes("selected.add(name)"), "Checked controls still present in the DOM must be captured");
  assert(getter.includes("filter(name=>allowedNames.has(name))"), "Only teachers in the currently selected supporting department may be sent");
  assert(getter.includes("const names=[...selected].filter(name=>allowedNames.has(name))"), "The returned names must come from the canonical selection filtered by the current department");
});

Deno.test("changing the supporting department clears the previous department selection", () => {
  const controls = section("function bindOtherDepartmentControls()", "window.openSubstitutionView");
  assert(controls.includes("window.substitutionSelectedOtherDepartmentId=String(department.value||\"\")"), "The selection must be scoped to the currently selected department");
  assert(controls.includes("window.substitutionSelectedOtherTeacherNames=new Set()"), "Changing departments must clear the previous department's selected teachers");
  assert(controls.includes("renderSubstitutionOtherTeacherChoices()"), "The new department must render its own teacher choices");
});

Deno.test("a checked support teacher is not discarded by a stale department tracker", () => {
  const getter = section("function getSubstitutionSelectedOtherTeacherNames()", "async function timetableToggleOtherDepartments(");
  const render = section("function renderSubstitutionOtherTeacherChoices()", "function getSubstitutionSelectedOtherTeacherNames()");
  assert(!getter.includes("if(!department||String(window.substitutionSelectedOtherDepartmentId||\"\")!==departmentId)return []"), "A stale department tracker must not discard a valid current selection");
  assert(getter.includes('host.dataset.departmentId||""') && getter.includes("===departmentId"), "Checkboxes must be read only when rendered for the current department");
  assert(getter.includes("else selected.delete(name)"), "Unchecked current-department controls must remove stale selections");
  assert(getter.includes("window.substitutionSelectedOtherDepartmentId=departmentId"), "The current department tracker must be reconciled before returning");
  assert(render.includes("host.dataset.departmentId=departmentKey"), "The picker must tag its DOM with the department it displays");
});
