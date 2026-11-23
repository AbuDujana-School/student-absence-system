import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
function section(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = html.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section boundary: ${end}`);
  return html.slice(from, to);
}

test("primary administrator login does not bootstrap Student Affairs in the background", () => {
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord(");
  assert.match(login, /void finalizeLoginState\(\)/);
  assert.doesNotMatch(login, /saLogin\(/);
  assert.match(login, /Student Affairs is deliberately lazy-loaded/);
});

test("Student Affairs creates its secondary session only after the module is opened", () => {
  const entry = section("async function openStudentAffairsView(fromHome = false)", "function closeStudentAffairsView()");
  assert.match(entry, /if \(!saSession\?\.token\)/);
  assert.match(entry, /await saLogin\(\)/);
  assert.match(entry, /return; \/\/ saLogin initializes the module screen/);
});

test("report loading remains inside the Student Affairs module entry path, not primary login", () => {
  const entry = section("async function openStudentAffairsView(fromHome = false)", "function closeStudentAffairsView()");
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord(");
  assert.match(entry, /saSetupCompetitionPanel\(\)/);
  assert.match(entry, /saSetupSupervisionPanel\(\)/);
  assert.doesNotMatch(login, /saSetDomain\(|saSetupCompetitionPanel\(|saSetupSupervisionPanel\(/);
});

const reserveWorkflow = await readFile(new URL("../reserve-workflow.js", import.meta.url), "utf8");

test("admin reserve distribution report does not auto-load when login reveals its panel", () => {
  const start = reserveWorkflow.indexOf("function installSchoolwideReserveDistributionReport()");
  assert.notEqual(start, -1, "missing reserve report installer");
  const end = reserveWorkflow.indexOf("\n  installSchoolwideReserveDistributionReport();", start);
  assert.notEqual(end, -1, "missing reserve report installer boundary");
  const installer = reserveWorkflow.slice(start, end);
  assert.doesNotMatch(installer, /loadSubstitutionDistributionReport/);

  const reportsTab = section("if (tab === 'reports') {", "if (tab === 'timetable') {");
  assert.match(reportsTab, /loadSubstitutionDistributionReport\(true\)/);
});

test("staggered dashboard pilot is restricted to the non-admin Distron account", () => {
  const pilot = section("function isDistronStagedPilot(", "function renderAuthenticatedDashboardShell()");
  assert.match(pilot, /normalizedName === 'distron'/);
  assert.match(pilot, /user\.type !== 'admin'/);
  assert.match(pilot, /distronDashboardStageRunId/);
  assert.match(pilot, /runId !== distronDashboardStageRunId/);
  assert.match(pilot, /isDistronStagedPilot\(\)/);
});

test("Distron dashboard modules are revealed on the requested independent schedule", () => {
  const pilot = section("function startDistronDashboardStages()", "function renderAuthenticatedDashboardShell()");
  assert.match(pilot, /schedule\(5000,[\s\S]*'morning-assembly'/);
  assert.match(pilot, /schedule\(10000,[\s\S]*timetableRefreshAccess\(\{ deferAdminPortalStatus: true \}\)/);
  assert.match(pilot, /schedule\(15000,[\s\S]*'student-affairs'/);
  const duty = section("function refreshDutyDashboardCard()", "function openDutyView()");
  const morning = section("function refreshMorningAssemblyLatenessCard()", "function openMorningAssemblyLateness()");
  assert.match(duty, /distronDashboardStagePending\(10000\)/);
  assert.match(morning, /distronDashboardStagePending\(5000\)/);
  assert.match(html, /distronDashboardStagePending\(15000\)/);
});

test("the staged pilot starts with the authenticated shell and does not change administrator credentials", () => {
  const shell = section("function renderAuthenticatedDashboardShell()", "async function finalizeLoginState()");
  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess(");
  assert.match(shell, /startDistronDashboardStages\(\)/);
  assert.doesNotMatch(finalize, /startDistronDashboardStages\(\)/);
  assert.doesNotMatch(finalize, /update.*adminPin|set.*adminPin|change.*adminPin/i);
  assert.match(finalize, /refreshActiveUserPermissions\(\)/);
  assert.match(finalize, /if \(!isDistronStagedPilot\(\)\) \{\s*refreshDutyDashboardCard\(\);\s*renderDutyTodayRecords\(\);/);
});


test("additional administrators never inherit the general administrator frontend bypass", () => {
  const identity = section("function isGeneralAdminUser(", "function grantTemporaryAdminAuth(");
  assert.match(identity, /user\?\.type === "admin"/);
  assert.match(identity, /user\.adminScope === "general"/);
  assert.match(identity, /user\.name === "مدير النظام العام"/);
  assert.doesNotMatch(identity, /permissions\?\.admin/);

  const adminPanels = section("function hasAdminPanelAccess(", "function hasAnyPermission(");
  assert.match(adminPanels, /isGeneralAdminUser\(user\)/);
  assert.doesNotMatch(adminPanels, /permissions\?\.admin/);

  const reports = section("function canManageReportPermissions()", "function refreshReportPanelsVisibility()");
  assert.match(reports, /isGeneralAdminUser\(user\)/);
  assert.match(reports, /return p\[key\] === true/);
  assert.doesNotMatch(reports, /p\.admin === true/);
});
