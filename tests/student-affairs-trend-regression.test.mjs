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
test("chaos chart and legend use a clearly distinct amber color", () => {
  assert.match(html, /\["الفوضى","chaos","#a16207"\]/);
  assert.match(html, /style="background:#a16207"><\/i>الفوضى/);
});
test("attendance and behavior saves refresh a visible competition panel", () => {
  assert.match(html, /loadSessionAttendance\(\); saRefreshCompetitionAfterRecordSave\(\);/);
  assert.match(html, /loadSessionBehavior\(\); saRefreshCompetitionAfterRecordSave\(\);/);
});

test("visible competition refreshes when the app returns without background polling", () => {
  assert.match(html, /function saRefreshCompetitionOnReturn\(\)/);
  assert.match(html, /document\.addEventListener\("visibilitychange",\(\)=>\{if\(document\.visibilityState==="visible"\)saRefreshCompetitionOnReturn\(\);\}\)/);
  assert.match(html, /window\.addEventListener\("focus",saRefreshCompetitionOnReturn\)/);
  assert.match(html, /window\.addEventListener\("online",saRefreshCompetitionOnReturn\)/);
  assert.match(html, /now-saCompetitionLastResumeRefreshAt<1500/);
  assert.doesNotMatch(html, /setInterval\([^\n]*saLoadCompetition/);
});

test("Cloudflare branch preview hosts fail closed without connecting to production", () => {
  const match = html.match(/function isCloudflareBranchPreviewHost\(hostname\)\{[^\n]*\}/);
  assert.ok(match, "preview-host detector must exist");
  const isPreviewHost = vm.runInNewContext("(" + match[0] + ")");
  assert.equal(isPreviewHost("fix-student-affairs-trend-we.student-absence-system.pages.dev"), true);
  assert.equal(isPreviewHost("099871fa.student-absence-system.pages.dev"), true);
  assert.equal(isPreviewHost("fix-student-affairs-trend-we.abu-dujana-school-preview.pages.dev"), true);
  assert.equal(isPreviewHost("student-absence-system.pages.dev"), false);
  assert.equal(isPreviewHost("school.example.com"), false);
  assert.match(html, /window\.__ABUDUJANA_CLOUDFLARE_PREVIEW__ === true \|\| isCloudflareBranchPreviewHost\(window\.location\?\.hostname\)/);
});
