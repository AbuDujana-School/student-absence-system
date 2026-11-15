export type TimetablePageResult<T> = {
  data: T[] | null;
  error: unknown;
};

/**
 * Read a PostgREST result in bounded pages. A stable ordering must be applied
 * by the caller before range(from, to) so no rows are skipped between pages.
 */
export async function fetchAllTimetablePages<T>(
  queryForRange: (from: number, to: number) => PromiseLike<TimetablePageResult<T>>,
  pageSize = 1000,
  maxRows = 25000,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxRows) || maxRows < pageSize) {
    throw new Error("Invalid timetable pagination limits");
  }
  const rows: T[] = [];
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    const { data, error } = await queryForRange(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    if (page.length === 0) return rows;
    if (rows.length + page.length > maxRows) {
      throw new Error("Weekly timetable exceeds the safe pagination limit");
    }
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  return rows;
}
