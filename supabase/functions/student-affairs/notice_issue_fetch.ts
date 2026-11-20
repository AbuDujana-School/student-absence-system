/** Batched reads for the historical rows used when issuing Student Affairs notices. */
export type NoticeSourceTable = "attendance" | "behaviors";

const NOTICE_CLASS_ROW_LIMIT = 5000;
const NOTICE_COLUMNS = "record_key,date_str,class_name,period,records";

function limitError(year: number): Error {
  return new Error("بلغت سجلات أحد الصفوف الحد الأقصى في سنة " + year + ". لم نعتمد أي تنبيه حتى لا تكون النتائج ناقصة.");
}

/**
 * Read a year's rows for the authorized class set in one request when the
 * combined result is small. If the combined result exceeds the safe batch
 * window, retain the previous per-class limit behavior instead of truncating.
 */
export async function fetchNoticeRowsForClasses(
  db: any,
  table: NoticeSourceTable,
  classNames: string[],
  from: string,
  to: string,
  year: number,
): Promise<any[]> {
  const classes = [...new Set(classNames.map((value) => String(value)).filter(Boolean))];
  if (!classes.length) return [];

  const batch = await db.from(table)
    .select(NOTICE_COLUMNS, { count: "exact" })
    .in("class_name", classes)
    .gte("date_str", from)
    .lte("date_str", to)
    .order("date_str", { ascending: true })
    .order("class_name", { ascending: true })
    .order("record_key", { ascending: true })
    .limit(NOTICE_CLASS_ROW_LIMIT);

  if (batch.error) throw new Error("تعذر قراءة سجلات المخالفات التاريخية.");
  const batchRows: any[] = Array.isArray(batch.data) ? batch.data : [];
  const hasExactCount = typeof batch.count === "number" && Number.isFinite(batch.count);
  const total = hasExactCount ? Number(batch.count) : batchRows.length;
  const batchIsComplete = hasExactCount
    ? total <= NOTICE_CLASS_ROW_LIMIT && batchRows.length === total
    : batchRows.length < NOTICE_CLASS_ROW_LIMIT;

  if (batchIsComplete) {
    const perClass = new Map<string, number>();
    for (const row of batchRows) {
      const className = String(row.class_name || "");
      if (!classes.includes(className)) throw new Error("وصل سجل من صف خارج النطاق المصرح به.");
      perClass.set(className, (perClass.get(className) || 0) + 1);
    }
    if ([...perClass.values()].some((count) => count >= NOTICE_CLASS_ROW_LIMIT)) throw limitError(year);
    return batchRows;
  }

  // The batch count is above the safe window (or the count metadata is absent
  // at the limit). Fall back to the old per-class reads and enforce the same
  // 5,000-row ceiling independently for each class.
  const rowsByClass = new Map<string, any[]>();
  const fallbackErrors: Error[] = [];
  let classCursor = 0;
  const fallbackWorker = async () => {
    while (classCursor < classes.length) {
      const className = classes[classCursor++];
      try {
        const result = await db.from(table)
          .select(NOTICE_COLUMNS)
          .eq("class_name", className)
          .gte("date_str", from)
          .lte("date_str", to)
          .order("date_str", { ascending: true })
          .limit(NOTICE_CLASS_ROW_LIMIT);
        if (result.error) throw new Error("تعذر قراءة سجلات المخالفات التاريخية.");
        const page: any[] = Array.isArray(result.data) ? result.data : [];
        if (page.length >= NOTICE_CLASS_ROW_LIMIT) throw limitError(year);
        for (const row of page) {
          if (String(row.class_name || "") !== className) throw new Error("وصل سجل من صف خارج النطاق المصرح به.");
        }
        rowsByClass.set(className, page);
      } catch (error) {
        fallbackErrors.push(error instanceof Error ? error : new Error("تعذر قراءة السجلات."));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, classes.length) }, () => fallbackWorker()));
  if (fallbackErrors.length) throw fallbackErrors[0];
  return classes.flatMap((className) => rowsByClass.get(className) || []);
}
