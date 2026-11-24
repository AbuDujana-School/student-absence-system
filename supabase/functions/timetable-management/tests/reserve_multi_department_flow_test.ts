function assertMatch(source: string, pattern: RegExp) {
  if (!pattern.test(source)) throw new Error("Expected source to match " + pattern);
}
function assertNotMatch(source: string, pattern: RegExp) {
  if (pattern.test(source)) throw new Error("Expected source not to match " + pattern);
}

const workflow = await Deno.readTextFile(new URL("../../../../reserve-workflow.js", import.meta.url));
const backend = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
const auth = await Deno.readTextFile(new URL("../session_auth.ts", import.meta.url));

Deno.test("reserve workflow presents four clear guided steps", () => {
  for (const step of ["1", "2", "3", "4"]) {
    assertMatch(workflow, new RegExp('data-reserve-step="' + step + '"'));
  }
  assertMatch(workflow, /التاريخ والغياب/);
  assertMatch(workflow, /سبب الغياب/);
  assertMatch(workflow, /اختيار البدلاء/);
  assertMatch(workflow, /المراجعة والاعتماد/);
});

Deno.test("absence reason categories match the agreed options and Other may be left blank", () => {
  assertMatch(workflow, /ABSENCE_REASON_OPTIONS=\["طارئة","موعد مستشفى","مرضية","أخرى"\]/);
  assertMatch(workflow, /choice==="أخرى"\?\(custom\?"أخرى: "\+custom:"أخرى"\):choice/);
  assertNotMatch(workflow, /اكتب سبب الغياب عند اختيار «أخرى»/);
});

Deno.test("support picker permits choosing several departments and teachers from each", () => {
  assertMatch(workflow, /reserveSelectedOtherDepartmentIds=new Set\(\)/);
  assertMatch(workflow, /reserveSelectedOtherTeachersByDepartment=new Map\(\)/);
  assertMatch(workflow, /data-other-department-id=/);
  assertMatch(workflow, /data-other-teacher-department=/);
  assertMatch(workflow, /otherDepartmentSelections:otherDepartmentSelectionsPayload\(\)/);
  assertMatch(backend, /const rawOtherDepartmentSelections=Array\.isArray\(body\.otherDepartmentSelections\)/);
  assertMatch(backend, /const selectedSupportingTeacher=\(teacher:any\)=>includeOtherDepartments&&otherDepartmentSelections\.some/);
  assertMatch(backend, /selectedOtherTeacherNames=new Set\(otherTeacherNames\)/);
});

Deno.test("custom coordinators keep absent-teacher scope while selected support teachers are allowed", () => {
  assertMatch(auth, /"timetable_substitution_departments"/);
  assertMatch(auth, /"timetable_substitution_update"/);
  assertMatch(backend, /principal\.type === "custom" && !String\(actor\?\.departmentId\|\|""\)\.trim\(\)/);
  if (!backend.includes("getVisibleAbsentTeachers(dayCells.map") || !backend.includes("directory,actorDepartmentId,principal.type===\"admin\"")) {
    throw new Error("The backend must continue deriving the absent-teacher list from the coordinator's server-resolved department");
  }
  assertMatch(backend, /customReserveScopeAllows\(targetAbsent,item\.substituteTeacherName,selectedSupport\)/);
});

Deno.test("the reserve observer loop guard remains limited to direct child mutations", async () => {
  assertMatch(workflow, /substitutionContentObserver\.observe\(substitutionView,\{childList:true\}\)/);
  assertNotMatch(workflow, /substitutionContentObserver\.observe\(substitutionView,\{subtree:true,childList:true\}\)/);
});
