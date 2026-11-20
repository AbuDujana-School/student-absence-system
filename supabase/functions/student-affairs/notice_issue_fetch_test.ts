import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchNoticeRowsForClasses } from "./notice_issue_fetch.ts";

type Response = { data: any[] | null; error: Error | null; count?: number | null };

function mockDb(responses: Response[]) {
  const calls: any[] = [];
  return {
    calls,
    from(table: string) {
      const call: any = { table, orders: [] };
      const query = {
        select(columns: string, options?: unknown) { call.columns = columns; call.selectOptions = options; return query; },
        in(column: string, values: string[]) { call.in = { column, values }; return query; },
        eq(column: string, value: string) { call.eq = { column, value }; return query; },
        gte(column: string, value: string) { call.gte = { column, value }; return query; },
        lte(column: string, value: string) { call.lte = { column, value }; return query; },
        order(column: string, options: unknown) { call.orders.push({ column, options }); return query; },
        limit(value: number) {
          call.limit = value;
          calls.push(call);
          return Promise.resolve(responses.shift() || { data: [], error: null, count: 0 });
        },
      };
      return query;
    },
  };
}

Deno.test("notice reader skips empty scopes without querying", async () => {
  const db = mockDb([]);
  assertEquals(await fetchNoticeRowsForClasses(db, "attendance", [], "2026-01-01", "2026-12-31", 2026), []);
  assertEquals(db.calls.length, 0);
});

Deno.test("notice reader batches the authorized classes when the combined result fits", async () => {
  const classes = Array.from({ length: 28 }, (_, index) => `class-${index + 1}`);
  const rows = Array.from({ length: 891 }, (_, index) => ({
    record_key: `attendance-${index}`,
    class_name: classes[index % classes.length],
    date_str: "2026-11-20",
    records: {},
  }));
  const db = mockDb([{ data: rows, error: null, count: 891 }]);

  const result = await fetchNoticeRowsForClasses(db, "attendance", classes, "2026-01-01", "2026-12-31", 2026);

  assertEquals(result.length, 891);
  assertEquals(db.calls.length, 1);
  assertEquals(db.calls[0].in, { column: "class_name", values: classes });
  assertEquals(db.calls[0].gte, { column: "date_str", value: "2026-01-01" });
  assertEquals(db.calls[0].lte, { column: "date_str", value: "2026-12-31" });
  assertEquals(db.calls[0].limit, 5000);
  assertEquals(db.calls[0].selectOptions, { count: "exact" });
  assertEquals(db.calls[0].orders.map((item: any) => item.column), ["date_str", "class_name", "record_key"]);
});

Deno.test("notice reader preserves the per-class 5,000-row safety ceiling", async () => {
  const rows = Array.from({ length: 5000 }, (_, index) => ({ class_name: "9/1", record_key: String(index) }));
  const db = mockDb([{ data: rows, error: null, count: 5000 }]);

  await assertRejects(
    () => fetchNoticeRowsForClasses(db, "attendance", ["9/1", "9/2"], "2026-01-01", "2026-12-31", 2026),
    Error,
    "بلغت سجلات أحد الصفوف الحد الأقصى في سنة 2026",
  );
  assertEquals(db.calls.length, 1);
});

Deno.test("notice reader falls back to per-class reads when the combined result exceeds the batch window", async () => {
  const firstClass = Array.from({ length: 10 }, (_, index) => ({ class_name: "9/1", record_key: `a-${index}` }));
  const secondClass = Array.from({ length: 20 }, (_, index) => ({ class_name: "9/2", record_key: `b-${index}` }));
  const db = mockDb([
    { data: Array.from({ length: 5000 }, () => ({ class_name: "9/1" })), error: null, count: 5001 },
    { data: firstClass, error: null },
    { data: secondClass, error: null },
  ]);

  const result = await fetchNoticeRowsForClasses(db, "behaviors", ["9/1", "9/2"], "2026-01-01", "2026-12-31", 2026);

  assertEquals(result.length, 30);
  assertEquals(db.calls.length, 3);
  assertEquals(db.calls[1].eq, { column: "class_name", value: "9/1" });
  assertEquals(db.calls[2].eq, { column: "class_name", value: "9/2" });
});

Deno.test("notice reader refuses a class that reaches the old per-class cap after fallback", async () => {
  const cappedRows = Array.from({ length: 5000 }, (_, index) => ({ class_name: "9/1", record_key: String(index) }));
  const db = mockDb([
    { data: Array.from({ length: 5000 }, () => ({ class_name: "9/1" })), error: null, count: 5001 },
    { data: cappedRows, error: null },
  ]);

  await assertRejects(
    () => fetchNoticeRowsForClasses(db, "attendance", ["9/1", "9/2"], "2026-01-01", "2026-12-31", 2026),
    Error,
    "بلغت سجلات أحد الصفوف الحد الأقصى في سنة 2026",
  );
  assertEquals(db.calls.length, 2);
});

Deno.test("notice reader propagates database errors without returning partial rows", async () => {
  const expected = new Error("synthetic database failure");
  const db = mockDb([{ data: null, error: expected }]);
  await assertRejects(
    () => fetchNoticeRowsForClasses(db, "behaviors", ["9/1"], "2026-01-01", "2026-12-31", 2026),
    Error,
    "تعذر قراءة سجلات المخالفات التاريخية",
  );
});
