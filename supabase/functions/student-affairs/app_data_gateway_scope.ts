export type TimetableScopeCell = {
  matched_teacher_name?: unknown;
  match_status?: unknown;
  cell_status?: unknown;
  class_sections?: unknown;
};

/**
 * Resolve only explicitly matched teaching placements for the exact authenticated
 * principal name. Free periods, duties, unmatched rows, and other teachers never
 * grant student-data scope.
 */
export function projectAssignedClassScope(
  rows: readonly TimetableScopeCell[],
  principalName: string,
): string[] {
  const name = principalName.trim();
  if (!name || !Array.isArray(rows)) return [];
  const classes = new Set<string>();
  for (const row of rows) {
    if (row?.matched_teacher_name !== name ||
      row.match_status !== "matched" ||
      row.cell_status !== "teaching" ||
      !Array.isArray(row.class_sections)) continue;
    for (const value of row.class_sections) {
      if (typeof value !== "string") continue;
      const className = value.trim();
      if (className && className.length <= 120) classes.add(className);
    }
  }
  return [...classes].sort((a, b) => a.localeCompare(b, "en"));
}

export type ExplicitAppDataClassGrants = {
  allowed_classes?: unknown;
  allowed_attendance_classes?: unknown;
  allowed_behavior_classes?: unknown;
  can_read_attendance?: unknown;
  can_read_behavior?: unknown;
};

function cleanClassNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120
  ).map(value => value.trim()))].sort((a, b) => a.localeCompare(b, "en"));
}

/** Combine trusted timetable assignments with separately granted Student Affairs scopes. */
export function mergeAppDataClassScopes(
  timetableClasses: readonly string[],
  grants: ExplicitAppDataClassGrants | null,
): { allowedClasses: string[]; allowedAttendanceClasses: string[]; allowedBehaviorClasses: string[] } {
  const general = cleanClassNames(grants?.allowed_classes);
  const attendance = grants?.can_read_attendance === false ? [] :
    Array.isArray(grants?.allowed_attendance_classes)
      ? cleanClassNames(grants?.allowed_attendance_classes) : general;
  const behavior = grants?.can_read_behavior === false ? [] :
    Array.isArray(grants?.allowed_behavior_classes)
      ? cleanClassNames(grants?.allowed_behavior_classes) : general;
  return {
    allowedClasses: cleanClassNames([...timetableClasses, ...general]),
    allowedAttendanceClasses: cleanClassNames([...timetableClasses, ...attendance]),
    allowedBehaviorClasses: cleanClassNames([...timetableClasses, ...behavior]),
  };
}
