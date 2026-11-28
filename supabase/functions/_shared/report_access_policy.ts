export const REPORT_PERMISSION_KEYS = [
  "reportMorningAssemblyLateness",
  "reportStudentAffairs",
  "reportComprehensiveAbsence",
  "reportClassLatenessFollowup",
  "reportSubstitutionDistribution",
] as const;

export type ReportPermissionKey = typeof REPORT_PERMISSION_KEYS[number];

export function hasExplicitReportPermissions(permissions: Record<string, unknown> | null | undefined): boolean {
  const value = permissions && typeof permissions === "object" ? permissions : {};
  return REPORT_PERMISSION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function hasAdminRecordsCenterAccess(
  principalType: string,
  permissions: Record<string, unknown> | null | undefined,
  isGeneralAdmin = false,
): boolean {
  if (principalType === "admin" && isGeneralAdmin) return true;
  const value = permissions && typeof permissions === "object" ? permissions : {};
  const overrides = value.additionalAdminOverrides && typeof value.additionalAdminOverrides === "object"
    ? value.additionalAdminOverrides as Record<string, unknown> : {};
  return value.adminRecords === true || value.canViewAdminRecords === true || overrides.adminRecords === true;
}

/** Explicit per-report flags take precedence over the legacy broad reports flag. */
export function canAccessReportPermission(
  principalType: string,
  permissions: Record<string, unknown> | null | undefined,
  report: ReportPermissionKey,
  isGeneralAdmin = false,
  adminRecordsCenterAccess = false,
): boolean {
  if (principalType === "admin" && isGeneralAdmin) return true;
  if (report === "reportStudentAffairs" && adminRecordsCenterAccess) return true;
  const value = permissions && typeof permissions === "object" ? permissions : {};
  // A legacy broad flag cannot identify which report was approved.
  // Require an explicit grant for each report; only the explicitly identified general administrator retains the bypass above.
  return value[report] === true;
}
