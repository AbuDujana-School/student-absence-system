import {
  createSupabaseAppSessionStore,
  type AppSessionDatabaseClient,
} from "./app_session_store.ts";
import type { AppSessionRecord } from "./app_auth_policy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Supabase app session adapter uses only the dedicated table and minimal projection", async () => {
  const tokenHash = "a".repeat(64);
  const record: AppSessionRecord = {
    token_hash: tokenHash,
    principal_type: "teacher",
    principal_name: "Teacher A",
    expires_at: "2026-01-01T02:00:00.000Z",
  };
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    from(table: "app_sessions") {
      calls.push({ method: "from", args: [table] });
      return {
        delete() {
          calls.push({ method: "delete", args: [] });
          return {
            async lte(column: string, value: string) {
              calls.push({ method: "lte", args: [column, value] });
              return { error: null };
            },
            async eq(column: string, value: string) {
              calls.push({ method: "delete.eq", args: [column, value] });
              return { error: null };
            },
          };
        },
        async insert(value: AppSessionRecord) {
          calls.push({ method: "insert", args: [value] });
          return { error: null };
        },
        select(columns: string) {
          calls.push({ method: "select", args: [columns] });
          return {
            eq(column: string, value: string) {
              calls.push({ method: "select.eq", args: [column, value] });
              return {
                async maybeSingle() {
                  calls.push({ method: "maybeSingle", args: [] });
                  return { data: record, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as AppSessionDatabaseClient;

  const store = createSupabaseAppSessionStore(client);
  await store.deleteExpired("2026-01-01T00:00:00.000Z");
  await store.insert(record);
  const found = await store.findByTokenHash(tokenHash);
  await store.deleteByTokenHash(tokenHash);

  assert(found?.token_hash === tokenHash, "Expected the matching session record");
  assert(calls.every((call) => call.method !== "from" || call.args[0] === "app_sessions"), "Adapter used an unexpected table");
  const projection = calls.find((call) => call.method === "select")?.args[0];
  assert(projection === "token_hash,principal_type,principal_name,expires_at", "Session lookup selected more than the minimum fields");
  assert(calls.some((call) => call.method === "lte" && call.args[0] === "expires_at"), "Expired sessions were not cleaned up by expiry");
  assert(calls.some((call) => call.method === "delete.eq" && call.args[0] === "token_hash"), "Revocation did not target the token digest");
});

Deno.test("Supabase app session adapter rejects malformed rows and ignores malformed digests", async () => {
  const lookups: string[] = [];
  const client = {
    from() {
      lookups.push("from");
      return {
        delete() {
          return { async lte() { return { error: null }; }, async eq() { return { error: null }; } };
        },
        async insert() { return { error: null }; },
        select() {
          return { eq() { return { async maybeSingle() { return { data: {
            token_hash: "bad", principal_type: "visitor", principal_name: "X", expires_at: "not-a-date",
          }, error: null }; } }; } };
        },
      };
    },
  } as unknown as AppSessionDatabaseClient;

  const store = createSupabaseAppSessionStore(client);
  assert(await store.findByTokenHash("bad-digest") === null, "Malformed digest should not be queried");
  assert(lookups.length === 0, "Malformed digest reached the database");
  assert(await store.findByTokenHash("b".repeat(64)) === null, "Malformed database row was accepted");
  assert(Number(lookups.length) === 1, "Valid digest did not perform exactly one lookup");
});

Deno.test("Supabase app session adapter does not expose database error details", async () => {
  const client = {
    from() {
      return {
        delete() {
          return { async lte() { return { error: null }; }, async eq() { return { error: null }; } };
        },
        async insert() { return { error: { message: "sensitive backend detail" } }; },
        select() {
          return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } };
        },
      };
    },
  } as unknown as AppSessionDatabaseClient;
  const store = createSupabaseAppSessionStore(client);
  let message = "";
  try {
    await store.insert({
      token_hash: "c".repeat(64),
      principal_type: "admin",
      principal_name: "Admin",
      expires_at: "2026-01-01T01:00:00.000Z",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("session insert failed"), "Expected a generic store failure");
  assert(!message.includes("sensitive backend detail"), "Raw database error leaked to the caller");
});
