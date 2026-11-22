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
