import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../teacher-attendance-compliance.js", import.meta.url), "utf8");

test("teacher compliance report does not issue a request during page startup", () => {
  const start = source.indexOf('document.addEventListener("DOMContentLoaded", () => {');
  assert.notEqual(start, -1, "startup date initialization should remain");
  const end = source.indexOf("\n  });", start);
  assert.notEqual(end, -1, "startup handler should close");
  const startup = source.slice(start, end);
  assert.doesNotMatch(startup, /\bloadReport\s*\(/);
  assert.match(startup, /اضغط «تحديث البيانات»/);
});

test("the report remains manually refreshable", () => {
  assert.match(source, /window\.loadTeachersActivityCompliance\s*=\s*loadReport/);
});
