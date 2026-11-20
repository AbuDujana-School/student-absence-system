import { assertEquals, assert } from "jsr:@std/assert";
import {
  handleAppCredentialSnapshot,
  handleAppCredentialWrite,
} from "./app_data_gateway_credentials_handler.ts";
import type { AppDataPrincipal } from "./app_data_gateway_policy.ts";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const admin = { type: "admin" as const, name: "مدير النظام العام" };
const teacher = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: true } };
const session = { principal: { type: "teacher", name: "Teacher A" } };
const hash = "a".repeat(64);
const salt = "b".repeat(32);

function fixture(options: {
  session?: typeof session | null;
  principal?: AppDataPrincipal | null;
  adminSetting?: unknown;
  accounts?: Record<string, unknown>[];
  rpcData?: unknown;
  rpcError?: unknown;
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const db = {
    from(table: string) {
      calls.push(["from", table]);
      const query: any = {
        select(value: string) { calls.push(["select", value]); return this; },
        eq(column: string, value: string) { calls.push(["eq", column, value]); return this; },
        maybeSingle() { return Promise.resolve({ data: options.adminSetting ?? { value: { hash, salt } }, error: null }); },
        order(column: string, config: unknown) {
          calls.push(["order", column, config]);
          return Promise.resolve({ data: options.accounts ?? [{
            name: "Teacher A", role: "teacher", pin_hash: hash, pin_salt: salt,
            permissions: { attendance: true, nested: { api_token: "never" } }, must_change_pin: true,
          }], error: null });
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(["rpc", name, args]);
      return { data: options.rpcData ?? 1, error: options.rpcError ?? null };
    },
  };
  const deps = {
    db, headers,
    async readSession(_authorization: string | null) { return options.session === undefined ? session : options.session; },
    async currentPrincipal(_type: string, _name: string) { return options.principal === undefined ? teacher : options.principal; },
  };
  return { deps, calls };
}
async function req(body: Record<string, unknown>, deps: any) {
  return await handleAppCredentialWrite(new Request("https://unit.test/functions/v1/student-affairs", {
    method: "POST", headers: { authorization: "Bearer " + "a".repeat(64), "content-type": "application/json" },
    body: JSON.stringify(body),
  }), body, deps);
}

Deno.test("credential snapshot requires a server-issued app session before reading credentials", async () => {
  const { deps, calls } = fixture({ session: null });
  const response = await handleAppCredentialSnapshot(new Request("https://unit.test", { headers: { authorization: "Bearer invalid" } }), deps);
  assertEquals(response.status, 401);
  assertEquals(calls.some(([name]) => name === "from"), false);
});

Deno.test("credential snapshot preserves offline PIN data but strips nested secret-like permission fields", async () => {
  const { deps } = fixture();
  const response = await handleAppCredentialSnapshot(new Request("https://unit.test", { headers: { authorization: "Bearer " + "a".repeat(64) } }), deps);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.admin_pin, { hash, salt });
  assertEquals(body.accounts[0].pin_hash, hash);
  assertEquals(body.accounts[0].pin_salt, salt);
  assertEquals(body.accounts[0].permissions, { attendance: true, nested: {} });
});

Deno.test("teacher can rotate only their own PIN through the dedicated RPC", async () => {
  const { deps, calls } = fixture();
  const response = await req({
    target_type: "teacher", target_name: "Teacher A", hash, salt, must_change_pin: false,
  }, deps);
  assertEquals(response.status, 200);
  assert(calls.some(([name, rpcName, args]) =>
    name === "rpc" && rpcName === "app_data_gateway_set_pin_record" &&
    (args as any).p_target_name === "Teacher A"
  ));
});

Deno.test("teacher cannot change another account or an administrator PIN", async () => {
  const { deps } = fixture();
  const other = await req({ target_type: "teacher", target_name: "Teacher B", hash, salt }, deps);
  const adminPin = await req({ target_type: "admin", target_name: admin.name, hash, salt }, deps);
  assertEquals(other.status, 403);
  assertEquals(adminPin.status, 403);
});

Deno.test("administrator may reset a teacher PIN but malformed credential material is rejected", async () => {
  const { deps } = fixture({ principal: admin, session: { principal: { type: "admin", name: admin.name } } });
  const reset = await req({ target_type: "teacher", target_name: "Teacher B", hash, salt, must_change_pin: true }, deps);
  const malformed = await req({ target_type: "teacher", target_name: "Teacher B", hash: "bad", salt }, deps);
  assertEquals(reset.status, 200);
  assertEquals(malformed.status, 400);
});

Deno.test("PIN update rejects missing sessions and database errors without leaking details", async () => {
  const missing = fixture({ session: null });
  const denied = await req({ target_type: "teacher", target_name: "Teacher A", hash, salt }, missing.deps);
  assertEquals(denied.status, 401);
  const broken = fixture({ rpcError: { code: "42501", message: "private database detail" } });
  const failed = await req({ target_type: "teacher", target_name: "Teacher A", hash, salt }, broken.deps);
  assertEquals(failed.status, 503);
  assertEquals((await failed.text()).includes("private database detail"), false);
});
