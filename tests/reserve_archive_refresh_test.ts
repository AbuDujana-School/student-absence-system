const source = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve archive refresh is centralized after mutations only", () => {
  const legacyStart = source.indexOf("function installLegacyOtherDepartmentTeacherPicker()");
  const autoStart = source.indexOf("function installReserveArchiveAutoRefresh()");
  assert(legacyStart >= 0 && autoStart > legacyStart, "Both request wrappers must exist");
  const homeArchiveStart = source.indexOf("function installHomeReserveArchive()", legacyStart);
  assert(homeArchiveStart > legacyStart, "The home archive installer must exist");
  const legacy = source.slice(legacyStart, homeArchiveStart);
  const auto = source.slice(autoStart);
  assert(!legacy.includes("substitutionLoadCumulativeArchive()"), "The legacy request wrapper must not issue a second archive read");
  assert(auto.includes("const reserveMutationActions=new Set(["), "A single explicit mutation allowlist must control archive refresh");
  for (const action of [
    "timetable_substitution_batch_save", "timetable_substitution_save",
    "timetable_substitution_update", "timetable_substitution_update_batch",
    "timetable_substitution_cancel", "timetable_substitution_cancel_batch",
  ]) {
    assert(auto.includes('"'+action+'"'), "Archive refresh must follow mutation: " + action);
  }
  assert(!auto.includes('"timetable_substitution_preview"'), "Preview requests must not trigger an archive read");
  assert(auto.includes("const reserveAction=reserveMutationActions.has(action)"), "Only allowlisted mutations may refresh reserve archives");
});
