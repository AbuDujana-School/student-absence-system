/** Batched attendance/behavior reads for Student Affairs analytics. */
export type AnalyticsSourceTable = "attendance" | "behaviors";

const BATCH_ROW_LIMIT = 5000;

export type AnalyticsBatchResult = {
  attendanceRowsByClass: Map<string, any[]>;
  attendanceSessionsByClass: Map<string, number>;
  behaviorSessionsByClass: Map<string, number>;
};

async function fetchAttendance(
  db: any,
  classes: string[],
  from: string,
  to: string,
): Promise<{ rowsByClass: Map<string, any[]>; countsByClass: Map<string, number> }> {
  const rowsByClass = new Map<string, any[]>();
  const countsByClass = new Map<string, number>();
  if (!classes.length) return { rowsByClass, countsByClass };

  const batch = await db.from("attendance")
    .select("record_key,date_str,class_name,records", { count: "exact" })
    .in("class_name", classes)
    .gte("date_str", from)
    .lte("date_str", to)
    .limit(BATCH_ROW_LIMIT);

  if (batch.error) throw new Error("تعذر تحميل التحليلات");
  const batchRows: any[] = Array.isArray(batch.data) ? batch.data : [];
  const hasExactCount = typeof batch.count === "number" && Number.isFinite(batch.count);
  const total = hasExactCount ? Number(batch.count) : batchRows.length;
  const complete = hasExactCount && total <= BATCH_ROW_LIMIT && batchRows.length === total;

  if (complete) {
    for (const className of classes) {
      rowsByClass.set(className, []);
      countsByClass.set(className, 0);
    }
    for (const row of batchRows) {
      const className = String(row.class_name || "");
      if (!classes.includes(className)) throw new Error("تعذر تحميل التحليلات");
      rowsByClass.get(className)!.push(row);
      countsByClass.set(className, (countsByClass.get(className) || 0) + 1);
    }
    return { rowsByClass, countsByClass };
  }

  // Preserve the original per-class exact session count and 5,000-row
  // response cap whenever a complete combined result cannot be proven.
  for (const className of classes) {
    rowsByClass.set(className, []);
    countsByClass.set(className, 0);
  }
  let cursor = 0;
  const errors: Error[] = [];
  const worker = async () => {
    while (cursor < classes.length) {
      const className = classes[cursor++];
      try {
        const result = await db.from("attendance")
          .select("record_key,date_str,records", { count: "exact" })
          .eq("class_name", className)
          .gte("date_str", from)
          .lte("date_str", to)
          .limit(BATCH_ROW_LIMIT);
        if (result.error) throw new Error("تعذر تحميل التحليلات");
        const rows: any[] = Array.isArray(result.data) ? result.data : [];
        rowsByClass.set(className, rows);
        countsByClass.set(className, Number.isFinite(result.count) ? Number(result.count) : rows.length);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error("تعذر تحميل التحليلات"));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, classes.length) }, () => worker()));
  if (errors.length) throw errors[0];
  return { rowsByClass, countsByClass };
}

async function fetchBehaviorCounts(
  db: any,
  classes: string[],
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const countsByClass = new Map<string, number>();
  if (!classes.length) return countsByClass;

  const batch = await db.from("behaviors")
    .select("class_name,record_key", { count: "exact" })
    .in("class_name", classes)
    .gte("date_str", from)
    .lte("date_str", to)
    .limit(BATCH_ROW_LIMIT);

  if (batch.error) throw new Error("تعذر تحميل التحليلات");
  const batchRows: any[] = Array.isArray(batch.data) ? batch.data : [];
  const hasExactCount = typeof batch.count === "number" && Number.isFinite(batch.count);
  const total = hasExactCount ? Number(batch.count) : batchRows.length;
  const complete = hasExactCount && total <= BATCH_ROW_LIMIT && batchRows.length === total;

  if (complete) {
    for (const className of classes) countsByClass.set(className, 0);
    for (const row of batchRows) {
      const className = String(row.class_name || "");
      if (!classes.includes(className)) throw new Error("تعذر تحميل التحليلات");
      countsByClass.set(className, (countsByClass.get(className) || 0) + 1);
    }
    return countsByClass;
  }

  // Large behavior ranges keep the old exact HEAD count per class, avoiding
  // downloading a potentially large behavior history just to count it.
  let cursor = 0;
  const errors: Error[] = [];
  const worker = async () => {
    while (cursor < classes.length) {
      const className = classes[cursor++];
      try {
        const result = await db.from("behaviors")
          .select("record_key", { count: "exact", head: true })
          .eq("class_name", className)
          .gte("date_str", from)
          .lte("date_str", to);
        if (result.error) throw new Error("تعذر تحميل التحليلات");
        countsByClass.set(className, Number.isFinite(result.count) ? Number(result.count) : 0);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error("تعذر تحميل التحليلات"));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, classes.length) }, () => worker()));
  if (errors.length) throw errors[0];
  return countsByClass;
}

export async function fetchAnalyticsBatch(
  db: any,
  attendanceClasses: string[],
  behaviorClasses: string[],
  from: string,
  to: string,
): Promise<AnalyticsBatchResult> {
  const attendanceScope = [...new Set(attendanceClasses.map((value) => String(value)).filter(Boolean))];
  const behaviorScope = [...new Set(behaviorClasses.map((value) => String(value)).filter(Boolean))];
  const [attendance, behaviorCounts] = await Promise.all([
    fetchAttendance(db, attendanceScope, from, to),
    fetchBehaviorCounts(db, behaviorScope, from, to),
  ]);
  return {
    attendanceRowsByClass: attendance.rowsByClass,
    attendanceSessionsByClass: attendance.countsByClass,
    behaviorSessionsByClass: behaviorCounts,
  };
}
