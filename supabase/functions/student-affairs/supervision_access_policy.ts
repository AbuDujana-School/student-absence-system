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
