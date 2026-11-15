import { fetchAllTimetablePages } from "../timetable_pagination.ts";

Deno.test("weekly timetable pagination reads all rows beyond the 1,000-row API cap", async () => {
  const source = Array.from({ length: 2415 }, (_, index) => index);
  const ranges: Array<[number, number]> = [];
  const result = await fetchAllTimetablePages(async (from, to) => {
    ranges.push([from, to]);
    return { data: source.slice(from, to + 1), error: null };
  }, 1000, 25000);
  if (result.length !== 2415) throw new Error("Expected all 2,415 weekly cells");
  if (ranges.length !== 3) throw new Error("Expected three 1,000-row pages");
  if (ranges[0][0] !== 0 || ranges[1][0] !== 1000 || ranges[2][0] !== 2000) {
    throw new Error("Page offsets must be sequential and non-overlapping");
  }
});

Deno.test("weekly timetable pagination rejects data beyond its safe maximum", async () => {
  const source = Array.from({ length: 2501 }, (_, index) => index);
  let rejected = false;
  try {
    await fetchAllTimetablePages(async (from, to) => ({
      data: source.slice(from, to + 1),
      error: null,
    }), 1000, 2000);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Expected the safe row limit to reject oversized schedules");
});

Deno.test("weekly timetable pagination propagates database errors", async () => {
  let rejected = false;
  try {
    await fetchAllTimetablePages(async () => ({ data: null, error: new Error("database unavailable") }));
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Expected database errors to propagate");
});
