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
