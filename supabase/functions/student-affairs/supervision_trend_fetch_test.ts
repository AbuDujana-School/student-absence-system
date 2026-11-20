import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchSupervisionTrendRows } from "./supervision_trend_fetch.ts";

function mockDb(responses: Array<{ data: any[] | null; error: Error | null }>) {
  const calls: any[] = [];
  return {
    calls,
    from(table: string) {
      const call: any = { table, orders: [] };
      const query = {
        select(columns: string) { call.columns = columns; return query; },
        in(column: string, values: string[]) { call.in = { column, values }; return query; },
        gte(column: string, value: string) { call.gte = { column, value }; return query; },
        lte(column: string, value: string) { call.lte = { column, value }; return query; },
        order(column: string, options: unknown) { call.orders.push({ column, options }); return query; },
        range(from: number, to: number) {
          call.range = [from, to];
          calls.push(call);
          return Promise.resolve(responses.shift() || { data: [], error: null });
        },
      };
      return query;
    },
  };
}

Deno.test("supervision trend reader skips empty class scopes without querying", async () => {
  const db = mockDb([]);
  assertEquals(await fetchSupervisionTrendRows(db, "attendance", [], "2026-11-01", "2026-11-20"), []);
  assertEquals(db.calls.length, 0);
});

Deno.test("supervision trend reader batches classes and paginates all rows", async () => {
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({ record_key: `row-${index}` }));
  const lastPage = [{ record_key: "row-1000" }, { record_key: "row-1001" }];
  const db = mockDb([{ data: firstPage, error: null }, { data: lastPage, error: null }]);

  const rows = await fetchSupervisionTrendRows(
    db, "attendance", ["9/1", "9/2", "9/1"], "2026-11-01", "2026-11-20",
  );

  assertEquals(rows.length, 1002);
  assertEquals(db.calls.length, 2);
  assertEquals(db.calls.map((call) => call.range), [[0, 999], [1000, 1999]]);
  assertEquals(db.calls[0].in, { column: "class_name", values: ["9/1", "9/2"] });
  assertEquals(db.calls[0].gte, { column: "date_str", value: "2026-11-01" });
  assertEquals(db.calls[0].lte, { column: "date_str", value: "2026-11-20" });
  assertEquals(db.calls[0].orders.map((item: any) => item.column), ["date_str", "class_name", "record_key"]);
});

Deno.test("supervision trend reader uses one request for many authorized classes", async () => {
  const classes = Array.from({ length: 28 }, (_, index) => `class-${index + 1}`);
  const rows = classes.map((class_name) => ({ class_name, date_str: "2026-11-10", records: {} }));
  const db = mockDb([{ data: rows, error: null }]);

  const result = await fetchSupervisionTrendRows(db, "behaviors", classes, "2026-11-01", "2026-11-20");

  assertEquals(result.length, 28);
  assertEquals(db.calls.length, 1);
  assertEquals(db.calls[0].in.values, classes);
});

Deno.test("supervision trend reader propagates database errors", async () => {
  const expected = new Error("synthetic database failure");
  const db = mockDb([{ data: null, error: expected }]);
  let caught: unknown = null;
  try {
    await fetchSupervisionTrendRows(db, "behaviors", ["9/1"], "2026-11-01", "2026-11-20");
  } catch (error) {
    caught = error;
  }
  assertEquals(caught, expected);
});
