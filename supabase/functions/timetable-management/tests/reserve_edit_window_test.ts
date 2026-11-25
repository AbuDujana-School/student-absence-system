import { isSubstitutionDayOpen } from "../reserve_edit_window.ts";

Deno.test("reserve edit window stays open until Muscat midnight for today and future dates", () => {
  const today = "2026-11-25";
  const beforeMidnightMuscat = Date.parse("2026-11-25T19:59:59.999Z");
  const atMidnightMuscat = Date.parse("2026-11-25T20:00:00.000Z");
  assert(isSubstitutionDayOpen(today, beforeMidnightMuscat), "Today's assignments must remain editable until 23:59:59 Muscat time");
  assert(!isSubstitutionDayOpen(today, atMidnightMuscat), "Today's assignments must close exactly at Muscat midnight");
  assert(isSubstitutionDayOpen("2026-11-26", atMidnightMuscat), "Tomorrow's assignments must remain editable throughout tomorrow");
  assert(!isSubstitutionDayOpen("2026-11-24", beforeMidnightMuscat), "Past assignments must be archived and read-only");
  assert(!isSubstitutionDayOpen("2026-02-30", beforeMidnightMuscat), "Invalid calendar dates must never receive an edit window");
});

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
