import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("index.html", "utf8");
const helperMatch = html.match(/function saFilterSupervisionTrendRows\(rows\)\{[^\n]*\}/);
assert.ok(helperMatch, "weekend filtering helper must exist");
const filterRows = vm.runInNewContext("(" + helperMatch[0] + ")");
test("supervision trends exclude Friday and Saturday but retain Sunday-Thursday", () => {
  const input = [
    { date: "2026-11-22" }, // Sunday
    { date: "2026-11-23" }, // Monday
    { date: "2026-11-26" }, // Thursday
    { date: "2026-11-27" }, // Friday
    { date: "2026-11-28" }, // Saturday
    { date: "not-a-date" },
  ];
  assert.deepEqual(Array.from(filterRows(input), row => row.date), [
    "2026-11-22", "2026-11-23", "2026-11-26"
  ]);
});
test("chaos chart and legend use a clearly distinct teal color", () => {
  assert.match(html, /\["الفوضى","chaos","#a16207"\]/);
  assert.match(html, /style="background:#a16207"><\/i>الفوضى/);
});
test("attendance and behavior saves refresh a visible competition panel", () => {
  assert.match(html, /loadSessionAttendance\(\); saRefreshCompetitionAfterRecordSave\(\);/);
  assert.match(html, /loadSessionBehavior\(\); saRefreshCompetitionAfterRecordSave\(\);/);
});
