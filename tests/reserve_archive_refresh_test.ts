const source = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve archive refresh is centralized and mutation-only", () => {
  const legacyStart = source.indexOf("function installLegacyOtherDepartmentTeacherPicker()");
  const homeStart = source.indexOf("function installHomeReserveArchive()", legacyStart);
  const autoStart = source.indexOf("function installReserveArchiveAutoRefresh()");
  assert(legacyStart >= 0 && homeStart > legacyStart && autoStart > homeStart, "Reserve request wrappers must exist in the expected order");

  const legacy = source.slice(legacyStart, homeStart);
  const auto = source.slice(autoStart);
  assert(!legacy.includes("substitutionLoadCumulativeArchive()"), "The legacy request wrapper must not duplicate cumulative archive reads");

  assert(auto.includes("const reserveMutationActions=new Set(["), "A single explicit mutation allowlist must control reserve archive refresh");
  for (const action of [
    "timetable_substitution_batch_save",
    "timetable_substitution_save",
    "timetable_substitution_update",
    "timetable_substitution_update_batch",
    "timetable_substitution_cancel",
    "timetable_substitution_cancel_batch",
  ]) {
    assert(auto.includes('"'+action+'"'), "Archive refresh must follow mutation: " + action);
  }
  for (const readOnlyAction of [
    "timetable_substitution_preview",
    "timetable_substitution_batch_preview",
    "timetable_substitution_departments",
    "timetable_substitution_reset_options",
    "timetable_substitution_archive",
    "timetable_substitution_stats",
  ]) {
    assert(!auto.includes('"'+readOnlyAction+'"'), "Read-only action must not trigger mutation archive refresh: " + readOnlyAction);
  }
  assert(auto.includes("const reserveAction=reserveMutationActions.has(action)"), "Only allowlisted mutations may trigger the reserve archive refresh path");
  assert(auto.includes('action==="timetable_substitution_archive_access"&&result?.canView===true'), "Authorized archive opening must still load the archive");
});


Deno.test("home reserve archive handles non-school days without an uncaught error or server read", () => {
  const start = source.indexOf("window.substitutionLoadHomeTodayAssignments = async function()");
  const end = source.indexOf("window.substitutionRenderHomeTodayAssignments", start);
  assert(start >= 0 && end > start, "Home-today reserve loader must exist");
  const loader = source.slice(start, end);
  const weekendGuard = loader.indexOf('validationMessage.includes("الاحتياط متاح لأيام الدراسة من الأحد إلى الخميس فقط.")');
  const weekendReturn = loader.indexOf("return false;", weekendGuard);
  const tokenRead = loader.indexOf("const token=", weekendGuard);
  assert(weekendGuard >= 0 && weekendReturn > weekendGuard, "Weekend validation must be handled as a normal empty-day state");
  assert(tokenRead > weekendReturn, "Weekend handling must return before reading a session token or calling Supabase");
  assert(loader.includes("لا توجد تكليفات احتياط في أيام العطلة الأسبوعية."), "The home panel must show a clear weekend message");
});
