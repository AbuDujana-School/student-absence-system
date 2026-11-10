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
