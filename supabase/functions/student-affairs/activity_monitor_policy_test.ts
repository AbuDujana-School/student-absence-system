import { omanActivityDateRange, omanTodayIsoDate } from "./activity_monitor_policy.ts";

Deno.test("Oman date filter includes the complete local calendar day", () => {
  const range = omanActivityDateRange("2026-11-23", "2026-11-23");
  if (range.startInclusive !== "2026-11-22T20:00:00.000Z") {
    throw new Error(`Unexpected Oman start boundary: ${range.startInclusive}`);
  }
  if (range.endExclusive !== "2026-11-23T20:00:00.000Z") {
    throw new Error(`Unexpected Oman end boundary: ${range.endExclusive}`);
  }
});

Deno.test("Oman date filter supports a multi-day inclusive range", () => {
  const range = omanActivityDateRange("2026-11-21", "2026-11-23");
  if (range.startInclusive !== "2026-11-20T20:00:00.000Z" ||
      range.endExclusive !== "2026-11-23T20:00:00.000Z") {
    throw new Error(`Unexpected multi-day range: ${JSON.stringify(range)}`);
  }
});

Deno.test("Oman today uses UTC+04 even when UTC is still on the previous date", () => {
  const today = omanTodayIsoDate(new Date("2026-11-22T21:30:00.000Z"));
  if (today !== "2026-11-23") throw new Error(`Unexpected Oman date: ${today}`);
});
