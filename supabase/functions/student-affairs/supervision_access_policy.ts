/** Server-side team membership checks for Student Affairs supervision. */
export type SupervisionTeacherRecord = {
  name: string;
  role?: string;
  permissions?: Record<string, unknown> | null;
};

/**
 * A supervisor belongs to one leader only when an explicit leader is stored.
 * Legacy records without that field continue to use the existing team-name match.
 */
export function isDirectSupervisionMember(
  teacher: SupervisionTeacherRecord,
  leaderName: string,
  leaderTeamName: string,
): boolean {
  if (!teacher || !teacher.name || teacher.name === leaderName || teacher.role === "custom") return false;
  const permissions = teacher.permissions || {};
  if (permissions.studentAffairs !== true || permissions.student_affairs_role !== "supervisor") return false;
  const explicitLeader = String(permissions.supervisor_team_leader_name || "").trim();
  if (explicitLeader) return explicitLeader === leaderName;
  return String(permissions.student_affairs_team_name || "").trim() === leaderTeamName;
}

/** Centralized Student Affairs supervision scope rules. */
export type SupervisionTeacher = {
  name: string;
  allowed_attendance_classes?: string[];
  allowed_behavior_classes?: string[];
  attendance_statuses?: string[];
  can_read_attendance?: boolean;
  can_read_behavior?: boolean;
  can_view_analytics?: boolean;
  can_print_attendance?: boolean;
  can_print_behavior?: boolean;
  can_print_combined?: boolean;
};

const ALL_ATTENDANCE_STATUSES = ["absent", "late", "escape", "outside"];

function unique(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

/** A leader may open only directly assigned team supervisors; a visitor may open any listed Student Affairs teacher. */
export function resolveSupervisionTeacher(
  role: string,
  targetName: string,
  teamMembers: SupervisionTeacher[],
  teacherDirectory: SupervisionTeacher[],
): SupervisionTeacher | null {
  const name = String(targetName || "").trim();
  if (!name) return null;
  const source = role === "visitor" ? teacherDirectory : role === "team_leader" ? teamMembers : [];
  return source.find((teacher) => teacher.name === name) || null;
}

/** Visitors have global read/analysis/print access, but no personal class ownership or competition participation. */
export function buildVisitorAccess(allClasses: string[], teacherDirectory: SupervisionTeacher[]) {
  const classes = unique(allClasses);
  return {
    role: "visitor",
    team_name: "",
    own_allowed_attendance_classes: [] as string[],
    own_allowed_behavior_classes: [] as string[],
    team_allowed_attendance_classes: [] as string[],
    team_allowed_behavior_classes: [] as string[],
    allowed_classes: classes,
    allowed_attendance_classes: classes,
    allowed_behavior_classes: classes,
    attendance_statuses: [...ALL_ATTENDANCE_STATUSES],
    can_read_attendance: true,
    can_read_behavior: true,
    can_view_analytics: true,
    can_view_competition: true,
    competition_participant: false,
    can_print_attendance: true,
    can_print_behavior: true,
    can_print_combined: true,
    team_members: [] as SupervisionTeacher[],
    teacher_directory: teacherDirectory,
  };
}

/** Resolves a selected leader only when that leader is active and is not the teacher being assigned. */
export function resolveTeamLeader(selectedName: string, targetName: string, leaders: Array<{ name: string; role?: string; studentAffairs?: boolean; teamName?: string }>) {
  const name = String(selectedName || "").trim();
  if (!name || name === String(targetName || "").trim()) return null;
  return leaders.find((leader) => leader.name === name && leader.role === "team_leader" && leader.studentAffairs === true && String(leader.teamName || "").trim()) || null;
}

/**
 * Team leaders may print notices for a directly resolved team member.
 * This grant is deliberately limited to notice workflows; ordinary reports
 * continue to honor the member's own print permissions.
 */
export function applyTeamLeaderNoticePrintAccess<T extends Record<string, any>>(
  permissions: T,
  viewerRole: string,
  target: SupervisionTeacher | null,
  mode: string,
): T {
  if (viewerRole !== "team_leader" || !target || !["notice_scan", "notice_history", "notice_issue_commit"].includes(mode)) {
    return permissions;
  }
  return {
    ...permissions,
    can_print_attendance: true,
    can_print_behavior: true,
    can_print_combined: true,
  };
}

/** Projects an authorized colleague's report scope without changing the viewer's own assignments. */
export function projectSupervisionReportPermissions<T extends Record<string, any>>(
  base: T,
  target: SupervisionTeacher,
  visitor: boolean,
) {
  const attendance = unique(target.allowed_attendance_classes || []);
  const behavior = unique(target.allowed_behavior_classes || []);
  const statuses = unique(target.attendance_statuses || ALL_ATTENDANCE_STATUSES);
  return {
    ...base,
    allowed_classes: unique([...attendance, ...behavior]),
    allowed_attendance_classes: attendance,
    allowed_behavior_classes: behavior,
    attendance_statuses: visitor ? [...ALL_ATTENDANCE_STATUSES] : statuses,
    can_read_attendance: true,
    can_read_behavior: true,
    can_view_analytics: target.can_view_analytics === true || base.can_view_analytics === true || visitor,
    can_print_attendance: visitor || target.can_print_attendance === true,
    can_print_behavior: visitor || target.can_print_behavior === true,
    can_print_combined: visitor || target.can_print_combined === true,
    supervision_teacher_name: target.name,
  };
}
