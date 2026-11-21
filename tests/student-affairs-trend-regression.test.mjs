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
  assert.match(html, /\["الفوضى","chaos","#a16207"\]/);
  assert.match(html, /style="background:#a16207"><\/i>الفوضى/);
});
test("attendance and behavior saves refresh a visible competition panel", () => {
  assert.match(html, /loadSessionAttendance\(\); saRefreshCompetitionAfterRecordSave\(\);/);
  assert.match(html, /loadSessionBehavior\(\); saRefreshCompetitionAfterRecordSave\(\);/);
});
test("visible competition refreshes when the app returns without polling", () => {
  assert.match(html, /function saRefreshCompetitionOnReturn\(\)/);
  assert.match(html, /document\.addEventListener\("visibilitychange"/);
  assert.match(html, /window\.addEventListener\("focus",saRefreshCompetitionOnReturn\)/);
  assert.match(html, /window\.addEventListener\("online",saRefreshCompetitionOnReturn\)/);
  assert.match(html, /now-saCompetitionLastResumeRefreshAt<1500/);
  assert.doesNotMatch(html, /setInterval\([^\n]*saLoadCompetition/);
});

test("competition refresh is scheduled for Thursday after the 13:51 Oman cutoff", () => {
  assert.match(html, /function saScheduleCompetitionCutoffRefresh\(\)/);
  assert.match(html, /let targetMinutes=13\*60\+56/);
  assert.match(html, /targetMinutes=14\*60\+6/);
  assert.match(html, /saScheduleCompetitionCutoffRefresh\(\);/);
  assert.match(html, /setTimeout\(\(\)=>\{/);
  assert.doesNotMatch(html, /setInterval\([^\n]*saLoadCompetition/);
});
test("competition cutoff refresh remains limited to the visible authorized panel", () => {
  assert.match(html, /if\(!panel\|\|panel\.classList\.contains\("hidden"\)\|\|!saCanViewCompetition\(\)\)return;/);
  assert.match(html, /navigator\.onLine&&saCanViewCompetition\(\)\)saLoadCompetition\(\)/);
});


test("competition API complete snapshots are normalized to the UI approved contract", () => {
  const helperStart = html.indexOf("function saNormalizeCompetitionResponse(data){");
  const helperEnd = html.indexOf("async function saLoadCompetition(){", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "competition response normalizer must exist before the loader");
  const normalize = vm.runInNewContext("(" + html.slice(helperStart, helperEnd).trim() + ")");
  const complete = { status: "complete", period: "weekly", teams: [{ teamId: "synthetic", rank: 1 }] };
  assert.equal(normalize(complete).status, "approved");
  assert.equal(normalize(complete).teams.length, 1);
  assert.equal(normalize({ status: "complete", teams: [] }).status, "complete", "empty snapshots must not be promoted to approved");
  assert.equal(normalize({ status: "no_completed_weeks", teams: [] }).status, "no_completed_weeks");
  assert.ok(html.includes('const response=await saRequest(request);' + String.fromCharCode(10) + '    const data=saNormalizeCompetitionResponse(response);'));
});
