import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchAnalyticsBatch } from "./analytics_batch_fetch.ts";

type Response = { data: any[] | null; error: Error | null; count?: number | null };

function mockDb(responses: Response[]) {
  const calls: any[] = [];
  return {
    calls,
    from(table: string) {
      const call: any = { table, orders: [] };
      const query: any = {
        select(columns: string, options?: unknown) { call.columns = columns; call.selectOptions = options; return query; },
        in(column: string, values: string[]) { call.in = { column, values }; return query; },
        eq(column: string, value: string) { call.eq = { column, value }; return query; },
        gte(column: string, value: string) { call.gte = { column, value }; return query; },
        lte(column: string, value: string) { call.lte = { column, value }; return query; },
        limit(value: number) {
          call.limit = value;
          calls.push(call);
          return Promise.resolve(responses.shift() || { data: [], error: null, count: 0 });
        },
        then(resolve: (value: Response) => unknown, reject?: (reason: unknown) => unknown) {
          calls.push(call);
          return Promise.resolve(responses.shift() || { data: null, error: null, count: 0 }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

Deno.test("analytics reader batches attendance rows and behavior counts across classes", async () => {
  const classes = Array.from({ length: 28 }, (_, index) => `class-${index + 1}`);
  const attendance = Array.from({ length: 891 }, (_, index) => ({
    class_name: classes[index % classes.length], record_key: `a-${index}`, date_str: "2026-11-20", records: {},
  }));
  const behaviors = Array.from({ length: 224 }, (_, index) => ({
    class_name: classes[index % classes.length], record_key: `b-${index}`,
  }));
  const db = mockDb([
    { data: attendance, error: null, count: 891 },
    { data: behaviors, error: null, count: 224 },
  ]);

  const result = await fetchAnalyticsBatch(db, classes, classes, "2026-01-01", "2026-12-31");

  assertEquals(db.calls.length, 2);
  assertEquals(db.calls.map((call) => call.table).sort(), ["attendance", "behaviors"]);
  assertEquals(result.attendanceSessionsByClass.get("class-1"), 32);
  assertEquals(result.behaviorSessionsByClass.get("class-1"), 8);
  assertEquals(result.attendanceRowsByClass.get("class-1")?.length, 32);
});

Deno.test("analytics reader skips empty table scopes", async () => {
  const db = mockDb([]);
  const result = await fetchAnalyticsBatch(db, [], [], "2026-01-01", "2026-12-31");
  assertEquals(db.calls.length, 0);
  assertEquals(result.attendanceRowsByClass.size, 0);
  assertEquals(result.behaviorSessionsByClass.size, 0);
});

Deno.test("analytics reader falls back to per-class attendance reads when batch is too large", async () => {
  const classes = ["9/1", "9/2"];
  const first = [{ class_name: "9/1", record_key: "a-1", date_str: "2026-11-01", records: {} }];
  const second = [{ class_name: "9/2", record_key: "a-2", date_str: "2026-11-02", records: {} }];
  const db = mockDb([
    { data: Array.from({ length: 5000 }, () => ({ class_name: "9/1" })), error: null, count: 5001 },
    { data: first, error: null, count: 11 },
    { data: second, error: null, count: 22 },
    { data: [], error: null, count: 0 },
  ]);

  const result = await fetchAnalyticsBatch(db, classes, [], "2026-01-01", "2026-12-31");

  assertEquals(result.attendanceRowsByClass.get("9/1")?.length, 1);
  assertEquals(result.attendanceSessionsByClass.get("9/1"), 11);
  assertEquals(result.attendanceSessionsByClass.get("9/2"), 22);
  assertEquals(db.calls.filter((call) => call.table === "attendance").length, 3);
});

Deno.test("analytics reader falls back to per-class behavior HEAD counts for large ranges", async () => {
  const classes = ["9/1", "9/2"];
  const db = mockDb([
    { data: Array.from({ length: 5000 }, () => ({ class_name: "9/1" })), error: null, count: 5001 },
    { data: null, error: null, count: 13 },
    { data: null, error: null, count: 17 },
  ]);

  const result = await fetchAnalyticsBatch(db, [], classes, "2026-01-01", "2026-12-31");

  assertEquals(result.behaviorSessionsByClass.get("9/1"), 13);
  assertEquals(result.behaviorSessionsByClass.get("9/2"), 17);
  assertEquals(db.calls.length, 3);
  assertEquals(db.calls[1].selectOptions, { count: "exact", head: true });
});

Deno.test("analytics reader falls back when exact count metadata is missing", async () => {
  const classes = ["9/1"];
  const rows = [{ class_name: "9/1", record_key: "a-1", date_str: "2026-11-01", records: {} }];
  const db = mockDb([
    { data: rows, error: null, count: null },
    { data: rows, error: null, count: 1 },
  ]);

  const result = await fetchAnalyticsBatch(db, classes, [], "2026-01-01", "2026-12-31");

  assertEquals(result.attendanceRowsByClass.get("9/1")?.length, 1);
  assertEquals(result.attendanceSessionsByClass.get("9/1"), 1);
  assertEquals(db.calls.length, 2);
});

Deno.test("analytics reader rejects rows outside the authorized class set", async () => {
  const db = mockDb([
    { data: [{ class_name: "9/2", record_key: "unexpected" }], error: null, count: 1 },
  ]);
  await assertRejects(
    () => fetchAnalyticsBatch(db, ["9/1"], [], "2026-01-01", "2026-12-31"),
    Error,
    "تعذر تحميل التحليلات",
  );
});

Deno.test("analytics reader propagates database errors", async () => {
  const db = mockDb([{ data: null, error: new Error("synthetic failure") }]);
  await assertRejects(
    () => fetchAnalyticsBatch(db, ["9/1"], [], "2026-01-01", "2026-12-31"),
    Error,
    "تعذر تحميل التحليلات",
  );
});
