import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const complianceModule = fs.readFileSync(new URL("../teacher-attendance-compliance.js", import.meta.url), "utf8");
const start = html.indexOf("function reportDateRangeDays(");
const exportBoundary = html.indexOf("\n// Expose the validator", start);
const end = exportBoundary > start ? exportBoundary : html.indexOf("\nfunction reportCatalog()", start);
assert.ok(start >= 0 && end > start, "report date range helper must exist");
assert.ok(html.includes("window.reportDateRangeDays=reportDateRangeDays"), "date-range helper must be exposed to report functions in other script scopes");
const helperSource = html.slice(start, end).trim();
const reportDateRangeDays = vm.runInNewContext("(" + helperSource + ")");

test("report date range includes both endpoints", () => {
  assert.deepEqual(Array.from(reportDateRangeDays("2026-11-20", "2026-11-26")), [
    "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23",
    "2026-11-24", "2026-11-25", "2026-11-26",
  ]);
});

test("report date range accepts the maximum safe inclusive span", () => {
  const dates = reportDateRangeDays("2026-01-01", "2027-01-05");
  assert.equal(dates.length, 370);
  assert.equal(dates[0], "2026-01-01");
  assert.equal(dates.at(-1), "2027-01-05");
});

test("report date range rejects spans that would previously be silently truncated", () => {
  assert.throws(
    () => reportDateRangeDays("2026-01-01", "2027-01-06"),
    /370/,
  );
});

test("report date range rejects invalid and reversed dates", () => {
  assert.throws(() => reportDateRangeDays("not-a-date", "2026-11-26"), /غير صحيحة/);
  assert.throws(() => reportDateRangeDays("2026-11-27", "2026-11-26"), /غير صحيحة/);
});

test("report action preserves the validation message for the user", () => {
  assert.match(html, /catch\(e\)\{delete window\.__arcReportRange;if\(msg\)msg\.textContent=e\.message/);
});


test("morning assembly report filters events to the exact selected date window and recalculates thresholds", () => {
  const helperStart = html.indexOf("function filterMorningAssemblyReportRowsByDate(");
  const helperEnd = html.indexOf("\nwindow.filterMorningAssemblyReportRowsByDate", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "morning report date filter helper must exist");
  const helper = vm.runInNewContext("(" + html.slice(helperStart, helperEnd).trim() + ")");
  const rows = helper([{
    name: "طالب تجريبي", className: "9/1", count: 5, absenceDays: 1,
    events: [
      { late_date: "2026-11-19" },
      { late_date: "2026-11-20" },
      { late_date: "2026-11-21" },
      { late_date: "2026-11-26" },
      { late_date: "2026-11-27" },
    ],
  }], "2026-11-20", "2026-11-26");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].absenceDays, 0);
  assert.equal(rows[0].remaining, 3);
  assert.deepEqual(Array.from(rows[0].events, event => event.late_date), [
    "2026-11-20", "2026-11-21", "2026-11-26",
  ]);
});

test("administrative report actions validate every date range and constrain morning reports to one academic year", () => {
  const actionStart = html.indexOf("async function reportAction(k,from,to)");
  const actionEnd = html.indexOf("\nfunction statsView()", actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart, "report action dispatcher must exist");
  const source = html.slice(actionStart, actionEnd);
  assert.match(source, /reportDateRangeDays\(from,to\)/);
  assert.match(source, /academicYearForDate\(from\)!==academicYearForDate\(to\)/);
  assert.match(source, /filterMorningAssemblyReportRowsByDate\(morningAssemblyReportRows,from,to\)/);
});


test("teacher activity report counts normalized multi-type behavior records", () => {
  const start = html.indexOf("function getTeachersActivityRows(");
  const end = html.indexOf("\nfunction renderTeachersActivity(", start);
  assert.ok(start >= 0 && end > start, "teacher activity data adapter must exist");
  const source = html.slice(start, end);
  const context = {
    db: {
      teachers: [{ name: "معلم الاختبار" }],
      customUsers: [],
      attendance: { "2026-11-20_9/1_p1": { teacher: "معلم الاختبار", records: { طالب: "absent" } } },
      behaviors: { "2026-11-20_9/1_p2": { teacher: "معلم الاختبار", records: {
        طالب: { types: ["talking", "homework"], note: "" },
        طالب2: { type: "normal" },
      } } },
    },
    normalizeBehaviorRecord(record) {
      const raw = Array.isArray(record?.types) ? record.types : [record?.type];
      return { types: raw.map(String).filter(value => value && value !== "normal") };
    },
  };
  const fn = vm.runInNewContext("(" + source + ")", context);
  const rows = fn("2026-11-20", "2026-11-20");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].absences, 1);
  assert.equal(rows[0].behaviors, 1);
  assert.equal(rows[0].total, 2);
});


test("administrative records center mounts the timetable-backed compliance report instead of printing stale local totals", () => {
  assert.ok(html.includes("async function teacherComplianceReportsView(from,to)"));
  assert.ok(html.includes("await window.loadTeachersActivityCompliance(from,to)"));
  assert.ok(html.includes("await teacherComplianceReportsView(from,to)"));
  assert.ok(html.includes("dashboardTeachersActivity"));
  assert.ok(complianceModule.includes("timetable_activity_report_data"));
  assert.ok(complianceModule.includes("reportRequest.admin_records_center = true"));
  assert.ok(complianceModule.includes("async function loadReport(fromOverride, toOverride)"));
});
