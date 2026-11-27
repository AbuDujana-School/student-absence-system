import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reserve = readFileSync(new URL("../reserve-workflow.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("canonical reserve workspace does not require the removed legacy timetable panel", () => {
  const start = reserve.indexOf("function mountCanonicalPanel(){");
  const end = reserve.indexOf("\n    function restoreCanonicalPanel()", start);
  assert.ok(start >= 0 && end > start, "canonical mount function must exist");
  const mount = reserve.slice(start, end);
  assert.match(mount, /const editHost=\$\("subxEditMountArea"\)/);
  assert.match(mount, /const archiveHost=\$\("subxArchiveMountArea"\)/);
  assert.match(mount, /if\(!root\|\|!editHost\|\|!archiveHost\)return false/);
  assert.doesNotMatch(mount, /if\(!panel\|\|/);
  assert.match(mount, /\$\("timetableSubstitutionPanel"\)\?\.classList\.add\("hidden"\)/);
});

test("the current unified reserve screen provides the canonical editor and archive hosts", () => {
  assert.match(html, /<section id="substitutionView"/);
  assert.match(html, /id="subxEditMountArea"/);
  assert.match(html, /id="subxArchiveMountArea"/);
  assert.doesNotMatch(html, /id="timetableSubstitutionPanel"/);
});
