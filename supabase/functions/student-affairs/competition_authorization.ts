/** Pure server-side authorization policy for the stage competition. */
export const COMPETITION_GRADES = ["9", "10", "11", "12"] as const;
export const COMPETITION_REQUIRED_ATTENDANCE_STATUSES = ["absent", "late", "outside", "escape"] as const;

export type CompetitionPermissions = {
  can_view_competition?: boolean;
  // Retained in the type for compatibility; competition authorization does not depend on them.
  can_view_analytics?: boolean;
  can_read_attendance?: boolean;
  can_read_behavior?: boolean;
  attendance_statuses?: unknown;
  allowed_attendance_classes?: unknown;
  allowed_behavior_classes?: unknown;
};

export type CompetitionAuthorization = {
  allowed: boolean;
  ownGrades: string[];
  reason?: "missing_competition_permission";
  message?: string;
};

export function authorizeCompetitionAccess(
  principalType: string,
  permissions: CompetitionPermissions,
  _classesByGrade: Record<string, string[]>,
  grades: string[] = [...COMPETITION_GRADES]
): CompetitionAuthorization {
  if (principalType === "admin") return { allowed: true, ownGrades: [...grades] };
  if (permissions?.can_view_competition !== true) {
    return { allowed: false, ownGrades: [], reason: "missing_competition_permission", message: "لا تملك صلاحية مشاهدة لوحة سباق التميز." };
  }
  // Teachers receive only the four stage-level aggregates, never class-level metrics or student records.
  return { allowed: true, ownGrades: [] };
}
