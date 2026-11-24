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

test("reserve admin tools use the canonical general-admin identity and never load during login", () => {
  assert.doesNotMatch(reserveWorkflow, /schoolwideReserveReportIsAdmin/);
  assert.match(reserveWorkflow, /function installAdminReserveTools\(\)[\s\S]*?isGeneralAdminUser\(activeUser\)/);
  assert.match(reserveWorkflow, /if\(isGeneralAdminUser\(activeUser\)\)installAdminReserveTools\(\)/);
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord(");
  assert.doesNotMatch(login, /installAdminReserveTools\(|timetable_substitution_archive/);
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
  const identity = section("function isGeneralAdminUser(", "function isAdditionalAdminUser(");
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


test("delegated admin permission grants reserve management without the general-admin bypass", () => {
  const reserve = section("function canManageReserveWorkspace(", "function isAdminAuthorized()");
  assert.match(reserve, /isGeneralAdminUser\(user\)/);
  assert.match(reserve, /user\?\.permissions\?\.admin === true/);
  assert.match(reserve, /user\?\.type === "teacher" && user\?\.permissions\?\.reserve === true/);

  const identity = section("function isGeneralAdminUser(", "function isAdditionalAdminUser(");
  assert.doesNotMatch(identity, /permissions\?\.admin/);
  const adminPanels = section("function hasAdminPanelAccess(", "function hasAnyPermission(");
  assert.doesNotMatch(adminPanels, /canManageReserveWorkspace|permissions\?\.admin/);
  assert.match(reserveWorkflow, /if\(!isGeneralAdminUser\(activeUser\)\)\{say\("هذه الميزة متاحة لمدير النظام العام فقط\./);
});

const morningLateness = await readFile(new URL("../supabase/functions/morning-assembly-lateness/index.ts", import.meta.url), "utf8");
test("additional administrators use teacher-scoped morning lateness permissions", () => {
  assert.match(morningLateness, /return \{type:"teacher",name:principalName,permissions:buildAdditionalAdminPermissions\(user\)\}/);
  assert.match(morningLateness, /principal\.permissions\.reportMorningAssemblyLateness !== true/);
  assert.doesNotMatch(morningLateness, /principal\.type === "admin" && principal\.name !== "مدير النظام العام"/);
});


test("reserve tools are restricted to the canonical general administrator identity", () => {
  assert.doesNotMatch(reserveWorkflow, /schoolwideReserveReportIsAdmin/);
  assert.match(reserveWorkflow, /function installAdminReserveTools\(\)[\s\S]*?isGeneralAdminUser\(activeUser\)/);
  assert.match(reserveWorkflow, /if\(isGeneralAdminUser\(activeUser\)\)installAdminReserveTools\(\)/);
  assert.match(reserveWorkflow, /if\(!isGeneralAdminUser\(activeUser\)\)\{say\("هذه الميزة متاحة لمدير النظام العام فقط\."/);
});

test("attendance and behavior statistics require their matching read permissions while admins retain access", () => {
  const policy = section("function canAccessAdminTab(", "function grantTemporaryAdminAuth()");
  assert.match(policy, /isGeneralAdminUser\(user\) \|\| \(user === activeUser && isAdminAuthorized\(\)\)/);
  assert.match(policy, /key === 'studstats'.*permissions\.studstats === true && permissions\.attendance !== false/);
  assert.match(policy, /key === 'behaviorstats'.*permissions\.behaviorstats === true && permissions\.behavior !== false/);

  const access = section("function hasAdminPanelAccess(", "function getSingleAdminPanelPermission(");
  assert.match(access, /ADMIN_TAB_PERMISSIONS\.some\(key => canAccessAdminTab\(key, user\)\)/);
  const switcher = section("function switchAdminTab(tab)", "/* ============ Students admin ============ */");
  assert.match(switcher, /: canAccessAdminTab\(k, activeUser\)/);
  const setup = section("function setupRolePermissions()", "let currentUrgentType");
  assert.match(setup, /const allow = canAccessAdminTab\(id, activeUser\)/);
  const dashboard = section("function initAdminDashboard()", "/* Independent copy of Student Affairs report tools");
  assert.match(dashboard, /const has = \(k\) => k === 'timetable' \? \(isA \|\| timetableCanAccess\) : canAccessAdminTab\(k, activeUser\)/);
  assert.match(html, /const canStats = canAccessAdminTab\('studstats', activeUser\)/);
});
