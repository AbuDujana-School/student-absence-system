import { authorizeReportMode, isValidIsoDate, filterAttendanceRecordMap, filterBehaviorRecordMap, behaviorTypesFromRecord, areClassesAllowed } from "./report_policy.ts";
import { awardWeeklyCompetitionPoints, rankCompetitionTeamsByAccumulatedPoints, buildTeamRates, calculateRelativeCompetitionScores, getSchoolDays, getSchoolWeekRange } from "./competition_policy.ts";
import { buildCompetitionTeams, projectCompetitionTeam } from "./competition_team_policy.ts";
import { projectCompetitionClassComparison } from "./competition_response_policy.ts";
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
async function verifyExistingPin(pin: string, salt: string, expected: string) {
  if (!salt || !expected) return false;
  const legacy = await getLegacyPeppers();
  const modern = await pbkdf2(legacy.pbkdf2 + ":" + salt + ":" + pin, salt, PIN_ITERATIONS);
  if (equalHex(modern, expected)) return true;
  return equalHex(await sha256(legacy.sha256 + ":" + salt + ":" + pin), expected);
}
function validPin(pin: unknown): pin is string { return typeof pin === "string" && /^[0-9]{4,10}$/.test(pin); }
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
type Principal = { type: "admin" | "teacher" | "custom"; name: string; hash: string; salt: string };
async function findPrincipal(pin: string, pepper: string): Promise<Principal | null> {
  const candidates: Principal[] = [];
  const { data: adminSetting } = await db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle();
  const adminRecord = adminSetting?.value;
  if (adminRecord?.hash && adminRecord?.salt) candidates.push({ type: "admin", name: "مدير النظام العام", hash: adminRecord.hash, salt: adminRecord.salt });
  const { data: users, error } = await db.from("teachers").select("name,role,pin_hash,pin_salt");
  if (error) throw error;
  for (const u of (users || []).filter((x: any) => x.role === "custom")) if (u.pin_hash && u.pin_salt) candidates.push({ type: "custom", name: u.name, hash: u.pin_hash, salt: u.pin_salt });
  for (const u of (users || []).filter((x: any) => x.role !== "custom")) if (u.pin_hash && u.pin_salt) candidates.push({ type: "teacher", name: u.name, hash: u.pin_hash, salt: u.pin_salt });
  const { data: upgraded } = await db.from("student_affairs_credentials").select("principal_type,principal_name,pin_salt,pin_hash,source_hash,source_salt");
  const secureMap = new Map((upgraded || []).map((x: any) => [x.principal_type + "|" + x.principal_name, x]));
  for (const p of candidates) {
    const stored = secureMap.get(p.type + "|" + p.name) as any;
    if (stored && stored.source_hash === p.hash && stored.source_salt === p.salt) {
      if (await verifyNewPin(pin, stored.pin_salt, stored.pin_hash, pepper)) return p;
    } else if (await verifyExistingPin(pin, p.salt, p.hash)) {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await pbkdf2(pepper + ":" + salt + ":" + pin, salt, 310000);
      const { error: saveError } = await db.from("student_affairs_credentials").upsert({ principal_type: p.type, principal_name: p.name, pin_salt: salt, pin_hash: hash, source_hash: p.hash, source_salt: p.salt, updated_at: new Date().toISOString() }, { onConflict: "principal_type,principal_name" });
      if (saveError) throw saveError;
      return p;
    }
  }
  return null;
}
async function permissionsFor(p: { type: string; name: string }, strictCompetition = false) {
  if (p.type === "admin") {
    const { data: classes } = await db.from("classes").select("name");
    const all = (classes || []).map((x: any) => x.name);
    return { role: "admin", own_allowed_attendance_classes: all, own_allowed_behavior_classes: all, team_allowed_attendance_classes: all, team_allowed_behavior_classes: all, team_members: [], allowed_classes: all, allowed_attendance_classes: all, allowed_behavior_classes: all, attendance_statuses: ["absent", "late", "escape", "outside"], can_read_attendance: true, can_read_behavior: true, can_view_analytics: true, can_view_competition: true, can_print_attendance: true, can_print_behavior: true, can_print_combined: true };
  }
  const [{ data }, { data: teacher }] = await Promise.all([
    db.from("student_affairs_permissions").select("*").eq("principal_type", p.type).eq("principal_name", p.name).maybeSingle(),
    db.from("teachers").select("permissions").eq("name", p.name).maybeSingle()
  ]);
  const legacy = Array.isArray(data?.allowed_classes) ? data.allowed_classes : [];
  const ownAttendance = Array.isArray(data?.allowed_attendance_classes) ? data.allowed_attendance_classes : legacy;
  const ownBehavior = Array.isArray(data?.allowed_behavior_classes) ? data.allowed_behavior_classes : legacy;
  const tp = teacher?.permissions && typeof teacher.permissions === "object" ? teacher.permissions : {};
  const role = ["team_leader", "supervisor", "visitor"].includes(String(tp.student_affairs_role || "")) ? String(tp.student_affairs_role) : "unassigned";
  const teamName = String(tp.student_affairs_team_name || "").trim();
  let teamMembers: any[] = [], teamAttendance: string[] = [], teamBehavior: string[] = [];
  if (role === "team_leader" && teamName) {
    const [{ data: teachers }, { data: permissionRows }] = await Promise.all([
      db.from("teachers").select("name,permissions").neq("role", "custom"),
      db.from("student_affairs_permissions").select("principal_name,allowed_classes,allowed_attendance_classes,allowed_behavior_classes").eq("principal_type", "teacher")
    ]);
    const byName = new Map((permissionRows || []).map((row: any) => [String(row.principal_name), row]));
    teamMembers = (teachers || []).filter((item: any) => item.name !== p.name && item.permissions?.student_affairs_role === "supervisor"
      && String(item.permissions?.student_affairs_team_name || "").trim() === teamName && item.permissions?.studentAffairs === true).map((item: any) => {
        const row: any = byName.get(String(item.name)) || {};
        const legacyClasses = Array.isArray(row.allowed_classes) ? row.allowed_classes : [];
        const attendance = Array.isArray(row.allowed_attendance_classes) ? row.allowed_attendance_classes : legacyClasses;
        const behavior = Array.isArray(row.allowed_behavior_classes) ? row.allowed_behavior_classes : legacyClasses;
        teamAttendance.push(...attendance); teamBehavior.push(...behavior);
        return { name: String(item.name), allowed_attendance_classes: attendance, allowed_behavior_classes: behavior, attendance_statuses: Array.isArray(row.attendance_statuses) ? row.attendance_statuses : ["absent", "late", "escape", "outside"] };
      });
  }
  const unique = (items: string[]) => [...new Set(items.map(String).filter(Boolean))];
  const ownAttendanceUnique = unique(ownAttendance), ownBehaviorUnique = unique(ownBehavior);
  const teamAttendanceUnique = unique(teamAttendance), teamBehaviorUnique = unique(teamBehavior);
  const visitor = role === "visitor";
  return {
    ...(data || {}), role, team_name: teamName, team_members: teamMembers,
    own_allowed_attendance_classes: ownAttendanceUnique, own_allowed_behavior_classes: ownBehaviorUnique,
    team_allowed_attendance_classes: teamAttendanceUnique, team_allowed_behavior_classes: teamBehaviorUnique,
    // Standard reports and sheets are restricted to personal assignments. Team data is only available
    // through the dedicated supervision endpoints below.
    allowed_classes: unique([...ownAttendanceUnique, ...ownBehaviorUnique]), allowed_attendance_classes: ownAttendanceUnique, allowed_behavior_classes: ownBehaviorUnique,
    attendance_statuses: Array.isArray(data?.attendance_statuses) ? data.attendance_statuses : (strictCompetition ? [] : ["absent", "late", "escape", "outside"]),
    can_read_attendance: !visitor && data?.can_read_attendance === true, can_read_behavior: !visitor && data?.can_read_behavior === true,
    can_view_analytics: data?.can_view_analytics === true,
    can_view_competition: teacher?.permissions?.can_view_competition === true,
    competition_participant: teacher?.permissions?.competition_participant === true,
    competition_team_name: typeof teacher?.permissions?.competition_team_name === "string" ? teacher.permissions.competition_team_name : "",
    competition_team_classes: Array.isArray(teacher?.permissions?.competition_team_classes) ? teacher.permissions.competition_team_classes : [],
    can_print_attendance: !visitor && data?.can_print_attendance === true, can_print_behavior: !visitor && data?.can_print_behavior === true,
    can_print_combined: !visitor && data?.can_print_combined === true
  };
}
async function hasStudentAffairsAccess(p: { type: string; name: string }) {
  if (p.type === "admin") return true;
  const { data, error } = await db.from("teachers").select("role,permissions").eq("name", p.name).maybeSingle();
  if (error || !data) return false;
  const expectedRole = p.type === "custom" ? "custom" : "teacher";
  return (expectedRole === "custom" ? data.role === "custom" : data.role !== "custom")
    && (data.permissions?.studentAffairs === true || data.permissions?.admin === true);
}
async function getSession(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const tokenHash = await sha256(token);
  const { data } = await db.from("student_affairs_sessions").select("*").eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!data) return null;
  return { tokenHash, principal: { type: data.principal_type, name: data.principal_name } };
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
  const isAdmin = principal.type === "admin";
  const sourceTeams = Array.isArray(snapshot?.teams) ? snapshot.teams : [];
  const rawClasses = Array.isArray(snapshot?.classComparison) ? snapshot.classComparison : [];
  const ownClassNames = new Set<string>((Array.isArray(permissions?.competition_team_classes) ? permissions.competition_team_classes : []).map((name: unknown) => String(name)));
  const ownTeams = isAdmin ? [] : permissions?.competition_participant === true
    ? sourceTeams.filter((team: any) => String(team.teamId || "") === principal.name || String(team.leaderName || "") === principal.name)
    : [];
  const ownTeamIds = new Set<string>(ownTeams.map((team: any) => String(team.teamId || "")));
  const ownClassRows = rawClasses.filter((item: any) => ownTeamIds.has(String(item.teamId || "")) && ownClassNames.has(String(item.className || "")));
  const average = (rows: any[], key: string) => {
    const values = rows.map((item: any) => Number(item[key])).filter((value: number) => Number.isFinite(value));
    return values.length ? values.reduce((sum: number, value: number) => sum + value, 0) / values.length : null;
  };
  const sum = (rows: any[], key: string) => rows.reduce((total: number, item: any) => total + (Number(item[key]) || 0), 0);
  const teams = sourceTeams.map((team: any) => {
    const isOwn = ownTeamIds.has(String(team.teamId || ""));
    const projected: any = {
      teamId: team.teamId, teamName: team.teamName, leaderName: team.leaderName,
      classNames: isOwn ? Array.from(ownClassNames) : (Array.isArray(team.classNames) ? team.classNames : []),
      grade: team.grade, score: team.score, rank: team.rank,
      attendancePoints: team.attendancePoints, behaviorPoints: team.behaviorPoints,
      weeklyAwardPoints: team.weeklyAwardPoints, complete: team.complete,
      resultStatus: team.resultStatus
    };
    if (isAdmin) {
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
  const visibleClasses = isAdmin ? rawClasses : ownClassRows;
  return {
    ...snapshot,
    isAdmin,
    teams,
    ownGrades: ownTeams.map((team: any) => team.teamName || team.grade),
    ownClasses: visibleClasses,
    classComparison: projectCompetitionClassComparison(visibleClasses, isAdmin, Array.from(ownTeamIds))
  };
}
async function getLatestWeeklyCompetition(principal: { type: string; name: string }, permissions: any) {
  const today = getOmanIsoDate();
  const week = getSchoolWeekRange(today);
  const weekday = new Date(today + "T12:00:00.000Z").getUTCDay();
  const afterCutoff = weekday > 4 || (weekday === 4 && getOmanClockMinutes() >= 13 * 60 + 50);
  const latestClosedWeekStart = afterCutoff ? week.start : shiftCompetitionDate(week.start, -7);
  const baseQuery = () => db.from("competition_weekly_results")
    .select("week_start,week_end,status,finalized_at,snapshot")
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
  return {
    from: latestClosedWeekStart, to: shiftCompetitionDate(latestClosedWeekStart, 4), today,
    period: "weekly", status: "awaiting_first_result", finalizedAt: null, pendingWeek: null,
    teams: [], ownGrades: [], ownClasses: [], classComparison: [],
    weeklyWins: {}, weeklyPoints: {}, weeklyHistory: [], completedWeeks: 0
  };
}
async function buildTermCompetitionSnapshot(principal: { type: string; name: string }, permissions: any) {
  if (principal.type !== "admin" && permissions?.can_view_competition !== true) competitionError(403, "لا تملك صلاحية مشاهدة لوحة سباق التميز.");
  const today = getOmanIsoDate();
  const { data: setting, error: settingError } = await db.from("school_settings").select("value").eq("key", "competition_term_calendar").maybeSingle();
  if (settingError) throw settingError;
  const terms = Array.isArray(setting?.value) ? setting.value : [];
  const activeTerm = terms.find((term: any) => typeof term?.start === "string" && typeof term?.end === "string" && term.start <= today && today <= term.end)
    || terms.filter((term: any) => typeof term?.start === "string" && term.start <= today).sort((a: any, b: any) => String(b.start).localeCompare(String(a.start)))[0];
  if (!activeTerm || !isValidIsoDate(activeTerm.start) || !isValidIsoDate(activeTerm.end)) {
    competitionError(409, "لم يتم إعداد تواريخ الفصل الدراسي في إعدادات المدرسة.");
  }
  const termTo = today > activeTerm.end ? activeTerm.end : today;
  const { data: history, error } = await db.from("competition_weekly_results")
    .select("week_start,week_end,status,finalized_at,snapshot")
    .gte("week_start", activeTerm.start)
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
    from: activeTerm.start, to: termTo, termStart: activeTerm.start, termEnd: activeTerm.end,
    termLabel: String(activeTerm.label || "الفصل الدراسي"), dataAvailableFrom: earliestWeek,
    today, period: "term", status: completed.length ? "complete" : "no_completed_weeks",
    teams: rankedTeams, ownGrades: [], ownClasses: [], classComparison: allClasses,
    dailyProgress: [], weeklyWins, weeklyPoints, weeklyHistory,
    completedWeeks: completed.length
  };
  return projectCompetitionResponse(raw, principal, permissions);
}
async function finalizeCompetitionWeek() {
  const today = getOmanIsoDate();
  const weekday = new Date(today + "T12:00:00.000Z").getUTCDay();
  if (weekday !== 4 || getOmanClockMinutes() < 13 * 60 + 50) {
    competitionError(400, "لم يحن موعد اعتماد نتيجة الأسبوع بعد.");
  }
  const range = getSchoolWeekRange(today);
  const { data: existing, error: existingError } = await db.from("competition_weekly_results")
    .select("status").eq("week_start", range.start).maybeSingle();
  if (existingError) throw existingError;
  if (existing?.status === "complete") {
    return { ok: true, alreadyFinalized: true, weekStart: range.start, status: "complete" };
  }
  const principal = { type: "admin" as const, name: "مدير النظام العام" };
  const permissions = await permissionsFor(principal, true);
  const snapshot = await buildCompetitionSnapshot(principal, permissions, range.start, range.end, "weekly");
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
  if (principal.type !== "admin" && permissions?.can_view_competition !== true) competitionError(403, "لا تملك صلاحية مشاهدة لوحة سباق التميز.");
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

  const [{ data: classRows, error: classError }, { data: teacherRows, error: teacherError }] = await Promise.all([
    db.from("classes").select("name").order("name", { ascending: true }),
    db.from("teachers").select("name,role,permissions").order("name", { ascending: true })
  ]);
  if (classError) throw classError;
  if (teacherError) throw teacherError;
  const allClasses = (classRows || []).map((row: any) => String(row.name || "").trim()).filter(Boolean);
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
  const selectedWeek = getSchoolWeekRange(from);
  const fullSelectedWeek = period === "weekly" && from <= selectedWeek.start && to >= selectedWeek.end;
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
  return { from, to, period, today, isAdmin: principal.type === "admin", status: allTeamsComplete ? "complete" : "incomplete", teams: currentWeekAwards, ownGrades: teams.filter((team: any) => ownTeamIds.includes(team.teamId)).map((team: any) => team.teamName), ownClasses, classComparison, dailyProgress, weeklyWins, weeklyPoints, weeklyHistory, completedWeeks };
}

async function handle(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  let body: any; try { body = await req.json(); } catch { return reply(400, { error: "Invalid request" }); }
  if (body?.action === "login") {
    if (!validPin(body.pin)) return reply(400, { error: "بيانات الدخول غير صحيحة" });
    const rate = await rateLimit(req);
    if (rate.blocked) return reply(429, { error: "محاولات كثيرة. حاول بعد 15 دقيقة." });
    try {
      const principal = await findPrincipal(body.pin, await getPepper());
      if (!principal) { await failedLogin(rate.key); return reply(401, { error: "بيانات الدخول غير صحيحة" }); }
      if (principal.type !== "admin" && !(await hasStudentAffairsAccess(principal))) { await failedLogin(rate.key); return reply(403, { error: "هذا الحساب غير مخوّل لدخول شؤون الطلبة" }); }
      await clearFailedLogin(rate.key);
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
      await db.from("student_affairs_sessions").delete().lt("expires_at", new Date().toISOString());
      const { error } = await db.from("student_affairs_sessions").insert({ token_hash: await sha256(token), principal_type: principal.type, principal_name: principal.name, expires_at: expires });
      if (error) throw error;
      return reply(200, { token, expires_at: expires, principal: { type: principal.type, name: principal.name }, permissions: await permissionsFor(principal) });
    } catch (e) { console.error("Student affairs login failed:", e); return reply(500, { error: "تعذر إتمام التحقق الآمن حالياً" }); }
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
  const session = await getSession(req);
  if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
  const p = session.principal;
  if (p.type !== "admin" && !(await hasStudentAffairsAccess(p))) {
    await db.from("student_affairs_sessions").delete().eq("token_hash", session.tokenHash);
    return reply(403, { error: "تم إيقاف صلاحية دخول شؤون الطلبة لهذا الحساب" });
  }
  if (body?.action === "logout") {
    await db.from("student_affairs_sessions").delete().eq("token_hash", session.tokenHash);
    return reply(200, { ok: true });
  }
  if (body?.action === "get_my_permissions") {
    return reply(200, { permissions: await permissionsFor(p) });
  }
  if (body?.action === "supervision_trend") {
    const permissions = await permissionsFor(p);
    if (p.type !== "admin" && permissions.can_view_analytics !== true) return reply(403, { error: "غير مصرح بعرض مؤشر الأداء" });
    const from = body.from == null ? "2000-01-01" : body.from;
    const to = body.to == null ? new Date().toISOString().slice(0, 10) : body.to;
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) return reply(400, { error: "نطاق التاريخ غير صالح" });
    const scope = String(body.scope || "own");
    let attendanceClasses: string[] = [], behaviorClasses: string[] = [];
    let selectedMembers: any[] = [];
    if (scope === "own") {
      attendanceClasses = permissions.own_allowed_attendance_classes || [];
      behaviorClasses = permissions.own_allowed_behavior_classes || [];
    } else if (scope === "team" && p.type !== "admin" && permissions.role === "team_leader") {
      selectedMembers = permissions.team_members || [];
      attendanceClasses = permissions.team_allowed_attendance_classes || [];
      behaviorClasses = permissions.team_allowed_behavior_classes || [];
    } else if (scope === "teacher" && p.type !== "admin" && permissions.role === "team_leader") {
      const targetName = String(body.teacher_name || "");
      const member = (permissions.team_members || []).find((item: any) => item.name === targetName);
      if (!member) return reply(403, { error: "هذا المعلم ليس ضمن فريقك" });
      selectedMembers = [member];
      attendanceClasses = member.allowed_attendance_classes || [];
      behaviorClasses = member.allowed_behavior_classes || [];
    } else if (scope !== "own") return reply(403, { error: "نطاق المتابعة غير مصرح به" });
    const unique = (items: string[]) => [...new Set(items.map(String).filter(Boolean))];
    attendanceClasses = unique(attendanceClasses); behaviorClasses = unique(behaviorClasses);
    const ownStatusSet = new Set((permissions.attendance_statuses || ["absent", "late", "escape", "outside"]).map(String));
    const classStatusSets = new Map<string, Set<string>>();
    if (scope === "team" || scope === "teacher") {
      for (const member of selectedMembers) {
        const statuses = new Set((member.attendance_statuses || ["absent", "late", "escape", "outside"]).map(String));
        for (const className of member.allowed_attendance_classes || []) {
          const key = String(className);
          const combined = classStatusSets.get(key) || new Set<string>();
          for (const status of statuses) combined.add(status);
          classStatusSets.set(key, combined);
        }
      }
    }
    const fetchAll = async (table: "attendance" | "behaviors", classes: string[]) => {
      const rows: any[] = [];
      for (const className of classes) {
        let offset = 0;
        while (true) {
          const { data, error } = await db.from(table).select("date_str,class_name,records")
            .eq("class_name", className).gte("date_str", from).lte("date_str", to)
            .order("date_str").range(offset, offset + 999);
          if (error) throw error;
          const page = data || [];
          rows.push(...page);
          if (page.length < 1000) break;
          offset += page.length;
        }
      }
      return rows;
    };
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
    const getDay = (date: string) => { if (!days.has(date)) days.set(date, { date, absent: 0, late: 0, escape: 0, outside: 0, behavior: 0, total: 0 }); return days.get(date); };
    for (const row of attendanceRows) {
      const day = getDay(String(row.date_str)), records = row.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {};
      for (const value of Object.values(records as Record<string, unknown>)) {
        const status = typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).status || "") : "";
        const allowedStatuses = classStatusSets.get(String(row.class_name)) || ownStatusSet;
        if (["absent", "late", "escape", "outside"].includes(status) && allowedStatuses.has(status)) { day[status]++; day.total++; }
      }
    }
    for (const row of behaviorRows) {
      const day = getDay(String(row.date_str)), records = row.records && typeof row.records === "object" && !Array.isArray(row.records) ? row.records : {};
      for (const value of Object.values(records as Record<string, unknown>)) { const count = behaviorTypesFromRecord(value).length; if (count) { day.behavior += count; day.total += count; } }
    }
    return reply(200, { scope, class_count: unique([...attendanceClasses, ...behaviorClasses]).length, series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), permissions: { role: permissions.role } });
  }
  if (body?.action === "supervision_team") {
    const permissions = await permissionsFor(p);
    if (p.type !== "admin" && permissions.role !== "team_leader") return reply(403, { error: "متابعة المعلمين متاحة لرئيس الفريق فقط" });
    return reply(200, { team_name: permissions.team_name || "", teachers: permissions.team_members || [] });
  }
  if (body?.action === "get_permissions") {
    if (p.type !== "admin") return reply(403, { error: "غير مصرح" });
    const [{ data: teachers }, { data: classes }, { data: perms }] = await Promise.all([
      db.from("teachers").select("name,role,permissions").order("name"),
      db.from("classes").select("name").order("name"),
      db.from("student_affairs_permissions").select("*")
    ]);
    return reply(200, { teachers: teachers || [], classes: classes || [], permissions: perms || [] });
  }
  if (body?.action === "set_permissions") {
    if (p.type !== "admin") return reply(403, { error: "غير مصرح" });
    const type = body.principal_type, name = String(body.principal_name || "").trim();
    if (!["teacher", "custom"].includes(type) || !name) return reply(400, { error: "المعلم غير صالح" });
    const { data: target } = await db.from("teachers").select("name,role,permissions").eq("name", name).maybeSingle();
    if (!target || (type === "custom" ? target.role !== "custom" : target.role === "custom")) return reply(404, { error: "المعلم غير موجود" });
    const supervisionRole = String(body.student_affairs_role ?? target.permissions?.student_affairs_role ?? "").trim();
    const supervisionTeam = String(body.student_affairs_team_name ?? target.permissions?.student_affairs_team_name ?? "").trim();
    if (type === "teacher" && supervisionRole && !["team_leader", "supervisor", "visitor"].includes(supervisionRole)) return reply(400, { error: "نوع الإشراف غير صالح" });
    if (type === "teacher" && !supervisionRole && supervisionTeam) return reply(400, { error: "حدد نوع الإشراف قبل ربط المعلم بفريق" });
    if (type === "teacher" && supervisionRole === "team_leader" && (!supervisionTeam || body.studentAffairs !== true)) return reply(400, { error: "يجب تحديد اسم الفريق ومنح رئيس الفريق دخول شؤون الطلبة" });
    if (type === "teacher" && supervisionRole === "supervisor" && supervisionTeam && body.studentAffairs !== true) return reply(400, { error: "يجب تفعيل دخول شؤون الطلبة للمعلم المشرف المرتبط بفريق" });
    if (type === "teacher" && supervisionRole === "supervisor" && supervisionTeam) {
      const { data: leaders, error: leaderError } = await db.from("teachers").select("name,permissions").neq("name", target.name);
      if (leaderError) throw leaderError;
      const hasLeader = (leaders || []).some((item: any) => item.permissions?.student_affairs_role === "team_leader" && String(item.permissions?.student_affairs_team_name || "").trim() === supervisionTeam && item.permissions?.studentAffairs === true);
      if (!hasLeader) return reply(400, { error: "لا يوجد رئيس فريق مفعّل بهذا الاسم. أضف رئيس الفريق أولاً." });
    }
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
      if (type !== "teacher") return reply(400, { error: "المشاركة في سباق التميز مخصصة لحسابات المعلمين." });
      const teamName = String(body.competition_team_name || "").trim();
      const teamClasses = Array.isArray(body.competition_team_classes)
        ? Array.from(new Set((body.competition_team_classes as unknown[]).map(value => String(value || "").trim()).filter(Boolean)))
        : [];
      if (!teamName) return reply(400, { error: "اكتب اسم الفريق قبل تفعيل المشاركة." });
      if (!teamClasses.length) return reply(400, { error: "حدد صفاً واحداً على الأقل للفريق." });
      if (teamClasses.some(className => !valid.has(className))) return reply(400, { error: "توجد صفوف غير معتمدة ضمن الفريق." });
      const { data: participantRows, error: participantError } = await db.from("teachers").select("name,permissions").neq("name", target.name);
      if (participantError) throw participantError;
      const assigned = new Map<string, string>();
      for (const participant of participantRows || []) {
        const pp = participant.permissions || {};
        if (pp.competition_participant !== true) continue;
        for (const className of Array.isArray(pp.competition_team_classes) ? pp.competition_team_classes : []) assigned.set(String(className), String(participant.name));
      }
      const conflict = teamClasses.find(className => assigned.has(className));
      if (conflict) return reply(409, { error: "الصف " + conflict + " مسند بالفعل إلى فريق المعلم " + assigned.get(conflict) + "." });
    }
    const visitor = type === "teacher" && supervisionRole === "visitor";
    const row = { principal_type: type, principal_name: name, allowed_classes: allowed, allowed_attendance_classes: attendanceClasses, allowed_behavior_classes: behaviorClasses, attendance_statuses: statuses, can_read_attendance: !visitor && asBool(body.can_read_attendance), can_read_behavior: !visitor && asBool(body.can_read_behavior), can_view_analytics: asBool(body.can_view_analytics), can_print_attendance: !visitor && asBool(body.can_print_attendance), can_print_behavior: !visitor && asBool(body.can_print_behavior), can_print_combined: !visitor && asBool(body.can_print_combined), updated_at: new Date().toISOString() };
    const { error } = await db.from("student_affairs_permissions").upsert(row, { onConflict: "principal_type,principal_name" });
    if (error) throw error;
    if (typeof body.studentAffairs === "boolean" || typeof body.can_view_competition === "boolean") {
      const mergedPermissions = { ...(target.permissions || {}) };
      if (type === "teacher") {
        if (supervisionRole) {
          mergedPermissions.student_affairs_role = supervisionRole;
          mergedPermissions.student_affairs_team_name = supervisionRole === "visitor" ? "" : supervisionTeam;
        } else {
          delete mergedPermissions.student_affairs_role;
          delete mergedPermissions.student_affairs_team_name;
        }
      }
      if (typeof body.studentAffairs === "boolean") mergedPermissions.studentAffairs = body.studentAffairs;
      if (typeof body.can_view_competition === "boolean") mergedPermissions.can_view_competition = body.can_view_competition;
      if (typeof body.competition_participant === "boolean") {
        if (body.competition_participant && type !== "teacher") return reply(400, { error: "المشاركة في سباق التميز مخصصة لحسابات المعلمين." });
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
            if (pp.competition_participant !== true) continue;
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
  if (body?.action === "competition") {
    const permissions = await permissionsFor(p, true);
    if (p.type !== "admin" && permissions?.can_view_competition !== true) {
      return reply(403, { error: "لا تملك صلاحية مشاهدة لوحة سباق التميز." });
    }
    try {
      let snapshot: any;
      const period = String(body.period || "weekly");
      if (period === "weekly") snapshot = await getLatestWeeklyCompetition(p, permissions);
      else if (period === "term") snapshot = await buildTermCompetitionSnapshot(p, permissions);
      else {
        const live = await buildCompetitionSnapshot(p, permissions, body.from, body.to, period);
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
    const permissions = await permissionsFor(p);
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
    const authorizationError = authorizeReportMode(permissions, mode);
    if (authorizationError) return reply(authorizationError.status, { error: authorizationError.message });
    const from = body.from == null ? "2000-01-01" : body.from;
    const to = body.to == null ? "2100-12-31" : body.to;
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) return reply(400, { error: "نطاق التاريخ غير صالح" });
    const statusAllow = new Set((permissions.attendance_statuses || []) as string[]);
    if (body.attendance_status_filters != null && !Array.isArray(body.attendance_status_filters)) return reply(400, { error: "قائمة حالات الغياب غير صالحة" });
    const requestedStatuses = body.attendance_status_filters == null
      ? (body.attendance_status_filter == null ? null : [String(body.attendance_status_filter)])
      : Array.from(new Set((body.attendance_status_filters as unknown[]).map(String)));
    if (requestedStatuses && requestedStatuses.some((status: string) => !statusAllow.has(status))) return reply(403, { error: "غير مصرح بعرض إحدى حالات الغياب المطلوبة" });
    if (mode === "analytics") {
      const classes = Array.from(new Set([...requestedAttendance, ...requestedBehavior]));
      if (!classes.length) return reply(200, { attendance: [], behaviors: [], students: [], analytics: {}, permissions });
      const analytics: Record<string, unknown> = {};
      for (const className of classes) {
        const [a, b] = await Promise.all([
          allowedAttendance.has(className) ? db.from("attendance").select("record_key,records", { count: "exact" }).eq("class_name", className).gte("date_str", body.from || "2000-01-01").lte("date_str", body.to || "2100-12-31").limit(5000) : Promise.resolve({ data: [], error: null } as any),
          allowedBehavior.has(className) ? db.from("behaviors").select("record_key", { count: "exact", head: true }).eq("class_name", className).gte("date_str", body.from || "2000-01-01").lte("date_str", body.to || "2100-12-31") : Promise.resolve({ count: 0, error: null } as any)
        ]);
        if (a.error || b.error) return reply(500, { error: "تعذر تحميل التحليلات" });
        const statusCounts: Record<string, number> = { absent: 0, late: 0, escape: 0, outside: 0 };
        for (const session of (a.data || [])) {
          const records = session.records && typeof session.records === "object" && !Array.isArray(session.records) ? session.records : {};
          for (const value of Object.values(records as Record<string, unknown>)) {
            const status = typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).status || "") : "";
            if (Object.prototype.hasOwnProperty.call(statusCounts, status) && statusAllow.has(status) && (!requestedStatuses || requestedStatuses.includes(status))) statusCounts[status]++;
          }
        }
        const selectedAttendanceRecords = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
        analytics[className] = { attendance_sessions: a.count || (a.data || []).length, selected_attendance_records: selectedAttendanceRecords, attendance_status_counts: statusCounts, behavior_sessions: b.count || 0 };
      }
      return reply(200, { attendance: [], behaviors: [], students: [], analytics, permissions });
    }
    const wantsAttendance = mode === "view" || mode === "print_attendance" || mode === "print_combined";
    const wantsBehavior = mode === "view" || mode === "print_behavior" || mode === "print_combined";
    if (wantsAttendance && requestedAttendance.length && permissions.can_read_attendance !== true) return reply(403, { error: "غير مصرح بعرض الغياب" });
    if (wantsBehavior && requestedBehavior.length && permissions.can_read_behavior !== true) return reply(403, { error: "غير مصرح بعرض السلوكيات" });
    const filterAttendance = (rows: any[]) => (rows || []).map(row => ({ ...row, records: filterAttendanceRecordMap(row.records, [...statusAllow], requestedStatuses) })).filter(row => Object.keys(row.records).length > 0);
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
    return reply(200, { attendance: filterAttendance(attendance.data || []), behaviors: filterBehavior(behaviors.data || []), students: [], analytics: {}, permissions });
  }
  return reply(400, { error: "Unknown action" });
}
Deno.serve(async (req: Request) => {
  try { return await handle(req); }
  catch (e) { console.error("Student affairs request failed:", e); return reply(500, { error: "حدث خطأ داخلي. حاول لاحقاً." }); }
});
