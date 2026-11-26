import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("function reportDateRangeDays(");
const end = html.indexOf("\nfunction reportCatalog()", start);
assert.ok(start >= 0 && end > start, "report date range helper must exist");
assert.match(html, /window\\.reportDateRangeDays\\s*=\\s*reportDateRangeDays/, "date-range helper must be exposed to report functions in other script scopes");
const helperSource = html.slice(start, end).trim();
const reportDateRangeDays = vm.runInNewContext("(" + helperSource + ")");

test("report date range includes both endpoints", () => {
  assert.deepEqual(Array.from(reportDateRangeDays("2026-11-20", "2026-11-26")), [
    "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23",
    "2026-11-24", "2026-11-25", "2026-11-26",
  ]);
});

test("report date range accepts the maximum safe inclusive span", () => {
  const dates = reportDateRangeDays("2026-01-01", "2027-01-05");
  assert.equal(dates.length, 370);
  assert.equal(dates[0], "2026-01-01");
  assert.equal(dates.at(-1), "2027-01-05");
});

test("report date range rejects spans that would previously be silently truncated", () => {
  assert.throws(
    () => reportDateRangeDays("2026-01-01", "2027-01-06"),
    /370/,
  );
});

test("report date range rejects invalid and reversed dates", () => {
  assert.throws(() => reportDateRangeDays("not-a-date", "2026-11-26"), /غير صحيحة/);
  assert.throws(() => reportDateRangeDays("2026-11-27", "2026-11-26"), /غير صحيحة/);
});

test("report action preserves the validation message for the user", () => {
  assert.match(html, /catch\(e\)\{delete window\.__arcReportRange;if\(msg\)msg\.textContent=e\.message/);
});
