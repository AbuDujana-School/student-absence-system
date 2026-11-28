import { authorizeReportMode, isValidIsoDate, filterAttendanceRecordMap, filterBehaviorRecordMap, behaviorTypesFromRecord, areClassesAllowed, applyReportsEntryPermissions, filterNoticeHistoryRows } from "./report_policy.ts";
import { buildNoticeCandidates, validateNoticeIssueItem, NOTICE_ATTENDANCE_TYPES, NOTICE_BEHAVIOR_TYPES, NOTICE_TYPES } from "./notice_policy.ts";
import { fetchNoticeRowsForClasses } from "./notice_issue_fetch.ts";
import { awardWeeklyCompetitionPoints, rankCompetitionTeamsByAccumulatedPoints, buildTeamRates, calculateRelativeCompetitionScores, getSchoolDays, getSchoolWeekRange, isCompleteSchoolWeekRange, isCompetitionWeeklyCutoffReached, getCompetitionMonthRange } from "./competition_policy.ts";
import { buildCompetitionTeams, findCompetitionClassesOutsidePersonalScope, projectCompetitionTeam } from "./competition_team_policy.ts";
import { projectCompetitionClassComparison } from "./competition_response_policy.ts";
import { applyTeamLeaderNoticePrintAccess, buildVisitorAccess, projectSupervisionReportPermissions, resolveSupervisionTeacher } from "./supervision_access_policy.ts";
import { fetchAnalyticsBatch } from "./analytics_batch_fetch.ts";
import { fetchSupervisionTrendRows } from "./supervision_trend_fetch.ts";
import {
  resolveAppPrincipal, issueAppSession, readAppSession, revokeAppSession, appCredentialLookupKey,
  type AppLoginCandidate, type AppPrincipal,
} from "./app_auth_policy.ts";
import { createSupabaseAppSessionStore, type AppSessionDatabaseClient } from "./app_session_store.ts";
import { type AppDataScope } from "./app_data_gateway_policy.ts";
import { handleAppDataGatewayRead } from "./app_data_gateway_handler.ts";
import { resolveAppDataScope } from "./app_data_gateway_resolver.ts";
import { canAccessReportPermission, hasAdminRecordsCenterAccess } from "../_shared/report_access_policy.ts";
import { isAdminStudentAffairsAccessEnabled } from "./admin_student_affairs_access_policy.ts";
import { omanActivityDateRange, omanTodayIsoDate } from "./activity_monitor_policy.ts";
import { isAdditionalAdminTeacher, buildAdditionalAdminPermissions } from "../_shared/admin_principal_policy.ts";
import { parseTimetableWorkbook, matchSystemTeacherName, type SystemTeacher } from "./timetable_import.ts";
import { parseTimetableDay, validateSchoolTeacherCount } from "./timetable_grid.ts";
import { getAbsentTeacherLessons, getAvailableSubstitutionCandidates, type TimetableEntry, type SubstitutionAssignment, type SubstitutionTeacher } from "./substitution_policy.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const PIN_ITERATIONS = 150000;
const SESSION_HOURS = 8;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
function reply(status: number, body: Record<string, unknown>) { return new Response(JSON.stringify(body), { status, headers: cors }); }
const enc = new TextEncoder();
function hex(bytes: Uint8Array) { return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))); }
async function pbkdf2(value: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(value), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" }, key, 256);
  return hex(new Uint8Array(bits));
}
function equalHex(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function getPepper() {
  const { data, error } = await db.rpc("student_affairs_get_pin_pepper");
  if (error || typeof data !== "string" || data.length < 32) throw new Error("Server authentication secret unavailable");
  return data;
}
async function verifyNewPin(pin: string, salt: string, expected: string, pepper: string) {
  return equalHex(await pbkdf2(pepper + ":" + salt + ":" + pin, salt, 310000), expected);
}
async function getLegacyPeppers(): Promise<{ pbkdf2: string; sha256: string }> {
  const { data, error } = await db.rpc("student_affairs_get_legacy_pin_peppers");
  if (error || !data || typeof data.pbkdf2 !== "string" || typeof data.sha256 !== "string") {
    throw new Error("Legacy PIN compatibility secrets are not configured in Vault");
  }
  return data as { pbkdf2: string; sha256: string };
}
async function verifyExistingPin(pin: string, salt: string, expected: string, legacy: { pbkdf2: string; sha256: string }) {
  if (!salt || !expected) return false;
  const modern = await pbkdf2(legacy.pbkdf2 + ":" + salt + ":" + pin, salt, PIN_ITERATIONS);
  if (equalHex(modern, expected)) return true;
  return equalHex(await sha256(legacy.sha256 + ":" + salt + ":" + pin), expected);
}
function validPin(pin: unknown): pin is string { return typeof pin === "string" && /^[0-9]{4,10}$/.test(pin); }

const appSessionStore = createSupabaseAppSessionStore(db as unknown as AppSessionDatabaseClient);

async function findAppPrincipal(pin: string, pepper: string): Promise<AppPrincipal | null> {
  // The administrator is the highest-priority principal. Verify this record
  // first so an admin login never waits for full teacher/credential directory scans.
  const [{ data: adminSetting, error: adminError }, { data: adminSecure, error: adminSecureError }] = await Promise.all([
    db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle(),
    db.from("student_affairs_credentials").select("pin_salt,pin_hash,source_hash,source_salt")
      .eq("principal_type", "admin").eq("principal_name", "مدير النظام العام").maybeSingle(),
  ]);
  if (adminError || adminSecureError) throw new Error("Unable to load administrator login record");
  const adminRecord = adminSetting?.value;
  let legacy: { pbkdf2: string; sha256: string } | null = null;
  if (adminRecord?.hash && adminRecord?.salt) {
    const secure = adminSecure as any;
    const adminMatches = secure && secure.source_hash === adminRecord.hash && secure.source_salt === adminRecord.salt
      ? await verifyNewPin(pin, secure.pin_salt, secure.pin_hash, pepper)
      : await verifyExistingPin(pin, adminRecord.salt, adminRecord.hash, legacy || (legacy = await getLegacyPeppers()));
    if (adminMatches) {
      return {
        type: "admin", adminScope: "general", name: "مدير النظام العام",
        permissions: { studstats: true, behaviorstats: true, users: true, students: true, teachers: true, duty: true, alerts: true, reports: true, sync: true, security: true },
        mustChangePin: false,
      };
    }
  }

  // Only non-admin attempts need the teacher/custom-user directory.
  const [{ data: users, error: usersError }, { data: upgraded, error: upgradedError }] = await Promise.all([
    db.from("teachers").select("name,role,pin_hash,pin_salt,permissions,must_change_pin"),
    db.from("student_affairs_credentials").select("principal_type,principal_name,pin_salt,pin_hash,source_hash,source_salt")
      .in("principal_type", ["custom", "teacher"]),
  ]);
  if (usersError || upgradedError) throw new Error("Unable to load user login records");
  const candidates: AppLoginCandidate[] = [];
  for (const user of users || []) {
    const designatedAdmin = isAdditionalAdminTeacher(user);
    const type = designatedAdmin ? "admin" : user.role === "custom" ? "custom" : "teacher";
    if (!user.pin_hash || !user.pin_salt) continue;
    candidates.push({
      type, adminScope: designatedAdmin ? "additional" : undefined, credentialType: user.role === "custom" ? "custom" : "teacher",
      name: user.name, hash: user.pin_hash, salt: user.pin_salt,
      permissions: designatedAdmin
        ? buildAdditionalAdminPermissions(user)
        : user.permissions || {},
      mustChangePin: user.must_change_pin === true || user.permissions?.mustChangePin === true,
    });
  }
  const secureMap = new Map((upgraded || []).map((item: any) => [item.principal_type + "|" + item.principal_name, item]));
  return await resolveAppPrincipal(pin, candidates, async (candidatePin, salt, hash) => {
    const candidate = candidates.find((item) => item.salt === salt && item.hash === hash);
    if (!candidate) return false;
    const secure = secureMap.get(appCredentialLookupKey(candidate)) as any;
    if (secure && secure.source_hash === hash && secure.source_salt === salt) {
      return await verifyNewPin(candidatePin, secure.pin_salt, secure.pin_hash, pepper);
    }
    return await verifyExistingPin(candidatePin, salt, hash, legacy || (legacy = await getLegacyPeppers()));
  });
}

async function currentAppPrincipal(type: string, name: string): Promise<AppPrincipal | null> {
  if (type === "admin") {
    let effectivePermissions: Record<string, boolean>;
    if (name === "مدير النظام العام") {
      const { data, error } = await db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle();
      if (error || !data?.value?.hash || !data?.value?.salt) return null;
      effectivePermissions = { studstats: true, behaviorstats: true, users: true, students: true, teachers: true, duty: true, alerts: true, reports: true, sync: true, security: true };
    } else {
      const { data, error } = await db.from("teachers").select("name,role,permissions").eq("name", name).maybeSingle();
      if (error || !data || !isAdditionalAdminTeacher(data)) return null;
      effectivePermissions = buildAdditionalAdminPermissions(data);
    }
    return { type: "admin", adminScope: name === "مدير النظام العام" ? "general" : "additional", name, permissions: effectivePermissions, mustChangePin: false };
  }
  const { data, error } = await db.from("teachers").select("name,role,permissions,must_change_pin").eq("name", name).maybeSingle();
  if (error || !data || (type === "custom" ? data.role !== "custom" : data.role === "custom")) return null;
  return {
    type: type as "teacher" | "custom",
    name: data.name,
    permissions: data.permissions && typeof data.permissions === "object" ? data.permissions : {},
    mustChangePin: data.must_change_pin === true || data.permissions?.mustChangePin === true,
  };
}

function isGeneralAdminPrincipal(value: { type?: unknown; name?: unknown; adminScope?: unknown } | null | undefined): boolean {
  return value?.type === "admin" && (value.adminScope === "general" || value.name === "مدير النظام العام");
}

function hasFullAdministrativeAccess(value: { type?: unknown; name?: unknown; adminScope?: unknown; permissions?: Record<string, unknown> | null } | null | undefined): boolean {
  // Delegated full administrators keep their teacher identity and do not become Additional Admins.
  return isGeneralAdminPrincipal(value) || (value?.type === "teacher" && value.permissions?.admin === true);
}

async function readAuthorizedAppSession(authorization: unknown) {
  const session = await readAppSession(appSessionStore, authorization);
  if (!session) return null;
  const principal = await currentAppPrincipal(session.principal.type, session.principal.name);
  if (!principal) {
    await revokeAppSession(appSessionStore, authorization);
    return null;
  }
  return { ...session, principal };
}

async function clientKey(req: Request) {
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return await sha256(ip + "|" + (req.headers.get("user-agent") || "unknown"));
}
async function rateLimit(req: Request) {
  const key = await clientKey(req), now = new Date();
  const { data } = await db.from("student_affairs_login_attempts").select("*").eq("client_key", key).maybeSingle();
  if (data?.blocked_until && new Date(data.blocked_until).getTime() > now.getTime()) return { key, blocked: true };
  if (data?.window_started_at && now.getTime() - new Date(data.window_started_at).getTime() > 15 * 60 * 1000) {
    await db.from("student_affairs_login_attempts").upsert({ client_key: key, window_started_at: now.toISOString(), failed_attempts: 0, blocked_until: null });
  }
  return { key, blocked: false };
}
async function failedLogin(key: string) {
  const { data } = await db.from("student_affairs_login_attempts").select("*").eq("client_key", key).maybeSingle();
  const count = (data?.failed_attempts || 0) + 1;
  await db.from("student_affairs_login_attempts").upsert({ client_key: key, window_started_at: data?.window_started_at || new Date().toISOString(), failed_attempts: count, blocked_until: count >= 6 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null });
}
async function clearFailedLogin(key: string) { await db.from("student_affairs_login_attempts").delete().eq("client_key", key); }
type Principal = { type: "admin" | "teacher" | "custom"; name: string; hash: string; salt: string; adminScope?: "general" | "additional" };
async function findPrincipal(pin: string, pepper: string): Promise<Principal | null> {
  const candidates: Principal[] = [];
  const { data: adminSetting } = await db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle();
  const adminRecord = adminSetting?.value;
  if (adminRecord?.hash && adminRecord?.salt) candidates.push({ type: "admin", adminScope: "general", name: "مدير النظام العام", hash: adminRecord.hash, salt: adminRecord.salt });
  const { data: users, error } = await db.from("teachers").select("name,role,pin_hash,pin_salt,permissions");
  if (error) throw error;
  for (const u of (users || []).filter((x: any) => isAdditionalAdminTeacher(x))) if (u.pin_hash && u.pin_salt) candidates.push({ type: "admin", adminScope: "additional", name: u.name, hash: u.pin_hash, salt: u.pin_salt });
  for (const u of (users || []).filter((x: any) => x.role === "custom")) if (u.pin_hash && u.pin_salt) candidates.push({ type: "custom", name: u.name, hash: u.pin_hash, salt: u.pin_salt });
  for (const u of (users || []).filter((x: any) => x.role === "teacher" && !isAdditionalAdminTeacher(x))) if (u.pin_hash && u.pin_salt) candidates.push({ type: "teacher", name: u.name, hash: u.pin_hash, salt: u.pin_salt });
  const { data: upgraded } = await db.from("student_affairs_credentials").select("principal_type,principal_name,pin_salt,pin_hash,source_hash,source_salt");
  const secureMap = new Map((upgraded || []).map((x: any) => [x.principal_type + "|" + x.principal_name, x]));
  let legacy: { pbkdf2: string; sha256: string } | null = null;
  for (const p of candidates) {
    const stored = secureMap.get(p.type + "|" + p.name) as any;
    if (stored && stored.source_hash === p.hash && stored.source_salt === p.salt) {
      if (await verifyNewPin(pin, stored.pin_salt, stored.pin_hash, pepper)) return p;
    } else if (await verifyExistingPin(pin, p.salt, p.hash, legacy || (legacy = await getLegacyPeppers()))) {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await pbkdf2(pepper + ":" + salt + ":" + pin, salt, 310000);
      const { error: saveError } = await db.from("student_affairs_credentials").upsert({ principal_type: p.type, principal_name: p.name, pin_salt: salt, pin_hash: hash, source_hash: p.hash, source_salt: p.salt, updated_at: new Date().toISOString() }, { onConflict: "principal_type,principal_name" });
      if (saveError) throw saveError;
      return p;
    }
  }
  return null;
}
async function permissionsFor(p: { type: string; name: string; permissions?: Record<string, unknown> }, strictCompetition = false, adminRecordsCenterAccess = false) {
  if (hasFullAdministrativeAccess(p) || adminRecordsCenterAccess) {
    const [{ data: classes }, { data: teachers }, { data: permissionRows }] = await Promise.all([
      db.from("classes").select("name"),
      db.from("teachers").select("name,role,permissions").neq("role", "custom"),
      db.from("student_affairs_permissions").select("*").eq("principal_type", "teacher")
    ]);
    const all = (classes || []).map((x: any) => x.name);
    const byName = new Map((permissionRows || []).map((row: any) => [String(row.principal_name), row]));
    const teacherDirectory = (teachers || []).filter((item: any) => item.permissions?.studentAffairs === true)
      .map((item: any) => {
        const row: any = byName.get(String(item.name)) || {};
        const legacy = Array.isArray(row.allowed_classes) ? row.allowed_classes : [];
        return { name: String(item.name), allowed_attendance_classes: Array.isArray(row.allowed_attendance_classes) ? row.allowed_attendance_classes : legacy, allowed_behavior_classes: Array.isArray(row.allowed_behavior_classes) ? row.allowed_behavior_classes : legacy, attendance_statuses: Array.isArray(row.attendance_statuses) ? row.attendance_statuses : ["absent", "late", "escape", "outside"], can_read_attendance: true, can_read_behavior: true, can_view_analytics: true, can_print_attendance: true, can_print_behavior: true, can_print_combined: true };
      }).sort((a: any, b: any) => a.name.localeCompare(b.name, "ar"));
    return { role: "admin", own_allowed_attendance_classes: all, own_allowed_behavior_classes: all, team_allowed_attendance_classes: all, team_allowed_behavior_classes: all, allowed_classes: all, allowed_attendance_classes: all, allowed_behavior_classes: all, attendance_statuses: ["absent", "late", "escape", "outside"], can_read_attendance: true, can_read_behavior: true, can_view_analytics: true, can_view_competition: true, competition_participant: false, can_print_attendance: true, can_print_behavior: true, can_print_combined: true, team_members: [], teacher_directory: teacherDirectory };
  }
  const principalPermissions = p.permissions && typeof p.permissions === "object" ? p.permissions : null;
  const teacherLookup = principalPermissions
    ? Promise.resolve({ data: { name: p.name, role: p.type === "custom" ? "custom" : "teacher", permissions: principalPermissions }, error: null })
    : db.from("teachers").select("name,role,permissions").eq("name", p.name).maybeSingle();
  const principalType = p.type === "admin" ? "teacher" : p.type;
  const [{ data }, { data: teacher }] = await Promise.all([
    db.from("student_affairs_permissions").select("*").eq("principal_type", principalType).eq("principal_name", p.name).maybeSingle(),
    teacherLookup
  ]);
  const legacy = Array.isArray(data?.allowed_classes) ? data.allowed_classes : [];
  const ownAttendance = Array.isArray(data?.allowed_attendance_classes) ? data.allowed_attendance_classes : legacy;
  const ownBehavior = Array.isArray(data?.allowed_behavior_classes) ? data.allowed_behavior_classes : legacy;
  const tp = teacher?.permissions && typeof teacher.permissions === "object" ? teacher.permissions : {};
  const role = ["team_leader", "supervisor", "visitor"].includes(String(tp.student_affairs_role || "")) ? String(tp.student_affairs_role) : "unassigned";
  const teamName = String(tp.student_affairs_team_name || "").trim();
  let teamMembers: any[] = [], teacherDirectory: any[] = [], teamAttendance: string[] = [], teamBehavior: string[] = [];
  if ((role === "team_leader" && teamName) || role === "visitor") {
    const [{ data: teachers, error: teachersError }, { data: permissionRows, error: permissionError }] = await Promise.all([
      db.from("teachers").select("name,role,permissions").neq("role", "custom"),
      db.from("student_affairs_permissions").select("*").eq("principal_type", "teacher")
    ]);
    if (teachersError || permissionError) throw new Error("تعذر تحميل نطاق الإشراف في شؤون الطلبة.");
    const byName = new Map((permissionRows || []).map((row: any) => [String(row.principal_name), row]));
    const projectTeacher = (item: any) => {
      const row: any = byName.get(String(item.name)) || {};
      const legacyClasses = Array.isArray(row.allowed_classes) ? row.allowed_classes : [];
      const attendance = Array.isArray(row.allowed_attendance_classes) ? row.allowed_attendance_classes : legacyClasses;
      const behavior = Array.isArray(row.allowed_behavior_classes) ? row.allowed_behavior_classes : legacyClasses;
      return {
        name: String(item.name),
        allowed_attendance_classes: attendance,
        allowed_behavior_classes: behavior,
        attendance_statuses: Array.isArray(row.attendance_statuses) ? row.attendance_statuses : ["absent", "late", "escape", "outside"],
        can_read_attendance: row.can_read_attendance === true,
        can_read_behavior: row.can_read_behavior === true,
        can_view_analytics: row.can_view_analytics === true,
        can_print_attendance: row.can_print_attendance === true,
        can_print_behavior: row.can_print_behavior === true,
        can_print_combined: row.can_print_combined === true
      };
    };
    if (role === "team_leader") {
      teamMembers = (teachers || []).filter((item: any) => item.name !== p.name && item.role !== "custom"
        && item.permissions?.student_affairs_role === "supervisor"
        && (String(item.permissions?.supervisor_team_leader_name || "").trim() === p.name
          || (!item.permissions?.supervisor_team_leader_name && String(item.permissions?.student_affairs_team_name || "").trim() === teamName))
        && item.permissions?.studentAffairs === true).map((item: any) => {
          const member = projectTeacher(item);
          teamAttendance.push(...member.allowed_attendance_classes);
          teamBehavior.push(...member.allowed_behavior_classes);
          return member;
        });
    }
    if (role === "visitor") {
      teacherDirectory = (teachers || []).filter((item: any) => item.name !== p.name
        && item.role !== "custom" && item.permissions?.studentAffairs === true
        && item.permissions?.student_affairs_role !== "visitor")
        .map(projectTeacher)
        .sort((a: any, b: any) => a.name.localeCompare(b.name, "ar"));
    }
  }
  const unique = (items: string[]) => [...new Set(items.map(String).filter(Boolean))];
  const ownAttendanceUnique = unique(ownAttendance), ownBehaviorUnique = unique(ownBehavior);
  const teamAttendanceUnique = unique(teamAttendance), teamBehaviorUnique = unique(teamBehavior);
  const visitor = role === "visitor";
  if (visitor) {
    const { data: classes, error: classesError } = await db.from("classes").select("name").order("name");
    if (classesError) throw classesError;
    const access = buildVisitorAccess((classes || []).map((item: any) => String(item.name || "")), teacherDirectory);
    return { ...(data || {}), ...access, can_view_competition: true, competition_team_name: "", competition_team_classes: [] };
  }
  const reportPermissions = {
    ...(data || {}), role, team_name: teamName, team_members: teamMembers, teacher_directory: [],
    own_allowed_attendance_classes: ownAttendanceUnique, own_allowed_behavior_classes: ownBehaviorUnique,
    team_allowed_attendance_classes: teamAttendanceUnique, team_allowed_behavior_classes: teamBehaviorUnique,
    allowed_classes: unique([...ownAttendanceUnique, ...ownBehaviorUnique]), allowed_attendance_classes: ownAttendanceUnique, allowed_behavior_classes: ownBehaviorUnique,
    attendance_statuses: Array.isArray(data?.attendance_statuses) ? data.attendance_statuses : (strictCompetition ? [] : ["absent", "late", "escape", "outside"]),
    can_read_attendance: data?.can_read_attendance === true, can_read_behavior: data?.can_read_behavior === true,
    can_view_analytics: data?.can_view_analytics === true,
    can_view_competition: teacher?.permissions?.can_view_competition === true,
    competition_participant: teacher?.permissions?.competition_participant === true,
    competition_team_name: typeof teacher?.permissions?.competition_team_name === "string" ? teacher.permissions.competition_team_name : "",
    competition_team_classes: Array.isArray(teacher?.permissions?.competition_team_classes) ? teacher.permissions.competition_team_classes : [],
    can_print_attendance: data?.can_print_attendance === true, can_print_behavior: data?.can_print_behavior === true,
    can_print_combined: data?.can_print_combined === true
  };
  const reportsAccess = canAccessReportPermission(p.type, tp, "reportStudentAffairs", hasFullAdministrativeAccess(p));
  let reportClasses: string[] = [];
  if (reportsAccess) {
    const { data: classes, error: classesError } = await db.from("classes").select("name");
    if (classesError) throw classesError;
    reportClasses = (classes || []).map((item: any) => String(item.name || ""));
  }
  return applyReportsEntryPermissions(reportPermissions, reportClasses, reportsAccess);
}
async function hasStudentAffairsAccess(p: { type: string; name: string; permissions?: Record<string, unknown> }) {
  if (hasFullAdministrativeAccess(p)) return true;
  if (p.permissions && typeof p.permissions === "object") {
    if (p.type !== "teacher" && p.type !== "custom" && p.type !== "admin") return false;
    return p.permissions.studentAffairs === true;
  }
  const { data, error } = await db.from("teachers").select("name,role,permissions").eq("name", p.name).maybeSingle();
  if (error || !data) return false;
  if (p.type === "admin") return isAdditionalAdminTeacher(data) && data.permissions?.studentAffairs === true;
  const expectedRole = p.type === "custom" ? "custom" : "teacher";
  return (expectedRole === "custom" ? data.role === "custom" : data.role !== "custom")
    && data.permissions?.studentAffairs === true;
}
async function adminStudentAffairsAccessEnabled(): Promise<boolean> {
  try {
    const { data, error } = await db.from("school_settings")
      .select("value")
      .eq("key", "admin_student_affairs_access")
      .maybeSingle();
    if (error) throw error;
    return isAdminStudentAffairsAccessEnabled(data?.value);
  } catch (error) {
    // Fail closed for this optional module only; the general application login
    // and all unrelated school permissions remain unaffected.
    console.error("Admin Student Affairs access setting unavailable; denying this module only.", error);
    return false;
  }
}
async function getSession(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const tokenHash = await sha256(token);
  const { data } = await db.from("student_affairs_sessions").select("*").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!data) return null;
  if (data.principal_type === "admin") {
    if (data.principal_name === "مدير النظام العام") {
      if (!(await adminStudentAffairsAccessEnabled())) return null;
    } else {
      const { data: teacher, error: teacherError } = await db.from("teachers")
        .select("name,role,permissions").eq("name", data.principal_name).maybeSingle();
      if (teacherError || !teacher || !isAdditionalAdminTeacher(teacher)) return null;
    }
  }
  return {
    tokenHash,
    appSessionHash: typeof data.app_session_hash === "string" ? data.app_session_hash : null,
    principal: { type: data.principal_type, name: data.principal_name }
  };
}
function asBool(v: unknown) { return v === true; }

function competitionError(status: number, message: string): never { const error = new Error(message); (error as any).status = status; throw error; }
function getOmanIsoDate() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  return values.year + "-" + values.month + "-" + values.day;
}
function shiftCompetitionDate(value: string, days: number) {
  const date = new Date(value + "T12:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getOmanClockMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Muscat", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const values: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  return Number(values.hour || 0) * 60 + Number(values.minute || 0);
}
function secureStringEquals(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function getCompetitionCronSecret() {
  const { data, error } = await db.rpc("student_affairs_get_competition_cron_secret");
  if (error || typeof data !== "string" || data.length < 32) throw new Error("Competition scheduler secret unavailable");
  return data;
}
// Current teacher class access is projected from live assignment permissions.
function projectCompetitionResponse(snapshot: any, principal: { type: string; name: string }, permissions: any = {}) {
  const isAdmin = hasFullAdministrativeAccess(principal);
  const isVisitor = permissions?.role === "visitor";
  const canSeeAll = isAdmin || isVisitor;
  const sourceTeams = Array.isArray(snapshot?.teams) ? snapshot.teams : [];
  const rawClasses = Array.isArray(snapshot?.classComparison) ? snapshot.classComparison : [];
  const ownClassNames = new Set<string>((Array.isArray(permissions?.competition_team_classes) ? permissions.competition_team_classes : []).map((name: unknown) => String(name)));
  const ownTeams = canSeeAll ? sourceTeams : permissions?.competition_participant === true
    ? sourceTeams.filter((team: any) => String(team.teamId || "") === principal.name || String(team.leaderName || "") === principal.name)
    : [];
  const ownTeamIds = new Set<string>(ownTeams.map((team: any) => String(team.teamId || "")));
  const ownClassRows = rawClasses.filter((item: any) => ownTeamIds.has(String(item.teamId || "")) && (isVisitor || ownClassNames.has(String(item.className || ""))));
  const average = (rows: any[], key: string) => {
    const values = rows.map((item: any) => Number(item[key])).filter((value: number) => Number.isFinite(value));
    return values.length ? values.reduce((sum: number, value: number) => sum + value, 0) / values.length : null;
  };
  const sum = (rows: any[], key: string) => rows.reduce((total: number, item: any) => total + (Number(item[key]) || 0), 0);
  const teams = sourceTeams.map((team: any) => {
    const isOwn = ownTeamIds.has(String(team.teamId || ""));
    const projected: any = {
      teamId: team.teamId, teamName: team.teamName, leaderName: team.leaderName,
      classNames: canSeeAll ? (Array.isArray(team.classNames) ? team.classNames : []) : isOwn ? Array.from(ownClassNames) : (Array.isArray(team.classNames) ? team.classNames : []),
      grade: team.grade, score: team.score, rank: team.rank,
      attendancePoints: team.attendancePoints, behaviorPoints: team.behaviorPoints,
      weeklyAwardPoints: team.weeklyAwardPoints, complete: team.complete,
      resultStatus: team.resultStatus
    };
    if (canSeeAll) {
      Object.assign(projected, {
        attendanceRate: team.attendanceRate, behaviorRate: team.behaviorRate,
        attendanceIncidents: team.attendanceIncidents, behaviorIncidents: team.behaviorIncidents,
        classMetrics: team.classMetrics
      });
    } else if (isOwn) {
      const ownMetrics = ownClassRows.filter((item: any) => String(item.teamId || "") === String(team.teamId || ""));
      Object.assign(projected, {
        attendanceRate: average(ownMetrics, "attendanceRate"),
        behaviorRate: average(ownMetrics, "behaviorRate"),
        attendanceIncidents: sum(ownMetrics, "attendanceIncidents"),
        behaviorIncidents: sum(ownMetrics, "behaviorIncidents"),
        classMetrics: ownMetrics
      });
    }
    return projected;
  });
  const visibleClasses = canSeeAll ? rawClasses : ownClassRows;
  return {
    ...snapshot,
    isAdmin,
    teams,
    ownGrades: ownTeams.map((team: any) => team.teamName || team.grade),
    ownClasses: visibleClasses,
    classComparison: projectCompetitionClassComparison(visibleClasses, canSeeAll, Array.from(ownTeamIds))
  };
}
async function getLatestWeeklyCompetition(principal: { type: string; name: string }, permissions: any) {
  const today = getOmanIsoDate();
  const { currentTerm } = await readCompetitionTermSettings();
  const week = getSchoolWeekRange(today);
  const weekday = new Date(today + "T12:00:00.000Z").getUTCDay();
  const afterCutoff = isCompetitionWeeklyCutoffReached(weekday, getOmanClockMinutes());
  const latestClosedWeekStart = afterCutoff ? week.start : shiftCompetitionDate(week.start, -7);
  const baseQuery = () => db.from("competition_weekly_results")
    .select("week_start,week_end,status,finalized_at,snapshot")
    .gte("week_start", currentTerm.start)
    .lte("week_end", currentTerm.end)
    .lte("week_start", latestClosedWeekStart);
  const [{ data: latestComplete, error: completeError }, { data: latestAttempt, error: attemptError }] = await Promise.all([
    baseQuery().eq("status", "complete").order("week_start", { ascending: false }).limit(1).maybeSingle(),
    baseQuery().order("week_start", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (completeError) throw completeError;
  if (attemptError) throw attemptError;
  if (latestComplete) {
    const pendingWeek = latestAttempt?.status === "incomplete" && latestAttempt.week_start > latestComplete.week_start
      ? { from: latestAttempt.week_start, to: latestAttempt.week_end, status: "incomplete" }
      : null;
    return projectCompetitionResponse({
      ...(latestComplete.snapshot || {}),
      from: latestComplete.week_start, to: latestComplete.week_end, today, period: "weekly",
      snapshotStatus: latestComplete.status, finalizedAt: latestComplete.finalized_at, pendingWeek
    }, principal, permissions);
  }
  if (latestAttempt) {
    return projectCompetitionResponse({
      ...(latestAttempt.snapshot || {}),
      from: latestAttempt.week_start, to: latestAttempt.week_end, today, period: "weekly",
      status: "incomplete", snapshotStatus: latestAttempt.status,
      finalizedAt: latestAttempt.finalized_at, pendingWeek: null
    }, principal, permissions);
  }
  const firstVisibleWeek = latestClosedWeekStart < currentTerm.start ? currentTerm.start : latestClosedWeekStart;
  return {
    from: firstVisibleWeek, to: shiftCompetitionDate(firstVisibleWeek, 4), today,
    period: "weekly", status: "awaiting_first_result", finalizedAt: null, pendingWeek: null,
    teams: [], ownGrades: [], ownClasses: [], classComparison: [],
    weeklyWins: {}, weeklyPoints: {}, weeklyHistory: [], completedWeeks: 0
  };
}
async function readCompetitionTermSettings() {
  // Read both small settings in one indexed request instead of issuing two
  // separate PostgREST calls every time the competition panel is opened.
  const { data: rows, error } = await db.from("school_settings")
    .select("key,value")
    .in("key", ["competition_term_calendar", "competition_visibility_mode"]);
  if (error) throw error;
  const settings = new Map<string, unknown>((rows || []).map((row: any) => [String(row.key), row.value] as [string, unknown]));
  const calendar = settings.get("competition_term_calendar");
  const visibility = settings.get("competition_visibility_mode") as any;
  const terms = (Array.isArray(calendar) ? calendar : [])
    .filter((term: any) => isValidIsoDate(term?.start) && isValidIsoDate(term?.end) && term.start <= term.end)
    .sort((a: any, b: any) => String(a.start).localeCompare(String(b.start)))
    .map((term: any) => ({ id: String(term.start), start: String(term.start), end: String(term.end), label: String(term.label || "الفصل الدراسي") }));
  const today = getOmanIsoDate();
  const currentTerm = terms.find((term: any) => term.start <= today && today <= term.end)
    || terms.find((term: any) => term.start > today)
    || terms.filter((term: any) => term.start <= today).sort((a: any, b: any) => String(b.start).localeCompare(String(a.start)))[0]
    || terms[0];
  if (!currentTerm) competitionError(409, "لم يتم إعداد تواريخ الفصل الدراسي في إعدادات المدرسة.");
  return { terms, currentTerm, showBothTerms: visibility?.showBothTerms === true };
}
async function buildTermCompetitionSnapshot(principal: { type: string; name: string }, permissions: any, requestedTermId?: unknown) {
  if (!hasFullAdministrativeAccess(principal) && permissions?.can_view_competition !== true) competitionError(403, "لا تملك صلاحية مشاهدة لوحة سباق التميز.");
  const today = getOmanIsoDate();
  const termSettings = await readCompetitionTermSettings();
  const { terms, currentTerm, showBothTerms } = termSettings;
  const selectedTermId = String(requestedTermId || currentTerm.id);
  const selectedTerm = terms.find((term: any) => term.id === selectedTermId);
  if (!selectedTerm) competitionError(400, "الفصل الدراسي المطلوب غير موجود في تقويم المدرسة.");
  if (!hasFullAdministrativeAccess(principal) && !showBothTerms && selectedTerm.id !== currentTerm.id) {
    competitionError(403, "لا تملك صلاحية عرض نتائج فصل دراسي سابق.");
  }
  const visibleTerms = hasFullAdministrativeAccess(principal) || showBothTerms ? terms : [currentTerm];
  const termTo = today > selectedTerm.end ? selectedTerm.end : today < selectedTerm.start ? selectedTerm.start : today;
  const { data: history, error } = await db.from("competition_weekly_results")
    .select("week_start,week_end,status,finalized_at,snapshot")
    .gte("week_start", selectedTerm.start)
    .lte("week_end", termTo)
    .order("week_start", { ascending: true });
  if (error) throw error;
  const completed = (history || []).filter((row: any) => row.status === "complete" && Array.isArray(row.snapshot?.teams));
  const teamTotals = new Map<string, any>();
  const classTotals = new Map<string, any>();
  const weeklyHistory: any[] = [];
  for (const row of completed) {
    const snap = row.snapshot || {};
    const points: Record<string, number> = {};
    for (const team of Array.isArray(snap.teams) ? snap.teams : []) {
      const id = String(team.teamId || "");
      if (!id) continue;
      const total = teamTotals.get(id) || {
        teamId: id, points: 0, wins: 0, weeks: 0, scoreTotal: 0,
        attendancePointsTotal: 0, behaviorPointsTotal: 0, latest: team
      };
      total.latest = team;
      total.points += Number(team.weeklyAwardPoints) || 0;
      total.wins += Number(team.rank) === 1 ? 1 : 0;
      total.weeks += 1;
      total.scoreTotal += Number(team.score) || 0;
      total.attendancePointsTotal += Number(team.attendancePoints) || 0;
      total.behaviorPointsTotal += Number(team.behaviorPoints) || 0;
      teamTotals.set(id, total);
      points[id] = Number(team.weeklyAwardPoints) || 0;
    }
    for (const item of Array.isArray(snap.classComparison) ? snap.classComparison : []) {
      const teamId = String(item.teamId || ""), className = String(item.className || "");
      if (!teamId || !className || item.complete !== true) continue;
      const key = teamId + "\u001f" + className;
      const total = classTotals.get(key) || {
        teamId, teamName: item.teamName, leaderName: item.leaderName, className,
        days: 0, attendanceIncidents: 0, behaviorIncidents: 0,
        attendanceStatusCounts: {}, behaviorTypeCounts: {}
      };
      total.days += Number(item.schoolDaysCount) || 5;
      total.attendanceIncidents += Number(item.attendanceIncidents) || 0;
      total.behaviorIncidents += Number(item.behaviorIncidents) || 0;
      for (const [key, value] of Object.entries(item.attendanceStatusCounts || {})) total.attendanceStatusCounts[key] = (Number(total.attendanceStatusCounts[key]) || 0) + (Number(value) || 0);
      for (const [key, value] of Object.entries(item.behaviorTypeCounts || {})) total.behaviorTypeCounts[key] = (Number(total.behaviorTypeCounts[key]) || 0) + (Number(value) || 0);
      classTotals.set(key, total);
    }
    weeklyHistory.push({
      start: row.week_start, end: row.week_end, complete: true,
      finalizedAt: row.finalized_at, winners: Array.isArray(snap.weeklyHistory?.[0]?.winners) ? snap.weeklyHistory[0].winners : [],
      points
    });
  }
  const weeklyPoints: Record<string, number> = {};
  const weeklyWins: Record<string, number> = {};
  const teamRows: any[] = [];
  for (const [id, total] of teamTotals.entries()) {
    const latest = total.latest || {};
    const ownClasses = [...classTotals.values()].filter((item: any) => item.teamId === id);
    const mean = (key: string) => ownClasses.length ? ownClasses.reduce((sum: number, item: any) => sum + (item.days ? Number(item[key]) / item.days : 0), 0) / ownClasses.length : null;
    const attendanceRate = mean("attendanceIncidents");
    const behaviorRate = mean("behaviorIncidents");
    weeklyPoints[id] = total.points;
    weeklyWins[id] = total.wins;
    teamRows.push({
      ...latest, teamId: id, weeklyAwardPoints: total.points,
      score: Number((total.scoreTotal / Math.max(1, total.weeks)).toFixed(2)),
      attendancePoints: Number((total.attendancePointsTotal / Math.max(1, total.weeks)).toFixed(2)),
      behaviorPoints: Number((total.behaviorPointsTotal / Math.max(1, total.weeks)).toFixed(2)),
      attendanceRate, behaviorRate, complete: true, weeksCounted: total.weeks
    });
  }
  const rankedTeams = rankCompetitionTeamsByAccumulatedPoints(teamRows, weeklyPoints);
  const allClasses = [...classTotals.values()].map((item: any) => ({
    ...item, complete: true,
    attendanceRate: item.days ? item.attendanceIncidents / item.days : null,
    behaviorRate: item.days ? item.behaviorIncidents / item.days : null,
    repeatAttendanceStudents: null, repeatBehaviorStudents: null,
    schoolDaysCount: item.days
  }));
  const earliestWeek = completed.length ? completed[0].week_start : null;
  const raw = {
    from: selectedTerm.start, to: termTo, termStart: selectedTerm.start, termEnd: selectedTerm.end,
    termLabel: selectedTerm.label, dataAvailableFrom: earliestWeek,
    today, period: "term", status: selectedTerm.start > today ? "not_started" : completed.length ? "complete" : "no_completed_weeks",
    teams: rankedTeams, ownGrades: [], ownClasses: [], classComparison: allClasses,
    dailyProgress: [], weeklyWins, weeklyPoints, weeklyHistory,
    completedWeeks: completed.length
  };
  return { ...projectCompetitionResponse(raw, principal, permissions), terms: visibleTerms, currentTermId: currentTerm.id, selectedTermId: selectedTerm.id, showBothTerms };
}
async function finalizeCompetitionWeek() {
  const today = getOmanIsoDate();
  const weekday = new Date(today + "T12:00:00.000Z").getUTCDay();
  const currentWeek = getSchoolWeekRange(today);
  const afterWeeklyCutoff = isCompetitionWeeklyCutoffReached(weekday, getOmanClockMinutes());
  // Before Thursday 13:51 Oman time, the latest closed week is eligible. After the cutoff, this week is eligible.
  const eligibleStart = afterWeeklyCutoff ? currentWeek.start : shiftCompetitionDate(currentWeek.start, -7);
  const { currentTerm } = await readCompetitionTermSettings();
  // Never abandon an earlier incomplete week when the calendar rolls forward; retry it until it completes.
  const { data: pending, error: pendingError } = await db.from("competition_weekly_results")
    .select("week_start,week_end").eq("status", "incomplete")
    .gte("week_start", currentTerm.start).lte("week_end", currentTerm.end)
    .order("week_start", { ascending: true }).limit(1).maybeSingle();
  if (pendingError) throw pendingError;
  const range = pending && pending.week_start <= eligibleStart
    ? { start: pending.week_start, end: pending.week_end }
    : { start: eligibleStart, end: shiftCompetitionDate(eligibleStart, 4) };
  if (range.start < currentTerm.start || range.end > currentTerm.end) {
    return { ok: true, status: "outside_term", weekStart: range.start };
  }
  const { data: existing, error: existingError } = await db.from("competition_weekly_results")
    .select("status").eq("week_start", range.start).maybeSingle();
  if (existingError) throw existingError;
  if (existing?.status === "complete") {
    return { ok: true, alreadyFinalized: true, weekStart: range.start, status: "complete" };
  }
  const principal = { type: "admin" as const, name: "مدير النظام العام" };
  // The finalizer is always an admin. buildCompetitionSnapshot loads its own
  // classes, teachers, and permission inputs, so permissionsFor(admin) here
  // only repeats those same reads without changing the admin result.
  const snapshot = await buildCompetitionSnapshot(principal, {}, range.start, range.end, "weekly");
  if (snapshot.status === "configuration_incomplete") return { ok: true, status: "configuration_incomplete", weekStart: range.start };
  const finalizedAt = new Date().toISOString();
  const { error: saveError } = await db.from("competition_weekly_results").upsert({
    week_start: range.start, week_end: range.end,
    status: snapshot.status === "complete" ? "complete" : "incomplete",
    finalized_at: finalizedAt, snapshot
  }, { onConflict: "week_start" });
  if (saveError) throw saveError;
  return { ok: true, status: snapshot.status, weekStart: range.start, finalizedAt };
}
async function fetchCompetitionRows(table: "attendance" | "behaviors", classNames: string[], from: string, to: string) {
  const rows: any[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    if (offset >= 60000) throw new Error("Competition data range exceeds the safe query limit");
    const { data, error } = await db.from(table)
      .select("record_key,date_str,class_name,period,records")
      .in("class_name", classNames)
      .gte("date_str", from).lte("date_str", to)
      .order("record_key", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
function indexCompetitionRows(rows: any[]) {
  const index = new Map<string, Map<string, any[]>>();
  for (const row of rows || []) {
    const date = String(row.date_str || "");
    const className = String(row.class_name || "");
    if (!date || !className) continue;
    if (!index.has(date)) index.set(date, new Map());
    const byClass = index.get(date)!;
    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className)!.push(row);
  }
  return index;
}
function rowsForCompetitionRange(index: Map<string, Map<string, any[]>>, classNames: string[], from: string, to: string) {
  const rows: any[] = [];
  for (const day of getSchoolDays(from, to)) {
    const byClass = index.get(day);
    if (!byClass) continue;
    for (const className of classNames) rows.push(...(byClass.get(className) || []));
  }
  return rows;
}
async function buildCompetitionSnapshot(principal: { type: string; name: string }, permissions: any, fromValue: unknown, toValue: unknown, periodValue: unknown) {
  if (!hasFullAdministrativeAccess(principal) && permissions?.can_view_competition !== true) competitionError(403, "لا تملك صلاحية مشاهدة لوحة سباق التميز.");
  const today = getOmanIsoDate();
  const period = ["weekly", "monthly", "term"].includes(String(periodValue)) ? String(periodValue) : "weekly";
  const defaultWeek = getSchoolWeekRange(today);
  const from = fromValue == null ? defaultWeek.start : fromValue;
  const to = toValue == null ? defaultWeek.end : toValue;
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) competitionError(400, "نطاق تاريخ البطولة غير صالح");
  const spanDays = Math.floor((new Date(to + "T12:00:00.000Z").getTime() - new Date(from + "T12:00:00.000Z").getTime()) / 86400000) + 1;
  if (spanDays > 370) competitionError(400, "الفترة المطلوبة تتجاوز الحد المسموح للتحليل");
  const schoolDays = getSchoolDays(from, to);
  const dataFrom = period === "monthly" ? getSchoolWeekRange(from).start : from;
  if (!schoolDays.length) competitionError(400, "الفترة المحددة لا تحتوي على أيام دراسية");

  const [{ data: classRows, error: classError }, { data: teacherRows, error: teacherError }, { data: studentAffairsRows, error: studentAffairsError }] = await Promise.all([
    db.from("classes").select("name").order("name", { ascending: true }),
    db.from("teachers").select("name,role,permissions").order("name", { ascending: true }),
    db.from("student_affairs_permissions").select("principal_name,allowed_classes,allowed_attendance_classes,allowed_behavior_classes").eq("principal_type", "teacher")
  ]);
  if (classError) throw classError;
  if (teacherError) throw teacherError;
  if (studentAffairsError) throw studentAffairsError;
  const allClasses = (classRows || []).map((row: any) => String(row.name || "").trim()).filter(Boolean);
  const studentAffairsByTeacher = new Map((studentAffairsRows || []).map((row: any) => [String(row.principal_name), row]));
  for (const teacher of teacherRows || []) {
    if (teacher.permissions?.student_affairs_role !== "team_leader" || teacher.permissions?.competition_participant !== true) continue;
    const personal = studentAffairsByTeacher.get(String(teacher.name)) as any;
    const legacy = Array.isArray(personal?.allowed_classes) ? personal.allowed_classes : [];
    const ownClasses = [...(Array.isArray(personal?.allowed_attendance_classes) ? personal.allowed_attendance_classes : legacy),
      ...(Array.isArray(personal?.allowed_behavior_classes) ? personal.allowed_behavior_classes : legacy)];
    const outside = findCompetitionClassesOutsidePersonalScope(teacher.permissions?.competition_team_classes || [], ownClasses);
    if (outside.length) competitionError(409, "إعداد سباق التميز غير متوافق مع فصول قائد الفريق الشخصية: " + String(teacher.name) + " — " + outside[0]);
  }
  let teams: any[];
  try {
    teams = buildCompetitionTeams(teacherRows || [], allClasses);
  } catch (error) {
    competitionError(409, error instanceof Error ? error.message : "إعدادات فرق سباق التميز غير مكتملة.");
  }
  if (!teams.length) {
    return { from, to, today, period, status: "configuration_incomplete", message: "لم تتم إضافة أي معلم إلى سباق التميز بعد.", teams: [], ownGrades: [], ownClasses: [], dailyProgress: [], weeklyWins: {}, weeklyHistory: [] };
  }
  const competitionClasses = [...new Set(teams.flatMap((team: any) => team.classNames))];
  const ownTeamIds = teams.filter((team: any) => team.leaderName === principal.name).map((team: any) => team.teamId);
  const [attendanceRows, behaviorRows] = await Promise.all([
    fetchCompetitionRows("attendance", competitionClasses, dataFrom, to),
    fetchCompetitionRows("behaviors", competitionClasses, dataFrom, to)
  ]);
  const attendanceIndex = indexCompetitionRows(attendanceRows);
  const behaviorIndex = indexCompetitionRows(behaviorRows);
  const scoreTeamsRange = (rangeFrom: string, rangeTo: string) => {
    const metrics = teams.map((team: any) => {
      const metric = buildTeamRates({
        grade: team.teamName,
        classNames: team.classNames,

        attendanceRows: rowsForCompetitionRange(attendanceIndex, team.classNames, rangeFrom, rangeTo),
        behaviorRows: rowsForCompetitionRange(behaviorIndex, team.classNames, rangeFrom, rangeTo),
        from: rangeFrom,
        to: rangeTo
      });
      return { ...metric, grade: team.teamName, teamId: team.teamId, teamName: team.teamName, leaderName: team.leaderName, classNames: team.classNames };
    });
    return calculateRelativeCompetitionScores(metrics).map((metric: any) => {
      const team = teams.find((item: any) => item.teamId === metric.teamId);
      return projectCompetitionTeam(team, metric);
    });
  };
  const scored = scoreTeamsRange(from, to);
  const allTeamsComplete = scored.length === teams.length && scored.every((team: any) => team.complete === true);
  const fullSelectedWeek = period === "weekly" && isCompleteSchoolWeekRange(from, to);
  let currentWeekAwards = fullSelectedWeek && allTeamsComplete ? awardWeeklyCompetitionPoints(scored) : scored.map((team: any) => ({ ...team, weeklyAwardPoints: null }));
  const dailyProgress = schoolDays.map(day => {
    const dayScores = scoreTeamsRange(day, day);
    const dayComplete = dayScores.length === teams.length && dayScores.every((team: any) => team.complete === true);
    return { date: day, teams: dayScores.map((team: any) => ({ grade: team.teamName, teamId: team.teamId, teamName: team.teamName, score: dayComplete ? team.score : null, rank: dayComplete ? team.rank : null, complete: dayComplete && team.complete === true })) };
  });
  const weeklyWins: Record<string, number> = Object.fromEntries(teams.map((team: any) => [team.teamId, 0]));
  const weeklyPoints: Record<string, number> = Object.fromEntries(teams.map((team: any) => [team.teamId, 0]));
  const weeklyHistory: any[] = [];
  const firstWeek = getSchoolWeekRange(from).start;
  for (let weekStart = firstWeek; shiftCompetitionDate(weekStart, 4) <= to; weekStart = shiftCompetitionDate(weekStart, 7)) {
    const weekEnd = shiftCompetitionDate(weekStart, 4);
    if (weekStart < from || weekEnd > to) continue;
    const weekScores = scoreTeamsRange(weekStart, weekEnd);
    const weekComplete = weekScores.length === teams.length && weekScores.every((team: any) => team.complete === true);
    const awarded = weekComplete ? awardWeeklyCompetitionPoints(weekScores) : [];
    const winners = awarded.filter((team: any) => team.rank === 1).map((team: any) => team.teamId);
    const points: Record<string, number> = Object.fromEntries(teams.map((team: any) => [team.teamId, 0]));
    awarded.forEach((team: any) => {
      const earned = Number(team.weeklyAwardPoints) || 0;
      points[team.teamId] = earned;
      weeklyPoints[team.teamId] = (weeklyPoints[team.teamId] || 0) + earned;
      if (team.rank === 1) weeklyWins[team.teamId] = (weeklyWins[team.teamId] || 0) + 1;
    });
    weeklyHistory.push({ start: weekStart, end: weekEnd, complete: weekComplete, winners, points });
  }
  const completedWeeks = weeklyHistory.filter((week: any) => week.complete === true).length;
  if (period !== "weekly") {
    if (completedWeeks > 0) {
      const accumulatedRanks = rankCompetitionTeamsByAccumulatedPoints(scored, weeklyPoints);
      const rankByTeam = Object.fromEntries(accumulatedRanks.map((team: any) => [team.teamId, team.rank]));
      currentWeekAwards = currentWeekAwards.map((team: any) => ({ ...team, rank: rankByTeam[team.teamId] ?? null }));
    } else {
      currentWeekAwards = currentWeekAwards.map((team: any) => ({ ...team, rank: null }));
    }
  }
  const ownClasses: any[] = [];
  const classComparison: any[] = [];
  for (const team of teams) {
    for (const className of team.classNames) {
      const metric = buildTeamRates({
        grade: team.teamName,
        classNames: [className],

        attendanceRows: rowsForCompetitionRange(attendanceIndex, [className], from, to),
        behaviorRows: rowsForCompetitionRange(behaviorIndex, [className], from, to),
        from,
        to
      });
      const classMetrics = metric.classMetrics?.[0] || {};
      const classItem = {
        teamId: team.teamId, teamName: team.teamName, leaderName: team.leaderName, className,
        complete: metric.complete, schoolDaysCount: metric.schoolDays?.length || 0, attendanceRate: metric.attendanceRate, behaviorRate: metric.behaviorRate,
        attendanceIncidents: metric.attendanceIncidents, behaviorIncidents: metric.behaviorIncidents,
        attendanceStatusCounts: classMetrics.attendanceStatusCounts || null,
        behaviorTypeCounts: classMetrics.behaviorTypeCounts || null,
        repeatAttendanceStudents: classMetrics.repeatAttendanceStudents ?? null,
        repeatBehaviorStudents: classMetrics.repeatBehaviorStudents ?? null
      };
      classComparison.push(classItem);
      if (ownTeamIds.includes(team.teamId)) ownClasses.push(classItem);
    }
  }
  return { from, to, period, today, isAdmin: hasFullAdministrativeAccess(principal), status: allTeamsComplete ? "complete" : "incomplete", teams: currentWeekAwards, ownGrades: teams.filter((team: any) => ownTeamIds.includes(team.teamId)).map((team: any) => team.teamName), ownClasses, classComparison, dailyProgress, weeklyWins, weeklyPoints, weeklyHistory, completedWeeks };
}


async function resolveAppDataScopeForPrincipal(principal: AppPrincipal): Promise<AppDataScope> {
  return await resolveAppDataScope(principal, db);
}

async function readAppDataGateway(req: Request, body: any): Promise<Response> {
  return await handleAppDataGatewayRead(req, body, {
    db,
    headers: cors,
    readSession: (authorization) => readAuthorizedAppSession(authorization),
    currentPrincipal: (type, name) => currentAppPrincipal(type, name),
    resolveScope: (principal) => resolveAppDataScopeForPrincipal(principal as AppPrincipal),
  });
}

async function hasTimetableAccess(principal: { type: string; name: string }): Promise<boolean> {
  if (hasFullAdministrativeAccess(principal)) return true;
  const principalType = principal.type === "admin" ? "teacher" : principal.type;
  const { data, error } = await db.from("timetable_access_permissions")
    .select("can_access")
    .eq("principal_type", principalType)
    .eq("principal_name", principal.name)
    .maybeSingle();
  if (error) throw error;
  return data?.can_access === true;
}

async function handle(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  let body: any; try { body = await req.json(); } catch { return reply(400, { error: "Invalid request" }); }
  if (body?.action === "app_login") {
    if (!validPin(body.pin)) return reply(400, { error: "بيانات الدخول غير صحيحة" });
    const rate = await rateLimit(req);
    if (rate.blocked) return reply(429, { error: "محاولات كثيرة. حاول بعد 15 دقيقة." });
    const loginStartedAt = performance.now();
    try {
      const principal = await findAppPrincipal(body.pin, await getPepper());
      console.info("Application login credential check completed", {
        principalType: principal?.type || "none",
        durationMs: Math.round(performance.now() - loginStartedAt),
      });
      if (!principal) { await failedLogin(rate.key); return reply(401, { error: "بيانات الدخول غير صحيحة" }); }
      const issued = await issueAppSession(appSessionStore, principal, Date.now(), SESSION_HOURS);
      await clearFailedLogin(rate.key);
      console.info("Application login session issued", {
        principalType: principal.type,
        durationMs: Math.round(performance.now() - loginStartedAt),
      });
      return reply(200, { ...issued, principal });
    } catch (error) {
      console.error("General application login failed:", error);
      return reply(500, { error: "تعذر إتمام تسجيل الدخول حالياً" });
    }
  }

  if (body?.action === "admin_reset_morning_assembly_lateness") {
    try {
      const session = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
      const principal = session.principal;
      if (!isGeneralAdminPrincipal(principal) ||
          principal.name !== "مدير النظام العام" ||
          !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "تصفير سجلات الطابور الصباحي متاح لمدير النظام العام فقط." });
      }

      const pin1 = body.pin1;
      const pin2 = body.pin2;
      if (!validPin(pin1) || !validPin(pin2)) {
        return reply(400, { error: "أدخل رمز مدير النظام الصحيح في الحقلين." });
      }
      const rate = await rateLimit(req);
      if (rate.blocked) return reply(429, { error: "محاولات كثيرة. حاول بعد 15 دقيقة." });
      if (pin1 !== pin2) {
        await failedLogin(rate.key);
        return reply(400, { error: "الرمزان غير متطابقين." });
      }

      const [{ data: adminSetting, error: adminSettingError }, { data: adminSecure, error: adminSecureError }] =
        await Promise.all([
          db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle(),
          db.from("student_affairs_credentials")
            .select("pin_salt,pin_hash,source_hash,source_salt")
            .eq("principal_type", "admin")
            .eq("principal_name", "مدير النظام العام")
            .maybeSingle(),
        ]);
      if (adminSettingError || adminSecureError) throw new Error("تعذر تحميل بيانات تحقق مدير النظام.");
      const adminRecord = adminSetting?.value;
      let pinMatches = false;
      if (adminRecord?.hash && adminRecord?.salt) {
        if (adminSecure &&
            adminSecure.source_hash === adminRecord.hash &&
            adminSecure.source_salt === adminRecord.salt) {
          pinMatches = await verifyNewPin(pin1, adminSecure.pin_salt, adminSecure.pin_hash, await getPepper());
        } else {
          pinMatches = await verifyExistingPin(pin1, adminRecord.salt, adminRecord.hash, await getLegacyPeppers());
        }
      }
      if (!pinMatches) {
        await failedLogin(rate.key);
        return reply(401, { error: "رمز مدير النظام غير صحيح." });
      }

      const { data: result, error: resetError } = await db.rpc(
        "admin_delete_all_morning_assembly_lateness_records",
        { p_actor_name: principal.name }
      );
      if (resetError) throw resetError;
      if (result?.ok !== true) throw new Error("لم يؤكد إجراء قاعدة البيانات اكتمال التصفير.");
      await clearFailedLogin(rate.key);
      return reply(200, { ok: true, result });
    } catch (error) {
      console.error("Admin morning-assembly-lateness reset failed:", error instanceof Error ? error.message : "unknown error");
      return reply(500, { error: "تعذر تصفير سجلات الطابور الصباحي حالياً. لم يتم تأكيد نجاح العملية." });
    }
  }

  if (body?.action === "admin_reset_reserve_records") {
    try {
      const session = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
      const principal = session.principal;
      if (!isGeneralAdminPrincipal(principal) ||
          principal.name !== "مدير النظام العام" ||
          !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "تصفير سجلات الاحتياط متاح لمدير النظام العام فقط." });
      }

      const pin1 = body.pin1;
      const pin2 = body.pin2;
      if (!validPin(pin1) || !validPin(pin2)) {
        return reply(400, { error: "أدخل رمز مدير النظام الصحيح في الحقلين." });
      }

      const rate = await rateLimit(req);
      if (rate.blocked) return reply(429, { error: "محاولات كثيرة. حاول بعد 15 دقيقة." });
      if (pin1 !== pin2) {
        await failedLogin(rate.key);
        return reply(400, { error: "الرمزان غير متطابقين." });
      }

      const [{ data: adminSetting, error: adminSettingError }, { data: adminSecure, error: adminSecureError }] =
        await Promise.all([
          db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle(),
          db.from("student_affairs_credentials")
            .select("pin_salt,pin_hash,source_hash,source_salt")
            .eq("principal_type", "admin")
            .eq("principal_name", "مدير النظام العام")
            .maybeSingle(),
        ]);
      if (adminSettingError || adminSecureError) throw new Error("تعذر تحميل بيانات تحقق مدير النظام.");

      const adminRecord = adminSetting?.value;
      let pinMatches = false;
      if (adminRecord?.hash && adminRecord?.salt) {
        if (adminSecure &&
            adminSecure.source_hash === adminRecord.hash &&
            adminSecure.source_salt === adminRecord.salt) {
          pinMatches = await verifyNewPin(pin1, adminSecure.pin_salt, adminSecure.pin_hash, await getPepper());
        } else {
          pinMatches = await verifyExistingPin(
            pin1, adminRecord.salt, adminRecord.hash, await getLegacyPeppers()
          );
        }
      }
      if (!pinMatches) {
        await failedLogin(rate.key);
        return reply(401, { error: "رمز مدير النظام غير صحيح." });
      }

      const { data: result, error: resetError } = await db.rpc(
        "admin_delete_all_timetable_substitution_records",
        { p_actor_name: principal.name }
      );
      if (resetError) throw resetError;
      if (result?.ok !== true) throw new Error("لم يؤكد إجراء قاعدة البيانات اكتمال التصفير.");

      await clearFailedLogin(rate.key);
      return reply(200, { ok: true, result });
    } catch (error) {
      console.error("Admin reserve-record reset failed:", error instanceof Error ? error.message : "unknown error");
      return reply(500, { error: "تعذر تصفير سجلات الاحتياط حالياً. لم يتم تأكيد نجاح العملية." });
    }
  }

  if (body?.action === "app_data_gateway_read") {
    try { return await readAppDataGateway(req, body); }
    catch (error) {
      console.error("App data gateway read failed:", error);
      return reply(500, { error: "تعذر تحميل البيانات المطلوبة حالياً." });
    }
  }
  if (body?.action === "admin_save_student_roster") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "حفظ قوائم الطلاب متاح لمدير النظام العام فقط." });
      }
      const className = String(body.class_name || "").trim();
      const studentNames = body.student_names;
      if (!className || className.length > 120 || !Array.isArray(studentNames) || studentNames.length > 500) {
        return reply(400, { error: "بيانات قائمة الطلاب غير مكتملة أو غير صحيحة." });
      }
      const { data, error } = await db.rpc("admin_save_student_roster", {
        p_class_name: className,
        p_student_names: studentNames,
        p_actor_name: principal.name
      });
      if (error) {
        const code = String(error.message || "");
        const messages: Record<string, string> = {
          STUDENT_ROSTER_INVALID_INPUT: "بيانات قائمة الطلاب غير صالحة.",
          STUDENT_ROSTER_INVALID_STUDENT_NAME: "توجد أسماء طلاب فارغة أو غير صالحة في القائمة.",
          STUDENT_ROSTER_CLASS_NOT_FOUND: "الصف المحدد غير موجود."
        };
        const matched = Object.entries(messages).find(([key]) => code.includes(key));
        return reply(code.includes("INVALID") ? 400 : 409, { error: matched?.[1] || "تعذر حفظ قائمة الطلاب؛ لم تُعتمد العملية." });
      }
      return reply(200, { ok: true, roster: data });
    } catch (error) {
      console.error("Direct student roster save failed:", error);
      return reply(500, { error: "حدث خطأ أثناء حفظ قائمة الطلاب. لم تُعتمد العملية." });
    }
  }
  if (body?.action === "admin_transfer_student") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "نقل الطلاب بين الصفوف متاح لمدير النظام العام فقط." });
      }
      const studentName = String(body.student_name || "").trim();
      const fromClass = String(body.from_class || "").trim();
      const toClass = String(body.to_class || "").trim();
      if (!studentName || !fromClass || !toClass || studentName.length > 160 || fromClass.length > 120 || toClass.length > 120 || fromClass === toClass) {
        return reply(400, { error: "بيانات نقل الطالب غير مكتملة أو غير صحيحة." });
      }
      const { data, error } = await db.rpc("admin_transfer_student", {
        p_student_name: studentName,
        p_from_class: fromClass,
        p_to_class: toClass,
        p_actor_name: principal.name
      });
      if (error) {
        const code = String(error.message || "");
        const messages: Record<string, string> = {
          STUDENT_TRANSFER_CLASS_NOT_FOUND: "الصف المصدر أو الصف الوجهة غير موجود.",
          STUDENT_TRANSFER_SOURCE_NOT_FOUND: "لم يُعثر على الطالب في الصف المصدر.",
          STUDENT_TRANSFER_ALREADY_IN_DESTINATION: "الطالب موجود بالفعل في الصف الوجهة.",
          STUDENT_TRANSFER_SOURCE_DUPLICATE: "توجد عضوية مكررة للطالب في الصف المصدر. لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_DESTINATION_DUPLICATE: "توجد عضوية مكررة للطالب في الصف الوجهة. لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_MEMBERSHIP_CHANGED: "تغير سجل الطالب أثناء النقل؛ لم تُعتمد العملية. حدّث البيانات ثم أعد المحاولة.",
          STUDENT_TRANSFER_INVALID_ATTENDANCE_RECORD: "يوجد سجل حضور غير صالح للطالب؛ لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_INVALID_BEHAVIOR_RECORD: "يوجد سجل سلوك أو ملاحظة غير صالح للطالب؛ لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_NOTICE_CONFLICT: "تعذر النقل لأن أرقام التنبيهات الرسمية تتعارض مع سجل سابق في الصف الوجهة. لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_ATTENDANCE_CONFLICT: "تعذر النقل بسبب تعارض في سجل حضور موجود بالصف الوجهة. لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_BEHAVIOR_CONFLICT: "تعذر النقل بسبب تعارض في سجل سلوك موجود بالصف الوجهة. لم تُغيّر أي بيانات.",
          STUDENT_TRANSFER_INVALID_INPUT: "بيانات النقل غير صالحة."
        };
        const matched = Object.entries(messages).find(([key]) => code.includes(key));
        return reply(code.includes("INVALID_INPUT") ? 400 : 409, { error: matched?.[1] || "تعذر إتمام النقل؛ لم تُعتمد العملية." });
      }
      return reply(200, { ok: true, transfer: data });
    } catch (error) {
      console.error("Atomic student transfer failed:", error);
      return reply(500, { error: "حدث خطأ أثناء نقل الطالب. لم تُعتمد العملية." });
    }
  }
  if (body?.action === "app_student_affairs_session") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal) {
        await revokeAppSession(appSessionStore, req.headers.get("authorization"));
        return reply(401, { error: "الحساب غير موجود أو لم يعد صالحاً." });
      }
      if (hasFullAdministrativeAccess(principal) && !(await adminStudentAffairsAccessEnabled())) {
        return reply(403, { error: "تم تعليق دخول مدير النظام إلى شؤون الطلبة مؤقتاً للاختبار؛ يمكن إعادة الصلاحية دون تغيير الحساب." });
      }
      if (!hasFullAdministrativeAccess(principal) && !(await hasStudentAffairsAccess(principal))) {
        return reply(403, { error: "هذا الحساب غير مخوّل لدخول شؤون الطلبة." });
      }
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
      await db.from("student_affairs_sessions").delete().lt("expires_at", new Date().toISOString());
      const { error } = await db.from("student_affairs_sessions").insert({
        token_hash: await sha256(token),
        app_session_hash: appSession.tokenHash,
        principal_type: principal.type,
        principal_name: principal.name,
        expires_at: expires
      });
      if (error) throw error;
      return reply(200, {
        token,
        expires_at: expires,
        principal: { type: principal.type, name: principal.name },
        permissions: await permissionsFor(principal)
      });
    } catch (error) {
      console.error("Student Affairs app-session bridge failed:", error);
      return reply(500, { error: "تعذر إنشاء جلسة شؤون الطلبة من جلسة التطبيق الحالية." });
    }
  }
  if (body?.action === "student_affairs_activity_list") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = appSession.principal;
      const allowed = principal.type === "admin" || principal.permissions?.studstats === true;
      if (!allowed) return reply(403, { error: "عرض مراقبة أداء شؤون الطلبة يتطلب صلاحية الإحصائيات أو صلاحية الإدارة." });
      const from = body.from_date == null ? omanTodayIsoDate() : String(body.from_date);
      const to = body.to_date == null ? from : String(body.to_date);
      if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) return reply(400, { error: "نطاق التاريخ غير صالح." });
      // Date filters are calendar dates in Oman (UTC+04:00), not UTC dates.
      const { startInclusive, endExclusive } = omanActivityDateRange(from, to);
      const [{ data: teacherRows, error: teacherError }, { data: events, error: eventsError }] = await Promise.all([
        db.from("teachers").select("name,role,permissions").eq("role", "teacher").order("name", { ascending: true }),
        db.from("student_affairs_activity_events").select("id,event_type,actor_type,actor_name,session_hash,created_at,metadata")
          .not("session_hash", "is", null)
          .gte("created_at", startInclusive).lt("created_at", endExclusive)
          .order("created_at", { ascending: false }).limit(10000),
      ]);
      if (teacherError || eventsError) throw new Error("تعذر تحميل سجل مراقبة الأداء.");
      const teachers = (teacherRows || []).filter((row: any) => row.permissions?.studentAffairs === true ||
        ["team_leader", "supervisor", "visitor"].includes(String(row.permissions?.student_affairs_role || "")))
        .map((row: any) => ({ name: String(row.name || "") })).filter((row: any) => row.name);
      return reply(200, { teachers, events: events || [], tracking_started_at: "2026-11-23T00:00:00.000Z" });
    } catch (error) {
      console.error("Student Affairs activity report failed:", error);
      return reply(500, { error: error instanceof Error ? error.message : "تعذر تحميل سجل مراقبة الأداء." });
    }
  }
  if (body?.action === "app_session") {
    try {
      const session = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
      const principal = await currentAppPrincipal(session.principal.type, session.principal.name);
      if (!principal) {
        await revokeAppSession(appSessionStore, req.headers.get("authorization"));
        return reply(401, { error: "الحساب غير موجود أو لم يعد صالحاً." });
      }
      return reply(200, { principal, expires_at: session.expiresAt });
    } catch (error) {
      console.error("General application session validation failed:", error);
      return reply(500, { error: "تعذر التحقق من الجلسة حالياً" });
    }
  }
  if (body?.action === "app_logout") {
    try {
      // Revoke the Student Affairs bridge session created under this exact app login.
      const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (/^[a-f0-9]{64}$/i.test(bearer)) {
        const appSessionHash = await sha256(bearer);
        const { error: linkedSessionError } = await db.from("student_affairs_sessions")
          .delete().eq("app_session_hash", appSessionHash);
        if (linkedSessionError) throw linkedSessionError;
      }
      const revoked = await revokeAppSession(appSessionStore, req.headers.get("authorization"));
      return reply(revoked ? 200 : 400, { ok: revoked });
    } catch (error) {
      console.error("General application logout failed:", error);
      return reply(500, { error: "تعذر إنهاء الجلسة حالياً" });
    }
  }
  if (body?.action === "login") {
    if (!validPin(body.pin)) return reply(400, { error: "بيانات الدخول غير صحيحة" });
    const rate = await rateLimit(req);
    if (rate.blocked) return reply(429, { error: "محاولات كثيرة. حاول بعد 15 دقيقة." });
    try {
      const principal = await findPrincipal(body.pin, await getPepper());
      if (!principal) { await failedLogin(rate.key); return reply(401, { error: "بيانات الدخول غير صحيحة" }); }
      if (hasFullAdministrativeAccess(principal) && !(await adminStudentAffairsAccessEnabled())) {
        return reply(403, { error: "تم تعليق دخول مدير النظام إلى شؤون الطلبة مؤقتاً للاختبار؛ يمكن إعادة الصلاحية دون تغيير الحساب." });
      }
      if (!hasFullAdministrativeAccess(principal) && !(await hasStudentAffairsAccess(principal))) { await failedLogin(rate.key); return reply(403, { error: "هذا الحساب غير مخوّل لدخول شؤون الطلبة" }); }
      await clearFailedLogin(rate.key);
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
      await db.from("student_affairs_sessions").delete().lt("expires_at", new Date().toISOString());
      const { error } = await db.from("student_affairs_sessions").insert({ token_hash: await sha256(token), principal_type: principal.type, principal_name: principal.name, expires_at: expires });
      if (error) throw error;
      return reply(200, { token, expires_at: expires, principal: { type: principal.type, name: principal.name }, permissions: await permissionsFor(principal) });
    } catch (e) { console.error("Student affairs login failed:", e); return reply(500, { error: "تعذر إتمام التحقق الآمن حالياً" }); }
  }
  if (["timetable_check_access","timetable_list_access","timetable_set_access"].includes(String(body?.action || ""))) {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal) return reply(401, { error: "الحساب غير موجود أو لم يعد صالحاً." });

      if (body.action === "timetable_check_access") {
        const canAccess = await hasTimetableAccess(principal);
        return reply(200, { canAccess, isAdmin: hasFullAdministrativeAccess(principal) });
      }

      if (!hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "إدارة صلاحيات الجداول متاحة لمدير النظام العام فقط." });
      }

      if (body.action === "timetable_list_access") {
        const [{ data: teachers, error: teachersError }, { data: grants, error: grantsError }] = await Promise.all([
          db.from("teachers").select("name,role,permissions").order("name"),
          db.from("timetable_access_permissions").select("principal_type,principal_name,can_access,updated_by,updated_at"),
        ]);
        if (teachersError) throw teachersError;
        if (grantsError) throw grantsError;
        const grantMap = new Map((grants || []).map((row: any) => [row.principal_type + ":" + row.principal_name, row]));
        const users = (teachers || []).filter((item: any) => item.role === "teacher" || item.role === "custom").map((item: any) => {
          const type = item.role === "custom" ? "custom" : "teacher";
          const grant = grantMap.get(type + ":" + String(item.name)) as any;
          return {
            principal_type: type,
            principal_name: String(item.name),
            category: typeof item.permissions?.category === "string" ? item.permissions.category : "",
            can_access: grant?.can_access === true,
            updated_by: grant?.updated_by || null,
            updated_at: grant?.updated_at || null,
          };
        });
        return reply(200, { users });
      }

      const principalType = String(body.principalType || "");
      const principalName = String(body.principalName || "").trim();
      const canAccess = body.canAccess === true;
      if (!["teacher","custom"].includes(principalType) || !principalName || principalName.length > 160 || typeof body.canAccess !== "boolean") {
        return reply(400, { error: "بيانات صلاحية الجداول غير صالحة." });
      }
      const { data: target, error: targetError } = await db.from("teachers")
        .select("name,role").eq("name", principalName).maybeSingle();
      if (targetError) throw targetError;
      if (!target || (principalType === "custom" ? target.role !== "custom" : target.role === "custom")) {
        return reply(404, { error: "المستخدم المحدد غير موجود أو نوع حسابه لا يطابق الاختيار." });
      }
      const { error } = await db.from("timetable_access_permissions").upsert({
        principal_type: principalType,
        principal_name: principalName,
        can_access: canAccess,
        updated_by: principal.name,
        updated_at: new Date().toISOString(),
      }, { onConflict: "principal_type,principal_name" });
      if (error) throw error;
      return reply(200, { ok: true, principalType, principalName, canAccess });
    } catch (error) {
      console.error("Timetable access permission request failed:", error);
      return reply(500, { error: "تعذر تحديث صلاحية الجداول. تحقق من migration التطوير." });
    }
  }
  if (["timetable_parse_day","timetable_save_weekly_day","timetable_activate_weekly_version","timetable_get_weekly_draft"].includes(String(body?.action || ""))) {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "إدارة الجدول الأسبوعي متاحة لمدير النظام العام فقط." });
      }

      if (body.action === "timetable_get_weekly_draft") {
        const { data: draft, error: draftError } = await db.from("timetable_weekly_versions")
          .select("id,version,expected_teacher_count,created_at")
          .eq("status", "draft").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (draftError) throw draftError;
        if (!draft) return reply(200, { ok: true, draft: null });
        const { data: cells, error: cellsError } = await db.from("timetable_weekly_cells")
          .select("weekday,teacher_source_name").eq("version_id", draft.id);
        if (cellsError) throw cellsError;
        const rows = cells || [];
        return reply(200, {
          ok: true,
          draft: {
            id: draft.id,
            version: draft.version,
            expectedTeacherCount: draft.expected_teacher_count,
            weekdays: [...new Set(rows.map((row: any) => String(row.weekday || "")).filter(Boolean))],
            teacherCount: new Set(rows.map((row: any) => String(row.teacher_source_name || ""))).size,
            cellCount: rows.length,
            createdAt: draft.created_at,
          },
        });
      }

      if (body.action === "timetable_activate_weekly_version") {
        const versionId = String(body.versionId || "");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) {
          return reply(400, { error: "رقم نسخة الجدول غير صالح." });
        }
        const { data, error } = await db.rpc("activate_timetable_weekly_version", {
          p_payload: { version_id: versionId, actor_name: principal.name },
        });
        if (error) throw error;
        return reply(200, { ok: true, result: data });
      }

      const weekday = String(body.weekday || "");
      const sourceText = String(body.text || "");
      if (!sourceText.trim() || sourceText.length > 500000) {
        return reply(400, { error: "أدخل نص يوم دراسي صحيحاً لا يتجاوز الحد المسموح." });
      }
      const parsed = parseTimetableDay(weekday, sourceText);
      // The current school roster has 69 teachers; enforce this on the server for both preview and save.
      validateSchoolTeacherCount(parsed, 69);
      const { data: directory, error: directoryError } = await db
        .from("teachers").select("name,role,permissions").eq("role", "teacher").order("name");
      if (directoryError) throw directoryError;
      const systemTeachers: SystemTeacher[] = (directory || []).map((teacher: any) => ({
        name: String(teacher.name || ""),
        departmentId: typeof teacher.permissions?.category === "string" ? teacher.permissions.category : typeof teacher.permissions?.department_id === "string" ? teacher.permissions.department_id : undefined,
        departmentName: typeof teacher.permissions?.category === "string" ? teacher.permissions.category : typeof teacher.permissions?.department_name === "string" ? teacher.permissions.department_name : undefined,
      })).filter((teacher: SystemTeacher) => teacher.name);
      const matchedTeachers = parsed.teachers.map((teacher) => {
        const match = matchSystemTeacherName(teacher.sourceName, systemTeachers);
        return { ...teacher, matchedTeacherName: match.teacherName, matchStatus: match.matchStatus };
      });
      const matchingTotals = {
        matched: matchedTeachers.filter((teacher) => teacher.matchStatus === "matched").length,
        unmatched: matchedTeachers.filter((teacher) => teacher.matchStatus === "unmatched").length,
        ambiguous: matchedTeachers.filter((teacher) => teacher.matchStatus === "ambiguous").length,
      };

      if (body.action === "timetable_parse_day") {
        return reply(200, {
          ok: true, weekday: parsed.weekday, teachers: matchedTeachers,
          totals: parsed.totals, totalCells: parsed.totalCells, matchingTotals,
        });
      }

      const versionId = body.versionId ? String(body.versionId) : null;
      if (versionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) {
        return reply(400, { error: "رقم المسودة غير صالح." });
      }
      const { data, error } = await db.rpc("save_timetable_weekly_day", {
        p_payload: {
          version_id: versionId,
          weekday: parsed.weekday,
          teachers: matchedTeachers,
          actor_name: principal.name,
        },
      });
      if (error) throw error;
      return reply(200, { ok: true, result: data, matchingTotals });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.error("Weekly timetable day operation failed:", error);
      return reply(400, { error: message || "تعذر معالجة اليوم. راجع النص والخانات ثم أعد المحاولة." });
    }
  }

  if (body?.action === "timetable_teacher_weekly_get") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "استعراض جداول جميع المعلمين متاح لمدير النظام العام فقط." });
      }
      const teacherName = String(body.teacherName || "").trim();
      const versionId = body.versionId ? String(body.versionId) : "";
      if (!teacherName || teacherName.length > 160) {
        return reply(400, { error: "أدخل اسم المعلم كاملاً." });
      }
      if (versionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) {
        return reply(400, { error: "رقم نسخة الجدول غير صالح." });
      }
      let versionQuery = db.from("timetable_weekly_versions")
        .select("id,version,status,activated_at");
      versionQuery = versionId ? versionQuery.eq("id", versionId) : versionQuery.eq("status", "active");
      const { data: timetableVersion, error: versionError } = await versionQuery.maybeSingle();
      if (versionError) throw versionError;
      if (!timetableVersion) {
        return reply(404, { error: versionId ? "نسخة الجدول المطلوبة غير موجودة." : "لا توجد نسخة أسبوعية معتمدة حالياً." });
      }
      const { data: cells, error: cellsError } = await db.from("timetable_weekly_cells")
        .select("weekday,period,cell_status,class_sections,subject,source_page,teacher_source_name,matched_teacher_name,match_status")
        .eq("version_id", timetableVersion.id)
        .eq("matched_teacher_name", teacherName)
        .order("weekday")
        .order("period");
      if (cellsError) throw cellsError;
      const weekdayOrder = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
      const orderedCells = (cells || []).sort((a: any, b: any) =>
        weekdayOrder.indexOf(String(a.weekday)) - weekdayOrder.indexOf(String(b.weekday)) ||
        Number(a.period) - Number(b.period)
      );
      if (!orderedCells.length) {
        return reply(404, { error: "لم يُعثر على جدول مرتبط بهذا الاسم في النسخة المحددة. تحقق من الاسم أو ربطه بحساب المعلم." });
      }
      return reply(200, {
        ok: true,
        teacherName,
        version: timetableVersion,
        cells: orderedCells,
        expectedCellCount: 35,
        actualCellCount: orderedCells.length,
        complete: orderedCells.length === 35,
      });
    } catch (error) {
      console.error("Admin teacher weekly timetable lookup failed:", error);
      return reply(500, { error: "تعذر استعراض جدول المعلم حالياً." });
    }
  }

  if (body?.action === "teacher_timetable_get_own") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || principal.type !== "teacher") {
        return reply(403, { error: "عرض الجدول الشخصي متاح لحساب المعلم فقط." });
      }
      const { data: activeVersion, error: versionError } = await db.from("timetable_weekly_versions")
        .select("id,version,status,activated_at").eq("status", "active").maybeSingle();
      if (versionError) throw versionError;
      if (!activeVersion) return reply(200, { ok: true, teacherName: principal.name, version: null, cells: [], assignments: [] });
      const [{ data: cells, error: cellsError }, { data: assignments, error: assignmentsError }] = await Promise.all([
        db.from("timetable_weekly_cells").select("weekday,period,cell_status,class_sections,subject,source_page")
          .eq("version_id", activeVersion.id).eq("matched_teacher_name", principal.name),
        db.from("timetable_assignments").select("id,assignment_type,weekday,period,assignment_date,class_sections,subject,absent_teacher_name,status")
          .eq("version_id", activeVersion.id).eq("teacher_name", principal.name).neq("status", "cancelled"),
      ]);
      if (cellsError) throw cellsError;
      if (assignmentsError) throw assignmentsError;
      const weekdayOrder = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
      const sortCells = (left: any, right: any) =>
        weekdayOrder.indexOf(left.weekday) - weekdayOrder.indexOf(right.weekday) || left.period - right.period;
      return reply(200, {
        ok: true, teacherName: principal.name, version: activeVersion,
        cells: (cells || []).sort(sortCells),
        assignments: (assignments || []).sort(sortCells),
      });
    } catch (error) {
      console.error("Teacher personal timetable read failed:", error);
      return reply(500, { error: "تعذر تحميل الجدول الشخصي حالياً." });
    }
  }

  if (["timetable_substitution_preview","timetable_substitution_save","timetable_substitution_cancel"].includes(String(body?.action || ""))) {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal) return reply(401, { error: "تعذر التحقق من المستخدم الحالي." });
      if (!hasFullAdministrativeAccess(principal) && !(await hasTimetableAccess(principal))) {
        return reply(403, { error: "لا تملك صلاحية منظومة الجداول والاحتياط." });
      }

      const weekday = String(body.weekday || "");
      const allowedDays = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
      if (!allowedDays.includes(weekday)) return reply(400, { error: "اختر يوماً دراسياً صحيحاً." });

      const { data: activeVersion, error: versionError } = await db.from("timetable_weekly_versions")
        .select("id,version,status").eq("status","active").maybeSingle();
      if (versionError) throw versionError;
      if (!activeVersion) return reply(200, { ok:true, active:false, absentTeachers:[], lessons:[] });

      const [{ data: directory, error: directoryError }, { data: dayCells, error: cellsError }] = await Promise.all([
        db.from("teachers").select("name,role,permissions").in("role",["teacher","custom"]).order("name"),
        db.from("timetable_weekly_cells")
          .select("id,matched_teacher_name,weekday,period,cell_status,class_sections,subject")
          .eq("version_id",activeVersion.id).eq("weekday",weekday),
      ]);
      if (directoryError) throw directoryError;
      if (cellsError) throw cellsError;

      const teacherRows = (directory || []).map((item:any) => ({
        name:String(item.name || ""),
        role:String(item.role || ""),
        department:String(item.permissions?.category || item.permissions?.department_id || item.permissions?.department_name || ""),
      })).filter((item:any)=>item.name);
      const actorDirectoryRow = teacherRows.find((item:any)=>item.name===principal.name);
      const actorDepartment = actorDirectoryRow?.department || "";
      if (!hasFullAdministrativeAccess(principal) && !actorDepartment) {
        return reply(403,{error:"حسابك غير مرتبط بقسم واضح في دليل المعلمين. راجع مدير النظام."});
      }

      const absentTeacherName = String(body.absentTeacherName || "").trim();
      const includeOtherDepartments = body.includeOtherDepartments === true;
      if (body.action === "timetable_substitution_cancel") {
        const assignmentId=String(body.assignmentId || "");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assignmentId)) {
          return reply(400,{error:"رقم تكليف الاحتياط غير صالح."});
        }
        const {data: assignment,error: assignmentLookupError}=await db.from("timetable_assignments")
          .select("id,version_id,absent_teacher_name,weekday,assignment_date")
          .eq("id",assignmentId).eq("version_id",activeVersion.id).eq("assignment_type","substitution").maybeSingle();
        if(assignmentLookupError)throw assignmentLookupError;
        const cancellationDate=String(body.assignmentDate || "");
        if(!assignment||assignment.weekday!==weekday||(assignment.assignment_date&&assignment.assignment_date!==cancellationDate))
          return reply(404,{error:"تكليف الاحتياط غير موجود في التاريخ المحدد."});
        const absentRow=teacherRows.find((item:any)=>item.name===assignment.absent_teacher_name&&item.role==="teacher");
        if(!absentRow)return reply(404,{error:"تعذر العثور على قسم المعلم الغائب."});
        if(!hasFullAdministrativeAccess(principal)&&absentRow.department!==actorDepartment) {
          return reply(403,{error:"لا تملك صلاحية إلغاء تكليف هذا القسم."});
        }
        const {data,error}=await db.rpc("cancel_timetable_substitution",{
          p_payload:{assignment_id:assignmentId,actor_name:principal.name,actor_type:principal.type},
        });
        if(error)throw error;
        return reply(200,{ok:true,assignment:data});
      }
      if (absentTeacherName) {
        const absentDirectoryRow = teacherRows.find((item:any)=>item.name===absentTeacherName);
        if (!absentDirectoryRow || absentDirectoryRow.role!=="teacher") return reply(404,{error:"المعلم المحدد غير موجود في دليل المعلمين."});
        if (!hasFullAdministrativeAccess(principal) && absentDirectoryRow.department !== actorDepartment) {
          return reply(403,{error:"يمكنك إدارة احتياط معلمي قسمك فقط."});
        }
      }

      if (body.action === "timetable_substitution_save") {
        const period = Number(body.period);
        const assignmentDate = String(body.assignmentDate || "");
        if (!absentTeacherName || !String(body.substituteTeacherName || "").trim()
          || !Number.isInteger(period) || period < 1 || period > 7
          || !/^\d{4}-\d{2}-\d{2}$/.test(assignmentDate)) {
          return reply(400,{error:"حدد تاريخ الغياب والمعلم الغائب والبديل والحصة."});
        }
        const { data, error } = await db.rpc("create_timetable_substitution", {
          p_payload: {
            version_id:activeVersion.id, weekday, period, assignment_date:assignmentDate,
            absent_teacher_name:absentTeacherName,
            substitute_teacher_name:String(body.substituteTeacherName).trim(),
            actor_name:principal.name, actor_type:principal.type,
            include_other_departments:includeOtherDepartments,
          },
        });
        if (error) throw error;
        return reply(201,{ok:true,assignment:data});
      }

      const date = String(body.assignmentDate || "");
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(400,{error:"تاريخ الغياب غير صالح."});
      const absentTeachers = Array.from(new Set((dayCells || [])
        .filter((cell:any)=>cell.cell_status==="teaching" && cell.matched_teacher_name)
        .filter((cell:any)=>teacherRows.find((t:any)=>t.name===cell.matched_teacher_name)?.role==="teacher")
        .filter((cell:any)=>hasFullAdministrativeAccess(principal) || teacherRows.find((t:any)=>t.name===cell.matched_teacher_name)?.department===actorDepartment)
        .map((cell:any)=>String(cell.matched_teacher_name))))
        .sort((a,b)=>a.localeCompare(b,"ar"));
      if (!absentTeacherName) {
        return reply(200,{ok:true,active:true,version:activeVersion,absentTeachers});
      }

      const timetable:TimetableEntry[]=(dayCells || []).filter((cell:any)=>cell.matched_teacher_name).map((cell:any)=>({
        teacherId:String(cell.matched_teacher_name),weekday:String(cell.weekday),period:Number(cell.period),
        className:Array.isArray(cell.class_sections)?cell.class_sections.join("، "):"",
        subject:String(cell.subject || ""),status:cell.cell_status,
      }));
      const lessons = getAbsentTeacherLessons(timetable,absentTeacherName,weekday);
      const { data: assignmentRows, error: assignmentError } = await db.from("timetable_assignments")
        .select("id,source_cell_id,teacher_name,weekday,period,status,assignment_date")
        .eq("version_id",activeVersion.id).in("status",["assigned","confirmed","completed"]);
      if (assignmentError) throw assignmentError;
      const selectedDate = date ? new Date(date+"T12:00:00") : null;
      const weekStart = selectedDate ? new Date(selectedDate.getFullYear(),selectedDate.getMonth(),selectedDate.getDate()-selectedDate.getDay(),12) : null;
      const weekEnd = weekStart ? new Date(weekStart.getFullYear(),weekStart.getMonth(),weekStart.getDate()+4,12) : null;
      const toLocalIsoDate=(value:Date)=>value.getFullYear()+"-"+String(value.getMonth()+1).padStart(2,"0")+"-"+String(value.getDate()).padStart(2,"0");
      const assignments:SubstitutionAssignment[]=(assignmentRows || [])
        .filter((item:any)=>!item.assignment_date || !weekStart ||
          (item.assignment_date>=toLocalIsoDate(weekStart) && item.assignment_date<=toLocalIsoDate(weekEnd!)))
        .map((item:any)=>({substituteTeacherId:String(item.teacher_name),weekday:String(item.weekday),
          period:Number(item.period),assignmentDate:item.assignment_date || null,status:item.status}));
      const candidates:SubstitutionTeacher[]=teacherRows.filter((item:any)=>item.role==="teacher").map((item:any)=>({
        id:item.name,name:item.name,departmentId:item.department,
      }));
      const lessonOptions=lessons.map((lesson)=>{
        const eligible=getAvailableSubstitutionCandidates({
          teachers:candidates,timetable,assignments,absentTeacherId:absentTeacherName,
          weekday,period:lesson.period,departmentId:teacherRows.find((item:any)=>item.name===absentTeacherName)?.department || "",
          includeOtherDepartments,assignmentDate:date || undefined,
        });
        const sourceCell=(dayCells || []).find((cell:any)=>cell.matched_teacher_name===absentTeacherName && Number(cell.period)===lesson.period);
        const existing=(assignmentRows || []).find((item:any)=>item.source_cell_id===sourceCell?.id &&
          (!date || !item.assignment_date || item.assignment_date===date) && item.status!=="cancelled");
        return {...lesson,candidates:eligible,assignment:existing?{
          id:existing.id,substituteTeacherName:String(existing.teacher_name),status:String(existing.status),
        }:null};
      });
      return reply(200,{ok:true,active:true,version:activeVersion,weekday,absentTeacherName,
        lessons:lessonOptions,includeOtherDepartments});
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.error("Timetable substitution operation failed:",error);
      return reply(400,{error:message || "تعذر إتمام إجراء الاحتياط. تحقق من البيانات ثم أعد المحاولة."});
    }
  }

  if (body?.action === "timetable_preview") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "لا تملك صلاحية الدخول إلى منظومة الجداول والاحتياط." });
      }
      const sheets = body?.sheets;
      if (!sheets || typeof sheets !== "object" || Array.isArray(sheets)) {
        return reply(400, { error: "بيانات ملف Excel غير صالحة." });
      }
      const sheetNames = Object.keys(sheets);
      if (!sheetNames.length || sheetNames.length > 20) {
        return reply(400, { error: "عدد أوراق العمل غير صالح." });
      }
      let rowCount = 0, cellCount = 0;
      for (const [name, rows] of Object.entries(sheets)) {
        if (typeof name !== "string" || !Array.isArray(rows)) return reply(400, { error: "بنية ورقة العمل غير صالحة." });
        rowCount += rows.length;
        for (const row of rows) {
          if (!Array.isArray(row)) return reply(400, { error: "توجد بيانات صف غير صالحة في ملف Excel." });
          cellCount += row.length;
        }
      }
      if (rowCount > 5000 || cellCount > 100000) {
        return reply(413, { error: "حجم بيانات الجدول أكبر من الحد المسموح للمعاينة. قلّص نطاق البيانات الفعلية في ملف Excel." });
      }
      const { data: directory, error: directoryError } = await db
        .from("teachers").select("name,role,permissions").eq("role", "teacher").order("name");
      if (directoryError) throw directoryError;
      const systemTeachers: SystemTeacher[] = (directory || []).map((teacher: any) => ({
        name: String(teacher.name || ""),
        departmentId: typeof teacher.permissions?.category === "string" ? teacher.permissions.category : typeof teacher.permissions?.department_id === "string" ? teacher.permissions.department_id : undefined,
        departmentName: typeof teacher.permissions?.category === "string" ? teacher.permissions.category : typeof teacher.permissions?.department_name === "string" ? teacher.permissions.department_name : undefined,
      })).filter((teacher: SystemTeacher) => teacher.name);
      const result = parseTimetableWorkbook(sheets, systemTeachers);
      return reply(200, {
        ok: true,
        fileName: String(body.fileName || "ملف Excel").slice(0, 180),
        importedAt: new Date().toISOString(),
        importedBy: principal.name,
        result,
      });
    } catch (error) {
      console.error("Timetable workbook preview failed:", error);
      return reply(500, { error: "تعذر تحليل ملف الجدول. تحقق من بنية الملف ثم أعد المحاولة." });
    }
  }
  if (body?.action === "timetable_save_import") {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !hasFullAdministrativeAccess(principal)) {
        return reply(403, { error: "لا تملك صلاحية الدخول إلى منظومة الجداول والاحتياط." });
      }
      const sheets = body?.sheets;
      if (!sheets || typeof sheets !== "object" || Array.isArray(sheets)) {
        return reply(400, { error: "بيانات ملف Excel غير صالحة." });
      }
      const sheetNames = Object.keys(sheets);
      if (!sheetNames.length || sheetNames.length > 20) return reply(400, { error: "عدد أوراق العمل غير صالح." });
      let rowCount = 0, cellCount = 0;
      for (const [name, rows] of Object.entries(sheets)) {
        if (typeof name !== "string" || !Array.isArray(rows)) return reply(400, { error: "بنية ورقة العمل غير صالحة." });
        rowCount += rows.length;
        for (const row of rows) {
          if (!Array.isArray(row)) return reply(400, { error: "توجد بيانات صف غير صالحة في ملف Excel." });
          cellCount += row.length;
        }
      }
      if (rowCount > 5000 || cellCount > 100000) {
        return reply(413, { error: "حجم بيانات الجدول أكبر من الحد المسموح للاستيراد." });
      }
      const { data: directory, error: directoryError } = await db
        .from("teachers").select("name,role,permissions").eq("role", "teacher").order("name");
      if (directoryError) throw directoryError;
      const systemTeachers: SystemTeacher[] = (directory || []).map((teacher: any) => ({
        name: String(teacher.name || ""),
        departmentId: typeof teacher.permissions?.category === "string" ? teacher.permissions.category : typeof teacher.permissions?.department_id === "string" ? teacher.permissions.department_id : undefined,
        departmentName: typeof teacher.permissions?.category === "string" ? teacher.permissions.category : typeof teacher.permissions?.department_name === "string" ? teacher.permissions.department_name : undefined,
      })).filter((teacher: SystemTeacher) => teacher.name);
      const parsed = parseTimetableWorkbook(sheets, systemTeachers);
      const { data, error } = await db.rpc("save_timetable_import", {
        p_payload: {
          file_name: String(body.fileName || "ملف Excel").slice(0,180),
          actor_name: principal.name,
          result: parsed,
        },
      });
      if (error) throw error;
      return reply(200, { ok: true, saved: data });
    } catch (error) {
      console.error("Timetable import persistence failed:", error);
      return reply(500, { error: "تعذر حفظ نسخة الجدول. تأكد من تطبيق migration الخاصة بالتطوير أولاً." });
    }
  }
  if (["timetable_list_imports","timetable_get_import","timetable_mutate_record","timetable_list_owner_candidates","timetable_reassign_owner"].includes(String(body?.action || ""))) {
    try {
      const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
      if (!appSession) return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
      const principal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!principal || !(await hasTimetableAccess(principal))) {
        return reply(403, { error: "لا تملك صلاحية الدخول إلى منظومة الجداول والاحتياط." });
      }

      if (body.action === "timetable_list_imports") {
        const { data, error } = await db.from("timetable_imports")
          .select("id,version,file_name,imported_by_name,status,has_weekly_placements,source_sheets,summary,created_at")
          .order("created_at", { ascending: false }).limit(30);
        if (error) throw error;
        return reply(200, { imports: data || [] });
      }

      if (body.action === "timetable_list_owner_candidates") {
        const { data, error } = await db.from("teachers")
          .select("name,role,permissions").eq("role", "teacher").order("name");
        if (error) throw error;
        return reply(200, { teachers: (data || []).map((item: any) => ({
          name: String(item.name || ""),
          department: String(item.permissions?.category || item.permissions?.department_name || item.permissions?.department_id || "")
        })).filter((item: any) => item.name) });
      }

      const importId = String(body.importId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(importId)) {
        return reply(400, { error: "معرّف نسخة الجدول غير صالح." });
      }

      if (body.action === "timetable_get_import") {
        const [{ data: imported, error: importError }, { data: teachers, error: teachersError }, { data: records, error: recordsError }] = await Promise.all([
          db.from("timetable_imports").select("*").eq("id", importId).maybeSingle(),
          db.from("timetable_import_teachers").select("*").eq("import_id", importId).order("source_name"),
          db.from("timetable_import_records").select("*").eq("import_id", importId).order("source_sheet").order("source_row"),
        ]);
        if (importError) throw importError;
        if (teachersError) throw teachersError;
        if (recordsError) throw recordsError;
        if (!imported) return reply(404, { error: "نسخة الجدول غير موجودة." });
        return reply(200, { imported, teachers: teachers || [], records: records || [] });
      }


      if (body.action === "timetable_reassign_owner") {
        const sourceName = String(body.sourceName || "").trim();
        const teacherName = String(body.teacherName || "").trim();
        if (!sourceName || sourceName.length > 200 || teacherName.length > 200) {
          return reply(400, { error: "بيانات مالك الجدول غير صالحة." });
        }
        const { data, error } = await db.rpc("reassign_timetable_import_owner", {
          p_payload: { import_id: importId, source_name: sourceName, teacher_name: teacherName, actor_name: principal.name },
        });
        if (error) throw error;
        return reply(200, { result: data });
      }

      if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
        return reply(400, { error: "بيانات تعديل الحصة غير صالحة." });
      }
      const { data, error } = await db.rpc("mutate_timetable_import_record", {
        p_payload: { ...body.payload, import_id: importId, actor_name: principal.name },
      });
      if (error) throw error;
      return reply(200, { result: data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("تعارض") || message.includes("مسودة") || message.includes("المعلم غير مطابق") || message.includes("غير موجود")) {
        return reply(409, { error: message });
      }
      console.error("Timetable administration request failed:", error);
      return reply(500, { error: "تعذر تنفيذ عملية إدارة الجدول. تحقق من تطبيق migration التطوير." });
    }
  }
  if (body?.action === "competition_finalize") {
    try {
      const expected = await getCompetitionCronSecret();
      const provided = req.headers.get("x-cron-secret") || "";
      if (!secureStringEquals(expected, provided)) return reply(403, { error: "غير مصرح" });
      const result = await finalizeCompetitionWeek();
      return reply(200, result);
    } catch (e) {
      const status = Number((e as any)?.status) || 500;
      const message = status < 500 && e instanceof Error ? e.message : "تعذر اعتماد نتيجة سباق التميز آلياً.";
      if (status >= 500) console.error("Competition finalization failed:", e);
      return reply(status, { error: message });
    }
  }
  let session: Awaited<ReturnType<typeof getSession>> = null;
  let activitySessionHash: string | null = null;
  let p: { type: string; name: string };
  let adminRecordsCenterAccess = false;
  if (body?.action === "reports_permissions" || body?.action === "reports") {
    const appSession = await readAuthorizedAppSession(req.headers.get("authorization"));
    if (appSession) {
      activitySessionHash = appSession.tokenHash;
      const appPrincipal = await currentAppPrincipal(appSession.principal.type, appSession.principal.name);
      if (!appPrincipal) {
        await revokeAppSession(appSessionStore, req.headers.get("authorization"));
        return reply(401, { error: "الحساب غير موجود أو لم يعد صالحاً." });
      }
      if (hasFullAdministrativeAccess(appPrincipal) && !(await adminStudentAffairsAccessEnabled())) {
        return reply(403, { error: "تم تعليق دخول مدير النظام إلى تقارير شؤون الطلبة مؤقتاً للاختبار." });
      }
      adminRecordsCenterAccess = body?.admin_records_center === true && hasAdminRecordsCenterAccess(appPrincipal.type, appPrincipal.permissions, hasFullAdministrativeAccess(appPrincipal));
      if (!canAccessReportPermission(appPrincipal.type, appPrincipal.permissions, "reportStudentAffairs", hasFullAdministrativeAccess(appPrincipal), adminRecordsCenterAccess)) {
        return reply(403, { error: "لا تملك صلاحية دخول لوحة تقارير شؤون الطلبة." });
      }
      p = appPrincipal;
    } else if (body?.action === "reports") {
      const saSession = await getSession(req);
      if (!saSession) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
      session = saSession;
      activitySessionHash = saSession.appSessionHash || saSession.tokenHash;
      p = saSession.principal;
      if (!hasFullAdministrativeAccess(p) && !(await hasStudentAffairsAccess(p))) {
        await db.from("student_affairs_sessions").delete().eq("token_hash", saSession.tokenHash);
        return reply(403, { error: "تم إيقاف صلاحية دخول شؤون الطلبة لهذا الحساب" });
      }
    } else {
      return reply(401, { error: "انتهت جلسة التطبيق. سجّل الدخول مجدداً." });
    }
    if (body?.action === "reports_permissions") {
      return reply(200, { permissions: await permissionsFor(p, false, adminRecordsCenterAccess) });
    }
  } else {
    session = await getSession(req);
    if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
    activitySessionHash = session.appSessionHash || session.tokenHash;
    p = session.principal;
    if (!hasFullAdministrativeAccess(p) && !(await hasStudentAffairsAccess(p))) {
      await db.from("student_affairs_sessions").delete().eq("token_hash", session.tokenHash);
      return reply(403, { error: "تم إيقاف صلاحية دخول شؤون الطلبة لهذا الحساب" });
    }
  }
  if (body?.action === "logout") {
    if (!session) return reply(400, { error: "جلسة شؤون الطلبة غير صالحة." });
    await db.from("student_affairs_sessions").delete().eq("token_hash", session.tokenHash);
    return reply(200, { ok: true });
  }
  if (body?.action === "get_my_permissions") {
    return reply(200, { permissions: await permissionsFor(p) });
  }
  if (body?.action === "supervision_trend") {
    const permissions = await permissionsFor(p);
    if (!hasFullAdministrativeAccess(p) && permissions.can_view_analytics !== true && !["team_leader", "visitor"].includes(permissions.role)) return reply(403, { error: "غير مصرح بعرض مؤشر الأداء" });
    const from = body.from == null ? "2000-01-01" : body.from;
    const to = body.to == null ? new Date().toISOString().slice(0, 10) : body.to;
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) return reply(400, { error: "نطاق التاريخ غير صالح" });
    const scope = String(body.scope || "own");
    let attendanceClasses: string[] = [], behaviorClasses: string[] = [];
    let selectedMembers: any[] = [];
    if (scope === "own") {
      attendanceClasses = permissions.own_allowed_attendance_classes || [];
      behaviorClasses = permissions.own_allowed_behavior_classes || [];
    } else if (scope === "team" && !hasFullAdministrativeAccess(p) && permissions.role === "team_leader") {
      // Team scope includes the leader's own assigned classes plus only directly supervised team members.
      selectedMembers = [{
        name: p.name,
        allowed_attendance_classes: permissions.own_allowed_attendance_classes || [],
        allowed_behavior_classes: permissions.own_allowed_behavior_classes || [],
        attendance_statuses: permissions.attendance_statuses || ["absent", "late", "escape", "outside"]
      }, ...(permissions.team_members || [])];
      attendanceClasses = [...(permissions.own_allowed_attendance_classes || []), ...(permissions.team_allowed_attendance_classes || [])];
      behaviorClasses = [...(permissions.own_allowed_behavior_classes || []), ...(permissions.team_allowed_behavior_classes || [])];
    } else if (scope === "teacher" && (hasFullAdministrativeAccess(p) || ["team_leader", "visitor"].includes(permissions.role))) {
      const target = resolveSupervisionTeacher(permissions.role === "admin" ? "visitor" : permissions.role, String(body.teacher_name || ""), permissions.team_members || [], permissions.teacher_directory || []);
      if (!target) return reply(403, { error: permissions.role === "visitor" ? "هذا المعلم غير موجود ضمن معلمي شؤون الطلبة." : "هذا المعلم ليس ضمن فريقك" });
      selectedMembers = [target];
      attendanceClasses = target.allowed_attendance_classes || [];
      behaviorClasses = target.allowed_behavior_classes || [];
    } else if (scope === "all" && (hasFullAdministrativeAccess(p) || permissions.role === "visitor")) {
      selectedMembers = permissions.teacher_directory || [];
      attendanceClasses = selectedMembers.flatMap((item: any) => item.allowed_attendance_classes || []);
      behaviorClasses = selectedMembers.flatMap((item: any) => item.allowed_behavior_classes || []);
    } else if (scope !== "own") return reply(403, { error: "نطاق المتابعة غير مصرح به" });
    const unique = (items: string[]) => [...new Set(items.map(String).filter(Boolean))];
    attendanceClasses = unique(attendanceClasses); behaviorClasses = unique(behaviorClasses);
    const ownStatusSet = new Set((permissions.attendance_statuses || ["absent", "late", "escape", "outside"]).map(String));
    const classStatusSets = new Map<string, Set<string>>();
    if (scope === "team" || scope === "teacher" || scope === "all") {
      for (const member of selectedMembers) {
        const statuses = new Set<string>((member.attendance_statuses || ["absent", "late", "escape", "outside"]).map(String));
        for (const className of member.allowed_attendance_classes || []) {
          const key = String(className);
          const combined = classStatusSets.get(key) || new Set<string>();
          for (const status of statuses) combined.add(status);
          classStatusSets.set(key, combined);
        }
      }
    }
    const fetchAll = (table: "attendance" | "behaviors", classes: string[]) =>
      fetchSupervisionTrendRows(db, table, classes, from, to);
    let attendanceRows: any[] = [], behaviorRows: any[] = [];
    try {
      [attendanceRows, behaviorRows] = await Promise.all([
        attendanceClasses.length ? fetchAll("attendance", attendanceClasses) : Promise.resolve([]),
        behaviorClasses.length ? fetchAll("behaviors", behaviorClasses) : Promise.resolve([])
      ]);
    } catch (error) {
      console.error("Supervision trend query failed:", error);
      return reply(500, { error: "تعذر إعداد مؤشر الأداء" });
    }
    const days = new Map<string, any>();
    const behaviorKeys = ["eating", "talking", "tools", "chaos", "sleeping", "homework", "other"];
    const countedDailyBehaviors = new Set<string>();
    // Absence is a daily status, not a per-period event. A student may appear in
    // several attendance rows (one per lesson) on the same date; count that
    // student's absence once per class/date while preserving per-record counts
    // for late, escape and outside statuses.
    const countedDailyAbsences = new Set<string>();
    const getDay = (date: string) => { if (!days.has(date)) days.set(date, { date, absent: 0, late: 0, escape: 0, outside: 0, behavior: 0, ...Object.fromEntries(behaviorKeys.map((key) => [key, 0])), total: 0 }); return days.get(date); };
    for (const row of attendanceRows) {
      const date = String(row.date_str || ""), className = String(row.class_name || "");
      const day = getDay(date), records = row.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {};
      for (const [student, value] of Object.entries(records as Record<string, unknown>)) {
        const status = typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).status || "") : "";
        const allowedStatuses = classStatusSets.get(className) || ownStatusSet;
        if (!["absent", "late", "escape", "outside"].includes(status) || !allowedStatuses.has(status)) continue;
        if (status === "absent") {
          const dailyKey = [className, student, date].join("\u001f");
          if (countedDailyAbsences.has(dailyKey)) continue;
          countedDailyAbsences.add(dailyKey);
        }
        day[status]++;
        day.total++;
      }
    }
    for (const row of behaviorRows) {
      const date = String(row.date_str), className = String(row.class_name || "");
      const day = getDay(date), records = row.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {};
      for (const [student, value] of Object.entries(records as Record<string, unknown>)) {
        for (const behaviorType of behaviorTypesFromRecord(value)) {
          if (!behaviorKeys.includes(behaviorType)) continue;
          const dailyKey = [className, String(student), date, behaviorType].join("\u001f");
          if (countedDailyBehaviors.has(dailyKey)) continue;
          countedDailyBehaviors.add(dailyKey);
          day[behaviorType]++;
          day.behavior++;
          day.total++;
        }
      }
    }
    return reply(200, { scope, class_count: unique([...attendanceClasses, ...behaviorClasses]).length, series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), permissions: { role: permissions.role } });
  }
  if (body?.action === "supervision_team") {
    const permissions = await permissionsFor(p);
    if (hasFullAdministrativeAccess(p)) return reply(200, { team_name: "جميع المعلمين", teachers: permissions.teacher_directory || [] });
    if (permissions.role === "visitor") return reply(200, { team_name: "جميع معلمي شؤون الطلبة", teachers: permissions.teacher_directory || [] });
    if (permissions.role !== "team_leader") return reply(403, { error: "متابعة المعلمين متاحة لقائد الفريق والزائر فقط" });
    return reply(200, { team_name: permissions.team_name || "", teachers: permissions.team_members || [] });
  }
  if (body?.action === "get_permissions") {
    if (!hasFullAdministrativeAccess(p)) return reply(403, { error: "غير مصرح" });
    const [{ data: teachers }, { data: classes }, { data: perms }] = await Promise.all([
      db.from("teachers").select("name,role,permissions").order("name"),
      db.from("classes").select("name").order("name"),
      db.from("student_affairs_permissions").select("*")
    ]);
    return reply(200, { teachers: teachers || [], classes: classes || [], permissions: perms || [] });
  }
  if (body?.action === "remove_student_affairs_member") {
    if (!hasFullAdministrativeAccess(p)) return reply(403, { error: "حذف عضوية شؤون الطلبة متاح لمدير النظام فقط." });
    const type = String(body.principal_type || "");
    const name = String(body.principal_name || "").trim();
    if (type !== "teacher" || !name) return reply(400, { error: "بيانات المعلم المطلوب حذفه غير صالحة." });
    const { data: target, error: targetError } = await db.from("teachers").select("name,role,permissions").eq("name", name).maybeSingle();
    if (targetError) throw targetError;
    if (!target || target.role === "custom") return reply(404, { error: "المعلم غير موجود." });
    const current = target.permissions && typeof target.permissions === "object" ? target.permissions : {};
    const { data: assignment, error: assignmentError } = await db.from("student_affairs_permissions").select("principal_name").eq("principal_type", "teacher").eq("principal_name", name).maybeSingle();
    if (assignmentError) throw assignmentError;
    const isMember = current.studentAffairs === true || ["team_leader", "supervisor", "visitor"].includes(String(current.student_affairs_role || "")) || !!assignment;
    if (!isMember) return reply(404, { error: "هذا المعلم غير مضاف حالياً إلى شؤون الطلبة." });

    const { error: sessionError } = await db.from("student_affairs_sessions").delete().eq("principal_type", "teacher").eq("principal_name", name);
    if (sessionError) throw sessionError;

    const cleaned = { ...current, studentAffairs: false };
    ["student_affairs_role", "student_affairs_team_name", "supervisor_team_leader_name",
     "can_read_attendance", "can_read_behavior", "can_view_analytics",
     "can_print_attendance", "can_print_behavior", "can_print_combined",
     "competition_participant", "competition_team_name", "competition_team_classes"].forEach(key => delete cleaned[key]);

    const { data: updated, error: updateError } = await db.from("teachers").update({ permissions: cleaned }).eq("name", name).select("name").maybeSingle();
    if (updateError) throw updateError;
    if (!updated) throw new Error("تعذر إلغاء عضوية المعلم من سجل الحساب.");

    if (current.student_affairs_role === "team_leader") {
      const { data: linked, error: linkedError } = await db.from("teachers").select("name,permissions").neq("name", name);
      if (linkedError) throw linkedError;
      const linkedSupervisors = (linked || []).filter((item: any) => item.permissions?.student_affairs_role === "supervisor"
        && String(item.permissions?.supervisor_team_leader_name || "").trim() === name);
      for (const supervisor of linkedSupervisors) {
        const supervisorPermissions = { ...(supervisor.permissions || {}) };
        delete supervisorPermissions.supervisor_team_leader_name;
        const { error: detachError } = await db.from("teachers").update({ permissions: supervisorPermissions }).eq("name", supervisor.name);
        if (detachError) throw detachError;
      }
    }

    const { error: deleteError } = await db.from("student_affairs_permissions").delete().eq("principal_type", "teacher").eq("principal_name", name);
    if (deleteError) throw deleteError;
    return reply(200, { ok: true, principal_name: name, removed_from: "student_affairs" });
  }
  if (body?.action === "set_permissions") {
    if (!hasFullAdministrativeAccess(p)) return reply(403, { error: "غير مصرح" });
    const type = body.principal_type, name = String(body.principal_name || "").trim();
    if (!["teacher", "custom"].includes(type) || !name) return reply(400, { error: "المعلم غير صالح" });
    const { data: target } = await db.from("teachers").select("name,role,permissions").eq("name", name).maybeSingle();
    if (!target || (type === "custom" ? target.role !== "custom" : target.role === "custom")) return reply(404, { error: "المعلم غير موجود" });
    const supervisionRole = String(body.student_affairs_role ?? target.permissions?.student_affairs_role ?? "").trim();
    let supervisionTeam = String(body.student_affairs_team_name ?? target.permissions?.student_affairs_team_name ?? "").trim();
    let supervisionLeaderName = String(body.supervisor_team_leader_name ?? target.permissions?.supervisor_team_leader_name ?? "").trim();
    if (supervisionRole && (type === "custom" ? supervisionRole !== "visitor" : !["team_leader", "supervisor", "visitor"].includes(supervisionRole))) return reply(400, { error: "نوع الإشراف غير صالح لهذا الحساب" });
    if (supervisionRole === "visitor" && body.studentAffairs !== true) return reply(400, { error: "يجب تفعيل دخول شؤون الطلبة للزائر." });
    if (type === "teacher" && !supervisionRole && supervisionTeam) return reply(400, { error: "حدد نوع الإشراف قبل ربط المعلم بفريق" });
    if (type === "teacher" && supervisionRole === "team_leader" && !supervisionTeam) return reply(400, { error: "حدد اسم الفريق للقائد قبل حفظ العضوية." });
    if (type === "teacher" && supervisionRole === "supervisor") {
      const { data: leaders, error: leaderError } = await db.from("teachers").select("name,permissions").neq("name", target.name);
      if (leaderError) throw leaderError;
      const matchedLeader = (leaders || []).find((item: any) => item.name === supervisionLeaderName
        && item.permissions?.student_affairs_role === "team_leader"
        && String(item.permissions?.student_affairs_team_name || "").trim())
        || (!supervisionLeaderName && supervisionTeam ? (leaders || []).find((item: any) => item.permissions?.student_affairs_role === "team_leader"
          && String(item.permissions?.student_affairs_team_name || "").trim() === supervisionTeam) : null);
      if (!matchedLeader) return reply(400, { error: "اختر قائداً محفوظاً في النظام من القائمة قبل ربط المعلم المشرف." });
      supervisionLeaderName = String(matchedLeader.name);
      supervisionTeam = String(matchedLeader.permissions.student_affairs_team_name || "").trim();
    }
    if (type === "teacher" && supervisionRole !== "supervisor") supervisionLeaderName = "";
    if (type === "teacher" && supervisionRole === "visitor" && supervisionTeam) return reply(400, { error: "المعلم الزائر لا يُربط بفريق إشراف" });
    const legacyClasses: string[] = Array.isArray(body.allowed_classes) ? Array.from(new Set((body.allowed_classes as unknown[]).map(String))) : [];
    const attendanceClasses: string[] = Array.isArray(body.allowed_attendance_classes) ? Array.from(new Set((body.allowed_attendance_classes as unknown[]).map(String))) : legacyClasses;
    const behaviorClasses: string[] = Array.isArray(body.allowed_behavior_classes) ? Array.from(new Set((body.allowed_behavior_classes as unknown[]).map(String))) : legacyClasses;
    const allowed = Array.from(new Set([...attendanceClasses, ...behaviorClasses]));
    const statuses: string[] = Array.isArray(body.attendance_statuses) ? Array.from(new Set((body.attendance_statuses as unknown[]).map(String))) : ["absent", "late", "escape", "outside"];
    const validStatuses = new Set(["absent", "late", "escape", "outside"]);
    if (statuses.some((x: string) => !validStatuses.has(x))) return reply(400, { error: "توجد حالة غياب غير معتمدة" });
    const { data: classRows } = await db.from("classes").select("name");
    const valid = new Set((classRows || []).map((x: any) => x.name));
    if (allowed.some((x: string) => !valid.has(x))) return reply(400, { error: "توجد شعبة غير معتمدة" });
    if (body.competition_participant === true) {
      if (supervisionRole === "visitor") return reply(400, { error: "الزائر يملك صلاحية الاطلاع ولا يدخل في سباق التميز." });
      if (type !== "teacher") return reply(400, { error: "المشاركة في سباق التميز مخصصة لحسابات المعلمين." });
      const teamName = String(body.competition_team_name || "").trim();
      const teamClasses = Array.isArray(body.competition_team_classes)
        ? Array.from(new Set((body.competition_team_classes as unknown[]).map(value => String(value || "").trim()).filter(Boolean)))
        : [];
      if (!teamName) return reply(400, { error: "اكتب اسم الفريق قبل تفعيل المشاركة." });
      if (!teamClasses.length) return reply(400, { error: "حدد صفاً واحداً على الأقل للفريق." });
      if (teamClasses.some(className => !valid.has(className))) return reply(400, { error: "توجد صفوف غير معتمدة ضمن الفريق." });
      if (supervisionRole === "team_leader") {
        const outsidePersonalScope = findCompetitionClassesOutsidePersonalScope(teamClasses, allowed);
        if (outsidePersonalScope.length) return reply(400, { error: "صفوف قائد الفريق في سباق التميز يجب أن تكون من فصوله الشخصية فقط. الصف غير المسند إليه: " + outsidePersonalScope[0] });
      }
      const { data: participantRows, error: participantError } = await db.from("teachers").select("name,permissions").neq("name", target.name);
      if (participantError) throw participantError;
      const assigned = new Map<string, string>();
      for (const participant of participantRows || []) {
        const pp = participant.permissions || {};
        const stillInStudentAffairs = pp.studentAffairs === true
          || ["team_leader", "supervisor", "visitor"].includes(String(pp.student_affairs_role || ""));
        // Ignore legacy competition scopes left behind by a previously removed member.
        if (pp.competition_participant !== true || !stillInStudentAffairs) continue;
        for (const className of Array.isArray(pp.competition_team_classes) ? pp.competition_team_classes : []) assigned.set(String(className), String(participant.name));
      }
      const conflict = teamClasses.find(className => assigned.has(className));
      if (conflict) return reply(409, { error: "الصف " + conflict + " مسند بالفعل إلى فريق المعلم " + assigned.get(conflict) + "." });
    }
    const visitor = supervisionRole === "visitor";
    const row = { principal_type: type, principal_name: name, allowed_classes: visitor ? [] : allowed, allowed_attendance_classes: visitor ? [] : attendanceClasses, allowed_behavior_classes: visitor ? [] : behaviorClasses, attendance_statuses: visitor ? ["absent", "late", "escape", "outside"] : statuses, can_read_attendance: visitor || asBool(body.can_read_attendance), can_read_behavior: visitor || asBool(body.can_read_behavior), can_view_analytics: visitor || asBool(body.can_view_analytics), can_print_attendance: visitor || asBool(body.can_print_attendance), can_print_behavior: visitor || asBool(body.can_print_behavior), can_print_combined: visitor || asBool(body.can_print_combined), updated_at: new Date().toISOString() };
    const { error } = await db.from("student_affairs_permissions").upsert(row, { onConflict: "principal_type,principal_name" });
    if (error) throw error;
    if (typeof body.studentAffairs === "boolean" || typeof body.can_view_competition === "boolean") {
      const mergedPermissions = { ...(target.permissions || {}) };
      if (supervisionRole) {
        mergedPermissions.student_affairs_role = supervisionRole;
        mergedPermissions.student_affairs_team_name = supervisionRole === "visitor" ? "" : supervisionTeam;
        if (supervisionRole === "supervisor" && supervisionLeaderName) mergedPermissions.supervisor_team_leader_name = supervisionLeaderName;
        else delete mergedPermissions.supervisor_team_leader_name;
      } else {
        delete mergedPermissions.student_affairs_role;
        delete mergedPermissions.student_affairs_team_name;
        delete mergedPermissions.supervisor_team_leader_name;
      }
      if (visitor) {
        mergedPermissions.can_view_competition = true;
        mergedPermissions.competition_participant = false;
        mergedPermissions.competition_team_name = "";
        mergedPermissions.competition_team_classes = [];
      }
      if (typeof body.studentAffairs === "boolean") mergedPermissions.studentAffairs = body.studentAffairs;
      if (typeof body.can_view_competition === "boolean") mergedPermissions.can_view_competition = body.can_view_competition;
      if (typeof body.competition_participant === "boolean") {
        if (body.competition_participant && (type !== "teacher" || visitor)) return reply(400, { error: "المشاركة في سباق التميز مخصصة للمعلمين المشاركين فقط، وليست للزائر." });
        const { data: configuredClasses, error: configuredClassesError } = await db.from("classes").select("name");
        if (configuredClassesError) throw configuredClassesError;
        const validCompetitionClasses = new Set((configuredClasses || []).map((item: any) => String(item.name || "").trim()));
        const teamName = String(body.competition_team_name || "").trim();
        const teamClasses = Array.isArray(body.competition_team_classes)
          ? Array.from(new Set((body.competition_team_classes as unknown[]).map(value => String(value || "").trim()).filter(Boolean)))
          : [];
        if (body.competition_participant && !teamName) return reply(400, { error: "اكتب اسم الفريق قبل تفعيل المشاركة." });
        if (body.competition_participant && !teamClasses.length) return reply(400, { error: "حدد صفاً واحداً على الأقل للفريق." });
        if (teamClasses.some(className => !validCompetitionClasses.has(className))) return reply(400, { error: "توجد صفوف غير معتمدة ضمن الفريق." });
        if (body.competition_participant) {
          const { data: participantRows, error: participantError } = await db.from("teachers").select("name,permissions").neq("name", target.name);
          if (participantError) throw participantError;
          const assigned = new Map<string, string>();
          for (const participant of participantRows || []) {
            const pp = participant.permissions || {};
            const stillInStudentAffairs = pp.studentAffairs === true
              || ["team_leader", "supervisor", "visitor"].includes(String(pp.student_affairs_role || ""));
            // Ignore legacy competition scopes left behind by a previously removed member.
            if (pp.competition_participant !== true || !stillInStudentAffairs) continue;
            for (const className of Array.isArray(pp.competition_team_classes) ? pp.competition_team_classes : []) assigned.set(String(className), String(participant.name));
          }
          const conflict = teamClasses.find(className => assigned.has(className));
          if (conflict) return reply(409, { error: "الصف " + conflict + " مسند بالفعل إلى فريق المعلم " + assigned.get(conflict) + "." });
        }
        mergedPermissions.competition_participant = body.competition_participant;
        mergedPermissions.competition_team_name = body.competition_participant ? teamName : "";
        mergedPermissions.competition_team_classes = body.competition_participant ? teamClasses : [];
      }
      const { data: updatedTeacher, error: accessError } = await db
        .from("teachers")
        .update({ permissions: mergedPermissions })
        .eq("name", target.name)
        .select("name,permissions")
        .maybeSingle();
      if (accessError) throw accessError;
      if (!updatedTeacher) {
        throw new Error("تعذر حفظ صلاحية سباق التميز: لم يتم تحديث سجل المعلم.");
      }
      if (typeof body.can_view_competition === "boolean" &&
          updatedTeacher.permissions?.can_view_competition !== body.can_view_competition) {
        throw new Error("لم يتم تأكيد حفظ صلاحية مشاهدة سباق التميز في سجل المعلم.");
      }
      if (typeof body.competition_participant === "boolean" &&
          (updatedTeacher.permissions?.competition_participant !== body.competition_participant ||
           (body.competition_participant && updatedTeacher.permissions?.competition_team_name !== String(body.competition_team_name || "").trim()))) {
        throw new Error("لم يتم تأكيد حفظ إعدادات فريق سباق التميز.");
      }
    }
    const { error: revokeError } = await db.from("student_affairs_sessions").delete().eq("principal_type", type).eq("principal_name", name);
    if (revokeError) throw revokeError;
    return reply(200, { ok: true, permissions: row });
  }
  if (body?.action === "competition_settings") {
    const permissions = hasFullAdministrativeAccess(p) ? {} : await permissionsFor(p, true);
    if (!hasFullAdministrativeAccess(p) && permissions?.can_view_competition !== true) return reply(403, { error: "لا تملك صلاحية مشاهدة إعدادات البطولة." });
    const mode = String(body.mode || "read");
    if (mode === "save") {
      if (!hasFullAdministrativeAccess(p)) return reply(403, { error: "تعديل إعدادات البطولة متاح لمدير النظام فقط." });
      if (typeof body.showBothTerms !== "boolean") return reply(400, { error: "قيمة إتاحة نتائج الفصلين غير صالحة." });
      const { error } = await db.from("school_settings").upsert({
        key: "competition_visibility_mode",
        value: { version: 1, showBothTerms: body.showBothTerms }
      }, { onConflict: "key" });
      if (error) throw error;
    }
    const settings = await readCompetitionTermSettings();
    const visibleTerms = hasFullAdministrativeAccess(p) || settings.showBothTerms ? settings.terms : [settings.currentTerm];
    return reply(200, {
      terms: visibleTerms, currentTermId: settings.currentTerm.id,
      selectedTermId: settings.currentTerm.id, showBothTerms: settings.showBothTerms,
      canManage: hasFullAdministrativeAccess(p)
    });
  }
  if (body?.action === "competition") {
    const permissions = hasFullAdministrativeAccess(p) ? {} : await permissionsFor(p, true);
    if (!hasFullAdministrativeAccess(p) && permissions?.can_view_competition !== true) {
      return reply(403, { error: "لا تملك صلاحية مشاهدة لوحة سباق التميز." });
    }
    try {
      let snapshot: any;
      const period = String(body.period || "weekly");
      if (period === "weekly") snapshot = await getLatestWeeklyCompetition(p, permissions);
      else if (period === "term") snapshot = await buildTermCompetitionSnapshot(p, permissions, body.termId);
      else if (period === "monthly") {
        // Monthly results are always resolved server-side from the current Oman calendar month.
        // Ignore client-supplied dates so teachers never need to select or enter a period.
        const termSettings = await readCompetitionTermSettings();
        const range = getCompetitionMonthRange(getOmanIsoDate(), termSettings.currentTerm.start, termSettings.currentTerm.end);
        if (!range) {
          snapshot = projectCompetitionResponse({
            from: getOmanIsoDate().slice(0, 7) + "-01", to: getOmanIsoDate(),
            today: getOmanIsoDate(), period: "monthly", status: "not_started",
            teams: [], ownGrades: [], ownClasses: [], classComparison: [],
            dailyProgress: [], weeklyWins: {}, weeklyPoints: {}, weeklyHistory: [], completedWeeks: 0
          }, p, permissions);
        } else {
          const live = await buildCompetitionSnapshot(p, permissions, range.from, range.to, "monthly");
          snapshot = projectCompetitionResponse(live, p, permissions);
        }
      }
      else {
        let from = body.from, to = body.to;
        const termSettings = await readCompetitionTermSettings();
        if (!hasFullAdministrativeAccess(p) && !termSettings.showBothTerms) {
          if (!isValidIsoDate(from) || !isValidIsoDate(to)) return reply(400, { error: "نطاق تاريخ البطولة غير صالح." });
          if (from < termSettings.currentTerm.start) from = termSettings.currentTerm.start;
          if (to > termSettings.currentTerm.end) to = termSettings.currentTerm.end;
          if (from > to) return reply(400, { error: "الفترة المحددة تقع خارج الفصل الدراسي الحالي." });
        }
        const live = await buildCompetitionSnapshot(p, permissions, from, to, period);
        snapshot = projectCompetitionResponse(live, p, permissions);
      }
      return reply(200, snapshot);
    } catch (e) {
      const status = Number((e as any)?.status) || 500;
      const message = status < 500 && e instanceof Error ? e.message : "تعذر إعداد نتائج المنافسة حالياً.";
      return reply(status, { error: message });
    }
  }
  if (body?.action === "reports") {
    let permissions = await permissionsFor(p, false, adminRecordsCenterAccess);
    const targetName = String(body.supervision_teacher_name || "").trim();
    if (targetName) {
      const target = resolveSupervisionTeacher(permissions.role === "admin" ? "visitor" : permissions.role, targetName, permissions.team_members || [], permissions.teacher_directory || []);
      if (!target) return reply(403, { error: "لا تملك صلاحية الاطلاع على تقارير هذا المعلم." });
      permissions = projectSupervisionReportPermissions(permissions, target, permissions.role === "visitor" || permissions.role === "admin");
      permissions = applyTeamLeaderNoticePrintAccess(permissions, permissions.role, target, String(body.report_mode || "view"));
    }
    const allowedAttendance = new Set((permissions.allowed_attendance_classes || []) as string[]);
    const allowedBehavior = new Set((permissions.allowed_behavior_classes || []) as string[]);
    const legacyRequested = Array.isArray(body.classes) ? Array.from(new Set((body.classes as unknown[]).map(String))) : null;
    const requestedAttendance: string[] = Array.isArray(body.attendance_classes)
      ? Array.from(new Set((body.attendance_classes as unknown[]).map(String)))
      : legacyRequested || (permissions.can_read_attendance === true ? [...allowedAttendance] : []);
    const requestedBehavior: string[] = Array.isArray(body.behavior_classes)
      ? Array.from(new Set((body.behavior_classes as unknown[]).map(String)))
      : legacyRequested || (permissions.can_read_behavior === true ? [...allowedBehavior] : []);
    if (!areClassesAllowed(requestedAttendance, [...allowedAttendance])) return reply(403, { error: "لا تملك صلاحية الاطلاع على إحدى شعب الغياب المطلوبة" });
    if (!areClassesAllowed(requestedBehavior, [...allowedBehavior])) return reply(403, { error: "لا تملك صلاحية الاطلاع على إحدى شعب السلوك المطلوبة" });
    const mode = body.report_mode || "view";
    if (adminRecordsCenterAccess && mode === "notice_issue_commit") return reply(403, { error: "صلاحية القسم الإداري تتيح عرض التقارير وطباعتها، ولا تمنح صلاحية اعتماد إصدار تنبيهات رسمية جديدة." });
    if (mode === "activity_event") {
      const eventType = String(body.activity_type || "");
      if (eventType === "module_access") {
        if (!hasFullAdministrativeAccess(p) && !(await hasStudentAffairsAccess(p))) return reply(403, { error: "غير مصرح بتسجيل دخول شؤون الطلبة." });
        if (!activitySessionHash) return reply(401, { error: "تعذر تحديد جلسة تسجيل الدخول لتوثيق النشاط." });
        const { error } = await db.from("student_affairs_activity_events").upsert({
          event_type: "module_access", actor_type: p.type, actor_name: p.name,
          session_hash: activitySessionHash,
          metadata: { source: "student_affairs_module", audit_version: 3 }
        }, { onConflict: "session_hash,event_type", ignoreDuplicates: true });
        if (error) throw error;
        return reply(200, { ok: true });
      }
      if (eventType === "formal_warning_print") {
        if (permissions.can_print_attendance !== true && permissions.can_print_behavior !== true) return reply(403, { error: "لا تملك صلاحية طباعة الإنذارات الرسمية." });
        const { data: recentIssues, error: issueReadError } = await db.from("student_affairs_notice_issues")
          .select("id,issued_at").eq("issued_by_name", p.name)
          .order("issued_at", { ascending: false }).limit(1000);
        if (issueReadError) throw issueReadError;
        const latestIssueAt = recentIssues?.[0]?.issued_at;
        const batchRows = latestIssueAt ? (recentIssues || []).filter((row: any) => row.issued_at === latestIssueAt) : [];
        if (!batchRows.length) return reply(409, { error: "لا يوجد إصدار رسمي حديث مرتبط بحسابك لتسجيل طباعته." });
        if (!activitySessionHash) return reply(401, { error: "تعذر تحديد جلسة تسجيل الدخول لتوثيق الطباعة." });
        const { error } = await db.from("student_affairs_activity_events").upsert({
          event_type: "formal_warning_print", actor_type: p.type, actor_name: p.name,
          session_hash: activitySessionHash,
          metadata: {
            // One official warning action is one event, irrespective of students, violations, or pages.
            warning_count: 1, notice_count: batchRows.length, notice_ids: batchRows.map((row: any) => row.id),
            issue_timestamp: latestIssueAt, source: "official_notice_print", audit_version: 3
          }
        }, { onConflict: "session_hash,event_type", ignoreDuplicates: true });
        if (error) throw error;
        return reply(200, { ok: true, warning_count: 1, notice_count: batchRows.length });
      }
      return reply(400, { error: "نوع سجل النشاط غير صالح." });
    }
    const authorizationError = authorizeReportMode(permissions, mode);
    if (authorizationError) return reply(authorizationError.status, { error: authorizationError.message });
    const from = body.from == null ? "2000-01-01" : body.from;
    const to = body.to == null ? "2100-12-31" : body.to;
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) return reply(400, { error: "نطاق التاريخ غير صالح" });
    const statusAllow = new Set((permissions.attendance_statuses || []) as string[]);
    if (mode === "notice_history") {
      const noticeClasses = Array.isArray(body.notice_classes) ? Array.from(new Set((body.notice_classes as unknown[]).map(String))) : [];
      const allowedNoticeClasses = [...new Set([...(permissions.allowed_attendance_classes || []), ...(permissions.allowed_behavior_classes || [])])];
      if (!noticeClasses.length || !areClassesAllowed(noticeClasses, allowedNoticeClasses)) return reply(403, { error: "لا تملك صلاحية الاطلاع على سجل التنبيهات في الصف المحدد." });
      const studentName = String(body.student_name || "").trim();
      let requestedStudentNames: string[] | null = null;
      if (body.student_names !== undefined && body.student_names !== null) {
        if (!Array.isArray(body.student_names) || !body.student_names.length || body.student_names.length > 1000 ||
            body.student_names.some((name: unknown) => typeof name !== "string" || !name.trim()) || studentName) {
          return reply(400, { error: "قائمة أسماء الطلاب المطلوبة لسجل التنبيهات غير صالحة." });
        }
        requestedStudentNames = Array.from(new Set((body.student_names as string[]).map(name => name.trim())));
      }
      let noticeQuery: any = db.from("student_affairs_notice_issues")
        .select("id,class_name,student_name,issue_number,issued_on,issued_at,issued_by_type,issued_by_name,delivered,delivered_at,threshold,period_start,period_end,selected_types,events")
        .in("class_name", noticeClasses).lte("issued_on", to);
      if (requestedStudentNames) noticeQuery = noticeQuery.in("student_name", requestedStudentNames);
      else if (studentName) noticeQuery = noticeQuery.eq("student_name", studentName);
      const { data, error } = await noticeQuery.order("issued_at", { ascending: true }).limit(10000);
      if (error) return reply(500, { error: "تعذر تحميل سجل التنبيهات الرسمي." });
      if ((data || []).length >= 10000) return reply(413, { error: "سجل التنبيهات كبير جداً للعرض دفعة واحدة. حدد طالباً أو صفاً واحداً." });
      const rows = filterNoticeHistoryRows(data || [], studentName, requestedStudentNames).map((row: any) => ({
        ...row,
        events: (Array.isArray(row.events) ? row.events : []).filter((event: any) => {
          const type = String(event?.type || "");
          if ((NOTICE_ATTENDANCE_TYPES as readonly string[]).includes(type)) return permissions.can_read_attendance === true && (permissions.allowed_attendance_classes || []).includes(String(row.class_name || ""));
          if ((NOTICE_BEHAVIOR_TYPES as readonly string[]).includes(type)) return permissions.can_read_behavior === true && (permissions.allowed_behavior_classes || []).includes(String(row.class_name || ""));
          return false;
        })
      }));
      return reply(200, { notices: rows, permissions });
    }
    if (mode === "notice_issue_commit") {
      const issuedOn = body.issued_on;
      const rangeFrom = body.range_from == null ? "2000-01-01" : String(body.range_from);
      const rangeTo = body.range_to == null ? issuedOn : String(body.range_to);
      const threshold = Number(body.threshold);
      const selectedTypes = Array.isArray(body.selected_types) ? Array.from(new Set((body.selected_types as unknown[]).map(String))) : [];
      if (!isValidIsoDate(issuedOn) || issuedOn > new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10)) return reply(400, { error: "تاريخ الإصدار غير صالح." });
      if (!isValidIsoDate(rangeFrom) || !isValidIsoDate(rangeTo) || rangeFrom > rangeTo || rangeTo > issuedOn) return reply(400, { error: "فترة المخالفات غير صالحة. يجب أن تكون البداية قبل النهاية، وألا تتجاوز النهاية تاريخ الإصدار." });
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) return reply(400, { error: "حد المخالفات يجب أن يكون من 1 إلى 10." });
      if (!selectedTypes.length || selectedTypes.some(type => !(NOTICE_TYPES as readonly string[]).includes(type))) return reply(400, { error: "أنواع المخالفات المحددة غير صالحة." });
      const useAttendance = selectedTypes.some(type => (NOTICE_ATTENDANCE_TYPES as readonly string[]).includes(type));
      const useBehavior = selectedTypes.some(type => (NOTICE_BEHAVIOR_TYPES as readonly string[]).includes(type));
      if (useAttendance && (permissions.can_read_attendance !== true || permissions.can_print_attendance !== true || selectedTypes.some(type => (NOTICE_ATTENDANCE_TYPES as readonly string[]).includes(type) && !statusAllow.has(type)))) return reply(403, { error: "غير مصرح بإصدار تنبيهات عن إحدى حالات الحضور المحددة." });
      if (useBehavior && (permissions.can_read_behavior !== true || permissions.can_print_behavior !== true)) return reply(403, { error: "غير مصرح بإصدار تنبيهات عن السلوكيات المحددة." });
      const attendanceClasses = useAttendance && Array.isArray(body.attendance_classes) ? Array.from(new Set((body.attendance_classes as unknown[]).map(String))) : [];
      const behaviorClasses = useBehavior && Array.isArray(body.behavior_classes) ? Array.from(new Set((body.behavior_classes as unknown[]).map(String))) : [];
      if (useAttendance && (!attendanceClasses.length || !areClassesAllowed(attendanceClasses, [...allowedAttendance]))) return reply(403, { error: "توجد صفوف حضور خارج نطاق صلاحياتك." });
      if (useBehavior && (!behaviorClasses.length || !areClassesAllowed(behaviorClasses, [...allowedBehavior]))) return reply(403, { error: "توجد صفوف سلوك خارج نطاق صلاحياتك." });
      const noticeClasses = [...new Set([...attendanceClasses, ...behaviorClasses])];
      if (!noticeClasses.length) return reply(400, { error: "حدد صفاً واحداً على الأقل." });
      const firstYear = Number(rangeFrom.slice(0, 4)), lastYear = Number(rangeTo.slice(0, 4));
      const yearJobs = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => {
        const year = firstYear + index;
        return {
          year,
          from: year === firstYear ? rangeFrom : year + "-01-01",
          to: year === lastYear ? rangeTo : year + "-12-31",
        };
      });
      const attendanceRows: any[] = [], behaviorRows: any[] = [], loadErrors: Error[] = [];
      let yearCursor = 0;
      const loadYearWorker = async () => {
        while (yearCursor < yearJobs.length) {
          const job = yearJobs[yearCursor++];
          try {
            const [a, b] = await Promise.all([
              fetchNoticeRowsForClasses(db, "attendance", attendanceClasses, job.from, job.to, job.year),
              fetchNoticeRowsForClasses(db, "behaviors", behaviorClasses, job.from, job.to, job.year),
            ]);
            attendanceRows.push(...a);
            behaviorRows.push(...b);
          } catch (error) { loadErrors.push(error instanceof Error ? error : new Error("تعذر قراءة السجلات.")); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, yearJobs.length) }, () => loadYearWorker()));
      if (loadErrors.length) return reply(500, { error: loadErrors[0].message });
      const { data: historyRows, error: historyError } = await db.from("student_affairs_notice_issues").select("class_name,student_name,issue_number,issued_on,events").in("class_name", noticeClasses).lte("issued_on", issuedOn).order("issued_at", { ascending: true }).limit(10000);
      if (historyError) return reply(500, { error: "تعذر تحميل سجل التنبيهات للتحقق من الإصدار." });
      if ((historyRows || []).length >= 10000) return reply(413, { error: "سجل التنبيهات تجاوز الحد الآمن للتحقق. لم يتم إصدار أي تنبيه." });
      const candidates = buildNoticeCandidates({
        attendance: attendanceRows, behaviors: behaviorRows, history: historyRows || [], roster: [],
        selected_types: selectedTypes, threshold, period_end: rangeTo
      });
      if (!candidates.length) return reply(200, { issued: [], candidates: [], message: "لا يوجد طالب تجاوز الحد المحدد خلال الفترة الجديدة." });
      const delivered = body.delivered === true;
      const payload = candidates.map(candidate => ({
        class_name: candidate.class_name, student_name: candidate.student_name, issued_on: issuedOn,
        issued_by_type: p.type, issued_by_name: p.name, delivered, threshold,
        period_start: rangeFrom, period_end: rangeTo, selected_types: selectedTypes, events: candidate.events
      }));
      if (payload.length > 1000) return reply(413, { error: "عدد التنبيهات في الدفعة يتجاوز الحد الآمن. لم يتم اعتماد أي تنبيه." });
      if (!payload.length) return reply(200, { issued: [], candidates: [], message: "لم يتبقَّ تنبيه جديد بعد إعادة التحقق الذرية. ربما اعتمد مستخدم آخر التنبيه نفسه، أو لم تعد المخالفات الجديدة تبلغ الحد." });
      for (let index = 0; index < payload.length; index++) {
        const validationError = validateNoticeIssueItem(payload[index]);
        if (validationError) return reply(400, { error: "تعذر اعتماد التنبيه رقم " + (index + 1) + ": " + validationError });
      }
      const { data: issued, error: issueError } = await db.rpc("issue_student_affairs_notices", { p_items: payload });
      if (issueError) return reply(500, { error: "تعذر حفظ التنبيهات الرسمية. لم نعرضها على أنها معتمدة." });
      const issuedRows = Array.isArray(issued) ? issued : [];
      if (!issuedRows.length) return reply(200, { issued: [], candidates: [], message: "لم يتبقَّ تنبيه جديد بعد إعادة التحقق الذرية. ربما اعتمد مستخدم آخر التنبيه نفسه، أو لم تعد المخالفات الجديدة تبلغ الحد." });
      const { error: activityError } = await db.from("student_affairs_activity_events").insert({
        event_type: "formal_warning_issued", actor_type: p.type, actor_name: p.name,
        metadata: { warning_count: issuedRows.length, source: "official_notice_issue_commit" }
      });
      if (activityError) console.error("Official warning activity audit insert failed:", activityError);
      return reply(200, { issued: issuedRows, candidates, message: "تم اعتماد التنبيهات الرسمية وحفظ سجلها.", activity_logged: !activityError });
    }
    if (body.attendance_status_filters != null && !Array.isArray(body.attendance_status_filters)) return reply(400, { error: "قائمة حالات الغياب غير صالحة" });
    const requestedStatuses = body.attendance_status_filters == null
      ? (body.attendance_status_filter == null ? null : [String(body.attendance_status_filter)])
      : Array.from(new Set((body.attendance_status_filters as unknown[]).map(String)));
    if (requestedStatuses && requestedStatuses.some((status: string) => !statusAllow.has(status))) return reply(403, { error: "غير مصرح بعرض إحدى حالات الغياب المطلوبة" });
    if (mode === "analytics") {
      const classes = Array.from(new Set([...requestedAttendance, ...requestedBehavior]));
      if (!classes.length) return reply(200, { attendance: [], behaviors: [], students: [], analytics: {}, permissions });
      const attendanceClasses = classes.filter(className => allowedAttendance.has(className));
      const behaviorClasses = classes.filter(className => allowedBehavior.has(className));
      let batch: Awaited<ReturnType<typeof fetchAnalyticsBatch>>;
      try {
        batch = await fetchAnalyticsBatch(
          db,
          attendanceClasses,
          behaviorClasses,
          body.from || "2000-01-01",
          body.to || "2100-12-31",
        );
      } catch {
        return reply(500, { error: "تعذر تحميل التحليلات" });
      }
      const analytics: Record<string, unknown> = {};
      for (const className of classes) {
        const statusCounts: Record<string, number> = { absent: 0, late: 0, escape: 0, outside: 0 };
        const countedDailyAbsences = new Set<string>();
        for (const session of (batch.attendanceRowsByClass.get(className) || [])) {
          const date = String(session.date_str || ""), records = session.records && typeof session.records === "object" && !Array.isArray(session.records) ? session.records : {};
          for (const [student, value] of Object.entries(records as Record<string, unknown>)) {
            const status = typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).status || "") : "";
            if (!Object.prototype.hasOwnProperty.call(statusCounts, status) || !statusAllow.has(status) || (requestedStatuses && !requestedStatuses.includes(status))) continue;
            if (status === "absent") {
              const dailyKey = [className, student, date].join("\u001f");
              if (countedDailyAbsences.has(dailyKey)) continue;
              countedDailyAbsences.add(dailyKey);
            }
            statusCounts[status]++;
          }
        }
        const selectedAttendanceRecords = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
        analytics[className] = {
          attendance_sessions: batch.attendanceSessionsByClass.get(className) || 0,
          selected_attendance_records: selectedAttendanceRecords,
          attendance_status_counts: statusCounts,
          behavior_sessions: batch.behaviorSessionsByClass.get(className) || 0,
        };
      }
      return reply(200, { attendance: [], behaviors: [], students: [], analytics, permissions });
    }
    const wantsAttendance = mode === "notice_scan" ? requestedAttendance.length > 0 : mode === "view" || mode === "print_attendance" || mode === "print_combined";
    const wantsBehavior = mode === "notice_scan" ? requestedBehavior.length > 0 : mode === "view" || mode === "print_behavior" || mode === "print_combined";
    if (wantsAttendance && requestedAttendance.length && (permissions.can_read_attendance !== true || (mode === "notice_scan" && permissions.can_print_attendance !== true))) return reply(403, { error: "غير مصرح بفحص سجلات الغياب المحددة" });
    if (wantsBehavior && requestedBehavior.length && (permissions.can_read_behavior !== true || (mode === "notice_scan" && permissions.can_print_behavior !== true))) return reply(403, { error: "غير مصرح بفحص سجلات السلوك المحددة" });
    const filterAttendance = (rows: any[]) => {
      const filtered = (rows || []).map(row => ({ ...row, records: filterAttendanceRecordMap(row.records, [...statusAllow], requestedStatuses) }))
        .filter(row => Object.keys(row.records).length > 0);
      // Student Affairs presents daily absence once only: keep the absent mark
      // in the earliest lesson of that class/date and hide repeated marks in
      // later lessons. This is a response-only projection; stored attendance
      // records and all other application sections remain unchanged.
      const seenDailyAbsences = new Set<string>();
      const periodOrder = (value: unknown) => {
        const match = String(value ?? "").match(/\d+/);
        return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
      };
      const ordered = [...filtered].sort((a, b) =>
        String(b.date_str || "").localeCompare(String(a.date_str || "")) ||
        String(a.class_name || "").localeCompare(String(b.class_name || "")) ||
        periodOrder(a.period) - periodOrder(b.period) ||
        String(a.record_key || "").localeCompare(String(b.record_key || ""))
      );
      return ordered.map(row => {
        const records = { ...row.records };
        for (const [student, value] of Object.entries(records)) {
          const status = typeof value === "string" ? value
            : value && typeof value === "object" ? String((value as Record<string, unknown>).status || "") : "";
          if (status !== "absent") continue;
          const dailyKey = [String(row.class_name || ""), String(student), String(row.date_str || "")].join("\u001f");
          if (seenDailyAbsences.has(dailyKey)) delete records[student];
          else seenDailyAbsences.add(dailyKey);
        }
        return { ...row, records };
      }).filter(row => Object.keys(row.records).length > 0);
    };
    const filterBehavior = (rows: any[]) => (rows || []).map(row => ({ ...row, records: filterBehaviorRecordMap(row.records) })).filter(row => Object.keys(row.records).length > 0);
    const [attendance, behaviors] = await Promise.all([
      wantsAttendance && permissions.can_read_attendance && requestedAttendance.length
        ? db.from("attendance").select("record_key,date_str,class_name,period,teacher_name,records").in("class_name", requestedAttendance).gte("date_str", from).lte("date_str", to).order("date_str", { ascending: false }).limit(5000)
        : Promise.resolve({ data: [], error: null } as any),
      wantsBehavior && permissions.can_read_behavior && requestedBehavior.length
        ? db.from("behaviors").select("record_key,date_str,class_name,period,teacher_name,records").in("class_name", requestedBehavior).gte("date_str", from).lte("date_str", to).order("date_str", { ascending: false }).limit(5000)
        : Promise.resolve({ data: [], error: null } as any)
    ]);
    if (attendance.error || behaviors.error) return reply(500, { error: "تعذر تحميل التقارير" });
    if (mode === "view") {
      const hasAttendanceView = wantsAttendance && requestedAttendance.length > 0;
      const hasBehaviorView = wantsBehavior && requestedBehavior.length > 0;
      const activityRows: any[] = [];
      const auditMetadata = { from, to, attendance_classes_count: requestedAttendance.length, behavior_classes_count: requestedBehavior.length };
      if (hasAttendanceView && hasBehaviorView) {
        // A combined report selection is one distinct action, not two independent report views.
        activityRows.push({ event_type: "combined_report_view", actor_type: p.type, actor_name: p.name, session_hash: activitySessionHash, metadata: { ...auditMetadata, source: "combined_report_selection", audit_version: 3 } });
      } else if (hasAttendanceView) {
        activityRows.push({ event_type: "absence_report_view", actor_type: p.type, actor_name: p.name, session_hash: activitySessionHash, metadata: { ...auditMetadata, source: "absence_report_selection", audit_version: 3 } });
      } else if (hasBehaviorView) {
        activityRows.push({ event_type: "behavior_report_view", actor_type: p.type, actor_name: p.name, session_hash: activitySessionHash, metadata: { ...auditMetadata, source: "behavior_report_selection", audit_version: 3 } });
      }
      if (activityRows.length) {
        if (!activitySessionHash) return reply(401, { error: "تعذر تحديد جلسة تسجيل الدخول لتوثيق الاطلاع." });
        const { error: activityError } = await db.from("student_affairs_activity_events")
          .upsert(activityRows, { onConflict: "session_hash,event_type", ignoreDuplicates: true });
        if (activityError) {
          console.error("Student Affairs report-view audit upsert failed:", activityError);
          return reply(500, { error: "تعذر توثيق عملية الاطلاع؛ لم يتم اعتماد عرض التقرير. حاول مرة أخرى." });
        }
      }
    }
    return reply(200, { attendance: filterAttendance(attendance.data || []), behaviors: filterBehavior(behaviors.data || []), students: [], analytics: {}, permissions });
  }
  return reply(400, { error: "Unknown action" });
}
Deno.serve(async (req: Request) => {
  try { return await handle(req); }
  catch (e) { console.error("Student affairs request failed:", e); return reply(500, { error: "حدث خطأ داخلي. حاول لاحقاً." }); }
});
