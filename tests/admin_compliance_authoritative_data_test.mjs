import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const api = fs.readFileSync(new URL("../supabase/functions/timetable-management/index.ts", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../teacher-attendance-compliance.js", import.meta.url), "utf8");

test("administrative compliance report reads authoritative attendance rows from Supabase", () => {
  const start = api.indexOf('if (body.action === "timetable_activity_report_data")');
  const end = api.indexOf('if (body.action === "timetable_teacher_weekly_get")', start);
  assert.ok(start >= 0 && end > start, "timetable activity report endpoint must exist");
  const source = api.slice(start, end);
  assert.match(source, /db\.from\("attendance"\)/);
  assert.match(source, /\.gte\("date_str", dateFrom\)\.lte\("date_str", dateTo\)/);
  assert.match(source, /record_key,date_str,class_name,teacher_name,period,records,updated_at/);
  assert.match(source, /attendance,\s*$/);
});

test("saved attendance teacher names are canonicalized using the school teacher directory", () => {
  const start = api.indexOf('if (body.action === "timetable_activity_report_data")');
  const end = api.indexOf('if (body.action === "timetable_teacher_weekly_get")', start);
  const source = api.slice(start, end);
  assert.match(source, /resolveTimetableTeacherName\(row\.teacher_name, row\.teacher_name, systemTeachers\)/);
  assert.match(source, /teacherName:\s*resolveTimetableTeacherName/);
});

test("compliance report prefers the server attendance response even when it is empty", () => {
  assert.match(client, /Array\.isArray\(data\.attendance\)\s*\?\s*data\.attendance\s*:/);
  assert.match(client, /data\.attendance/);
  assert.match(client, /session\.teacherName\s*\|\|\s*session\.teacher_name\s*\|\|\s*session\.teacher/);
});

test("the local dashboard cache is only a backwards-compatible fallback, not the admin report source", () => {
  const start = client.indexOf("const attendanceSessions = Array.isArray(data.attendance)");
  const end = client.indexOf("const rows = [];", start);
  assert.ok(start >= 0 && end > start);
  const source = client.slice(start, end);
  assert.match(source, /Object\.entries\(db\?\.attendance\s*\|\|\s*\{\}\)/);
  assert.match(source, /data\.attendance\s*\?\s*data\.attendance/);
});
