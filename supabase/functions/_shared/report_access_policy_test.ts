import { canAccessReportPermission, hasAdminRecordsCenterAccess, hasExplicitReportPermissions } from "./report_access_policy.ts";

Deno.test("legacy broad reports permission does not grant any individual report", () => {
  const legacy = { reports: true };
  assert(!hasExplicitReportPermissions(legacy), "legacy permissions should not be treated as granular");
  for (const report of ["reportMorningAssemblyLateness", "reportStudentAffairs", "reportComprehensiveAbsence", "reportClassLatenessFollowup", "reportSubstitutionDistribution"] as const) {
    assert(!canAccessReportPermission("teacher", legacy, report), "legacy reports must not grant an unselected report");
  }
});

Deno.test("explicit report permissions grant only the selected report", () => {
  const permissions = {
    reports: true,
    reportMorningAssemblyLateness: false,
    reportStudentAffairs: true,
    reportComprehensiveAbsence: false,
    reportClassLatenessFollowup: false,
    reportSubstitutionDistribution: false,
  };
  assert(canAccessReportPermission("teacher", permissions, "reportStudentAffairs"), "selected report should be allowed");
  assert(!canAccessReportPermission("teacher", permissions, "reportMorningAssemblyLateness"), "unselected morning report must be denied");
  assert(!canAccessReportPermission("teacher", permissions, "reportComprehensiveAbsence"), "unselected absence report must be denied");
  assert(!canAccessReportPermission("teacher", permissions, "reportClassLatenessFollowup"), "unselected lesson lateness report must be denied");
});

Deno.test("explicit false flags override legacy broad access", () => {
  const permissions = {
    reports: true,
    reportMorningAssemblyLateness: false,
    reportStudentAffairs: false,
    reportComprehensiveAbsence: false,
    reportClassLatenessFollowup: false,
  };
  assert(!canAccessReportPermission("teacher", permissions, "reportStudentAffairs"), "explicit false must not fall back to legacy reports");
});

Deno.test("administrator bypasses report flags while ordinary accounts without grants are denied", () => {
  assert(canAccessReportPermission("admin", {}, "reportStudentAffairs", true), "general administrator should retain full access");
  assert(!canAccessReportPermission("admin", {}, "reportSubstitutionDistribution", false), "additional administrator must not inherit general-admin bypass");
  assert(canAccessReportPermission("admin", { reportSubstitutionDistribution: true }, "reportSubstitutionDistribution", false), "explicit additional-admin grant should allow the reserve report");
  assert(!canAccessReportPermission("teacher", {}, "reportStudentAffairs"), "no report grant should be denied");
  assert(!canAccessReportPermission("custom", { reports: false }, "reportMorningAssemblyLateness"), "custom account without grant should be denied");
});

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}


Deno.test("reserve distribution report is detected as an explicit report permission", () => {
  assert(hasExplicitReportPermissions({ reportSubstitutionDistribution: false }), "reserve report flag should be part of granular report permissions");
});


Deno.test("administrative-records access is an explicit, center-scoped report grant", () => {
  assert(hasAdminRecordsCenterAccess("teacher", { adminRecords: true }), "explicit adminRecords grant should be recognized");
  assert(hasAdminRecordsCenterAccess("teacher", { additionalAdminOverrides: { adminRecords: true } }), "nested additional-admin override should be recognized");
  assert(!hasAdminRecordsCenterAccess("teacher", { additionalAdmin: true }), "Additional Admin alone must not grant the records center");
  assert(!hasAdminRecordsCenterAccess("teacher", {}), "accounts without the portal grant remain denied");
  assert(canAccessReportPermission("teacher", {}, "reportStudentAffairs", false, true), "center grant should unlock Student Affairs reports within the center");
  assert(!canAccessReportPermission("teacher", {}, "reportSubstitutionDistribution", false, true), "center report bypass must not become a generic per-report backend grant");
});
