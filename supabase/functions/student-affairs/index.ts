import { authorizeReportMode, isValidIsoDate, filterAttendanceRecordMap, filterBehaviorRecordMap, areClassesAllowed } from "./report_policy.ts";
import { awardWeeklyCompetitionPoints, buildTeamRates, calculateRelativeCompetitionScores, getSchoolDays, getSchoolWeekRange } from "./competition_policy.ts";
import { buildCompetitionTeams, projectCompetitionTeam } from "./competition_team_policy.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const PIN_ITERATIONS = 150000;
const SESSION_HOURS = 8;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
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
    return { allowed_classes: all, allowed_attendance_classes: all, allowed_behavior_classes: all, attendance_statuses: ["absent", "late", "escape", "outside"], can_read_attendance: true, can_read_behavior: true, can_view_analytics: true, can_view_competition: true, can_print_attendance: true, can_print_behavior: true, can_print_combined: true };
  }
  const [{ data }, { data: teacher }] = await Promise.all([
    db.from("student_affairs_permissions").select("*").eq("principal_type", p.type).eq("principal_name", p.name).maybeSingle(),
    db.from("teachers").select("permissions").eq("name", p.name).maybeSingle()
  ]);
  const legacy = Array.isArray(data?.allowed_classes) ? data.allowed_classes : [];
  return {
    ...(data || {}),
    allowed_classes: legacy,
    allowed_attendance_classes: Array.isArray(data?.allowed_attendance_classes) ? data.allowed_attendance_classes : legacy,
    allowed_behavior_classes: Array.isArray(data?.allowed_behavior_classes) ? data.allowed_behavior_classes : legacy,
    attendance_statuses: Array.isArray(data?.attendance_statuses) ? data.attendance_statuses : (strictCompetition ? [] : ["absent", "late", "escape", "outside"]),
    can_read_attendance: data?.can_read_attendance === true,
    can_read_behavior: data?.can_read_behavior === true,
    can_view_analytics: data?.can_view_analytics === true,
    can_view_competition: teacher?.permissions?.can_view_competition === true,
    competition_participant: teacher?.permissions?.competition_participant === true,
    competition_team_name: typeof teacher?.permissions?.competition_team_name === "string" ? teacher.permissions.competition_team_name : "",
    competition_team_classes: Array.isArray(teacher?.permissions?.competition_team_classes) ? teacher.permissions.competition_team_classes : [],
    can_print_attendance: data?.can_print_attendance === true,
    can_print_behavior: data?.can_print_behavior === true,
    can_print_combined: data?.can_print_combined === true
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
async function fetchCompetitionStudents(classNames: string[]) {
  const rows: any[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    if (offset >= 20000) throw new Error("Student roster exceeds the safe query limit");
    const { data, error } = await db.from("students")
      .select("class_name,student_name")
      .in("class_name", classNames)
      .order("class_name", { ascending: true })
      .order("student_name", { ascending: true })
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
  const currentWeekAwards = fullSelectedWeek && allTeamsComplete ? awardWeeklyCompetitionPoints(scored) : scored.map((team: any) => ({ ...team, weeklyAwardPoints: null }));
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
    if (period === "monthly" ? weekEnd < from : weekStart < from) continue;
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
      const classItem = { teamId: team.teamId, teamName: team.teamName, leaderName: team.leaderName, className, complete: metric.complete, attendanceRate: metric.attendanceRate, behaviorRate: metric.behaviorRate, attendanceIncidents: metric.attendanceIncidents, behaviorIncidents: metric.behaviorIncidents };
      classComparison.push(classItem);
      if (ownTeamIds.includes(team.teamId)) ownClasses.push(classItem);
    }
  }
  return { from, to, period, today, status: allTeamsComplete ? "complete" : "incomplete", teams: currentWeekAwards, ownGrades: teams.filter((team: any) => ownTeamIds.includes(team.teamId)).map((team: any) => team.teamName), ownClasses, classComparison, dailyProgress, weeklyWins, weeklyPoints, weeklyHistory };
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
      if (principal.type !== "admin" && !(await hasStudentAffairsAccess(principal))) { await failedLogin(rate.key); return reply(403, { error: "هذا الحساب غير مخوّل لدخول شؤون الطلاب" }); }
      await clearFailedLogin(rate.key);
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
      await db.from("student_affairs_sessions").delete().lt("expires_at", new Date().toISOString());
      const { error } = await db.from("student_affairs_sessions").insert({ token_hash: await sha256(token), principal_type: principal.type, principal_name: principal.name, expires_at: expires });
      if (error) throw error;
      return reply(200, { token, expires_at: expires, principal: { type: principal.type, name: principal.name }, permissions: await permissionsFor(principal) });
    } catch (e) { console.error("Student affairs login failed:", e); return reply(500, { error: "تعذر إتمام التحقق الآمن حالياً" }); }
  }
  const session = await getSession(req);
  if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." });
  const p = session.principal;
  if (p.type !== "admin" && !(await hasStudentAffairsAccess(p))) {
    await db.from("student_affairs_sessions").delete().eq("token_hash", session.tokenHash);
    return reply(403, { error: "تم إيقاف صلاحية دخول شؤون الطلاب لهذا الحساب" });
  }
  if (body?.action === "logout") {
    await db.from("student_affairs_sessions").delete().eq("token_hash", session.tokenHash);
    return reply(200, { ok: true });
  }
  if (body?.action === "get_my_permissions") {
    return reply(200, { permissions: await permissionsFor(p) });
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
    const row = { principal_type: type, principal_name: name, allowed_classes: allowed, allowed_attendance_classes: attendanceClasses, allowed_behavior_classes: behaviorClasses, attendance_statuses: statuses, can_read_attendance: asBool(body.can_read_attendance), can_read_behavior: asBool(body.can_read_behavior), can_view_analytics: asBool(body.can_view_analytics), can_print_attendance: asBool(body.can_print_attendance), can_print_behavior: asBool(body.can_print_behavior), can_print_combined: asBool(body.can_print_combined), updated_at: new Date().toISOString() };
    const { error } = await db.from("student_affairs_permissions").upsert(row, { onConflict: "principal_type,principal_name" });
    if (error) throw error;
    if (typeof body.studentAffairs === "boolean" || typeof body.can_view_competition === "boolean") {
      const mergedPermissions = { ...(target.permissions || {}) };
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
    try {
      const snapshot = await buildCompetitionSnapshot(p, permissions, body.from, body.to, body.period);
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
    const requestedAttendance: string[] = Array.isArray(body.attendance_classes) ? Array.from(new Set((body.attendance_classes as unknown[]).map(String))) : legacyRequested || [...allowedAttendance];
    const requestedBehavior: string[] = Array.isArray(body.behavior_classes) ? Array.from(new Set((body.behavior_classes as unknown[]).map(String))) : legacyRequested || [...allowedBehavior];
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
    if (wantsAttendance && Array.isArray(body.attendance_classes) && requestedAttendance.length && !permissions.can_read_attendance) return reply(403, { error: "غير مصرح بعرض الغياب" });
    if (wantsBehavior && Array.isArray(body.behavior_classes) && requestedBehavior.length && !permissions.can_read_behavior) return reply(403, { error: "غير مصرح بعرض السلوكيات" });
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
