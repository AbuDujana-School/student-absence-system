import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("index.html", "utf8");
const helperMatch = html.match(/function saFilterSupervisionTrendRows\\(rows\\)\\{[^\\n]*\\}/);
assert.ok(helperMatch, "weekend filtering helper must exist");
const filterRows = vm.runInNewContext("(" + helperMatch[0] + ")");
test("supervision trends exclude Friday and Saturday but retain Sunday-Thursday", () => {
  const input = [
    { date: "2026-11-22" },
    { date: "2026-11-23" },
    { date: "2026-11-26" },
    { date: "2026-11-27" },
    { date: "2026-11-28" },
    { date: "not-a-date" },
  ];
  assert.deepEqual(Array.from(filterRows(input), row => row.date), [
    "2026-11-22", "2026-11-23", "2026-11-26"
  ]);
});
test("chaos chart and legend use a distinct amber color", () => {
  assert.match(html, /\\["الفوضى","chaos","#a16207"\\]/);
  assert.match(html, /style="background:#a16207"><\\/i>الفوضى/);
});
test("attendance and behavior saves refresh a visible competition panel", () => {
  assert.match(html, /loadSessionAttendance\\(\\); saRefreshCompetitionAfterRecordSave\\(\\);/);
  assert.match(html, /loadSessionBehavior\\(\\); saRefreshCompetitionAfterRecordSave\\(\\);/);
});
test("visible competition refreshes when the app returns without polling", () => {
  assert.match(html, /function saRefreshCompetitionOnReturn\\(\\)/);
  assert.match(html, /document\\.addEventListener\\("visibilitychange"/);
  assert.match(html, /window\\.addEventListener\\("focus",saRefreshCompetitionOnReturn\\)/);
  assert.match(html, /window\\.addEventListener\\("online",saRefreshCompetitionOnReturn\\)/);
  assert.match(html, /now-saCompetitionLastResumeRefreshAt<1500/);
  assert.doesNotMatch(html, /setInterval\\([^\\n]*saLoadCompetition/);
});
