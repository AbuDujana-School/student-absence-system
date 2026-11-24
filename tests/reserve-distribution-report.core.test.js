const test = require("node:test");
const assert = require("node:assert/strict");
require("../reserve-distribution-report.core.draft.js");

const core = globalThis.ReserveDistributionReportCore;

test("permission checks are safe when application identity objects are absent", () => {
  assert.equal(core.canView({}), false);
  assert.equal(core.canManagePermissions({}), false);
  assert.equal(core.canView(null), false);
});

test("only general admin or explicit report permission can view", () => {
  assert.equal(core.canView({ activeUser: { type: "admin", adminScope: "general" } }), true);
  assert.equal(core.canView({ principal: { type: "admin", name: "مدير النظام العام" } }), true);
  assert.equal(core.canView({ activeUser: { type: "teacher", permissions: { reportSubstitutionDistribution: true } } }), true);
  assert.equal(core.canView({ activeUser: { type: "teacher", permissions: { reportSubstitutionDistribution: false } } }), false);
  assert.equal(core.canManagePermissions({ activeUser: { type: "teacher", permissions: { reportSubstitutionDistribution: true } } }), false);
});

test("date range rejects malformed, reversed, and excessively long ranges", () => {
  assert.equal(core.validateRange("2026-11-01", "2026-11-24"), true);
  assert.equal(core.validateRange("2026-02-30", "2026-03-01"), false);
  assert.equal(core.validateRange("2026-11-24", "2026-11-01"), false);
  assert.equal(core.validateRange("2025-01-01", "2026-11-24"), false);
});

test("grouping ignores malformed rows and orders dates and periods", () => {
  const days = core.groupRows([
    { assignmentDate: "2026-11-24", absentTeacherName: "أحمد", period: 3, className: "5/1", substituteTeacherName: "خالد" },
    { assignmentDate: "2026-11-24", absentTeacherName: "أحمد", period: 1, className: "4/1", substituteTeacherName: "سالم" },
    { assignmentDate: "not-a-date", absentTeacherName: "مجهول", period: 1 },
    { assignmentDate: "2026-11-23", absentTeacherName: "محمد", period: 2 }
  ]);
  assert.deepEqual(days.map((day) => day.date), ["2026-11-24", "2026-11-23"]);
  assert.deepEqual(days[0].groups[0].rows.map((row) => row.period), [1, 3]);
  assert.equal(days[0].groups[0].rows.length, 2);
});
