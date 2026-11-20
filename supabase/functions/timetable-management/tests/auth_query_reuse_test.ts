const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
const authSource = await Deno.readTextFile(new URL("../session_auth.ts", import.meta.url));

function section(start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`Missing source section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`Missing source boundary: ${end}`);
  return source.slice(from, to);
}

Deno.test("ordinary timetable auth reuses one teacher identity lookup without loading permissions", () => {
  const store = section("const timetableAuthStore: TimetableAuthStore = {", "async function requirePrincipal");
  if (!store.includes("async findTeacher(name, includePermissions = false)")) {
    throw new Error("Teacher lookup must support action-scoped permission loading");
  }
  if (!store.includes('.select("name,role,permissions")')) {
    throw new Error("Permission-bearing lookup must select the permission snapshot with teacher identity");
  }
  if (!store.includes("reserveAccess: includePermissions && data.role === \"teacher\" && permissions.reserve === true")) {
    throw new Error("Reserve permission must be derived from the same teacher lookup");
  }
  const resolver = section("async function requirePrincipal(", "function validUuid");
  if (!resolver.includes("requestedAction")) throw new Error("The requested action must scope permission loading");
});

Deno.test("reserve and duty permissions are reused from the authenticated teacher snapshot", () => {
  const store = section("const timetableAuthStore: TimetableAuthStore = {", "async function requirePrincipal");
  const reserveStart = store.indexOf("async hasSubstitutionAccess");
  if (reserveStart >= 0) throw new Error("Duplicate reserve permission query must be removed");
  const duty = section("async hasDutyReportAccess(", "async hasLinkedTeacherPortalAccess");
  if (duty.includes('db.from("teachers")')) throw new Error("Duty permission must not re-read the teacher table");
  if (!duty.includes("teacherPermissions")) throw new Error("Duty permission must use the supplied teacher snapshot");
  const context = section("async canReadDutyReportContext(", "async hasLinkedTeacherPortalAccess");
  if (context.includes('db.from("teachers")')) throw new Error("Duty context must not re-read the teacher table");
  if (!context.includes("teacherPermissions")) throw new Error("Duty context must use the supplied teacher snapshot");
});

Deno.test("daily notice authorization checks the portal allow-list without scanning weekly cells", () => {
  const store = section("const timetableAuthStore: TimetableAuthStore = {", "async function requirePrincipal");
  const notice = section("async hasLinkedTeacherPortalNoticeAccess(", "async hasOwnDailySubstitutionAssignment");
  if (!notice.includes('db.from("teacher_timetable_portal_settings")')) {
    throw new Error("Daily notice must check the portal allow-list");
  }
  if (notice.includes("fetchTeacherTimetableCells") || notice.includes("timetable_weekly_cells")) {
    throw new Error("Daily notice authorization must not load weekly timetable cells");
  }
  if (!store.includes("hasLinkedTeacherPortalNoticeAccess")) {
    throw new Error("Lightweight daily notice authorization must be wired into the auth store");
  }
});

Deno.test("request handler reuses the principal snapshot instead of issuing duplicate permission reads", () => {
  const handler = section("async function handle(req: Request)", 'if (action === "timetable_duty_report_context") {');
  if (!handler.includes("requirePrincipal(req, action)")) {
    throw new Error("The action must be supplied to principal resolution");
  }
  if (!handler.includes("principal.reserveAccess === true")) {
    throw new Error("Reserve authorization must use the resolved principal snapshot");
  }
  if (handler.includes("hasSubstitutionAccess")) {
    throw new Error("The handler must not perform a duplicate reserve permission query");
  }
  if (!handler.includes("principal.permissions?.teachers === true")) {
    throw new Error("Teacher activity permission must use the resolved permission snapshot");
  }
  if (!handler.includes("needsArchiveGrant")) {
    throw new Error("The separate timetable grant should be rechecked only for archive actions");
  }
});

Deno.test("timetable edge function caches successful CORS preflight responses", () => {
  if (!source.includes('"Access-Control-Max-Age": "600"')) {
    throw new Error("CORS preflight cache lifetime must be configured");
  }
});


Deno.test("duty context performs one authoritative duty-module check", () => {
  const duty = section("async hasDutyReportAccess(", "async canReadDutyReportContext(");
  if (!duty.includes("checkCurrentDay = true")) {
    throw new Error("Duty permission lookup must support skipping the preliminary day check");
  }
  if (!duty.includes("if (!checkCurrentDay) return true")) {
    throw new Error("Duty context must defer its only duty-module read to the authoritative period check");
  }
  const authStart = authSource.indexOf("export async function resolveTimetablePrincipal(");
  const authEnd = authSource.indexOf("export function canUseTimetableAction(", authStart);
  if (authStart < 0 || authEnd <= authStart) throw new Error("Missing timetable principal resolver");
  const resolver = authSource.slice(authStart, authEnd);
  if (!resolver.includes('requestedAction !== "timetable_duty_report_context"')) {
    throw new Error("The resolver must skip the preliminary duty-module read for the context action");
  }
});

Deno.test("linked timetable authorization avoids repeating the cell read performed by the handler", () => {
  const portal = section("async hasLinkedTeacherPortalAccess(", "async hasLinkedTeacherPortalNoticeAccess(");
  if (!portal.includes('action === "timetable_check_access" || action === "teacher_timetable_get_own"')) {
    throw new Error("The access resolver must defer authoritative cell reads to these handlers");
  }
  const resolverStart = authSource.indexOf("export async function resolveTimetablePrincipal(");
  const resolverEnd = authSource.indexOf("export function canUseTimetableAction(", resolverStart);
  const resolver = authSource.slice(resolverStart, resolverEnd);
  if (!resolver.includes("store.hasLinkedTeacherPortalAccess(name, requestedAction)")) {
    throw new Error("The requested action must be passed to linked portal authorization");
  }
  const ownTimetable = section('if (body.action === "teacher_timetable_get_own")', 'if (body.action === "teacher_substitution_get_today")');
  if (!ownTimetable.includes("fetchTeacherTimetableCells")) {
    throw new Error("The personal timetable handler must retain its authoritative cell read");
  }
});

Deno.test("department subject resolution reuses an already loaded teacher directory", () => {
  const helper = section("async function getActiveDepartmentSubjects(", "function timetableTeacherIdentityKey(");
  if (!helper.includes("preloadedDirectory ?? await teacherDirectory()")) {
    throw new Error("Department subject resolution must accept a preloaded teacher directory");
  }
  if (!source.includes("getActiveDepartmentSubjects(actor.departmentId, directory)") ||
      !source.includes("getActiveDepartmentSubjects(actorDepartmentId, directory)")) {
    throw new Error("Department workflows must reuse the directory they already loaded");
  }
});
