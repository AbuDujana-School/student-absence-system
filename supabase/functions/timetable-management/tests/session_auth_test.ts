import {
  resolveTimetablePrincipal,
  canUseTimetableAction,
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
    adminTeacher?: boolean;
    teacher?: { name: string; role: string; reserveAccess?: boolean; permissions?: Record<string, unknown> } | null;
    access?: boolean;
    reserve?: boolean;
    schoolwideReserveStats?: boolean;
    linkedPortalAccess?: boolean;
    duty?: boolean;
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
    async findAdminTeacher(name) {
      calls.push("admin-teacher:" + name);
      return options.adminTeacher === true;
    },
    async findTeacher(name, includePermissions = false) {
      calls.push("teacher:" + name);
      if (includePermissions) calls.push("teacher-permissions:" + name);
      return options.teacher
        ? {
          name: options.teacher.name,
          role: options.teacher.role,
          reserveAccess: includePermissions ? options.reserve ?? options.teacher.reserveAccess : false,
          permissions: includePermissions ? options.teacher.permissions ?? {} : {},
        }
        : null;
    },
    async hasTimetableAccess(type, name) {
      calls.push("access:" + type + ":" + name);
      return options.access === true;
    },
    async hasSchoolwideReserveStatsAccess(type, name) {
      calls.push("schoolwide-stats:" + type + ":" + name);
      return options.schoolwideReserveStats === true;
    },
    async hasLinkedTeacherPortalAccess(name) {
      calls.push("linked-portal:" + name);
      return options.linkedPortalAccess === true;
    },
    async hasDutyReportAccess(type, name) {
      calls.push("duty:" + type + ":" + name);
      return options.duty === true;
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


Deno.test("non-admin substitution access requires the correct explicit authorization", () => {
  const allowed = ["health", "timetable_check_access", "teacher_timetable_get_own"];
  for (const action of allowed) {
    if (!canUseTimetableAction("teacher", action)) throw new Error("Expected teacher read action to be allowed: " + action);
    if (!canUseTimetableAction("custom", action)) throw new Error("Expected custom read action to be allowed: " + action);
  }
  if (!canUseTimetableAction("teacher", "teacher_substitution_get_today")) {
    throw new Error("Teacher daily reserve notice action was denied");
  }
  if (canUseTimetableAction("custom", "teacher_substitution_get_today")) {
    throw new Error("Custom account gained teacher-only daily reserve notice access");
  }
  for (const action of ["timetable_substitution_preview", "timetable_substitution_save", "timetable_substitution_cancel", "timetable_substitution_cancel_batch"]) {
    if (canUseTimetableAction("teacher", action)) throw new Error("Teacher without reserve permission was allowed: " + action);
    if (!canUseTimetableAction("teacher", action, false, true)) throw new Error("Reserve-enabled teacher was denied: " + action);
    if (!canUseTimetableAction("custom", action)) throw new Error("Scoped custom coordinator was denied: " + action);
  }
  for (const action of [
    "timetable_preview", "timetable_save_import", "timetable_set_access", "timetable_activate_weekly_version",
    "timetable_mutate_record", "timetable_reassign_owner",
  ]) {
    if (canUseTimetableAction("teacher", action)) throw new Error("Teacher write action was allowed: " + action);
    if (canUseTimetableAction("custom", action)) throw new Error("Custom write action was allowed: " + action);
    if (!canUseTimetableAction("admin", action)) throw new Error("Administrator action was denied: " + action);
  }
});


Deno.test("self-scoped teacher timetable and daily notice actions defer checks to their handlers", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  for (const action of ["teacher_timetable_get_own", "teacher_substitution_get_today"]) {
    const calls: string[] = [];
    const store = storeWith(session, {
      teacher: { name: "Teacher A", role: "teacher" },
      access: false,
      linkedPortalAccess: false,
      calls,
    });
    const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW, action);
    if (principal?.type !== "teacher" || principal.name !== "Teacher A" || principal.portalOnly !== true) {
      throw new Error("Self-scoped teacher action did not receive a narrow portal-only identity: " + action);
    }
    if (calls.filter((call) => call === "teacher:Teacher A").length !== 1) {
      throw new Error("Teacher identity must be verified exactly once: " + action);
    }
    if (calls.some((call) =>
      call.startsWith("teacher-permissions:") || call.startsWith("access:") ||
      call.startsWith("linked-portal:") || call.startsWith("schoolwide-stats:") ||
      call.startsWith("duty:")
    )) {
      throw new Error("Self-scoped handler action performed a redundant authorization preflight: " + action);
    }
    if (!canUseTimetableAction("teacher", action, principal.portalOnly)) {
      throw new Error("The self-scoped teacher action was denied: " + action);
    }
    if (canUseTimetableAction("teacher", "timetable_substitution_preview", principal.portalOnly)) {
      throw new Error("The self-scoped identity gained reserve-management access");
    }
  }
});

Deno.test("explicit timetable permissions keep their existing scoped substitution capabilities", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher" },
    access: true,
    reserve: true,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_substitution_preview",
  );
  if (principal?.portalOnly === true) throw new Error("Explicit timetable permission was downgraded");
  if (principal?.reserveAccess !== true) throw new Error("Live reserve permission was not carried from the teacher lookup");
  if (canUseTimetableAction("teacher", "timetable_substitution_preview")) {
    throw new Error("General timetable access must not bypass the reserve permission");
  }
  if (!canUseTimetableAction("teacher", "timetable_substitution_preview", false, principal.reserveAccess === true)) {
    throw new Error("Reserve-enabled teacher lost substitution capability");
  }
});


Deno.test("reserve archive and edit actions require explicit reserve permission", () => {
  const actions = [
    "timetable_substitution_archive",
    "timetable_substitution_update",
    "timetable_substitution_update_batch",
  ];
  for (const action of actions) {
    if (!canUseTimetableAction("teacher", action, false, true)) {
      throw new Error("Reserve-authorized teacher was denied: " + action);
    }
    if (canUseTimetableAction("teacher", action)) {
      throw new Error("Teacher without reserve permission was allowed: " + action);
    }
    if (canUseTimetableAction("custom", action)) {
      throw new Error("Custom coordinator was granted archive mutation: " + action);
    }
    if (!canUseTimetableAction("admin", action)) {
      throw new Error("Administrator was denied: " + action);
    }
  }
  for (const action of [
    "timetable_substitution_preview",
    "timetable_substitution_save",
    "timetable_substitution_cancel",
  ]) {
    if (!canUseTimetableAction("custom", action)) {
      throw new Error("Custom coordinator lost the existing single-slot workflow: " + action);
    }
  }
});


Deno.test("schoolwide reserve statistics grants do not grant reserve management", () => {
  if (!canUseTimetableAction("teacher", "timetable_substitution_stats", false, false, false, true)) {
    throw new Error("Teacher with explicit schoolwide statistics grant was denied statistics");
  }
  if (!canUseTimetableAction("custom", "timetable_substitution_stats", false, false, false, true)) {
    throw new Error("Custom account with explicit schoolwide statistics grant was denied statistics");
  }
  if (canUseTimetableAction("teacher", "timetable_substitution_stats")) {
    throw new Error("Teacher without reserve or statistics permission was granted statistics");
  }
  if (canUseTimetableAction("custom", "timetable_substitution_stats")) {
    throw new Error("Custom account without explicit statistics grant was granted statistics");
  }
  for (const action of ["timetable_substitution_reset","timetable_substitution_reset_options"]) {
    if (canUseTimetableAction("teacher", action)) {
      throw new Error("Teacher without reserve permission gained department reset access: " + action);
    }
    if (!canUseTimetableAction("teacher", action, false, true)) {
      throw new Error("Reserve-enabled department coordinator was denied subject/day reset access: " + action);
    }
    if (canUseTimetableAction("custom", action)) {
      throw new Error("Custom account gained department reset access: " + action);
    }
    if (!canUseTimetableAction("admin", action)) {
      throw new Error("System administrator was denied reserve reset access: " + action);
    }
  }
  if (canUseTimetableAction("teacher", "timetable_reserve_stats_access_save", false, true)) {
    throw new Error("Department coordinator gained system-wide statistics permission management");
  }
  if (!canUseTimetableAction("admin", "timetable_reserve_stats_access_save")) {
    throw new Error("System administrator was denied statistics permission management");
  }
});


Deno.test("duty-only teachers receive read-only access to duty report timetable context", async () => {
  const session = { principal_type: "teacher", principal_name: "Duty Teacher", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "Duty Teacher", role: "teacher", permissions: { duty: true } },
    duty: true,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_duty_report_context",
  );
  if (principal?.type !== "teacher" || principal.name !== "Duty Teacher" || principal.dutyReportOnly !== true || principal.dutyReportAccess !== true) {
    throw new Error("Existing duty permission did not resolve a duty-only principal");
  }
  if (!canUseTimetableAction("teacher", "timetable_duty_report_context", false, false, false, false, true)) {
    throw new Error("Duty-only principal could not read the duty report context");
  }
  if (!canUseTimetableAction("teacher", "teacher_substitution_get_today", false, false, false, false, true)) {
    throw new Error("Duty-only principal lost access to their own daily substitution notice");
  }
  if (canUseTimetableAction("teacher", "timetable_class_weekly_get", false, false, false, false, true)) {
    throw new Error("Duty-only principal was granted broader timetable access");
  }
});

Deno.test("teacher without duty permission cannot obtain duty-only timetable access", async () => {
  const session = { principal_type: "teacher", principal_name: "No Duty Teacher", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "No Duty Teacher", role: "teacher" },
    duty: false,
  });
  if (await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW) !== null) {
    throw new Error("Teacher without any timetable, reserve, portal, or duty permission was accepted");
  }
});


Deno.test("schoolwide reserve statistics permission is checked only for statistics and its narrow bootstrap actions", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const ordinaryCalls: string[] = [];
  const ordinaryStore = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher" },
    access: true,
    schoolwideReserveStats: true,
    calls: ordinaryCalls,
  });
  const ordinaryPrincipal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, ordinaryStore, NOW, "timetable_class_weekly_get",
  );
  if (ordinaryPrincipal?.schoolwideReserveStats === true || ordinaryPrincipal === null) {
    throw new Error("An unrelated timetable action changed the existing general timetable identity or gained statistics access");
  }
  if (ordinaryCalls.some((call) => call.startsWith("schoolwide-stats:"))) {
    throw new Error("Schoolwide statistics permission was queried for an unrelated timetable action");
  }

  const statsCalls: string[] = [];
  const statsStore = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher" },
    access: true,
    schoolwideReserveStats: true,
    calls: statsCalls,
  });
  const statsPrincipal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, statsStore, NOW, "timetable_substitution_stats",
  );
  if (statsPrincipal?.schoolwideReserveStats !== true) {
    throw new Error("Explicit schoolwide statistics permission was not retained for statistics");
  }
  if (!statsCalls.includes("schoolwide-stats:teacher:Teacher A")) {
    throw new Error("Statistics action did not re-check the explicit statistics grant");
  }
  if (!canUseTimetableAction("teacher", "timetable_substitution_stats", false, false,
    statsPrincipal.reserveStatsOnly === true, statsPrincipal.schoolwideReserveStats === true)) {
    throw new Error("Authorized schoolwide statistics access was denied");
  }
});

Deno.test("statistics-only account retains statistics access without widening other actions", async () => {
  const session = { principal_type: "teacher", principal_name: "Stats Teacher", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: { name: "Stats Teacher", role: "teacher" },
    schoolwideReserveStats: true,
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_substitution_stats",
  );
  if (principal?.reserveStatsOnly !== true) {
    throw new Error("Statistics-only account did not retain its narrow principal scope");
  }
  if (!canUseTimetableAction("teacher", "timetable_substitution_stats", false, false, true)) {
    throw new Error("Statistics-only account lost statistics access");
  }
  const bootstrapPrincipal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_check_access",
  );
  if (bootstrapPrincipal?.reserveStatsOnly !== true ||
      !canUseTimetableAction("teacher", "timetable_check_access", false, false, true)) {
    throw new Error("Statistics-only account lost its existing narrow access-check capability");
  }
  if (canUseTimetableAction("teacher", "timetable_substitution_preview", false, false, true)) {
    throw new Error("Statistics-only account gained reserve-management access");
  }
});


Deno.test("unrelated timetable actions do not load linked portal weekly cells or daily assignments", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher" },
    linkedPortalAccess: true,
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_substitution_preview",
  );
  if (principal !== null) {
    throw new Error("A portal-linked teacher without reserve permission gained substitution access");
  }
  if (calls.some((call) => call.startsWith("linked-portal:"))) {
    throw new Error("An unrelated action performed portal weekly-cell or daily-assignment lookups");
  }
});


Deno.test("reserve-only teacher authorization reuses the live teacher permission lookup", async () => {
  const session = { principal_type: "teacher", principal_name: "Reserve Teacher", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: { name: "Reserve Teacher", role: "teacher" },
    reserve: true,
    access: false,
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_substitution_preview",
  );
  if (principal?.reserveAccess !== true) throw new Error("Reserve-only teacher lost the existing reserve grant");
  if (!canUseTimetableAction("teacher", "timetable_substitution_preview", false, principal.reserveAccess)) {
    throw new Error("Reserve-only teacher was denied substitution preview");
  }
  if (calls.filter((call) => call === "teacher:Reserve Teacher").length !== 1 ||
      !calls.includes("teacher-permissions:Reserve Teacher")) {
    throw new Error("Teacher identity and reserve permission were not loaded in one lookup");
  }
  if (calls.some((call) => call.startsWith("reserve:"))) {
    throw new Error("A duplicate reserve permission lookup was performed");
  }
});

Deno.test("duty-only permission is checked only for duty report and its narrow bootstrap actions", async () => {
  const session = { principal_type: "teacher", principal_name: "Duty Teacher", expires_at: EXPIRY };
  const ordinaryCalls: string[] = [];
  const ordinaryStore = storeWith(session, {
    teacher: { name: "Duty Teacher", role: "teacher" },
    duty: true,
    calls: ordinaryCalls,
  });
  if (await resolveTimetablePrincipal(
    "Bearer " + TOKEN, ordinaryStore, NOW, "timetable_substitution_preview",
  ) !== null) {
    throw new Error("Duty-only teacher gained substitution management access");
  }
  if (ordinaryCalls.some((call) => call.startsWith("duty:"))) {
    throw new Error("Unrelated action performed a duty permission lookup");
  }

  const dutyCalls: string[] = [];
  const dutyStore = storeWith(session, {
    teacher: { name: "Duty Teacher", role: "teacher", permissions: { duty: true } },
    access: true,
    duty: true,
    calls: dutyCalls,
  });
  const dutyPrincipal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, dutyStore, NOW, "timetable_duty_report_context",
  );
  if (dutyPrincipal?.dutyReportAccess !== true || dutyPrincipal.permissions?.duty !== true) {
    throw new Error("Explicit duty permission and its fresh teacher snapshot were not retained for duty report action");
  }
  if (dutyCalls.filter((call) => call === "duty:teacher:Duty Teacher").length !== 1) {
    throw new Error("Duty permission was not checked exactly once for duty report action");
  }
});


Deno.test("ordinary timetable actions load current permissions to detect delegated administrator capability", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher", permissions: { reserve: true, duty: true } },
    access: true,
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_class_weekly_get",
  );
  if (principal?.type !== "teacher") throw new Error("Teacher with timetable access was not authenticated");
  if (!calls.includes("teacher-permissions:Teacher A")) {
    throw new Error("An unrelated timetable read did not load the admin capability from the live permission snapshot");
  }
});


Deno.test("teacher activity report permission reuses the authenticated teacher permission snapshot", async () => {
  const session = { principal_type: "teacher", principal_name: "Activity Teacher", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: {
      name: "Activity Teacher",
      role: "teacher",
      permissions: { teachers: true },
    },
    access: true,
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_activity_report_data",
  );
  if (principal?.permissions?.teachers !== true) {
    throw new Error("Teacher activity permission was not included in the fresh teacher lookup");
  }
  if (!calls.includes("teacher-permissions:Activity Teacher")) {
    throw new Error("Activity report did not request the live teacher permission snapshot");
  }
  if (calls.filter((call) => call === "teacher:Activity Teacher").length !== 1) {
    throw new Error("Teacher identity was not loaded exactly once");
  }
});


Deno.test("delegated full administrator is elevated only inside timetable authorization while Additional Admin stays off", async () => {
  const session = { principal_type: "teacher", principal_name: "Tester1", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: {
      name: "Tester1", role: "teacher",
      permissions: { admin: true, additionalAdmin: false, reserve: true },
    },
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_portal_set_enabled",
  );
  if (principal?.type !== "admin" || principal.name !== "Tester1" || principal.permissions?.admin !== true) {
    throw new Error("Delegated administrator did not receive timetable administrator authority");
  }
  if (!calls.includes("teacher-permissions:Tester1")) {
    throw new Error("Delegated administrator capability was not read from the live teacher profile");
  }
});


Deno.test("schoolwide archive-only teacher permission authenticates only the two archive reads", async () => {
  const session = { principal_type: "teacher", principal_name: "Archive Reader", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: {
      name: "Archive Reader",
      role: "teacher",
      permissions: { schoolwideReserveArchive: true },
    },
  });
  for (const action of ["timetable_substitution_archive", "timetable_substitution_archive_access"]) {
    const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW, action);
    if (principal?.type !== "teacher" || principal.permissions?.schoolwideReserveArchive !== true) {
      throw new Error("Archive-only teacher permission did not authenticate " + action);
    }
  }
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "timetable_substitution_save",
  );
  if (principal !== null) {
    throw new Error("Archive-only teacher permission must not authenticate reserve management actions");
  }
});


Deno.test("admin-records portal grant unlocks only the read-only reserve report action", async () => {
  const session = { principal_type: "teacher", principal_name: "Records Viewer", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "Records Viewer", role: "teacher", permissions: { adminRecords: true } },
    access: false,
    reserve: false,
  });
  const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW, "admin_records_center:timetable_substitution_report");
  if (principal?.type !== "teacher" || principal.reportReadOnly !== true || principal.adminRecordsCenterReportOnly !== true) {
    throw new Error("Explicit admin-records access did not create the narrow report-only identity");
  }
  if (principal.reserveAccess === true || canUseTimetableAction("teacher", "timetable_substitution_save", false, principal.reserveAccess)) {
    throw new Error("Report-only access must not grant reserve management");
  }
});

Deno.test("Additional Admin alone does not grant the admin-records reserve report", async () => {
  const session = { principal_type: "teacher", principal_name: "Additional Only", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "Additional Only", role: "teacher", permissions: { additionalAdmin: true } },
    access: false,
    reserve: false,
  });
  const principal = await resolveTimetablePrincipal("Bearer " + TOKEN, store, NOW, "admin_records_center:timetable_substitution_report");
  if (principal !== null) throw new Error("Additional Admin alone must not gain report-only access");
});


Deno.test("administrative records center gets read-only teacher compliance data without timetable or reserve management", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const calls: string[] = [];
  const store = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher", permissions: { adminRecords: true } },
    access: false,
    reserve: false,
    calls,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "admin_records_center:timetable_activity_report_data",
  );
  if (principal?.type !== "teacher" || principal.adminRecordsCenterReportOnly !== true || principal.reportReadOnly !== true) {
    throw new Error("Records-center report grant did not produce the narrow read-only principal");
  }
  if (principal.portalOnly === true || principal.reserveAccess === true) {
    throw new Error("Records-center report grant was mixed with a portal or reserve grant");
  }
  if (canUseTimetableAction("teacher", "timetable_substitution_save", principal.portalOnly, principal.reserveAccess)) {
    throw new Error("Records-center report-only principal gained reserve mutation access");
  }
  if (calls.some(call => call.startsWith("access:") || call.startsWith("schoolwide-stats:"))) {
    throw new Error("Read-only report authorization performed unrelated timetable permission reads");
  }
});

Deno.test("teacher without administrative records grant cannot receive center-only compliance principal", async () => {
  const session = { principal_type: "teacher", principal_name: "Teacher A", expires_at: EXPIRY };
  const store = storeWith(session, {
    teacher: { name: "Teacher A", role: "teacher", permissions: {} },
    access: false,
  });
  const principal = await resolveTimetablePrincipal(
    "Bearer " + TOKEN, store, NOW, "admin_records_center:timetable_activity_report_data",
  );
  if (principal !== null) throw new Error("Teacher without records-center permission was accepted");
});
