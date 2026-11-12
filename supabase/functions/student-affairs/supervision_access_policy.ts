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
    can_view_analytics: base.can_view_analytics === true || visitor,
    can_print_attendance: visitor,
    can_print_behavior: visitor,
    can_print_combined: visitor,
    supervision_teacher_name: target.name,
  };
}
