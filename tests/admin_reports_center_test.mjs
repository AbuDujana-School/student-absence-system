import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const moduleCode = fs.readFileSync(new URL("../admin-reports-center.js", import.meta.url), "utf8");

test("administrative reports center loads as an isolated module", () => {
  assert.match(html, /admin-reports-center\.js/);
  assert.match(moduleCode, /#adminRecordsCenterModal/);
  assert.match(moduleCode, /MutationObserver/);
});

test("report cards use the existing report permissions", () => {
  for (const key of ["reportComprehensiveAbsence", "reportMorningAssemblyLateness", "reportClassLatenessFollowup", "reportSubstitutionDistribution", "reportStudentAffairs"]) {
    assert.ok(moduleCode.includes(key), "missing permission: " + key);
  }
  assert.match(moduleCode, /canAccessAdminTab\('behaviorstats'/);
  assert.match(moduleCode, /canAccessAdminTab\('teachers'/);
});

test("date dialog defaults to the current school year start and Oman today", () => {
  assert.match(moduleCode, /m>=9\?y:y-1/);
  assert.match(moduleCode, /'-09-01'/);
  assert.match(moduleCode, /getOmanLocalDate\(\)/);
  assert.match(moduleCode, /آخر 7 أيام/);
  assert.match(moduleCode, /الشهر الحالي/);
});

test("range reports reuse live school records and native report functions", () => {
  assert.match(moduleCode, /db\.attendance/);
  assert.match(moduleCode, /db\.behaviors/);
  assert.match(moduleCode, /loadSubstitutionDistributionReport/);
  assert.match(moduleCode, /printSubstitutionDistributionReport/);
  assert.match(moduleCode, /printLateFollowupReport/);
  assert.match(moduleCode, /printMorningAssemblyLatenessReport/);
  assert.match(moduleCode, /printTeachersActivityPDF/);
  assert.match(moduleCode, /repInitStudentAffairsReports/);
});

test("no demonstration permission switch or fabricated student rows are introduced", () => {
  assert.doesNotMatch(moduleCode, /setPermissionMode|permissionMode/);
  assert.doesNotMatch(moduleCode, /سالم بن حمد المقبالي|أحمد بن سلطان الجابري/);
});

test("calm glass theme keeps readable light/dusk contrast and avoids pure black", () => {
  assert.match(moduleCode, /arcCalmGlassTheme/);
  assert.match(moduleCode, /rgba\(34,52,71/);
  assert.match(moduleCode, /#e2e8f0/);
  assert.match(moduleCode, /#354c63/);
  assert.doesNotMatch(moduleCode, /background:#000(?:000)?\b/i);
  assert.match(moduleCode, /overflow-x:auto/);
});
