/** Builds the public competition response without leaking other teams' detailed metrics. */
type ScoredTeam = {
  grade: string;
  score: number | null;
  rank: number | null;
  attendancePoints: number | null;
  behaviorPoints: number | null;
  complete: boolean;
  attendanceRate?: number | null;
  behaviorRate?: number | null;
  attendanceIncidents?: number;
  behaviorIncidents?: number;
  studentDays?: number;
};

export function projectCompetitionTeams(
  teams: ScoredTeam[],
  isAdmin: boolean,
  ownGrades: string[],
  allTeamsComplete: boolean
) {
  const visibleGrades = new Set((Array.isArray(ownGrades) ? ownGrades : []).map(String));
  return (Array.isArray(teams) ? teams : []).map(team => ({
    grade: team.grade,
    score: allTeamsComplete ? team.score : null,
    rank: allTeamsComplete ? team.rank : null,
    attendancePoints: allTeamsComplete ? team.attendancePoints : null,
    behaviorPoints: allTeamsComplete ? team.behaviorPoints : null,
    complete: allTeamsComplete && team.complete === true,
    ...(isAdmin || visibleGrades.has(String(team.grade)) ? {
      attendanceRate: team.attendanceRate,
      behaviorRate: team.behaviorRate,
      attendanceIncidents: team.attendanceIncidents,
      behaviorIncidents: team.behaviorIncidents,
      studentDays: team.studentDays
    } : {})
  }));
}

/** Projects class comparison rates without exposing other teams' class assignments or metrics. */
export function projectCompetitionClassComparison(
  items: Array<Record<string, unknown>>,
  isAdmin: boolean,
  ownTeamIds: string[]
) {
  const visibleTeamIds = new Set((Array.isArray(ownTeamIds) ? ownTeamIds : []).map(String));
  return (Array.isArray(items) ? items : [])
    .filter(item => isAdmin || visibleTeamIds.has(String(item.teamId || "")))
    .map(item => ({
      teamName: String(item.teamName || ""),
      leaderName: String(item.leaderName || ""),
      className: String(item.className || ""),
      complete: item.complete === true,
      attendanceRate: item.complete === true && Number.isFinite(Number(item.attendanceRate)) ? Number(item.attendanceRate) : null,
      behaviorRate: item.complete === true && Number.isFinite(Number(item.behaviorRate)) ? Number(item.behaviorRate) : null,
      attendanceStatusCounts: item.complete === true && item.attendanceStatusCounts && typeof item.attendanceStatusCounts === "object" ? item.attendanceStatusCounts : null,
      behaviorTypeCounts: item.complete === true && item.behaviorTypeCounts && typeof item.behaviorTypeCounts === "object" ? item.behaviorTypeCounts : null,
      repeatAttendanceStudents: item.complete === true && Number.isFinite(Number(item.repeatAttendanceStudents)) ? Number(item.repeatAttendanceStudents) : null,
      repeatBehaviorStudents: item.complete === true && Number.isFinite(Number(item.repeatBehaviorStudents)) ? Number(item.repeatBehaviorStudents) : null
    }));
}
