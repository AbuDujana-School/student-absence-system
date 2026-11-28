export type TimetablePrincipalType = "admin" | "teacher" | "custom";

export interface TimetablePrincipal {
  type: TimetablePrincipalType;
  name: string;
  /** A linked teacher with portal-only access; cannot manage timetables or substitutions. */
  portalOnly?: boolean;
  /** May view schoolwide reserve statistics; does not itself grant reserve management. */
  schoolwideReserveStats?: boolean;
  /** Narrow read-only report capability; never grants reserve mutation. */
  reportReadOnly?: boolean;
  /** Marks report-only access originating from the admin-records portal grant. */
  adminRecordsCenterReportOnly?: boolean;
  /** Has only the schoolwide reserve-statistics view, with no other timetable grant. */
  reserveStatsOnly?: boolean;
  /** Can only read the timetable context needed to compose an authorized duty report. */
  dutyReportOnly?: boolean;
  /** Current teacher reserve grant, read together with the teacher identity. */
  reserveAccess?: boolean;
  /** Current duty-report grant, checked only on the duty/report bootstrap actions. */
  dutyReportAccess?: boolean;
  /** Fresh permission snapshot loaded with the authenticated teacher record. */
  permissions?: Record<string, unknown>;
}

export interface TimetableSessionLookup {
  principal_type: unknown;
  principal_name: unknown;
  expires_at: unknown;
}

export interface TimetableTeacherLookup {
  name: string;
  role: string;
  reserveAccess?: boolean;
  permissions?: Record<string, unknown>;
}

export interface TimetableAuthStore {
  findSession(tokenHash: string, nowIso: string): Promise<TimetableSessionLookup | null>;
  hasAdminCredential(): Promise<boolean>;
  findAdminTeacher?(name: string): Promise<boolean>;
  findTeacher(name: string, includePermissions?: boolean): Promise<TimetableTeacherLookup | null>;
  hasTimetableAccess(type: "teacher" | "custom", name: string): Promise<boolean>;
  hasDutyReportAccess?(type: "teacher" | "custom", name: string, permissions?: Record<string, unknown>, checkCurrentDay?: boolean): Promise<boolean>;
  canReadDutyReportContext?(type: "teacher" | "custom", name: string, date: string, weekday: string, period: number, permissions?: Record<string, unknown>): Promise<boolean>;
  hasLinkedTeacherPortalAccess?(name: string, action?: string): Promise<boolean>;
  /** Lightweight portal-setting check used only for the teacher's own daily notice. */
  hasSchoolwideReserveStatsAccess?(type: "teacher" | "custom", name: string): Promise<boolean>;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve a timetable identity only from a valid, active general-app session.
 * Staff management access requires an explicit timetable permission. A teacher
 * with a linked active schedule may receive a narrower, portal-only identity
 * when the school-wide teacher timetable portal is enabled. The caller never
 * supplies an identity name.
 */
export async function resolveTimetablePrincipal(
  authorization: unknown,
  store: TimetableAuthStore,
  now = Date.now(),
  requestedAction = "",
): Promise<TimetablePrincipal | null> {
  if (typeof authorization !== "string" || !Number.isFinite(now)) return null;
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(authorization.trim());
  if (!match) return null;

  const tokenHash = await sha256(match[1].toLowerCase());
  const nowIso = new Date(now).toISOString();
  const session = await store.findSession(tokenHash, nowIso);
  if (!session || typeof session.expires_at !== "string") return null;
  const expiresAt = Date.parse(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  let type: TimetablePrincipalType;
  let name: string;
  let preloadedTeacher: TimetableTeacherLookup | null = null;
  if (session.principal_type === "admin") {
    if (typeof session.principal_name !== "string" || !session.principal_name.trim()) return null;
    if (session.principal_name === "مدير النظام العام") {
      return await store.hasAdminCredential()
        ? { type: "admin", name: "مدير النظام العام" }
        : null;
    }
    // A legacy admin session for an additional administrator is normalized
    // to its original teacher identity before any authorization checks.
    name = session.principal_name;
    preloadedTeacher = await store.findTeacher(name, true);
    if (!preloadedTeacher || preloadedTeacher.name !== name || preloadedTeacher.role !== "teacher" ||
        preloadedTeacher.permissions?.additionalAdmin !== true) return null;
    type = "teacher";
  } else {
    if (session.principal_type !== "teacher" && session.principal_type !== "custom") return null;
    if (typeof session.principal_name !== "string" || !session.principal_name.trim()) return null;
    type = session.principal_type;
    name = session.principal_name;
  }
  // Always load the current teacher permission snapshot: the explicit
  // permissions.admin capability grants delegated administrator authority
  // inside this module without changing the account's stored teacher role.
  const selfScopedAction = new Set([
    "teacher_timetable_get_own",
    "teacher_substitution_get_today",
  ]).has(requestedAction);
  const needsTeacherPermissions = !selfScopedAction;
  const teacher = preloadedTeacher || await store.findTeacher(name, needsTeacherPermissions);
  if (!teacher || teacher.name !== name || teacher.role !== type) return null;
  const permissions = teacher.permissions && typeof teacher.permissions === "object"
    ? teacher.permissions : {};
  const additionalOverrides = permissions.additionalAdminOverrides && typeof permissions.additionalAdminOverrides === "object"
    ? permissions.additionalAdminOverrides as Record<string, unknown> : {};
  const hasAdminRecordsCenterGrant = permissions.adminRecords === true || permissions.canViewAdminRecords === true || additionalOverrides.adminRecords === true;
  if (requestedAction === "admin_records_center:timetable_substitution_report" && hasAdminRecordsCenterGrant) {
    return { type, name, permissions, reportReadOnly: true, adminRecordsCenterReportOnly: true };
  }
  if (requestedAction === "admin_records_center:timetable_activity_report_data" && hasAdminRecordsCenterGrant) {
    return { type, name, permissions, reportReadOnly: true, adminRecordsCenterReportOnly: true };
  }
  if (requestedAction === "timetable_substitution_report" && permissions.reportSubstitutionDistribution === true) {
    return { type, name, permissions, reportReadOnly: true };
  }
  // Delegated full administrators remain teacher identities in app_sessions,
  // but receive administrator authority for timetable management actions.
  if (type === "teacher" && permissions.admin === true) {
    return { type: "admin", name, permissions };
  }
  const reserveAccess = type === "teacher" && teacher.reserveAccess === true;
  const schoolwideReserveArchiveAccess = type === "teacher" && permissions.schoolwideReserveArchive === true;
  // These two reads are strictly self-scoped by their request handlers. The
  // handlers verify the live portal allow-list or query only this teacher's
  // assignments, so preflight permission/portal queries here are redundant.
  if (type === "teacher" && new Set([
    "teacher_timetable_get_own",
    "teacher_substitution_get_today",
  ]).has(requestedAction)) {
    return { type, name, portalOnly: true };
  }
  // The schoolwide statistics grant is relevant only to the statistics action.
  // Avoid one permission-table read on every unrelated timetable request.
  const needsSchoolwideReserveStats = new Set([
    "timetable_substitution_stats",
    // Statistics-only accounts historically retain these narrow bootstrap/read actions.
    "health",
    "timetable_check_access",
  ]).has(requestedAction);
  const hasSchoolwideReserveStats = async () => needsSchoolwideReserveStats &&
    store.hasSchoolwideReserveStatsAccess
      ? await store.hasSchoolwideReserveStatsAccess(type, name)
      : false;
  const dutyReportAction = requestedAction === "timetable_duty_report_context";
  if (await store.hasTimetableAccess(type, name)) {
    const schoolwideReserveStats = await hasSchoolwideReserveStats();
    const dutyReportAccess = dutyReportAction && store.hasDutyReportAccess
      ? await store.hasDutyReportAccess(type, name, permissions, requestedAction !== "timetable_duty_report_context")
      : false;
    return {
      type, name, permissions, reserveAccess, schoolwideReserveStats,
      ...(dutyReportAction ? { dutyReportAccess } : {}),
    };
  }
  // Reserve permission is loaded with the teacher identity, avoiding a second
  // teachers-table read during authorization and again in the request handler.
  if (reserveAccess) {
    const schoolwideReserveStats = await hasSchoolwideReserveStats();
    const dutyReportAccess = dutyReportAction && store.hasDutyReportAccess
      ? await store.hasDutyReportAccess(type, name, permissions, requestedAction !== "timetable_duty_report_context")
      : false;
    return {
      type, name, permissions, reserveAccess: true, schoolwideReserveStats,
      ...(dutyReportAction ? { dutyReportAccess } : {}),
    };
  }
  // This grant is deliberately read-only and authorizes only the two archive
  // endpoints. It does not unlock substitution planning, saving, or editing.
  if (schoolwideReserveArchiveAccess && new Set([
    "timetable_substitution_archive",
    "timetable_substitution_archive_access",
  ]).has(requestedAction)) {
    return { type, name, permissions };
  }
  const schoolwideReserveStats = await hasSchoolwideReserveStats();
  if (schoolwideReserveStats) {
    return { type, name, schoolwideReserveStats: true, reserveStatsOnly: true };
  }
  // The daily notice exposes only this teacher's own assignments. For this
  // action, verify the configured portal allow-list without loading weekly cells.
  if (type === "teacher" && new Set([
    "health",
    "timetable_check_access",
  ]).has(requestedAction)) {
    // Full linked-schedule verification is needed only for portal status reads.
    if (store.hasLinkedTeacherPortalAccess
      && await store.hasLinkedTeacherPortalAccess(name, requestedAction)) {
      return { type, name, portalOnly: true };
    }
  }
  const mayUseDutyBootstrap = new Set([
    "health",
    "timetable_check_access",
    "teacher_substitution_get_today",
  ]).has(requestedAction);
  if ((dutyReportAction || mayUseDutyBootstrap) && store.hasDutyReportAccess
    && await store.hasDutyReportAccess(type, name, permissions, requestedAction !== "timetable_duty_report_context")) {
    return { type, name, permissions, dutyReportOnly: true, dutyReportAccess: true };
  }
  return null;
}


/** Actions available to an explicitly authorized non-admin timetable account. */
export function canUseTimetableAction(
  principalType: TimetablePrincipalType,
  action: string,
  portalOnly = false,
  hasReservePermission = false,
  reserveStatsOnly = false,
  schoolwideReserveStats = false,
  dutyReportOnly = false,
): boolean {
  if (principalType === "admin") return true;
  if (dutyReportOnly) return new Set(["health", "timetable_check_access", "timetable_duty_report_context", "teacher_substitution_get_today"]).has(action);
  if (schoolwideReserveStats && action === "timetable_substitution_stats") return true;
  if (portalOnly) return new Set([
    "health",
    "timetable_check_access",
    "teacher_timetable_get_own",
    "teacher_substitution_get_today",
  ]).has(action);
  if (reserveStatsOnly) return new Set([
    "health",
    "timetable_check_access",
    "timetable_substitution_stats",
  ]).has(action);
  const substitutionActions = new Set([
    "timetable_substitution_preview",
    "timetable_substitution_departments",
    "timetable_substitution_save",
    "timetable_substitution_cancel",
    "timetable_substitution_cancel_batch",
    "timetable_substitution_batch_preview",
    "timetable_substitution_batch_save",
    "timetable_substitution_stats",
    "timetable_substitution_archive",
    "timetable_substitution_update",
    "timetable_substitution_update_batch",
    "timetable_substitution_reset_options",
    "timetable_substitution_reset",
  ]);
  if (principalType === "teacher") {
    if (substitutionActions.has(action)) return hasReservePermission;
    return new Set(["health","timetable_check_access","teacher_timetable_get_own","teacher_substitution_get_today"]).has(action);
  }
  const customSubstitutionActions = new Set([
    "timetable_substitution_preview",
    "timetable_substitution_save",
    "timetable_substitution_cancel",
    "timetable_substitution_cancel_batch",
    "timetable_substitution_batch_preview",
    "timetable_substitution_batch_save",
  ]);
  return new Set([
    "health",
    "timetable_check_access",
    "teacher_timetable_get_own",
    ...customSubstitutionActions,
  ]).has(action);
}

/** The administrator or a teacher explicitly granted reserve-distribution permission may broaden substitute candidates. */
export function canIncludeOtherDepartments(
  principalType: TimetablePrincipalType, requested: unknown, hasReservePermission = false,
): boolean {
  return requested === true && (principalType === "admin" || (principalType === "teacher" && hasReservePermission));
}

export function canAccessTeacherTimetablePortal(enabled: unknown, selectedTeacherNames: unknown, teacherName: string): boolean {
  if (enabled !== true || !String(teacherName || "").trim()) return false;
  const selected = Array.isArray(selectedTeacherNames)
    ? selectedTeacherNames.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  return selected.length === 0 || selected.includes(String(teacherName).trim());
}
