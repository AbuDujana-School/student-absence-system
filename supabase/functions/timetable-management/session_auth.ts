export type TimetablePrincipalType = "admin" | "teacher" | "custom";

export interface TimetablePrincipal {
  type: TimetablePrincipalType;
  name: string;
  /** A linked teacher with portal-only access; cannot manage timetables or substitutions. */
  portalOnly?: boolean;
}

export interface TimetableSessionLookup {
  principal_type: unknown;
  principal_name: unknown;
  expires_at: unknown;
}

export interface TimetableTeacherLookup {
  name: string;
  role: string;
}

export interface TimetableAuthStore {
  findSession(tokenHash: string, nowIso: string): Promise<TimetableSessionLookup | null>;
  hasAdminCredential(): Promise<boolean>;
  findTeacher(name: string): Promise<TimetableTeacherLookup | null>;
  hasTimetableAccess(type: "teacher" | "custom", name: string): Promise<boolean>;
  hasLinkedTeacherPortalAccess?(name: string): Promise<boolean>;
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

  if (session.principal_type === "admin" && session.principal_name === "مدير النظام العام") {
    return await store.hasAdminCredential()
      ? { type: "admin", name: "مدير النظام العام" }
      : null;
  }

  if (session.principal_type !== "teacher" && session.principal_type !== "custom") return null;
  if (typeof session.principal_name !== "string" || !session.principal_name.trim()) return null;

  const type = session.principal_type;
  const name = session.principal_name;
  const teacher = await store.findTeacher(name);
  if (!teacher || teacher.name !== name || teacher.role !== type) return null;
  if (await store.hasTimetableAccess(type, name)) return { type, name };
  if (type === "teacher" && store.hasLinkedTeacherPortalAccess
    && await store.hasLinkedTeacherPortalAccess(name)) {
    return { type, name, portalOnly: true };
  }
  return null;
}


/** Actions available to an explicitly authorized non-admin timetable account. */
export function canUseTimetableAction(
  principalType: TimetablePrincipalType,
  action: string,
  portalOnly = false,
): boolean {
  if (principalType === "admin") return true;
  if (portalOnly) return new Set([
    "health",
    "timetable_check_access",
    "teacher_timetable_get_own",
  ]).has(action);
  return new Set([
    "health",
    "timetable_check_access",
    "teacher_timetable_get_own",
    "timetable_substitution_preview",
    "timetable_substitution_save",
    "timetable_substitution_cancel",
  ]).has(action);
}

/** Only the system administrator may broaden substitution beyond the actor's department. */
export function canIncludeOtherDepartments(principalType: TimetablePrincipalType, requested: unknown): boolean {
  return principalType === "admin" && requested === true;
}
