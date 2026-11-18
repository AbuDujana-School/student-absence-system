export const TEACHER_TIMETABLE_FALLBACK_FILTER =
  "matched_teacher_name.is.null,match_status.is.null,match_status.neq.matched";

export type TeacherTimetableCell = {
  matched_teacher_name?: unknown;
  teacher_source_name?: unknown;
  [key: string]: unknown;
};

/**
 * Combine indexed exact-name rows with legacy rows resolved through source names.
 * Exact-name rows are excluded from fallback to avoid duplicates.
 */
export function selectTeacherTimetableCells<T extends TeacherTimetableCell>(
  matchedRows: T[],
  fallbackRows: T[],
  teacherName: string,
  resolveName: (cell: T) => string | null,
): T[] {
  const fallback = fallbackRows.filter((cell) =>
    cell.matched_teacher_name !== teacherName && resolveName(cell) === teacherName
  );
  return [...matchedRows, ...fallback];
}
