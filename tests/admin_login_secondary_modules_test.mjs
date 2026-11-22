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

test("administrator-only morning assembly card is restored immediately after login", () => {
  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess(");
  assert.match(finalize, /dashboardSelectionView'\)\?\.classList\.remove\('hidden'\);[\s\S]*refreshMorningAssemblyLatenessCard\(\)/);
  const policy = section("function canUseMorningAssemblyLateness()", "function refreshMorningAssemblyLatenessCard()");
  assert.match(policy, /return activeUser\?\.type === 'admin';/);
  assert.doesNotMatch(policy, /permissions\?\.morningAssemblyLateness|isTeacherOnDutyToday/);
});
