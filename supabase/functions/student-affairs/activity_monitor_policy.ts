export type ActivityPrincipal = { type?: unknown; permissions?: unknown } | null | undefined;
export function canReadStudentAffairsActivityReport(principal: ActivityPrincipal): boolean {
  if (!principal || typeof principal !== "object") return false;
  if (principal.type === "admin") return true;
  if (principal.type !== "teacher" || !principal.permissions || typeof principal.permissions !== "object" || Array.isArray(principal.permissions)) return false;
  return (principal.permissions as Record<string, unknown>).studstats === true;
}
export function isStudentAffairsActivityTeacher(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.role === "custom") return false;
  const permissions = row.permissions && typeof row.permissions === "object" && !Array.isArray(row.permissions)
    ? row.permissions as Record<string, unknown> : {};
  return permissions.studentAffairs === true ||
    ["team_leader", "supervisor", "visitor"].includes(String(permissions.student_affairs_role || ""));
}
export function validActivityEventType(value: unknown): value is "section_access" | "absence_report_view" | "behavior_report_view" | "official_warning_print" {
  return ["section_access", "absence_report_view", "behavior_report_view", "official_warning_print"].includes(String(value));
}
