import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("timetable dashboard exposes only general timetable settings and class schedules", () => {
  const navStart = html.indexOf('<nav class="tt-tabs tt-no-print"');
  assert.notEqual(navStart, -1, "timetable dashboard tab navigation exists");
  const navEnd = html.indexOf("</nav>", navStart);
  assert.notEqual(navEnd, -1, "timetable dashboard navigation closes");
  const nav = html.slice(navStart, navEnd);

  assert.match(nav, /id="timetableSettingsTabButton"/);
  assert.match(nav, /id="timetableClassTabButton"/);
  assert.doesNotMatch(nav, /daily|الاحتياط اليومي|توزيع الاحتياط/i);
  assert.doesNotMatch(html, /id="timetableDailyTabButton"/);
  assert.doesNotMatch(html, /id="timetableSubstitutionPanel"/);
  assert.doesNotMatch(html, /timetableSwitchDashboardTab\('daily'\)/);
  assert.match(html, /if \(tab === 'timetable'\) \{ timetableSwitchDashboardTab\('settings'\);/);
});

test("main home-page substitution distribution remains intact", () => {
  for (const id of [
    "substitutionDashboardCard",
    "substitutionView",
    "substitutionGenerateButton",
    "substitutionPlanPanel",
    "substitutionSaveButton",
    "substitutionWhatsappButton",
    "substitutionPdfButton",
    "reserveDistributionReportPanel"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing main-page element: " + id);
  }
  assert.match(html, /openSubstitutionView\(\)/);
  assert.ok(html.includes("loadSubstitutionDistributionReport"));
  assert.ok(html.includes("printSubstitutionDistributionReport"));
});
