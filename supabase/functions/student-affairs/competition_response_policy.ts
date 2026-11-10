/** Exposes team-level comparison rates while protecting class-level detail for other teams. */
type ScoredTeam = {
  grade: string; teamId?: string; teamName?: string; leaderName?: string; classNames?: string[];
  score: number | null; rank: number | null; weeklyPoints: number | null; totalPoints?: number;
  attendancePoints?: number | null; behaviorPoints?: number | null; complete: boolean;
  attendanceRate?: number | null; behaviorRate?: number | null;
  attendanceIncidents?: number; behaviorIncidents?: number; classCount?: number;
};
export function projectCompetitionTeams(teams: ScoredTeam[], isAdmin: boolean, ownGrades: string[], allTeamsComplete: boolean) {
  const visibleGrades = new Set((Array.isArray(ownGrades) ? ownGrades : []).map(String));
  return (Array.isArray(teams) ? teams : []).map(team => ({
    grade: team.grade, teamId: team.teamId, teamName: team.teamName, leaderName: team.leaderName,
    classNames: Array.isArray(team.classNames) ? [...team.classNames] : [],
    score: allTeamsComplete ? team.score : null, rank: allTeamsComplete ? team.rank : null,
    weeklyPoints: allTeamsComplete ? team.weeklyPoints : null,
    totalPoints: allTeamsComplete && team.totalPoints != null ? Number(team.totalPoints) : null,
    attendancePoints: allTeamsComplete ? team.attendancePoints : null,
    behaviorPoints: allTeamsComplete ? team.behaviorPoints : null,
    complete: allTeamsComplete && team.complete === true,
    attendanceRate: allTeamsComplete ? team.attendanceRate : null,
    behaviorRate: allTeamsComplete ? team.behaviorRate : null,
    ...(isAdmin || visibleGrades.has(String(team.grade)) ? {
      attendanceIncidents: team.attendanceIncidents, behaviorIncidents: team.behaviorIncidents, classCount: team.classCount
    } : {})
  }));
}
