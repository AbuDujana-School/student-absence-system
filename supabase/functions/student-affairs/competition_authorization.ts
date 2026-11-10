/** Pure server-side authorization policy for the stage competition. */
export const COMPETITION_GRADES = ["9", "10", "11", "12"] as const;
export const COMPETITION_REQUIRED_ATTENDANCE_STATUSES = ["absent", "late", "outside", "escape"] as const;

export type CompetitionPermissions = {
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
  reason?: "missing_permissions" | "missing_statuses" | "incomplete_grade_scope";
  message?: string;
};

export function authorizeCompetitionAccess(
  principalType: string,
  permissions: CompetitionPermissions,
  classesByGrade: Record<string, string[]>,
  grades: string[] = [...COMPETITION_GRADES]
): CompetitionAuthorization {
  if (principalType === "admin") return { allowed: true, ownGrades: [...grades] };

  if (
    permissions?.can_view_analytics !== true ||
    permissions?.can_read_attendance !== true ||
    permissions?.can_read_behavior !== true
  ) {
    return {
      allowed: false,
      ownGrades: [],
      reason: "missing_permissions",
      message: "تحتاج لوحة المنافسة إلى صلاحيات التحليلات وقراءة الغياب والسلوك معاً."
    };
  }

  const statuses = Array.isArray(permissions.attendance_statuses)
    ? permissions.attendance_statuses
    : [];
  if (COMPETITION_REQUIRED_ATTENDANCE_STATUSES.some(status => !statuses.includes(status))) {
    return {
      allowed: false,
      ownGrades: [],
      reason: "missing_statuses",
      message: "يجب السماح بحالات الغياب والتأخر والخروج والتسرب جميعها لاحتساب نقاط المنافسة."
    };
  }

  const attendance = Array.isArray(permissions.allowed_attendance_classes)
    ? permissions.allowed_attendance_classes
    : [];
  const behavior = Array.isArray(permissions.allowed_behavior_classes)
    ? permissions.allowed_behavior_classes
    : [];
  const jointlyAllowed = new Set(attendance.filter(name => behavior.includes(name)));
  const ownGrades = [...new Set(
    Object.entries(classesByGrade)
      .filter(([grade, classNames]) =>
        grades.includes(grade) &&
        classNames.length > 0 &&
        classNames.every(name => jointlyAllowed.has(name))
      )
      .map(([grade]) => grade)
  )].sort((a, b) => grades.indexOf(a) - grades.indexOf(b));

  if (!ownGrades.length) {
    return {
      allowed: false,
      ownGrades: [],
      reason: "incomplete_grade_scope",
      message: "يجب تخصيص جميع شعب مرحلة واحدة على الأقل لقائد الفريق في الغياب والسلوك قبل تفعيل المنافسة."
    };
  }

  return { allowed: true, ownGrades };
}
