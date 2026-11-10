/** Independent server-side authorization for aggregate stage competition viewing. */
export const COMPETITION_GRADES = ["9", "10", "11", "12"] as const;

export type CompetitionPermissions = {
  can_view_competition?: boolean;
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
  classesByGrade: Record<string, string[]>,
  grades: string[] = [...COMPETITION_GRADES]
): CompetitionAuthorization {
  if (principalType === "admin") return { allowed: true, ownGrades: [...grades] };

  if (permissions?.can_view_competition !== true) {
    return {
      allowed: false,
      ownGrades: [],
      reason: "missing_competition_permission",
      message: "ليست لديك صلاحية مشاهدة سباق التميز بين المراحل."
    };
  }

  // Aggregate team rankings are visible to authorized viewers. Detailed class
  // insights remain limited to grades fully assigned in both attendance and behavior.
  const attendance = Array.isArray(permissions.allowed_attendance_classes) ? permissions.allowed_attendance_classes : [];
  const behavior = Array.isArray(permissions.allowed_behavior_classes) ? permissions.allowed_behavior_classes : [];
  const jointlyAllowed = new Set(attendance.filter(name => behavior.includes(name)));
  const ownGrades = [...new Set(
    Object.entries(classesByGrade)
      .filter(([grade, classNames]) => grades.includes(grade) && classNames.length > 0 && classNames.every(name => jointlyAllowed.has(name)))
      .map(([grade]) => grade)
  )].sort((a, b) => grades.indexOf(a) - grades.indexOf(b));

  return { allowed: true, ownGrades };
}
