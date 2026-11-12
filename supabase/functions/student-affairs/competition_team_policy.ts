/** Pure validation and projection helpers for teacher-led excellence teams. */
export type TeacherTeamConfig = {
  name: string;
  role?: string;
  permissions?: {
    competition_participant?: boolean;
    competition_team_name?: string;
    competition_team_classes?: string[];
  } | null;
};

export type CompetitionTeam = {
  teamId: string;
  teamName: string;
  leaderName: string;
  classNames: string[];
};

export function buildCompetitionTeams(teachers: TeacherTeamConfig[], allClasses: string[]): CompetitionTeam[] {
  const validClasses = new Set((Array.isArray(allClasses) ? allClasses : []).map(value => String(value || "").trim()).filter(Boolean));
  const assigned = new Map<string, string>();
  const teams: CompetitionTeam[] = [];

  for (const teacher of Array.isArray(teachers) ? teachers : []) {
    const permissions = teacher?.permissions || {};
    if (permissions.competition_participant !== true) continue;
    if (teacher.role === "custom") throw new Error("لا يمكن إضافة مستخدم مخصص إلى سباق التميز؛ المشاركة مخصصة للمعلمين.");
    const teamName = String(permissions.competition_team_name || "").trim();
    const classNames = [...new Set((Array.isArray(permissions.competition_team_classes) ? permissions.competition_team_classes : [])
      .map(value => String(value || "").trim()).filter(Boolean))];
    if (!teamName) throw new Error("يوجد معلم مشارك دون اسم فريق.");
    if (!classNames.length) throw new Error("يجب تحديد صف واحد على الأقل لكل فريق مشارك.");
    for (const className of classNames) {
      if (!validClasses.has(className)) throw new Error("يوجد صف غير معتمد ضمن تكليف أحد الفرق.");
      const previous = assigned.get(className);
      if (previous) throw new Error("لا يمكن إسناد الصف نفسه إلى أكثر من فريق: " + className);
      assigned.set(className, teacher.name);
    }
    teams.push({ teamId: teacher.name, teamName, leaderName: teacher.name, classNames });
  }

  return teams.sort((a, b) => a.teamName.localeCompare(b.teamName, "ar") || a.leaderName.localeCompare(b.leaderName, "ar"));
}

/** Returns competition classes that are outside the teacher's own assigned classes. */
export function findCompetitionClassesOutsidePersonalScope(competitionClasses: unknown[], personalClasses: unknown[]): string[] {
  const personal = new Set((Array.isArray(personalClasses) ? personalClasses : []).map(value => String(value || "").trim()).filter(Boolean));
  return [...new Set((Array.isArray(competitionClasses) ? competitionClasses : []).map(value => String(value || "").trim()).filter(Boolean))]
    .filter(className => !personal.has(className));
}

export function projectCompetitionTeam(team: CompetitionTeam, metric: Record<string, unknown>) {
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    leaderName: team.leaderName,
    classNames: [...team.classNames],
    ...metric
  };
}
