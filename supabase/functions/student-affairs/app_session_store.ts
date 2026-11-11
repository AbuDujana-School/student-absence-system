import type { AppSessionRecord, AppSessionStore } from "./app_auth_policy.ts";

type StoreError = unknown;

interface QueryResult<T> {
  data: T | null;
  error: StoreError;
}

interface DeleteResult {
  error: StoreError;
}

interface DeleteFilter {
  lte(column: string, value: string): PromiseLike<DeleteResult>;
  eq(column: string, value: string): PromiseLike<DeleteResult>;
}

interface SelectFilter {
  maybeSingle(): PromiseLike<QueryResult<AppSessionRecord>>;
}

interface SelectBuilder {
  eq(column: string, value: string): SelectFilter;
}

interface AppSessionsTable {
  delete(): DeleteFilter;
  insert(record: AppSessionRecord): PromiseLike<DeleteResult>;
  select(columns: string): SelectBuilder;
}

export interface AppSessionDatabaseClient {
  from(table: "app_sessions"): AppSessionsTable;
}

const SESSION_COLUMNS = "token_hash,principal_type,principal_name,expires_at";

function throwStoreError(operation: string, error: StoreError): void {
  if (error) throw new Error(`App session store ${operation} failed`);
}

function isSessionRecord(value: unknown): value is AppSessionRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.token_hash === "string" &&
    /^[a-f0-9]{64}$/.test(row.token_hash) &&
    (row.principal_type === "admin" || row.principal_type === "teacher" || row.principal_type === "custom") &&
    typeof row.principal_name === "string" && row.principal_name.trim().length > 0 &&
    typeof row.expires_at === "string" && Number.isFinite(Date.parse(row.expires_at));
}

/**
 * Supabase adapter for the dedicated general-app session table.
 * The caller must supply a server-side client authenticated with the service role.
 * This adapter is intentionally not wired into the live function until the
 * app_sessions migration is reviewed and tested in an isolated database.
 */
export function createSupabaseAppSessionStore(client: AppSessionDatabaseClient): AppSessionStore {
  return {
    async deleteExpired(beforeIso) {
      const { error } = await client.from("app_sessions").delete().lte("expires_at", beforeIso);
      throwStoreError("expired-session cleanup", error);
    },

    async insert(record) {
      const { error } = await client.from("app_sessions").insert(record);
      throwStoreError("session insert", error);
    },

    async findByTokenHash(tokenHash) {
      if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
      const { data, error } = await client.from("app_sessions")
        .select(SESSION_COLUMNS)
        .eq("token_hash", tokenHash)
        .maybeSingle();
      throwStoreError("session lookup", error);
      return isSessionRecord(data) ? data : null;
    },

    async deleteByTokenHash(tokenHash) {
      if (!/^[a-f0-9]{64}$/.test(tokenHash)) return;
      const { error } = await client.from("app_sessions").delete().eq("token_hash", tokenHash);
      throwStoreError("session revocation", error);
    },
  };
}
