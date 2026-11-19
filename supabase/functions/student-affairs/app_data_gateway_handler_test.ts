import { assertEquals, assert } from "jsr:@std/assert";
import { handleAppDataGatewayRead } from "./app_data_gateway_handler.ts";
import type { AppDataPrincipal } from "./app_data_gateway_policy.ts";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const teacher = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: true, behavior: false } };
const session = { principal: { type: "teacher", name: "Teacher A" } };

function fixture(options: {
  session?: typeof session | null;
  principal?: AppDataPrincipal | null;
  scope?: { allowedClasses: string[]; allowedAttendanceClasses?: string[]; allowedBehaviorClasses?: string[] };
  rows?: Record<string, unknown>[];
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const data = options.rows ?? [{ class_name: "5/1", student_name: "Student A", pin_hash: "never-return" }];
  const query: any = {
    select(value: string) { calls.push(["select", value]); return this; },
    eq(...args: unknown[]) { calls.push(["eq", ...args]); return this; },
    in(...args: unknown[]) { calls.push(["in", ...args]); return this; },
    neq(...args: unknown[]) { calls.push(["neq", ...args]); return this; },
    gte(...args: unknown[]) { calls.push(["gte", ...args]); return this; },
    lte(...args: unknown[]) { calls.push(["lte", ...args]); return this; },
    order(...args: unknown[]) { calls.push(["order", ...args]); return this; },
    async range(...args: unknown[]) { calls.push(["range", ...args]); return { data, error: null }; },
  };
  const deps = {
    headers,
    db: { from(table: string) { calls.push(["from", table]); return query; } },
    async readSession(_authorization: string | null) { return options.session === undefined ? session : options.session; },
    async currentPrincipal(_type: string, _name: string) { return options.principal === undefined ? teacher : options.principal; },
    async resolveScope() { return options.scope ?? { allowedClasses: ["5/1"] }; },
  };
  return { deps, calls };
}
async function request(body: Record<string, unknown>, deps: any, authorization = "Bearer " + "a".repeat(64)) {
  return await handleAppDataGatewayRead(new Request("https://unit.test/functions/v1/student-affairs", {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
  }), body, deps);
}
async function body(response: Response) { return await response.json(); }

Deno.test("HTTP handler rejects missing or expired app sessions before querying data", async () => {
  const { deps, calls } = fixture({ session: null });
  const response = await request({ table: "students" }, deps);
  assertEquals(response.status, 401);
  assertEquals(calls.some(([name]) => name === "from"), false);
});

Deno.test("HTTP handler rejects a session when the current principal no longer exists", async () => {
  const { deps, calls } = fixture({ principal: null });
  const response = await request({ table: "students" }, deps);
  assertEquals(response.status, 401);
  assertEquals(calls.some(([name]) => name === "from"), false);
});

Deno.test("teacher student reads add server-derived class filters before pagination", async () => {
  const { deps, calls } = fixture();
  const response = await request({ table: "students", limit: 50 }, deps);
  assertEquals(response.status, 200);
  assert(calls.some(([name, column, values]) => name === "in" && column === "class_name" && Array.isArray(values) && values.join() === "5/1"));
  assert(calls.some(([name, from, to]) => name === "range" && from === 0 && to === 49));
  assertEquals((await body(response)).rows, [{ class_name: "5/1", student_name: "Student A" }]);
});

Deno.test("teacher cannot request a class outside the server-derived scope", async () => {
  const { deps, calls } = fixture();
  const response = await request({ table: "students", class_name: "6/1" }, deps);
  assertEquals(response.status, 403);
  assertEquals(calls.some(([name]) => name === "from"), false);
});

Deno.test("attendance and behavior use separate server-side class grants", async () => {
  const { deps: attendanceDeps, calls: attendanceCalls } = fixture({
    scope: { allowedClasses: ["5/1"], allowedAttendanceClasses: ["7/1"], allowedBehaviorClasses: [] },
  });
  const attendanceResponse = await request({ table: "attendance" }, attendanceDeps);
  assertEquals(attendanceResponse.status, 200);
  assert(attendanceCalls.some(([name, column, values]) => name === "in" && column === "class_name" && Array.isArray(values) && values.join() === "7/1"));

  const { deps: behaviorDeps, calls: behaviorCalls } = fixture({
    scope: { allowedClasses: ["5/1"], allowedAttendanceClasses: ["7/1"], allowedBehaviorClasses: [] },
  });
  const behaviorResponse = await request({ table: "behaviors" }, behaviorDeps);
  assertEquals(behaviorResponse.status, 403);
  assertEquals(behaviorCalls.some(([name]) => name === "from"), false);
});

Deno.test("admin settings query excludes admin_pin before data is returned", async () => {
  const admin = { type: "admin" as const, name: "مدير النظام العام", permissions: {} };
  const { deps, calls } = fixture({ principal: admin, session: { principal: { type: "admin", name: admin.name } }, rows: [{ key: "duty_module", value: true }] });
  const response = await request({ table: "school_settings" }, deps);
  assertEquals(response.status, 200);
  assert(calls.some(([name, column, value]) => name === "neq" && column === "key" && value === "admin_pin"));
  assertEquals((await body(response)).rows, [{ key: "duty_module", value: true }]);
});

Deno.test("date and pagination validation reject malformed requests before database reads", async () => {
  const { deps, calls } = fixture();
  const badDate = await request({ table: "attendance", from_date: "2026-02-31" }, deps);
  const badLimit = await request({ table: "students", limit: 501 }, deps);
  assertEquals(badDate.status, 400);
  assertEquals(badLimit.status, 400);
  assertEquals(calls.some(([name]) => name === "from"), false);
});
