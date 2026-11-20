import { assertEquals, assert } from "jsr:@std/assert";
import { handleAppDataGatewayWrite } from "./app_data_gateway_write_handler.ts";
import type { AppDataPrincipal } from "./app_data_gateway_policy.ts";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const teacher = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: true, behavior: true } };
const session = { principal: { type: "teacher", name: "Teacher A" } };

function fixture(options: {
  session?: { principal: { type: string; name: string } } | null;
  principal?: AppDataPrincipal | null;
  scope?: { allowedClasses: string[]; allowedAttendanceClasses?: string[]; allowedBehaviorClasses?: string[] };
  existing?: Record<string, unknown>[];
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let saved: Record<string, unknown>[] | null = null;
  const query: any = {
    select(value: string) { calls.push(["select", value]); return this; },
    in(...args: unknown[]) { calls.push(["in", ...args]); return Promise.resolve({ data: options.existing ?? [], error: null }); },
    async upsert(rows: Record<string, unknown>[], config: unknown) {
      calls.push(["upsert", config]);
      saved = rows;
      return { error: null };
    },
  };
  const deps = {
    headers,
    db: { from(table: string) { calls.push(["from", table]); return query; } },
    async readSession(_authorization: string | null) { return options.session === undefined ? session : options.session; },
    async currentPrincipal(_type: string, _name: string) { return options.principal === undefined ? teacher : options.principal; },
    async resolveScope() { return options.scope ?? { allowedClasses: ["5/1"], allowedAttendanceClasses: ["5/1"], allowedBehaviorClasses: ["5/1"] }; },
  };
  return { deps, calls, getSaved: () => saved };
}
async function request(body: Record<string, unknown>, deps: any) {
  return await handleAppDataGatewayWrite(new Request("https://unit.test/functions/v1/student-affairs", {
    method: "POST", headers: { authorization: "Bearer " + "a".repeat(64), "content-type": "application/json" },
    body: JSON.stringify(body),
  }), body, deps);
}

Deno.test("write handler rejects missing sessions before touching school tables", async () => {
  const { deps, calls } = fixture({ session: null });
  const response = await request({ table: "attendance", rows: [{ record_key: "r1", class_name: "5/1", teacher_name: "Teacher A" }] }, deps);
  assertEquals(response.status, 401);
  assertEquals(calls.some(([name]) => name === "from"), false);
});

Deno.test("admin writes allowlisted student rows using server-owned conflict targets", async () => {
  const admin = { type: "admin" as const, name: "مدير النظام العام" };
  const { deps, calls, getSaved } = fixture({ principal: admin, session: { principal: { type: "admin", name: admin.name } } });
  const response = await request({ table: "students", rows: [{ class_name: "5/1", student_name: "Student A" }] }, deps);
  assertEquals(response.status, 200);
  assertEquals(getSaved(), [{ class_name: "5/1", student_name: "Student A" }]);
  assert(calls.some(([name, config]) => name === "upsert" && (config as any).onConflict === "class_name,student_name"));
});

Deno.test("teacher writes only own attendance in the explicitly granted class", async () => {
  const { deps, calls } = fixture();
  const response = await request({ table: "attendance", rows: [{
    record_key: "r1", class_name: "5/1", teacher_name: "Teacher A", period: 1, records: {},
  }] }, deps);
  assertEquals(response.status, 200);
  assert(calls.some(([name]) => name === "upsert"));
});

Deno.test("teacher cannot write another teacher's row or an out-of-scope class", async () => {
  const { deps: otherTeacher } = fixture();
  const deniedOwner = await request({ table: "attendance", rows: [{
    record_key: "r1", class_name: "5/1", teacher_name: "Teacher B", period: 1, records: {},
  }] }, otherTeacher);
  assertEquals(deniedOwner.status, 403);

  const { deps: otherClass } = fixture();
  const deniedClass = await request({ table: "attendance", rows: [{
    record_key: "r2", class_name: "6/1", teacher_name: "Teacher A", period: 1, records: {},
  }] }, otherClass);
  assertEquals(deniedClass.status, 403);
});

Deno.test("teacher cannot overwrite an existing attendance record owned by another teacher", async () => {
  const { deps, calls } = fixture({ existing: [{ record_key: "r1", teacher_name: "Teacher B" }] });
  const response = await request({ table: "attendance", rows: [{
    record_key: "r1", class_name: "5/1", teacher_name: "Teacher A", period: 1, records: {},
  }] }, deps);
  assertEquals(response.status, 403);
  assertEquals(calls.some(([name]) => name === "upsert"), false);
});

Deno.test("writes reject credential fields, admin PIN settings, duplicate conflict keys, and deletes", async () => {
  const admin = { type: "admin" as const, name: "مدير النظام العام" };
  const { deps } = fixture({ principal: admin, session: { principal: { type: "admin", name: admin.name } } });
  const credential = await request({ table: "teachers", rows: [{ name: "Teacher A", pin_hash: "secret" }] }, deps);
  const adminPin = await request({ table: "school_settings", rows: [{ key: "admin_pin", value: { hash: "secret" } }] }, deps);
  const duplicate = await request({ table: "classes", rows: [{ name: "5/1" }, { name: "5/1" }] }, deps);
  const deletion = await request({ table: "teachers", operation: "delete", rows: [{ name: "Teacher A" }] }, deps);
  assertEquals(credential.status, 400);
  assertEquals(adminPin.status, 400);
  assertEquals(duplicate.status, 400);
  assertEquals(deletion.status, 400);
});


Deno.test("write handler rejects a session whose principal was removed or changed", async () => {
  const { deps, calls } = fixture({ principal: null });
  const response = await request({ table: "students", rows: [{ class_name: "5/1", student_name: "Student A" }] }, deps);
  assertEquals(response.status, 401);
  assertEquals(calls.some(([name]) => name === "from"), false);
});

Deno.test("custom users need explicit category permissions and matching server scope", async () => {
  const custom = { type: "custom" as const, name: "Attendance Clerk", permissions: { attendance: true, behavior: false } };
  const customSession = { principal: { type: "custom", name: custom.name } };
  const { deps: allowedDeps } = fixture({
    principal: custom,
    session: customSession,
    scope: { allowedClasses: [], allowedAttendanceClasses: ["5/1"], allowedBehaviorClasses: [] },
  });
  const allowed = await request({ table: "attendance", rows: [{
    record_key: "custom-r1", class_name: "5/1", teacher_name: custom.name, period: 1, records: {},
  }] }, allowedDeps);
  assertEquals(allowed.status, 200);

  const { deps: deniedDeps } = fixture({
    principal: custom,
    session: customSession,
    scope: { allowedClasses: [], allowedAttendanceClasses: ["5/1"], allowedBehaviorClasses: [] },
  });
  const denied = await request({ table: "behaviors", rows: [{
    record_key: "custom-r2", class_name: "5/1", teacher_name: custom.name, period: 1, records: {},
  }] }, deniedDeps);
  assertEquals(denied.status, 403);
});

Deno.test("admin may update allowlisted school settings but never the admin PIN record", async () => {
  const admin = { type: "admin" as const, name: "مدير النظام العام" };
  const { deps, calls } = fixture({ principal: admin, session: { principal: { type: "admin", name: admin.name } } });
  const response = await request({ table: "school_settings", rows: [{
    key: "duty_module", value: { graceMinutes: 5, periods: [] },
  }] }, deps);
  assertEquals(response.status, 200);
  assert(calls.some(([name, config]) => name === "upsert" && (config as any).onConflict === "key"));
});

Deno.test("admin duty reports use the verified id primary key", async () => {
  const admin = { type: "admin" as const, name: "مدير النظام العام" };
  const { deps, calls } = fixture({ principal: admin, session: { principal: { type: "admin", name: admin.name } } });
  const response = await request({ table: "duty_reports", rows: [{
    id: "duty-1", date_str: "2026-11-20", day_num: "الخميس", period: 1,
    class_name: "5/1", teacher_name: "Teacher A", reported_by: admin.name,
  }] }, deps);
  assertEquals(response.status, 200);
  assert(calls.some(([name, config]) => name === "upsert" && (config as any).onConflict === "id"));
});
