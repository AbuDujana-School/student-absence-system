import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../teacher-attendance-compliance.js", import.meta.url), "utf8");
const start = source.indexOf("function makeReport(data, from, to, today)");
const end = source.indexOf("\n  function listHtml(", start);
assert.ok(start >= 0 && end > start, "compliance report calculation must exist");
const normalize = value => String(value || "").normalize("NFKC")
  .replace(/[\\u064b-\\u065f\\u0670\\u0640]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ؤ/g, "و")
  .replace(/ئ/g, "ي").replace(/ة/g, "ه").replace(/\\s+/g, "").trim();
const classValues = value => (Array.isArray(value) ? value : String(value || "").split(/[،,؛;]+/))
  .map(item => String(item || "").trim()).filter(Boolean);
const slotKey = (date, period, className) => date + "|" + Number(period) + "|" + normalize(className);
const makeReport = vm.runInNewContext("(" + source.slice(start, end).trim() + ")", {
  normalize, classValues, slotKey, DAYS: ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"],
});

const data = {
  version: { id: "v1" },
  versions: [{ id: "v1", activatedDate: "2026-11-20" }],
  teachers: ["المعلم الأول"],
  cells: [{
    versionId: "v1", teacherName: "المعلم الأول", weekday: "الخميس",
    period: 1, status: "teaching", classSections: ["9/1"],
  }],
  assignments: [],
  attendance: [{
    date: "2026-11-26", className: "9/1", period: 1, teacherName: "المعلم الأول",
  }],
};

test("the compliance report recognizes saved attendance returned directly by its server request", () => {
  const report = makeReport(data, "2026-11-26", "2026-11-26", "2026-11-26");
  assert.equal(report.totalLessons, 1);
  assert.equal(report.completeLessons, 1);
  assert.equal(report.pendingLessons, 0);
  assert.deepEqual(Array.from(report.rows[0].complete), ["9/1 — الحصة 1"]);
});

test("the compliance report does not mark a lesson complete when no saved attendance row exists", () => {
  const report = makeReport({ ...data, attendance: [] }, "2026-11-26", "2026-11-26", "2026-11-26");
  assert.equal(report.completeLessons, 0);
  assert.equal(report.pendingLessons, 1);
});

test("the compliance report calculation no longer reads the browser-side attendance cache", () => {
  const calculation = source.slice(start, end);
  assert.match(calculation, /data\\.attendance/);
  assert.doesNotMatch(calculation, /db\\?\\.attendance|parseAttendanceKey/);
});
