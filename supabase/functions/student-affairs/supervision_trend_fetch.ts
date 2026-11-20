/** Batched, paginated reads for Student Affairs supervision trend reports. */
export type SupervisionTrendTable = "attendance" | "behaviors";

const PAGE_SIZE = 1000;

/**
 * Fetch rows for all authorized classes in one query per page rather than
 * issuing a serial request for every class. Stable ordering prevents page
 * boundaries from moving between rows that share the same date.
 */
export async function fetchSupervisionTrendRows(
  db: any,
  table: SupervisionTrendTable,
  classNames: string[],
  from: string,
  to: string,
): Promise<any[]> {
  const classes = [...new Set(classNames.map((value) => String(value)).filter(Boolean))];
  if (!classes.length) return [];

  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db.from(table)
      .select("date_str,class_name,records")
      .in("class_name", classes)
      .gte("date_str", from)
      .lte("date_str", to)
      .order("date_str", { ascending: true })
      .order("class_name", { ascending: true })
      .order("record_key", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;

    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}
