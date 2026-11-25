import { isSubstitutionDayOpen } from "../reserve_edit_window.ts";

Deno.test("saved reserve assignments remain editable until Muscat midnight", () => {
  const today = "2026-11-25";
  const beforeMidnightMuscat = Date.parse("2026-11-25T19:59:59.999Z");
  const atMidnightMuscat = Date.parse("2026-11-25T20:00:00.000Z");
  if (!isSubstitutionDayOpen(today, beforeMidnightMuscat)) throw new Error("Today must remain editable before Muscat midnight");
  if (isSubstitutionDayOpen(today, atMidnightMuscat)) throw new Error("Today's edit window must close at Muscat midnight");
  if (!isSubstitutionDayOpen("2026-11-26", atMidnightMuscat)) throw new Error("Future assignments must remain editable during their own day");
  if (isSubstitutionDayOpen("2026-11-24", beforeMidnightMuscat)) throw new Error("Past assignments must be read-only");
  if (isSubstitutionDayOpen("2026-02-30", beforeMidnightMuscat)) throw new Error("Invalid dates must never be editable");
});

Deno.test("saved reserve edit preview is separate from the per-period new-assignment gate", async () => {
  const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  const importPresent = source.includes('import { isSubstitutionDayOpen } from "./reserve_edit_window.ts";');
  if (!importPresent) throw new Error("The timetable edge function must use the shared Muscat-day edit-window helper");
  if (!source.includes("return isSubstitutionDayOpen(assignmentDate);")) throw new Error("The saved-assignment edit predicate must use the exact Muscat day window");
  if (!source.includes("const forEdit=body.forEdit===true;")) throw new Error("Only explicit saved-edit preview requests may open candidate suggestions after lesson time");
  if (!source.includes(":isSubstitutionPeriodOpen(date,lesson.period,periodTimings)")) throw new Error("Ordinary previews must keep the existing lesson-end deadline");
  if (!source.includes("const editTeacherDirectory=forEdit?directory.filter")) throw new Error("The other-teachers search directory must be created only for saved edits and filtered by scope");
  if (!source.includes('teacher.role!=="teacher"||!activeTeachingTeacherNames.has(teacher.name)')) throw new Error("The edit search must exclude inactive or non-teaching directory entries");
  if (!source.includes("occupiedPeriods:teacherCells.map")) throw new Error("The edit search must expose occupied periods from the active timetable");
});
