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
