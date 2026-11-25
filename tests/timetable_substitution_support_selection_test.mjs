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

test("timetable support department is translated into server-validated teacher names", () => {
  const loader = section("async function timetableLoadOtherDepartmentOptions", "function timetableGetOtherDepartmentTeacherNames");
  assert.match(loader, /checkboxId==="timetableSubstitutionOtherDepartments"\)\s*\{\s*window\.timetableSubstitutionOtherDepartmentsData=departments;/);
  const helper = section("function timetableGetOtherDepartmentTeacherNames", "function timetableSubstitutionOtherDepartmentChanged");
  assert.match(helper, /department\?\.teachers/);
  const preview = section("async function timetablePreviewSubstitutions()", "function timetableRenderSubstitutionLessons");
  assert.match(preview, /timetableGetOtherDepartmentTeacherNames\(\)/);
  assert.match(preview, /otherDepartmentId,otherTeacherNames/);
  const daily = section("async function timetableDailyFetchPreview", "async function timetableDailyRefreshOne");
  assert.match(daily, /timetableGetOtherDepartmentTeacherNames\(\)/);
  assert.match(daily, /otherDepartmentId,otherTeacherNames/);
  const save = section("async function timetableSaveSubstitution", "/* Smart daily timetable dashboard");
  assert.match(save, /otherTeacherNames=includeOtherDepartments\?\[substituteTeacherName\]:\[\]/);
  assert.match(save, /otherDepartmentId,otherTeacherNames/);
});

test("removed timetable daily panel does not remove home-page support department selection", () => {
  assert.doesNotMatch(html, /id="timetableSubstitutionPanel"/);
  assert.doesNotMatch(html, /onchange="timetableSubstitutionOtherDepartmentChanged\(\)"/);
  assert.match(html, /id="substitutionOtherDepartmentSelect"/);
  assert.match(html, /timetableLoadOtherDepartmentOptions\?\.\('substitutionOtherDepartments','substitutionOtherDepartmentSelect'\)/);
});
