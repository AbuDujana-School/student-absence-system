import {
  resolveTimetablePrincipal,
  type TimetableAuthStore,
  type TimetableSessionLookup,
} from "../session_auth.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const TOKEN = "a".repeat(64);
const EXPIRY = "2026-11-13T20:00:00.000Z";

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storeWith(
  session: TimetableSessionLookup | null,
  options: {
    admin?: boolean;
    teacher?: { name: string; role: string } | null;
    access?: boolean;
    calls?: string[];
  } = {},
): TimetableAuthStore {
  const calls = options.calls ?? [];
  return {
    async findSession(tokenHash, nowIso) {
      calls.push("session:" + tokenHash + ":" + nowIso);
      return session;
    },
    async hasAdminCredential() {
      calls.push("admin");
      return options.admin === true;
    },
    async findTeacher(name) {
      calls.push("teacher:" + name);
      return options.teacher ?? null;
    },
    async hasTimetableAccess(type, name) {
      calls.push("access:" + type + ":" + name);
      return options.access === true;
    },
  };
}

Deno.test("malformed and public-key-like authorization values are rejected before database access", async () => {
  const calls: string[] = [];
  const store = storeWith(null, { calls });
  for (const header of [
    null, "", "Basic " + TOKEN, "Bearer anon-key",
    "Bearer " + TOKEN + " extra", "Bearer " + "g".repeat(64),
  ]) {
    const principal = await resolveTimetablePrincipal(header, store, NOW);
    if (principal !== null) throw new Error("Malformed authorization was accepted");
  }
  if (calls.length !== 0) throw new Error("Malformed authorization reached the database");
});

Deno.test("teacher session requires a live token, matching teacher role, and explicit timetable grant", async () => {
  const tokenHash = await digest(TOKEN);
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher" },
    access: true,
    calls,
  });
  const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW);
  if (principal?.type !== "teacher" || principal.name !== "Teacher A") {
    throw new Error("Authorized teacher session was rejected");
  }
  if (!calls.some((call) => call.startsWith("session:" + tokenHash + ":"))) {
    throw new Error("Session lookup did not use the SHA-256 digest");
  }
  if (!calls.includes("access:teacher:Teacher A")) {
    throw new Error("Teacher access permission was not checked");
  }
});

Deno.test("expired or malformed session records are rejected", async () => {
  const cases = [
    { principal_type: "teacher", principal_name: "Teacher A", expires_at: "2026-11-13T11:59:59.000Z" },
    { principal_type: "teacher", principal_name: "Teacher A", expires_at: "not-a-date" },
    { principal_type: "teacher", principal_name: "Teacher A", expires_at: null },
  ];
  for (const session of cases) {
    const calls: string[] = [];
    const store = storeWith(session, {
      teacher: { name: "Teacher A", role: "teacher" },
      access: true,
      calls,
    });
    if (await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW) !== null) {
      throw new Error("Expired or malformed session was accepted");
    }
    if (calls.some((call) => call.startsWith("teacher:") || call.startsWith("access:"))) {
      throw new Error("Inactive session reached teacher authorization checks");
    }
  }
});

Deno.test("teacher role mismatch and missing timetable grant are denied", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const wrongRole = storeWith(session, {
    teacher: { name: "Teacher A", role: "custom" },
    access: true,
  });
  if (await resolveTimetablePrincipal("Bearer " + TOKEN, wrongRole, NOW) !== null) {
    throw new Error("Mismatched teacher role was accepted");
  }
  const noGrant = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher" },
    access: false,
  });
  if (await resolveTimetablePrincipal("Bearer " + TOKEN, noGrant, NOW) !== null) {
    throw new Error("Teacher without explicit timetable access was accepted");
  }
});

Deno.test("custom accounts require a matching custom role and explicit timetable grant", async () => {
  const session = { principal_type: "custom", principal_name: "Custom A", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "Custom A", role: "custom" },
    access: true,
  });
  const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW);
  if (principal?.type !== "custom" || principal.name !== "Custom A") {
    throw new Error("Authorized custom account was rejected");
  }
});

Deno.test("administrator access requires the configured system administrator credential", async () => {
  const session = { principal_type: "admin", principal_name: "مدير النظام العام", expires_at: EXPIRY };
  const allowed = storeWith(session, { admin: true });
  const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, allowed, NOW);
  if (principal?.type !== "admin") throw new Error("Configured administrator was rejected");

  const missingCredential = storeWith(session, { admin: false });
  if (await resolveTimetablePrincipal("Bearer " + TOKEN, missingCredential, NOW) !== null) {
    throw new Error("Administrator session without a configured credential was accepted");
  }
});

Deno.test("unknown principal types and empty teacher names are rejected", async () => {
  const unknown = storeWith({ principal_type: "visitor", principal_name: "Visitor", expires_at: EXPIRY });
  if (await resolveTimetablePrincipal("Bearer " + TOKEN, unknown, NOW) !== null) {
    throw new Error("Unknown principal type was accepted");
  }
  const emptyName = storeWith({ principal_type: "teacher", principal_name: "  ", expires_at: EXPIRY }, {
    teacher: { name: "  ", role: "teacher" },
    access: true,
  });
  if (await resolveTimetablePrincipal("Bearer " + TOKEN, emptyName, NOW) !== null) {
    throw new Error("Empty teacher name was accepted");
  }
});


import { canUseTimetableAction } from "../session_auth.ts";

Deno.test("authorized non-admin timetable users are limited to read-only timetable and import views", () => {
  const allowed = [
    "health", "timetable_check_access", "teacher_timetable_get_own",
    "timetable_list_imports", "timetable_get_import", "timetable_list_owner_candidates",
    "timetable_mutate_record", "timetable_reassign_owner",
  ];
  for (const action of allowed) {
    if (!canUseTimetableAction("teacher", action)) throw new Error("Expected read action to be allowed: " + action);
    if (!canUseTimetableAction("custom", action)) throw new Error("Expected custom read action to be allowed: " + action);
  }
  for (const action of [
    "timetable_preview", "timetable_save_import", "timetable_set_access", "timetable_activate_weekly_version",
  ]) {
    if (canUseTimetableAction("teacher", action)) throw new Error("Teacher write action was allowed: " + action);
    if (canUseTimetableAction("custom", action)) throw new Error("Custom write action was allowed: " + action);
    if (!canUseTimetableAction("admin", action)) throw new Error("Administrator action was denied: " + action);
  }
});
