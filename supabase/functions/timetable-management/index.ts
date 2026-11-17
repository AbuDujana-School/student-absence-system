import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseTimetableDay, validateSchoolTeacherCount } from "./timetable_grid.ts";
import { matchSystemTeacherName, parseTimetableWorkbook, validateWorkbookSchema, type SystemTeacher } from "./timetable_import.ts";
import { aggregateClassTimetables } from "./timetable_class_grid.ts";
import { fetchAllTimetablePages } from "./timetable_pagination.ts";
import { buildBatchSubstitutionPlan, countTeacherTeachingPeriods, getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, isValidSubstitutionDate, type TimetableEntry, type SubstitutionAssignment, type SubstitutionTeacher } from "./substitution_policy.ts";
import { canAccessTeacherTimetablePortal, canIncludeOtherDepartments, canUseTimetableAction, resolveTimetablePrincipal, type TimetableAuthStore, type TimetablePrincipal } from "./session_auth.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const DAYS = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
function muscatDateAndWeekday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Muscat", weekday: "long",
  }).format(now);
  const weekdayMap: Record<string,string> = {
    Sunday: "الأحد", Monday: "الاثنين", Tuesday: "الثلاثاء",
    Wednesday: "الأربعاء", Thursday: "الخميس",
  };
  return {
    date: String(values.year) + "-" + String(values.month).padStart(2,"0") + "-" + String(values.day).padStart(2,"0"),
    weekday: weekdayMap[weekdayName] || "",
  };
}
// Maximum accepted import: 500 teachers × 5 weekdays × 8 periods = 20,000 cells.
// PostgREST may cap each response at 1,000 rows, so full-week reads are paginated.
const TIMETABLE_CELL_PAGE_SIZE = 1000;
const WEEKLY_CELL_FETCH_LIMIT = 25000;
async function fetchAllTimetableCells(queryForRange: (from:number,to:number)=>any): Promise<any[]> {
  return fetchAllTimetablePages(queryForRange, TIMETABLE_CELL_PAGE_SIZE, WEEKLY_CELL_FETCH_LIMIT);
}
async function fetchAllSubstitutionRows(queryForRange: (from:number,to:number)=>any): Promise<any[]> {
  // Historical fairness and points must not silently stop at the weekly-grid row limit.
  return fetchAllTimetablePages(queryForRange, TIMETABLE_CELL_PAGE_SIZE, 100000);
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}
const timetableAuthStore: TimetableAuthStore = {
  async findSession(tokenHash, nowIso) {
    const { data, error } = await db.from("app_sessions")
      .select("principal_type,principal_name,expires_at")
      .eq("token_hash", tokenHash)
      .gt("expires_at", nowIso)
      .maybeSingle();
    return error || !data ? null : data;
  },
  async hasAdminCredential() {
    const { data, error } = await db.from("school_settings")
      .select("value").eq("key", "admin_pin").maybeSingle();
    return !error && !!data?.value?.hash && !!data?.value?.salt;
  },
  async findTeacher(name) {
    const { data, error } = await db.from("teachers")
      .select("name,role").eq("name", name).maybeSingle();
    return error || !data ? null : { name: String(data.name), role: String(data.role) };
  },
  async hasTimetableAccess(type, name) {
    const { data, error } = await db.from("timetable_access_permissions")
      .select("can_access").eq("principal_type", type)
      .eq("principal_name", name).maybeSingle();
    return !error && data?.can_access === true;
  },
  async hasSubstitutionAccess(name) {
    const { data, error } = await db.from("teachers")
      .select("permissions").eq("name", name).eq("role", "teacher").maybeSingle();
    return !error && data?.permissions?.reserve === true;
  },
  async hasLinkedTeacherPortalAccess(name) {
    const { data: setting, error: settingError } = await db.from("teacher_timetable_portal_settings")
      .select("enabled,selected_teacher_names").eq("id", true).maybeSingle();
    if (settingError || setting?.enabled !== true) return false;
    if (!canAccessTeacherTimetablePortal(setting.enabled, setting.selected_teacher_names, name)) return false;
    const { data: version, error: versionError } = await db.from("timetable_weekly_versions")
      .select("id").eq("status", "active").maybeSingle();
    if (versionError || !version) return false;
    const [cells, directory] = await Promise.all([
      fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("matched_teacher_name,teacher_source_name")
        .eq("version_id", version.id).eq("cell_status", "teaching").order("id").range(from,to)),
      teacherDirectory(),
    ]);
    const systemTeachers: SystemTeacher[] = directory.filter((item: any) => item.role === "teacher");
    return (cells || []).some((cell: any) =>
      resolveTimetableTeacherName(cell.matched_teacher_name, cell.teacher_source_name, systemTeachers) === name
    );
  },
  async hasOwnDailySubstitutionAssignment(name) {
    const { date: today, weekday } = muscatDateAndWeekday();
    if (!DAYS.includes(weekday)) return false;
    const { data: version, error: versionError } = await db.from("timetable_weekly_versions")
      .select("id").eq("status", "active").maybeSingle();
    if (versionError || !version) return false;
    const { data, error } = await db.from("timetable_assignments").select("id")
      .eq("version_id", version.id).eq("teacher_name", name)
      .eq("assignment_type", "substitution").eq("assignment_date", today)
      .eq("weekday", weekday).neq("status", "cancelled").limit(1).maybeSingle();
    return !error && !!data;
  },
  async hasSchoolwideReserveStatsAccess(type, name) {
    const { data, error } = await db.from("timetable_reserve_stats_access")
      .select("principal_name").eq("principal_type", type)
      .eq("principal_name", name).maybeSingle();
    return !error && !!data;
  },
};

async function requirePrincipal(req: Request): Promise<TimetablePrincipal | null> {
  return resolveTimetablePrincipal(req.headers.get("authorization"), timetableAuthStore);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function timetableImportRequestHash(fileName: string, actorName: string, sheets: unknown): Promise<string> {
  const canonicalPayload = JSON.stringify({ file_name: fileName, actor_name: actorName, sheets });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPayload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function teacherDirectory() {
  const { data, error } = await db.from("teachers").select("name,role,permissions").in("role", ["teacher","custom"]).order("name");
  if (error) throw error;
  return (data || []).map((item: any) => ({
    name: String(item.name || ""),
    role: String(item.role || ""),
    department: String(item.permissions?.category || item.permissions?.department_id || item.permissions?.department_name || ""),
    departmentId: String(item.permissions?.category || item.permissions?.department_id || item.permissions?.department_name || ""),
    departmentName: String(item.permissions?.category || item.permissions?.department_name || ""),
    canManageSubstitutions: item.permissions?.reserve === true,
  })).filter((item: any) => item.name);
}
async function getActiveDepartmentSubjects(departmentId: string): Promise<string[]> {
  const normalizedDepartmentId = String(departmentId || "").trim();
  if (!normalizedDepartmentId) return [];
  const directory = await teacherDirectory();
  const systemTeachers: SystemTeacher[] = directory.filter((teacher: any) =>
    teacher.role === "teacher" && teacher.departmentId === normalizedDepartmentId
  );
  if (!systemTeachers.length) return [];
  const teacherNames = new Set(systemTeachers.map((teacher) => teacher.name));
  const { data: version, error: versionError } = await db.from("timetable_weekly_versions")
    .select("id").eq("status", "active").maybeSingle();
  if (versionError) throw versionError;
  if (!version) return [];
  const cells = await fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells")
    .select("matched_teacher_name,teacher_source_name,subject").eq("version_id",version.id)
    .eq("cell_status","teaching").order("id").range(from,to));
  return [...new Set((cells || []).filter((cell:any) =>
    teacherNames.has(resolveTimetableTeacherName(cell.matched_teacher_name,cell.teacher_source_name,systemTeachers) || "")
  ).map((cell:any) => String(cell.subject || "").trim()).filter(Boolean))]
    .sort((a,b) => a.localeCompare(b,"ar"));
}
function timetableTeacherIdentityKey(value: unknown): string {
  return String(value??"").normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ؤ/g,"و").replace(/ئ/g,"ي").replace(/ة/g,"ه")
    .replace(/\s+/g,"").trim();
}
function resolveTimetableTeacherName(matchedName: unknown, sourceName: unknown, systemTeachers: SystemTeacher[]): string | null {
  const storedKey = timetableTeacherIdentityKey(matchedName);
  if (storedKey) {
    const indexed = systemTeachers.find(teacher => timetableTeacherIdentityKey(teacher.name) === storedKey);
    if (indexed) return indexed.name;
  }
  const source = String(sourceName || "").trim();
  if (!source) return null;
  const resolved = matchSystemTeacherName(source, systemTeachers);
  return resolved.matchStatus === "matched" ? resolved.teacherName : null;
}
async function schoolClassDirectory(): Promise<string[]> {
  const { data, error } = await db.from("classes").select("name").order("name");
  if (error) throw error;
  return Array.from(new Set((data || []).map((item: any) => String(item.name || "").trim()).filter(Boolean)));
}
function buildClassCoverage(cells: any[], classNames: string[], periodCount: number) {
  const classes = aggregateClassTimetables(cells, DAYS, periodCount, classNames);
  const expected = new Set(classNames);
  const expectedClasses = classes.filter(item => expected.has(item.className));
  const sum = (key: "vacancies" | "conflicts" | "teachingCount" | "freePeriods" | "meetingPeriods" | "unclearPeriods") =>
    expectedClasses.reduce((total: number, item: any) => total + Number(Array.isArray(item[key]) ? item[key].length : item[key] || 0), 0);
  const missingSlots = sum("vacancies");
  const conflictSlots = sum("conflicts");
  const teachingLessons = sum("teachingCount");
  const freeSlots = sum("freePeriods");
  const meetingSlots = sum("meetingPeriods");
  const unclearSlots = sum("unclearPeriods");
  const requiredSlots = classNames.length * DAYS.length * periodCount;
  const coveredSlots = requiredSlots - missingSlots;
  return {
    classCount: classNames.length, periodCount, weekdayCount: DAYS.length, requiredSlots,
    coveredSlots, missingSlots, conflictSlots, teachingLessons, freeSlots, meetingSlots, unclearSlots,
    otherCoveredSlots: Math.max(0, coveredSlots - teachingLessons - freeSlots - meetingSlots - unclearSlots - conflictSlots),
    complete: classNames.length === 28 && missingSlots === 0 && conflictSlots === 0 && unclearSlots === 0,
    configurationWarning: classNames.length !== 28 ? "عدد الصفوف المسجل في إعدادات المدرسة هو " + classNames.length + " وليس 28." : null,
    unexpectedClassNames: classes.filter(item => !expected.has(item.className)).map(item => item.className),
    classes,
  };
}
async function handle(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "Invalid request" }); }
  const principal = await requirePrincipal(req);
  if (!principal) return reply(401, { error: "انتهت جلسة الدخول أو لا تملك صلاحية الوصول إلى الجداول." });

  const action = String(body.action || "");
  const hasReservePermission = principal.type === "teacher" && action.startsWith("timetable_substitution_")
    ? await timetableAuthStore.hasSubstitutionAccess?.(principal.name) === true
    : false;
  const hasTimetableGrant = (principal.type === "teacher" || principal.type === "custom")
    ? await timetableAuthStore.hasTimetableAccess(principal.type, principal.name)
    : false;
  const hasArchivePermission = principal.type === "admin" || hasReservePermission || hasTimetableGrant;
  const hasTeacherActivityPermission = action === "timetable_activity_report_data" && (
    principal.type === "admin" || await (async () => {
      const { data, error } = await db.from("teachers").select("permissions")
        .eq("name", principal.name).eq("role", principal.type).maybeSingle();
      if (error) throw error;
      return data?.permissions?.teachers === true || data?.permissions?.admin === true;
    })()
  );
  if (!canUseTimetableAction(principal.type, action, principal.portalOnly === true, hasReservePermission, principal.reserveStatsOnly === true, principal.schoolwideReserveStats === true)
    && !(["timetable_substitution_archive","timetable_substitution_archive_access"].includes(action) && hasArchivePermission)
    && !hasTeacherActivityPermission) {
    return reply(403, { error: "تحتاج هذه العملية إلى صلاحية إدارة الاحتياط أو صلاحية أرشيف الاحتياط الممنوحة من مدير النظام العام." });
  }

  if (action === "timetable_substitution_archive_access") {
    return reply(200,{ok:true,canView:hasArchivePermission});
  }

  // Archive is independent of the currently active timetable version: historical
  // reserve records remain printable even after a new timetable is activated.
  if (action === "timetable_substitution_archive") {
    if (!hasArchivePermission) return reply(403,{error:"لا تملك صلاحية عرض أرشيف الاحتياط."});
    const dateFrom=String(body.dateFrom||"").trim(),dateTo=String(body.dateTo||"").trim();
    if(!isValidSubstitutionDate(dateFrom)||!isValidSubstitutionDate(dateTo)||dateFrom>dateTo) {
      return reply(400,{error:"حدد فترة زمنية صحيحة لأرشيف الاحتياط."});
    }
    const fromMs=Date.parse(dateFrom+"T00:00:00Z"),toMs=Date.parse(dateTo+"T00:00:00Z");
    if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||toMs<fromMs||(principal.type!=="admin"&&toMs-fromMs>366*86400000)) {
      return reply(400,{error:principal.type==="admin"?"نطاق التاريخ غير صحيح.":"الفترة القصوى لطباعة أرشيف الاحتياط هي 366 يوماً."});
    }
    const [directory,activeVersion]=await Promise.all([
      teacherDirectory(),
      db.from("timetable_weekly_versions").select("id").eq("status","active").maybeSingle(),
    ]);
    if(activeVersion.error)throw activeVersion.error;
    const actor=directory.find((teacher:any)=>teacher.name===principal.name);
    const schoolwide=principal.type==="admin"||hasTimetableGrant||hasReservePermission;
    const visibleNames=new Set(directory.filter((teacher:any)=>teacher.role==="teacher"&&
      (schoolwide||Boolean(actor?.departmentId&&teacher.departmentId===actor.departmentId))).map((teacher:any)=>teacher.name));
    const rows=await fetchAllSubstitutionRows((from,to)=>db.from("timetable_assignments")
      .select("id,version_id,teacher_name,absent_teacher_name,assignment_type,weekday,period,status,assignment_date,class_sections,subject,reserve_reason,created_at,reserve_created_at")
      .eq("assignment_type","substitution").gte("assignment_date",dateFrom).lte("assignment_date",dateTo)
      .order("assignment_date").order("period").order("id").range(from,to));
    const todayInMuscat=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const archive=(rows||[]).filter((row:any)=>visibleNames.has(String(row.absent_teacher_name||"")))
      .sort((a:any,b:any)=>String(a.assignment_date||"").localeCompare(String(b.assignment_date||""))||
        Number(a.period)-Number(b.period)||String(a.absent_teacher_name||"").localeCompare(String(b.absent_teacher_name||""),"ar"))
      .map((row:any)=>({
        id:String(row.id),assignmentDate:row.assignment_date||null,weekday:String(row.weekday||""),
        createdAt:row.reserve_created_at||row.created_at||null,
        canEdit:Boolean(activeVersion.data&&String(row.version_id)===String(activeVersion.data.id)&&
          String(row.assignment_date||"")===todayInMuscat&&["assigned","confirmed"].includes(String(row.status||""))),
        absentTeacherName:String(row.absent_teacher_name||""),substituteTeacherName:String(row.teacher_name||""),
        period:Number(row.period),className:Array.isArray(row.class_sections)?row.class_sections.join("، "):"",
        subject:String(row.subject||""),reason:String(row.reserve_reason||"-"),
        status:String(row.status||"assigned"),versionId:String(row.version_id||""),
      }));
    return reply(200,{ok:true,archive,dateFrom,dateTo,schoolwide});
  }

  if (["timetable_preview", "timetable_save_import"].includes(action)) {
    if (principal.type !== "admin") return reply(403, { error: "استيراد الجداول متاح لمدير النظام العام فقط." });
    const sheets = body?.sheets;
    const schema = validateWorkbookSchema(sheets);
    if (!schema.valid) {
      const detail = schema.errors.slice(0, 8).map(issue =>
        (issue.sheet ? "ورقة " + issue.sheet + "، " : "") +
        (issue.row ? "صف " + issue.row + "، " : "") +
        (issue.column ? "عمود " + issue.column + ": " : "") + issue.message
      ).join("؛ ");
      const tooLarge = schema.rowCount > 5000 || schema.cellCount > 100000;
      return reply(tooLarge ? 413 : 400, {
        error: "تعذر التحقق من بنية ملف الجدول: " + detail,
        validation: { valid: false, rowCount: schema.rowCount, cellCount: schema.cellCount, errors: schema.errors },
      });
    }
    try {
      const { data: directory, error: directoryError } = await db.from("teachers")
        .select("name,role,permissions").eq("role", "teacher").order("name");
      if (directoryError) throw directoryError;
      const systemTeachers: SystemTeacher[] = (directory || []).map((teacher: any) => ({
        name: String(teacher.name || ""),
        departmentId: typeof teacher.permissions?.category === "string" ? teacher.permissions.category
          : typeof teacher.permissions?.department_id === "string" ? teacher.permissions.department_id : undefined,
        departmentName: typeof teacher.permissions?.category === "string" ? teacher.permissions.category
          : typeof teacher.permissions?.department_name === "string" ? teacher.permissions.department_name : undefined,
      })).filter((teacher: SystemTeacher) => teacher.name);
      const parsed = parseTimetableWorkbook(sheets, systemTeachers);
      if (parsed.validation && !parsed.validation.valid) {
        parsed.warnings.push(...parsed.validation.errors.map((message: string) => "ملاحظة تحقق: " + message));
      }
      if (parsed.hasWeeklyPlacements) {
        const classNames = await schoolClassDirectory();
        const placementCells = (parsed.placements || []).filter((record: any) =>
          DAYS.includes(String(record.weekday || "")) && Number.isInteger(Number(record.period)) &&
          Number(record.period) >= 1 && Number(record.period) <= 8 && String(record.className || "").trim()
        ).flatMap((record: any) => {
          const owner = (parsed.teachers || []).find((teacher: any) => teacher.sourceName === record.teacherSourceName);
          const subject = String(record.subject || "");
          const normalizedSubject = subject.replace(/\s+/g, "");
          const cellStatus = normalizedSubject.includes("اجتماع") ? "meeting" :
            normalizedSubject.includes("فراغ") || normalizedSubject.includes("فارغ") ? "free" : "teaching";
          return String(record.className || "").split(/[،,؛;]+/).map((name: string) => name.trim()).filter(Boolean).map((className: string) => ({
            weekday: record.weekday, period: Number(record.period), cell_status: cellStatus,
            class_sections: [className], subject,
            matched_teacher_name: owner?.matchedTeacherName || null,
            teacher_source_name: String(record.teacherSourceName || ""),
          }));
        });
        const inferredPeriodCount = placementCells.some((cell: any) => cell.period === 8) ? 8 : 7;
        const classCoverage = buildClassCoverage(placementCells, classNames, inferredPeriodCount);
        (parsed.totals as any).classCoverage = classCoverage;
        if (classCoverage.missingSlots > 0) parsed.warnings.push(
          "فحص الصفوف: توجد " + classCoverage.missingSlots + " خانات غير مغطاة من أصل " +
          classCoverage.requiredSlots + "؛ راجع تقرير جداول الصفوف."
        );
      }
      if (action === "timetable_preview") {
        return reply(200, {
          ok: true, fileName: String(body.fileName || "ملف Excel").slice(0, 180),
          importedAt: new Date().toISOString(), importedBy: principal.name, result: parsed,
        });
      }
      const idempotencyKey = String(body.idempotencyKey || "");
      if (!validUuid(idempotencyKey)) {
        return reply(400, { error: "معرّف محاولة حفظ المسودة غير صالح. أعد اختيار الملف ثم حاول مجدداً." });
      }
      const fileName = String(body.fileName || "ملف Excel").slice(0, 180);
      const requestHash = await timetableImportRequestHash(fileName, principal.name, sheets);
      const { data, error } = await db.rpc("save_timetable_import", {
        p_payload: {
          file_name: fileName,
          actor_name: principal.name,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          result: parsed,
        },
      });
      if (error) throw error;
      return reply(200, { ok: true, saved: data });
    } catch (error) {
      console.error("Timetable import operation failed:", error instanceof Error ? error.message : "unknown");
      return reply(action === "timetable_preview" ? 500 : 500, {
        error: action === "timetable_preview"
          ? "تعذر تحليل ملف الجدول. تحقق من بنية الملف ثم أعد المحاولة."
          : "تعذر حفظ نسخة الجدول. تحقق من تطبيق migration الخاصة بالتطوير أولاً.",
      });
    }
  }

  if (["timetable_list_imports", "timetable_get_import", "timetable_list_owner_candidates",
       "timetable_mutate_record", "timetable_reassign_owner"].includes(action)) {
    try {
      if (action === "timetable_list_imports") {
        const { data, error } = await db.from("timetable_imports")
          .select("id,version,file_name,imported_by_name,status,has_weekly_placements,source_sheets,summary,created_at")
          .order("created_at", { ascending: false }).limit(30);
        if (error) throw error;
        return reply(200, { imports: data || [] });
      }
      if (action === "timetable_list_owner_candidates") {
        const { data, error } = await db.from("teachers")
          .select("name,role,permissions").eq("role", "teacher").order("name");
        if (error) throw error;
        return reply(200, { teachers: (data || []).map((item: any) => ({
          name: String(item.name || ""),
          department: String(item.permissions?.category || item.permissions?.department_name || item.permissions?.department_id || ""),
        })).filter((item: any) => item.name) });
      }
      if (!validUuid(body.importId)) return reply(400, { error: "معرّف نسخة الجدول غير صالح." });
      if (action === "timetable_get_import") {
        const [{ data: imported, error: importError }, { data: teachers, error: teachersError }, { data: records, error: recordsError }] = await Promise.all([
          db.from("timetable_imports").select("*").eq("id", body.importId).maybeSingle(),
          db.from("timetable_import_teachers").select("*").eq("import_id", body.importId).order("source_name"),
          db.from("timetable_import_records").select("*").eq("import_id", body.importId).order("source_sheet").order("source_row"),
        ]);
        if (importError) throw importError;
        if (teachersError) throw teachersError;
        if (recordsError) throw recordsError;
        if (!imported) return reply(404, { error: "نسخة الجدول غير موجودة." });
        return reply(200, { imported, teachers: teachers || [], records: records || [] });
      }
      if (action === "timetable_reassign_owner") {
        const sourceName = String(body.sourceName || "").trim();
        const teacherName = String(body.teacherName || "").trim();
        if (!sourceName || sourceName.length > 200 || teacherName.length > 200) {
          return reply(400, { error: "بيانات مالك الجدول غير صالحة." });
        }
        const { data, error } = await db.rpc("reassign_timetable_import_owner", {
          p_payload: { import_id: body.importId, source_name: sourceName, teacher_name: teacherName, actor_name: principal.name, actor_type: principal.type },
        });
        if (error) throw error;
        return reply(200, { result: data });
      }
      if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
        return reply(400, { error: "بيانات تعديل الحصة غير صالحة." });
      }
      const { data, error } = await db.rpc("mutate_timetable_import_record", {
        p_payload: { ...body.payload, import_id: body.importId, actor_name: principal.name, actor_type: principal.type },
      });
      if (error) throw error;
      return reply(200, { result: data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("تعارض") || message.includes("مسودة") || message.includes("المعلم غير مطابق") || message.includes("غير موجود")) {
        return reply(409, { error: message });
      }
      console.error("Timetable import administration failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر تنفيذ عملية إدارة الجدول. تحقق من تطبيق migration التطوير." });
    }
  }

  if (action === "health") {
    return reply(200, { ok: true, service: "timetable-management", authenticated: true, scope: "timetable-only" });
  }

  if (action === "timetable_check_access") {
    try {
      const [{ data: setting, error: settingError }, { data: version, error: versionError }] = await Promise.all([
        db.from("teacher_timetable_portal_settings").select("enabled,selected_teacher_names").eq("id", true).maybeSingle(),
        db.from("timetable_weekly_versions").select("id").eq("status", "active").maybeSingle(),
      ]);
      // The additive portal migration may not yet be deployed. In that case,
      // preserve existing timetable-management access and keep the new portal off.
      if (versionError) throw versionError;
      let hasPersonalSchedule = false;
      if (version && principal.type === "teacher") {
        const [teachingCells, directory] = await Promise.all([
          fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("matched_teacher_name,teacher_source_name")
            .eq("version_id", version.id).eq("cell_status", "teaching").order("id").range(from,to)),
          teacherDirectory(),
        ]);
        const systemTeachers: SystemTeacher[] = directory.filter((item: any) => item.role === "teacher");
        hasPersonalSchedule = (teachingCells || []).some((cell: any) =>
          resolveTimetableTeacherName(cell.matched_teacher_name, cell.teacher_source_name, systemTeachers) === principal.name
        );
      }
      return reply(200, {
        canAccess: principal.type === "admin" || principal.portalOnly !== true,
        teacherPortalEnabled: !settingError && setting?.enabled === true,
        teacherPortalCanAccess: principal.type === "teacher" && !settingError && hasPersonalSchedule && canAccessTeacherTimetablePortal(setting?.enabled, setting?.selected_teacher_names, principal.name),
        hasPersonalSchedule,
        isAdmin: principal.type === "admin",
        isTeacher: principal.type === "teacher" || principal.type === "custom",
      });
    } catch (error) {
      console.error("Timetable access status failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر التحقق من حالة خدمة الجدول الشخصي." });
    }
  }

  if (action === "timetable_portal_get_status") {
    if (principal.type !== "admin") return reply(403, { error: "تفعيل خدمة الجدول الشخصي متاح للمدير العام فقط." });
    try {
      const [{ data: setting, error: settingError }, { data: version, error: versionError }] = await Promise.all([
        db.from("teacher_timetable_portal_settings").select("enabled,selected_teacher_names,updated_by,updated_at").eq("id", true).maybeSingle(),
        db.from("timetable_weekly_versions").select("id").eq("status", "active").maybeSingle(),
      ]);
      if (settingError) throw settingError;
      if (versionError) throw versionError;
      let eligibleTeachers: Array<{name:string;category:string}> = [];
      if (version) {
        const [{ data: teachers, error: teachersError }, cells] = await Promise.all([
          db.from("teachers").select("name,permissions").eq("role", "teacher").order("name"),
          fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("matched_teacher_name,teacher_source_name")
            .eq("version_id", version.id).eq("cell_status", "teaching").order("id").range(from,to)),
        ]);
        if (teachersError) throw teachersError;
        const systemTeachers: SystemTeacher[] = (teachers || []).map((item: any) => ({
          name: String(item.name || ""),
          departmentId: typeof item.permissions?.category === "string" ? item.permissions.category
            : typeof item.permissions?.department_id === "string" ? item.permissions.department_id : undefined,
          departmentName: typeof item.permissions?.category === "string" ? item.permissions.category
            : typeof item.permissions?.department_name === "string" ? item.permissions.department_name : undefined,
        })).filter((item: SystemTeacher) => item.name);
        const teacherByKey = new Map(systemTeachers.map(item => [timetableTeacherIdentityKey(item.name), item]));
        const eligibleNames = new Set<string>();
        for (const cell of cells || []) {
          let canonical = teacherByKey.get(timetableTeacherIdentityKey(cell.matched_teacher_name))?.name || "";
          if (!canonical && cell.teacher_source_name) {
            const match = matchSystemTeacherName(String(cell.teacher_source_name), systemTeachers);
            if (match.matchStatus === "matched") canonical = match.teacherName || "";
          }
          if (canonical) eligibleNames.add(canonical);
        }
        eligibleTeachers = Array.from(eligibleNames).map(name => {
          const teacher = teacherByKey.get(timetableTeacherIdentityKey(name));
          return {
            name,
            category: String(teacher?.departmentName || teacher?.departmentId || "غير محدد").trim() || "غير محدد",
          };
        }).sort((a,b)=>a.category.localeCompare(b.category,"ar")||a.name.localeCompare(b.name,"ar"));
      }
      const selectedTeacherNames = Array.isArray(setting?.selected_teacher_names) ? setting.selected_teacher_names : [];
      return reply(200, {
        enabled: setting?.enabled === true,
        mode: selectedTeacherNames.length > 0 ? "custom" : "all",
        eligibleTeacherCount: eligibleTeachers.length,
        selectedTeacherNames,
        eligibleTeachers,
        updatedBy: setting?.updated_by || null,
        updatedAt: setting?.updated_at || null,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "خطأ غير محدد";
      console.error("Teacher timetable portal status failed:", detail);
      return reply(500, { error: "تعذر تحميل حالة تفعيل الجداول للمعلمين: " + detail });
    }
  }

  if (action === "timetable_portal_set_mode") {
    if (principal.type !== "admin") return reply(403, { error: "تخصيص عرض الجداول متاح لمدير النظام العام فقط." });
    const mode = String(body.mode || "");
    if (mode !== "all" && mode !== "custom") return reply(400, { error: "اختر وضع عرض صحيحاً." });
    if (mode === "custom" && !Array.isArray(body.teacherNames)) return reply(400, { error: "قائمة المعلمين المحددين غير صالحة." });
    const names: string[] = mode === "all" ? [] : Array.from(new Set<string>(
      (body.teacherNames as unknown[]).map(value => String(value || "").trim()).filter(Boolean)
    ));
    if (names.length > 500 || names.some(name => name.length > 160)) return reply(400, { error: "قائمة المعلمين المحددين تتجاوز الحدود المسموحة." });
    if (mode === "custom" && names.length === 0) return reply(400, { error: "اختر معلماً واحداً على الأقل للتفعيل المخصص." });
    try {
      if (names.length > 0) {
        const { data: teachers, error: teachersError } = await db.from("teachers").select("name").eq("role","teacher").in("name",names);
        if (teachersError) throw teachersError;
        const validNames = new Set((teachers || []).map((item: any) => String(item.name)));
        if (names.some(name => !validNames.has(name))) return reply(400, { error: "تتضمن القائمة اسماً غير موجود في فهرس المعلمين." });
      }
      const { data, error } = await db.from("teacher_timetable_portal_settings").upsert({
        id: true, enabled: true, selected_teacher_names: names, updated_by: principal.name, updated_at: new Date().toISOString(),
      }, { onConflict: "id" }).select("enabled,selected_teacher_names").single();
      if (error) throw error;
      return reply(200, { ok: true, enabled: data.enabled === true, mode, selectedTeacherNames: data.selected_teacher_names || [] });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "خطأ غير محدد";
      console.error("Teacher timetable portal mode update failed:", detail);
      return reply(500, { error: "تعذر حفظ وضع عرض الجداول: " + detail });
    }
  }

  if (action === "timetable_portal_set_custom_teachers") {
    if (principal.type !== "admin") return reply(403, { error: "تخصيص عرض الجداول متاح لمدير النظام العام فقط." });
    if (!Array.isArray(body.teacherNames) || body.teacherNames.length > 500) {
      return reply(400, { error: "قائمة المعلمين المحددين غير صالحة." });
    }
    const names: string[] = Array.from(new Set<string>(
      (body.teacherNames as unknown[]).map(value => String(value || "").trim()).filter(Boolean)
    ));
    if (names.some(name => name.length > 160)) return reply(400, { error: "يوجد اسم معلم أطول من الحد المسموح." });
    try {
      if (names.length > 0) {
        const { data: teachers, error: teachersError } = await db.from("teachers").select("name").eq("role","teacher").in("name",names);
        if (teachersError) throw teachersError;
        const validNames = new Set((teachers || []).map((item: any) => String(item.name)));
        if (names.some(name => !validNames.has(name))) return reply(400, { error: "تتضمن القائمة اسماً غير موجود في فهرس المعلمين." });
      }
      const { data, error } = await db.from("teacher_timetable_portal_settings").upsert({
        id: true, selected_teacher_names: names, updated_by: principal.name, updated_at: new Date().toISOString(),
      }, { onConflict: "id" }).select("selected_teacher_names").single();
      if (error) throw error;
      return reply(200, { ok: true, selectedTeacherNames: data.selected_teacher_names || [] });
    } catch (error) {
      console.error("Teacher timetable custom visibility update failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر حفظ قائمة المعلمين المحددين." });
    }
  }

  if (action === "timetable_portal_set_enabled") {
    if (principal.type !== "admin") return reply(403, { error: "تفعيل خدمة الجدول الشخصي متاح للمدير العام فقط." });
    if (typeof body.enabled !== "boolean") return reply(400, { error: "حالة تفعيل خدمة الجدول غير صالحة." });
    try {
      const { data, error } = await db.from("teacher_timetable_portal_settings").upsert({
        id: true,
        enabled: body.enabled,
        updated_by: principal.name,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" }).select("enabled,updated_by,updated_at").single();
      if (error) throw error;
      return reply(200, { ok: true, enabled: data.enabled === true, updatedBy: data.updated_by, updatedAt: data.updated_at });
    } catch (error) {
      console.error("Teacher timetable portal toggle failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر تحديث حالة خدمة الجدول الشخصي." });
    }
  }

  if (action === "timetable_list_access") {
    if (principal.type !== "admin") return reply(403, { error: "إدارة صلاحيات الجداول متاحة لمدير النظام العام فقط." });
    try {
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
          principal_type: type, principal_name: String(item.name),
          category: typeof item.permissions?.category === "string" ? item.permissions.category : "",
          can_access: grant?.can_access === true,
          updated_by: grant?.updated_by || null, updated_at: grant?.updated_at || null,
        };
      });
      return reply(200, { users });
    } catch (error) {
      console.error("Timetable access list failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر تحميل صلاحيات الجداول." });
    }
  }

  if (action === "timetable_set_access") {
    if (principal.type !== "admin") return reply(403, { error: "إدارة صلاحيات الجداول متاحة لمدير النظام العام فقط." });
    const principalType = String(body.principalType || "");
    const principalName = String(body.principalName || "").trim();
    if (!["teacher", "custom"].includes(principalType) || !principalName || principalName.length > 160 || typeof body.canAccess !== "boolean") {
      return reply(400, { error: "بيانات صلاحية الجداول غير صالحة." });
    }
    try {
      const { data: target, error: targetError } = await db.from("teachers")
        .select("name,role").eq("name", principalName).maybeSingle();
      if (targetError) throw targetError;
      if (!target || (principalType === "custom" ? target.role !== "custom" : target.role !== "teacher")) {
        return reply(404, { error: "المستخدم المحدد غير موجود أو نوع حسابه لا يطابق الاختيار." });
      }
      const { error } = await db.from("timetable_access_permissions").upsert({
        principal_type: principalType, principal_name: principalName,
        can_access: body.canAccess, updated_by: principal.name, updated_at: new Date().toISOString(),
      }, { onConflict: "principal_type,principal_name" });
      if (error) throw error;
      return reply(200, { ok: true, principalType, principalName, canAccess: body.canAccess });
    } catch (error) {
      console.error("Timetable access permission update failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر تحديث صلاحية الجداول." });
    }
  }

  if (["timetable_parse_day","timetable_save_weekly_day","timetable_get_weekly_draft","timetable_activate_weekly_version"].includes(String(body.action || ""))) {
    try {
      if (body.action === "timetable_get_weekly_draft") {
        const { data: draft, error } = await db.from("timetable_weekly_versions")
          .select("id,version,expected_teacher_count,created_at")
          .eq("status", "draft").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (!draft) return reply(200, { ok: true, draft: null });
        const [cells, { data: dayAudits, error: auditError }] = await Promise.all([
          fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("weekday,teacher_source_name")
            .eq("version_id", draft.id).order("id").range(from,to)),
          db.from("timetable_weekly_audit").select("weekday").eq("version_id", draft.id).in("action", ["day_saved","day_replaced"]),
        ]);
        if (auditError) throw auditError;
        const rows = cells || [];
        return reply(200, { ok: true, draft: {
          id: draft.id, version: draft.version, expectedTeacherCount: draft.expected_teacher_count,
          weekdays: [...new Set((dayAudits || []).map((row: any) => String(row.weekday || "")))].filter(Boolean),
          teacherCount: new Set(rows.map((row: any) => String(row.teacher_source_name || ""))).size,
          cellCount: rows.length, createdAt: draft.created_at,
        }});
      }
      if (body.action === "timetable_activate_weekly_version") {
        if (principal.type !== "admin") return reply(403, { error: "اعتماد الجدول الرسمي متاح لمدير النظام العام فقط." });
        if (!validUuid(body.versionId)) return reply(400, { error: "رقم نسخة الجدول غير صالح." });
        const forceWithWarnings = body.forceWithWarnings === true;
        const [{ data: version, error: versionError }, { count: unclearCount, error: unclearError },
          classSourceCells, { data: savedDays, error: savedDaysError }, classNames, directory] = await Promise.all([
          db.from("timetable_weekly_versions").select("period_count").eq("id", body.versionId).eq("status", "draft").maybeSingle(),
          db.from("timetable_weekly_cells").select("version_id", { count: "exact", head: true }).eq("version_id", body.versionId).eq("cell_status", "unclear"),
          fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("weekday,period,cell_status,class_sections,subject,matched_teacher_name,teacher_source_name,source_data")
            .eq("version_id", body.versionId).order("id").range(from,to)),
          db.from("timetable_weekly_audit").select("weekday").eq("version_id", body.versionId).in("action", ["day_saved","day_replaced"]),
          schoolClassDirectory(),
          teacherDirectory(),
        ]);
        if (versionError) throw versionError;
        if (unclearError) throw unclearError;
        if (savedDaysError) throw savedDaysError;
        if (!version) return reply(404, { error: "نسخة المسودة غير موجودة أو لم تعد قابلة للاعتماد." });
        const savedWeekdays = Array.from(new Set((savedDays || []).map((item: any) => String(item.weekday || ""))));
        const cellWeekdays = Array.from(new Set((classSourceCells || []).map((item: any) => String(item.weekday || ""))));
        const auditHasFullWeek = DAYS.every(day => savedWeekdays.includes(day));
        const cellsHaveFullWeek = DAYS.every(day => cellWeekdays.includes(day));
        if (!auditHasFullWeek && !cellsHaveFullWeek) {
          return reply(409, { error: "لا يمكن نشر الجدول رسمياً قبل حفظ الأيام الخمسة أو استنساخ نسخة تحتوي عليها. الأيام المسجلة: " + (savedWeekdays.join("، ") || "لا توجد") + "؛ الأيام ذات الخانات: " + (cellWeekdays.join("، ") || "لا توجد") + "." });
        }
        const periodCount = Number(version.period_count || 7);
        const systemTeachers: SystemTeacher[] = directory.filter((item: any) => item.role === "teacher");
        const normalizedClassSourceCells = (classSourceCells || []).map((cell: any) => {
          const sourceData: any = cell.source_data && typeof cell.source_data === "object" ? cell.source_data : {};
          const sourceGroupNote = String(sourceData.sourceGroupNote || (String(sourceData.sourceNote || "").includes("مجموعة مادة اختيارية") ? sourceData.sourceNote : "") || "");
          return {
            ...cell,
            matched_teacher_name: resolveTimetableTeacherName(cell.matched_teacher_name, cell.teacher_source_name, systemTeachers),
            source_group_note: sourceGroupNote,
          };
        });
        const effectiveUnmatchedCount = normalizedClassSourceCells.filter((cell: any) => !cell.matched_teacher_name).length;
        const coverage = buildClassCoverage(normalizedClassSourceCells, classNames, periodCount);
        const warningCount = Number(unclearCount || 0) + effectiveUnmatchedCount +
          coverage.missingSlots + coverage.conflictSlots + coverage.unclearSlots;
        if (!forceWithWarnings && warningCount > 0) {
          return reply(409, {
            error: "توجد ملاحظات في الجدول. راجع التقرير أو اختر الاعتماد الرسمي مع الاحتفاظ بالملاحظات.",
            classValidation: coverage,
            unclearCells: Number(unclearCount || 0),
            unmatchedCells: effectiveUnmatchedCount,
          });
        }
        const warnings = {
          unclearCells: Number(unclearCount || 0),
          unmatchedCells: effectiveUnmatchedCount,
          missingClassSlots: coverage.missingSlots,
          classConflicts: coverage.conflictSlots,
          unclearClassSlots: coverage.unclearSlots,
          classCount: coverage.classCount,
          requiredSlots: coverage.requiredSlots,
          teachingLessons: coverage.teachingLessons,
          freeSlots: coverage.freeSlots,
          meetingSlots: coverage.meetingSlots,
        };
        const { data, error } = await db.rpc("activate_timetable_weekly_version", {
          p_payload: { version_id: body.versionId, actor_name: principal.name, force_with_warnings: forceWithWarnings, warnings },
        });
        if (error) throw error;
        return reply(200, { ok: true, result: data, classValidation: coverage, warnings });
      }
      const weekday = String(body.weekday || "");
      if (!DAYS.includes(weekday)) return reply(400, { error: "اختر يوماً دراسياً صحيحاً." });
      const directory = await teacherDirectory();
      const systemTeachers: SystemTeacher[] = directory.filter((t: any) => t.role === "teacher").map((t: any) => ({
        name: t.name, departmentId: t.departmentId, departmentName: t.departmentName,
      }));
      let parsed: any;
      let matchedTeachers: any[];
      if (Array.isArray(body.teachers)) {
        // Structured editor payload: values were explicitly reviewed by the administrator.
        // The SQL RPC still validates every teacher, cell, day, period and owner before writing.
        if (body.teachers.length > 500) return reply(400, { error: "عدد المعلمين في اليوم غير صالح." });
        matchedTeachers = body.teachers.map((teacher: any) => {
          const sourceName = String(teacher?.sourceName || "").trim();
          const matchedTeacherName = String(teacher?.matchedTeacherName || "").trim();
          const matchStatus = matchedTeacherName ? "matched" : (teacher?.matchStatus === "ambiguous" ? "ambiguous" : "unmatched");
          if (!sourceName || !Array.isArray(teacher?.cells) || ![7,8].includes(teacher.cells.length)) {
            throw new Error("بيانات المعلم أو حصصه غير مكتملة: يجب أن يحتوي على 7 أو 8 حصص.");
          }
          return { ...teacher, sourceName, matchedTeacherName: matchedTeacherName || null, matchStatus };
        });
        parsed = {
          weekday, teachers: matchedTeachers,
          totals: { teaching: 0, free: 0, meeting: 0, activity: 0, other: 0, unclear: 0 },
          totalCells: matchedTeachers.reduce((sum: number, teacher: any) => sum + teacher.cells.length, 0),
        };
        for (const teacher of matchedTeachers) for (const cell of teacher.cells) {
          if (!Number.isInteger(Number(cell.period)) || Number(cell.period) < 1 || Number(cell.period) > matchedTeachers[0].cells.length) {
            throw new Error("رقم حصة غير صالح في بيانات المعلم " + teacher.sourceName + ".");
          }
          if (!["teaching","free","meeting","activity","other","unclear"].includes(cell.status)
            || !Array.isArray(cell.classSections)
            || !("sourceClass" in cell) || !("sourceSubject" in cell) || !("sourceStatus" in cell)) {
            throw new Error("بيانات إحدى الخانات غير مكتملة للمعلم " + teacher.sourceName + ".");
          }
          parsed.totals[cell.status]++;
        }
      } else {
        const sourceText = String(body.text || "");
        if ((!sourceText.trim() && (body.allowEmptyDay !== true || principal.type !== "admin")) || sourceText.length > 500000) return reply(400, { error: "أدخل نص يوم دراسي صحيحاً، أو فعّل حفظ اليوم الفارغ بصلاحية المدير." });
        parsed = parseTimetableDay(weekday, sourceText);
        if (parsed.teachers.length > 500) throw new Error("عدد المعلمين في النص غير صالح.");
        matchedTeachers = parsed.teachers.map((teacher: any) => {
          const match = matchSystemTeacherName(teacher.sourceName, systemTeachers);
          return { ...teacher, matchedTeacherName: match.teacherName, matchStatus: match.matchStatus };
        });
      }
      const matchingTotals = {
        matched: matchedTeachers.filter((t) => t.matchStatus === "matched").length,
        unmatched: matchedTeachers.filter((t) => t.matchStatus === "unmatched").length,
        ambiguous: matchedTeachers.filter((t) => t.matchStatus === "ambiguous").length,
      };
      if (body.action === "timetable_parse_day") {
        return reply(200, { ok: true, weekday: parsed.weekday, teachers: matchedTeachers, totals: parsed.totals, totalCells: parsed.totalCells, matchingTotals });
      }
      const versionId = body.versionId == null || body.versionId === "" ? null : body.versionId;
      if (versionId !== null && !validUuid(versionId)) return reply(400, { error: "رقم المسودة غير صالح." });
      const { data, error } = await db.rpc("save_timetable_weekly_day", {
        p_payload: { version_id: versionId, weekday: parsed.weekday, teachers: matchedTeachers, period_count: matchedTeachers[0]?.cells?.length || Number(body.periodCount) || 7, actor_name: principal.name },
      });
      if (error) throw error;
      return reply(200, { ok: true, result: data, matchingTotals });
    } catch (error) {
      const detail = error && typeof error === "object"
        ? String((error as any).message || (error as any).details || (error as any).hint || (error as any).code || JSON.stringify(error))
        : String(error || "سبب غير محدد");
      console.error("Timetable day operation failed:", detail);
      return reply(400, { error: detail || "تعذر معالجة اليوم." });
    }
  }

  if (body.action === "timetable_class_vacancy_assign") {
    if (principal.type !== "admin") return reply(403, { error: "تعديل جداول الصفوف متاح لمدير النظام فقط." });
    try {
      const className = String(body.className || "").trim();
      const weekday = String(body.weekday || "").trim();
      const period = Number(body.period);
      const teacherName = String(body.teacherName || "").trim();
      const subject = String(body.subject || "").trim();
      if (!className || className.length > 100 || !DAYS.includes(weekday) ||
          !Number.isInteger(period) || period < 1 || period > 8 ||
          !teacherName || teacherName.length > 160 || !subject || subject.length > 160 ||
          (body.versionId != null && body.versionId !== "" && !validUuid(body.versionId))) {
        return reply(400, { error: "بيانات إسناد الحصة غير مكتملة أو غير صالحة." });
      }
      const { data, error } = await db.rpc("assign_timetable_class_vacancy", {
        p_payload: {
          class_name: className, weekday, period, teacher_name: teacherName,
          subject, actor_name: principal.name,
          version_id: validUuid(body.versionId) ? body.versionId : null,
        },
      });
      if (error) throw error;
      return reply(200, {
        ok: true,
        reviewRequired: data?.review_required === true,
        versionId: data?.version_id,
        version: data?.version,
        message: data?.review_required === true
          ? "حُفظ التعديل ذرياً في نسخة مراجعة جديدة. راجعها ثم اعتمدها لنشر التغيير."
          : "حُفظ الإسناد في المسودة مع سجل التدقيق ضمن عملية واحدة.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر إسناد الحصة.";
      console.error("Class vacancy assignment failed:", message);
      const status = /غير موجود|ليس لديه حصة فراغ|مسجل بالفعل|لا تقبل التعديل|يتجاوز عدد حصص/i.test(message) ? 409 : 400;
      return reply(status, { error: message });
    }
  }

  if (body.action === "timetable_class_weekly_get") {
    if (principal.type !== "admin") return reply(403, { error: "استعراض جداول الصفوف متاح لمدير النظام فقط." });
    try {
      const versionQuery = db.from("timetable_weekly_versions").select("id,version,status,activated_at,period_count");
      const { data: version, error: versionError } = await (validUuid(body.versionId) ? versionQuery.eq("id", body.versionId) : versionQuery.eq("status", "active")).maybeSingle();
      if (versionError) throw versionError;
      if (!version) return reply(404, { error: "لا توجد نسخة جدول معتمدة لعرض جداول الصفوف." });
      const [cells, { data: teacherIndex, error: teacherIndexError }, classNames] = await Promise.all([
        fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells")
          .select("weekday,period,cell_status,class_sections,subject,matched_teacher_name,teacher_source_name,source_data")
          .eq("version_id", version.id).order("weekday").order("period").order("id").range(from,to)),
        db.from("teachers").select("name").eq("role", "teacher").order("name"),
        schoolClassDirectory(),
      ]);
      if (teacherIndexError) throw teacherIndexError;
      // Resolve displayed teacher names only through the canonical teachers index.
      // PDF/source abbreviations are deliberately never shown as teacher names.
      const systemTeachers: SystemTeacher[] = (teacherIndex || []).map((teacher: any) => ({name:String(teacher.name||"").trim()})).filter((teacher: SystemTeacher)=>teacher.name);
      const indexedNames = new Map(systemTeachers.map(teacher => [timetableTeacherIdentityKey(teacher.name), teacher.name]));
      const indexedCells = (cells || []).map((cell: any) => {
        let matchedName = indexedNames.get(timetableTeacherIdentityKey(cell.matched_teacher_name)) || "";
        if (!matchedName && cell.teacher_source_name) {
          const resolved = matchSystemTeacherName(String(cell.teacher_source_name), systemTeachers);
          if (resolved.matchStatus === "matched") matchedName = resolved.teacherName || "";
        }
        const sourceData: any = cell.source_data && typeof cell.source_data === "object" ? cell.source_data : {};
        const sourceGroupNote = String(sourceData.sourceGroupNote || (String(sourceData.sourceNote || "").includes("مجموعة مادة اختيارية") ? sourceData.sourceNote : "") || "");
        return {...cell,matched_teacher_name:matchedName||null,source_group_note:sourceGroupNote};
      });
      const periodCount = Number(version.period_count || 7);
      const coverage = buildClassCoverage(indexedCells, classNames, periodCount);
      return reply(200,{ok:true,version,periodCount,weekdays:DAYS,classes:coverage.classes,coverage,teachers:(teacherIndex||[]).map((teacher:any)=>String(teacher.name||"").trim()).filter(Boolean)});
    } catch (error) {
      console.error("Class weekly timetable read failed:", error instanceof Error ? error.message : "unknown");
      return reply(500,{error:"تعذر إنشاء جداول الصفوف من النسخة المعتمدة."});
    }
  }

  if (body.action === "timetable_activity_report_data") {
    if (!hasTeacherActivityPermission) return reply(403, { error: "تحتاج إلى صلاحية إدارة المعلمين لعرض تقرير الالتزام." });
    try {
      const dateFrom = String(body.dateFrom || "").trim();
      const dateTo = String(body.dateTo || "").trim();
      if (!isValidSubstitutionDate(dateFrom) || !isValidSubstitutionDate(dateTo) || dateFrom > dateTo) {
        return reply(400, { error: "حدد فترة زمنية صحيحة للتقرير." });
      }
      const fromMs = Date.parse(dateFrom + "T00:00:00Z");
      const toMs = Date.parse(dateTo + "T00:00:00Z");
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs - fromMs > 366 * 86400000) {
        return reply(400, { error: "الفترة القصوى للتقرير 367 يوماً." });
      }
      const [directory, versionResult] = await Promise.all([
        teacherDirectory(),
        db.from("timetable_weekly_versions")
          .select("id,version,status,activated_at,period_count")
          .in("status", ["active", "superseded"])
          .not("activated_at", "is", null)
          .lte("activated_at", dateTo + "T23:59:59+04:00")
          .order("activated_at", { ascending: true }),
      ]);
      if (versionResult.error) throw versionResult.error;
      const allVersions = versionResult.data || [];
      const omanDate = (value:any) => {
        const date = new Date(String(value || ""));
        if (!Number.isFinite(date.getTime())) return "";
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(date);
        const part = (type:string) => parts.find((item:any) => item.type === type)?.value || "";
        return part("year") + "-" + part("month") + "-" + part("day");
      };
      const datedVersions = allVersions.map((version:any) => ({
        id: String(version.id),
        version: Number(version.version),
        activatedAt: version.activated_at,
        activatedDate: omanDate(version.activated_at),
        periodCount: Number(version.period_count || 7),
      })).filter((version:any) => version.activatedDate && version.activatedDate <= dateTo);
      const previousVersion = datedVersions.filter((version:any) => version.activatedDate < dateFrom).slice(-1);
      const inRangeVersions = datedVersions.filter((version:any) => version.activatedDate >= dateFrom);
      const relevantVersions = [...previousVersion, ...inRangeVersions];
      if (!relevantVersions.length) {
        return reply(200, { ok: true, version: null, versions: [], teachers: [], cells: [], assignments: [] });
      }
      const versionIds = relevantVersions.map((version:any) => version.id);
      const [cellGroups, rawAssignments] = await Promise.all([
        Promise.all(relevantVersions.map(async (version:any) => {
          const rows = await fetchAllTimetableCells((from,to) => db.from("timetable_weekly_cells")
            .select("version_id,matched_teacher_name,teacher_source_name,weekday,period,cell_status,class_sections,subject")
            .eq("version_id", version.id).order("id").range(from,to));
          return rows || [];
        })),
        fetchAllSubstitutionRows((from,to) => db.from("timetable_assignments")
          .select("version_id,teacher_name,absent_teacher_name,assignment_type,weekday,period,status,assignment_date,class_sections,subject")
          .in("version_id", versionIds).eq("assignment_type", "substitution")
          .gte("assignment_date", dateFrom).lte("assignment_date", dateTo)
          .order("assignment_date").order("period").order("id").range(from,to)),
      ]);
      const systemTeachers = directory.filter((teacher:any) => teacher.role === "teacher")
        .map((teacher:any) => ({ name: String(teacher.name || "").trim() })).filter((teacher:any) => teacher.name);
      const cells = cellGroups.flat().map((cell:any) => ({
        versionId: String(cell.version_id || ""),
        teacherName: resolveTimetableTeacherName(cell.matched_teacher_name, cell.teacher_source_name, systemTeachers),
        weekday: String(cell.weekday || ""),
        period: Number(cell.period),
        status: String(cell.cell_status || ""),
        classSections: Array.isArray(cell.class_sections) ? cell.class_sections : [],
        subject: String(cell.subject || ""),
      })).filter((cell:any) => cell.teacherName);
      const assignments = (rawAssignments || []).map((row:any) => ({
        versionId: String(row.version_id || ""),
        teacherName: String(row.teacher_name || "").trim(),
        absentTeacherName: String(row.absent_teacher_name || "").trim(),
        assignmentType: String(row.assignment_type || ""),
        weekday: String(row.weekday || ""),
        period: Number(row.period),
        status: String(row.status || ""),
        assignmentDate: row.assignment_date || null,
        classSections: Array.isArray(row.class_sections) ? row.class_sections : [],
        subject: String(row.subject || ""),
      }));
      return reply(200, {
        ok: true, version: relevantVersions[relevantVersions.length - 1],
        versions: relevantVersions,
        teachers: directory.filter((teacher:any) => teacher.role === "teacher").map((teacher:any) => String(teacher.name || "").trim()).filter(Boolean),
        cells, assignments,
      });
    } catch (error) {
      console.error("Teacher attendance compliance report data failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر تحميل بيانات الجدول والاحتياط لتقرير الالتزام." });
    }
  }

  if (body.action === "timetable_teacher_weekly_get") {
    try {
      const teacherName = String(body.teacherName || "").trim();
      if (!teacherName || teacherName.length > 160) return reply(400, { error: "أدخل اسم المعلم كاملاً." });
      if (principal.type !== "admin" && teacherName !== principal.name) {
        return reply(403, { error: "لا يمكنك استعراض جدول معلم آخر." });
      }
      let query = db.from("timetable_weekly_versions").select("id,version,status,activated_at,period_count");
      query = validUuid(body.versionId) ? query.eq("id", body.versionId) : query.eq("status", "active");
      const { data: version, error } = await query.maybeSingle();
      if (error) throw error;
      if (!version) return reply(404, { error: "لا توجد نسخة جدول مطلوبة." });
      const { data: cells, error: cellsError } = await db.from("timetable_weekly_cells")
        .select("weekday,period,cell_status,class_sections,subject,source_page,teacher_source_name,matched_teacher_name,match_status")
        .eq("version_id", version.id).eq("matched_teacher_name", teacherName).order("weekday").order("period").limit(WEEKLY_CELL_FETCH_LIMIT);
      if (cellsError) throw cellsError;
      const order = new Map(DAYS.map((day, i) => [day, i]));
      const sorted = (cells || []).sort((a: any,b: any) => (order.get(a.weekday) ?? 99)-(order.get(b.weekday) ?? 99) || Number(a.period)-Number(b.period));
      if (!sorted.length) return reply(404, { error: "لم يُعثر على جدول مرتبط بهذا الاسم." });
      return reply(200, { ok: true, teacherName, version, cells: sorted, expectedCellCount: 5 * Number(version.period_count || 7), actualCellCount: sorted.length, complete: sorted.length === 5 * Number(version.period_count || 7) });
    } catch (error) {
      console.error("Teacher weekly timetable read failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر استعراض جدول المعلم." });
    }
  }

  if (body.action === "teacher_substitution_get_today") {
    if (principal.type !== "teacher") return reply(403, { error: "هذا الإشعار متاح لحسابات المعلمين فقط." });
    try {
      const { date: today, weekday } = muscatDateAndWeekday();
      if (!DAYS.includes(weekday)) return reply(200, { ok: true, assignmentDate: today, weekday, assignments: [] });
      const { data: version, error: versionError } = await db.from("timetable_weekly_versions")
        .select("id").eq("status", "active").maybeSingle();
      if (versionError) throw versionError;
      if (!version) return reply(200, { ok: true, assignmentDate: today, weekday, assignments: [] });
      const { data: assignments, error: assignmentsError } = await db.from("timetable_assignments")
        .select("id,assignment_type,weekday,period,assignment_date,class_sections,subject,status")
        .eq("version_id", version.id).eq("teacher_name", principal.name)
        .eq("assignment_type", "substitution").eq("assignment_date", today)
        .eq("weekday", weekday).neq("status", "cancelled").order("period");
      if (assignmentsError) throw assignmentsError;
      return reply(200, {
        ok: true, assignmentDate: today, weekday,
        assignments: assignments || [],
      });
    } catch (error) {
      console.error("Teacher daily substitution notice failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر التحقق من تكليفات الاحتياط لهذا اليوم." });
    }
  }

  if (body.action === "teacher_timetable_get_own") {
    if (principal.type !== "teacher") return reply(403, { error: "الجدول الشخصي متاح لحسابات المعلمين المرتبطة فقط." });
    try {
      const { data: portalSetting, error: portalSettingError } = await db.from("teacher_timetable_portal_settings")
        .select("enabled,selected_teacher_names").eq("id", true).maybeSingle();
      if (portalSettingError) throw portalSettingError;
      if (portalSetting?.enabled !== true) {
        return reply(403, { error: "خدمة الجدول الشخصي غير مفعّلة حالياً من المدير العام." });
      }
      if (!canAccessTeacherTimetablePortal(true, portalSetting.selected_teacher_names, principal.name)) {
        return reply(403, { error: "الجدول الشخصي غير مفعّل لحسابك ضمن قائمة التفعيل المخصص." });
      }
      const { data: version, error } = await db.from("timetable_weekly_versions").select("id,version,status,activated_at,period_count").eq("status","active").maybeSingle();
      if (error) throw error;
      if (!version) return reply(200, { ok:true, teacherName: principal.name, version:null, cells:[], assignments:[] });
      const [allCells,{data:assignments,error:assignError},directory] = await Promise.all([
        fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("weekday,period,cell_status,class_sections,subject,source_page,matched_teacher_name,teacher_source_name")
          .eq("version_id",version.id).order("id").range(from,to)),
        db.from("timetable_assignments").select("id,assignment_type,weekday,period,assignment_date,class_sections,subject,absent_teacher_name,status").eq("version_id",version.id).eq("teacher_name",principal.name).neq("status","cancelled"),
        teacherDirectory(),
      ]);
      if (assignError) throw assignError;
      const systemTeachers: SystemTeacher[] = directory.filter((item: any) => item.role === "teacher");
      const ownCells = (allCells || []).filter((cell: any) =>
        resolveTimetableTeacherName(cell.matched_teacher_name, cell.teacher_source_name, systemTeachers) === principal.name
      ).map(({matched_teacher_name,teacher_source_name,...cell}: any) => cell);
      const order = new Map(DAYS.map((day,i)=>[day,i]));
      const sort = (a:any,b:any)=>(order.get(a.weekday)??99)-(order.get(b.weekday)??99)||a.period-b.period;
      return reply(200,{ok:true,teacherName:principal.name,version,cells:ownCells.sort(sort),assignments:(assignments||[]).sort(sort)});
    } catch (error) {
      console.error("Own timetable read failed:", error instanceof Error ? error.message : "unknown");
      return reply(500,{error:"تعذر تحميل الجدول الشخصي."});
    }
  }

  if (action === "timetable_substitution_departments") {
    if (principal.type !== "admin" && principal.type !== "teacher") return reply(403,{error:"اختيار قسم آخر متاح لموزّعي الاحتياط المعتمدين فقط."});
    const [directory, activeVersionResult] = await Promise.all([
      teacherDirectory(),
      db.from("timetable_weekly_versions").select("id").eq("status","active").maybeSingle(),
    ]);
    if(activeVersionResult.error)throw activeVersionResult.error;
    const activeVersionId=activeVersionResult.data?.id;
    if(!activeVersionId)return reply(200,{ok:true,departments:[]});
    const teachingCells=await fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells")
      .select("matched_teacher_name,teacher_source_name").eq("version_id",activeVersionId)
      .eq("cell_status","teaching").order("id").range(from,to));
    const systemTeachers: SystemTeacher[] = directory.filter((teacher:any)=>teacher.role==="teacher");
    const teachersInActiveTimetable=new Set((teachingCells||[]).map((cell:any)=>
      resolveTimetableTeacherName(cell.matched_teacher_name,cell.teacher_source_name,systemTeachers)
    ).filter(Boolean));
    const actor = directory.find((teacher:any)=>teacher.name===principal.name);
    if (principal.type !== "admin" && actor?.canManageSubstitutions !== true) return reply(403,{error:"لا تملك صلاحية اختيار بدلاء من قسم آخر."});
    const ownDepartment = String(actor?.departmentId||"");
    const departments = [...new Map(directory.filter((teacher:any)=>teacher.role==="teacher"&&teacher.departmentId&&
      teachersInActiveTimetable.has(teacher.name)&&(principal.type==="admin"||teacher.departmentId!==ownDepartment))
      .map((teacher:any)=>[String(teacher.departmentId),{
        id:String(teacher.departmentId),name:String(teacher.departmentName||teacher.departmentId),
        teachers:directory.filter((candidate:any)=>candidate.role==="teacher"&&String(candidate.departmentId)===String(teacher.departmentId)&&teachersInActiveTimetable.has(candidate.name)).map((candidate:any)=>({name:String(candidate.name)})).sort((a:any,b:any)=>a.name.localeCompare(b.name,"ar"))
      }])).values()].sort((a:any,b:any)=>a.name.localeCompare(b.name,"ar"));
    return reply(200,{ok:true,departments,actorDepartmentName:principal.type==="admin"?"":String(actor?.departmentName||"").trim()});
  }

  if (action === "timetable_reserve_stats_access_list") {
    if (principal.type !== "admin") return reply(403, { error: "إدارة صلاحية الإحصائيات العامة متاحة لمدير النظام العام فقط." });
    const [{ data: users, error: usersError }, { data: grants, error: grantsError }] = await Promise.all([
      db.from("teachers").select("name,role").in("role", ["teacher","custom"]).order("name"),
      db.from("timetable_reserve_stats_access").select("principal_type,principal_name,granted_by,updated_at"),
    ]);
    if (usersError) throw usersError;
    if (grantsError) throw grantsError;
    const granted = new Set((grants || []).map((row:any) => String(row.principal_type)+":"+String(row.principal_name)));
    return reply(200, { ok:true, users:(users||[]).map((user:any)=>({
      principalType:String(user.role), principalName:String(user.name),
      enabled:granted.has(String(user.role)+":"+String(user.name)),
    })) });
  }

  if (action === "timetable_reserve_stats_access_save") {
    if (principal.type !== "admin") return reply(403, { error: "إدارة صلاحية الإحصائيات العامة متاحة لمدير النظام العام فقط." });
    if (!Array.isArray(body.grants) || body.grants.length > 500) return reply(400,{error:"قائمة الصلاحيات غير صالحة."});
    const grants = body.grants.map((item:any)=>({
      principal_type:String(item?.principalType||""),
      principal_name:String(item?.principalName||"").trim(),
      enabled:item?.enabled===true,
    }));
    if (grants.some((item:any)=>!["teacher","custom"].includes(item.principal_type)||!item.principal_name||typeof item.enabled!=="boolean")) {
      return reply(400,{error:"توجد بيانات غير صالحة في قائمة الصلاحيات."});
    }
    const {data,error}=await db.rpc("set_timetable_reserve_stats_access",{p_payload:{actor_name:principal.name,grants}});
    if(error)throw error;
    return reply(200,{ok:true,result:data});
  }

  if (action === "timetable_substitution_reset_options") {
    if (principal.type !== "admin" && !(principal.type === "teacher" && hasReservePermission)) {
      return reply(403,{error:"عرض مواد تفريغ الاحتياط متاح لمدير النظام العام ومنسق المادة المخوّل فقط."});
    }
    const date=String(body.assignmentDate||"").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidSubstitutionDate(date)) return reply(400,{error:"اختر تاريخاً دراسياً صحيحاً."});
    const {data,error}=await db.from("timetable_assignments").select("subject,absent_teacher_name")
      .eq("assignment_type","substitution").eq("assignment_date",date)
      .in("status",["assigned","confirmed"]);
    if(error)throw error;
    let allowedSubjects: Set<string> | null = null;
    let allowedAbsentTeachers: Set<string> | null = null;
    if(principal.type === "teacher") {
      const directory=await teacherDirectory();
      const actor=directory.find((teacher:any)=>teacher.name===principal.name&&teacher.role==="teacher");
      if(!actor?.canManageSubstitutions||!actor.departmentId) return reply(403,{error:"حسابك غير مخوّل لإدارة احتياط قسم محدد."});
      allowedSubjects=new Set(await getActiveDepartmentSubjects(actor.departmentId));
      allowedAbsentTeachers=new Set(directory
        .filter((teacher:any)=>teacher.role==="teacher"&&teacher.departmentId===actor.departmentId)
        .map((teacher:any)=>teacher.name));
    }
    const subjects=[...new Set((data||[])
      .filter((row:any)=>!allowedAbsentTeachers||allowedAbsentTeachers.has(String(row.absent_teacher_name||"")))
      .map((row:any)=>String(row.subject||"").trim())
      .filter((subject:string)=>Boolean(subject)&&(!allowedSubjects||allowedSubjects.has(subject))))]
      .sort((a,b) => a.localeCompare(b,"ar"));
    return reply(200,{ok:true,subjects});
  }

  if (action === "timetable_substitution_reset") {
    const mode=String(body.mode||"");
    const date=String(body.assignmentDate||"").trim();
    const subject=String(body.subject||"").trim();
    const isSystemAdmin=principal.type==="admin"&&principal.name==="مدير النظام العام";
    if(!isSystemAdmin && !(principal.type==="teacher"&&hasReservePermission&&mode==="subject_day")) {
      return reply(403,{error:"منسق المادة يستطيع إلغاء احتياط مادته في يوم محدد فقط، والتفريغ الشامل لمدير النظام العام."});
    }
    if(mode==="subject_day" && (!/^\d{4}-\d{2}-\d{2}$/.test(date)||!isValidSubstitutionDate(date)||!subject||subject.length>160)) {
      return reply(400,{error:"حدد التاريخ والمادة المراد تفريغ احتياطها."});
    }
    if(!["subject_day","all_active"].includes(mode)) return reply(400,{error:"نوع التفريغ غير معروف."});
    let actorDepartmentId="";
    if(!isSystemAdmin) {
      const directory=await teacherDirectory();
      const actor=directory.find((teacher:any)=>teacher.name===principal.name&&teacher.role==="teacher");
      if(!actor?.canManageSubstitutions||!actor.departmentId) return reply(403,{error:"لا تملك صلاحية إدارة احتياط مادة محددة."});
      actorDepartmentId=actor.departmentId;
      const allowedSubjects=new Set(await getActiveDepartmentSubjects(actorDepartmentId));
      if(!allowedSubjects.has(subject)) return reply(403,{error:"لا يمكنك إلغاء احتياط مادة خارج قسمك."});
    }
    const {data,error}=await db.rpc("reset_timetable_substitution_records",{p_payload:{
      actor_name:principal.name,actor_type:isSystemAdmin?"admin":"teacher",
      actor_department_id:actorDepartmentId,mode,assignment_date:mode==="subject_day"?date:null,
      subject:mode==="subject_day"?subject:null,
    }});
    if(error)throw error;
    return reply(200,{ok:true,result:data});
  }

  if (["timetable_substitution_preview","timetable_substitution_save","timetable_substitution_cancel","timetable_substitution_batch_preview","timetable_substitution_batch_save","timetable_substitution_stats","timetable_substitution_archive","timetable_substitution_update","timetable_substitution_update_batch","timetable_substitution_cancel_batch"].includes(String(body.action || ""))) {
    try {
      const actionName=String(body.action||"");
      const todayInMuscat=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const weekday = String(body.weekday || "");
      const weekdayOptionalActions=new Set(["timetable_substitution_update","timetable_substitution_update_batch"]);
      if (!DAYS.includes(weekday) && !weekdayOptionalActions.has(actionName)) return reply(400,{error:"اختر يوماً دراسياً صحيحاً."});
      const {data:activeVersion,error:versionError}=await db.from("timetable_weekly_versions").select("id,version,status,period_count").eq("status","active").maybeSingle();
      if (versionError) throw versionError;
      if (!activeVersion) return reply(200,{ok:true,active:false,absentTeachers:[],lessons:[]});
      const [directory,dayCells,weeklyLoad,pointsLedger]=await Promise.all([
        teacherDirectory(),
        fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("id,matched_teacher_name,weekday,period,cell_status,class_sections,subject")
          .eq("version_id",activeVersion.id).eq("weekday",weekday).order("id").range(from,to)),
        fetchAllTimetableCells((from,to)=>db.from("timetable_weekly_cells").select("matched_teacher_name,teacher_source_name,cell_status,weekday,period")
          .eq("version_id",activeVersion.id).order("id").range(from,to)),
        fetchAllSubstitutionRows((from,to)=>db.from("timetable_substitution_points_ledger").select("teacher_name,points_delta")
          .order("id").range(from,to)),
      ]);
      const weeklyQuotaByTeacher=countTeacherTeachingPeriods((weeklyLoad||[]).filter((cell:any)=>cell.matched_teacher_name).map((cell:any)=>({
        teacherId:String(cell.matched_teacher_name),weekday:String(cell.weekday||""),period:Number(cell.period),
        className:"",status:cell.cell_status,
      })));
      const systemTeachersForReserve: SystemTeacher[] = directory
        .filter((teacher:any)=>teacher.role==="teacher")
        .map((teacher:any)=>({name:String(teacher.name||"").trim()}))
        .filter((teacher:SystemTeacher)=>teacher.name);
      const activeTeachingTeacherNames = new Set((weeklyLoad||[])
        .filter((cell:any)=>cell.cell_status==="teaching")
        .map((cell:any)=>resolveTimetableTeacherName(cell.matched_teacher_name,cell.teacher_source_name,systemTeachersForReserve))
        .filter((name:string|null):name is string=>Boolean(name)));
      const actorDirectoryEntry=directory.find((t:any)=>t.name===principal.name);
      const actorDepartmentId=actorDirectoryEntry?.departmentId||"";
      if(principal.type!=="admin"&&!actorDepartmentId&&!principal.schoolwideReserveStats)return reply(403,{error:"حسابك غير مرتبط بقسم واضح في دليل المعلمين. راجع مدير النظام."});
      const absentTeacherName=String(body.absentTeacherName||"").trim();
      const includeOtherDepartments=canIncludeOtherDepartments(principal.type,body.includeOtherDepartments,actorDirectoryEntry?.canManageSubstitutions===true);
      const otherDepartmentId=String(body.otherDepartmentId||"").trim();
      const otherTeacherNames=Array.isArray(body.otherTeacherNames)?Array.from(new Set<string>(body.otherTeacherNames.map((name:any)=>String(name||"").trim()).filter(Boolean))):[];
      const requiresExplicitOtherTeachers=includeOtherDepartments&&["timetable_substitution_preview","timetable_substitution_save","timetable_substitution_batch_preview","timetable_substitution_batch_save"].includes(String(body.action||""));
      if(requiresExplicitOtherTeachers&&!otherTeacherNames.length)return reply(400,{error:"حدد معلماً واحداً على الأقل من القسم المساند أولاً."});
      if(requiresExplicitOtherTeachers&&otherTeacherNames.some((name:string)=>!directory.some((teacher:any)=>teacher.role==="teacher"&&teacher.name===name&&teacher.departmentId===otherDepartmentId&&activeTeachingTeacherNames.has(name))))return reply(403,{error:"تتضمن قائمة الاختيار معلماً لا ينتمي إلى القسم المحدد أو لا يملك حصة تدريس في الجدول النشط."});
      if(includeOtherDepartments && !otherDepartmentId && ["timetable_substitution_preview","timetable_substitution_batch_preview"].includes(String(body.action||""))) {
        return reply(400,{error:"اختر القسم الذي تريد الاستعانة بأحد معلميه أولاً."});
      }
      if(includeOtherDepartments && otherDepartmentId && !directory.some((teacher:any)=>
        teacher.role==="teacher"&&teacher.departmentId===otherDepartmentId&&activeTeachingTeacherNames.has(teacher.name))) {
        return reply(400,{error:"القسم المحدد لا يضم معلماً لديه حصة تدريس في الجدول النشط."});
      }
      if (body.action==="timetable_substitution_cancel") {
        if (!validUuid(body.assignmentId)) return reply(400,{error:"رقم تكليف الاحتياط غير صالح."});
        const {data:assignment,error}=await db.from("timetable_assignments").select("id,version_id,absent_teacher_name,weekday,assignment_date,status").eq("id",body.assignmentId).eq("version_id",activeVersion.id).eq("assignment_type","substitution").maybeSingle();
        if(error)throw error;
        const cancellationDate=String(body.assignmentDate||"");
        if(!assignment||assignment.weekday!==weekday||String(assignment.assignment_date||"")!==cancellationDate)return reply(404,{error:"تكليف الاحتياط غير موجود في التاريخ المحدد."});
        if(cancellationDate!==todayInMuscat||!["assigned","confirmed"].includes(String(assignment.status||"")))return reply(409,{error:"يمكن حذف تكليف الاحتياط النشط خلال يومه فقط، وحتى نهاية اليوم بتوقيت سلطنة عمان."});
        const {data,error:cancelError}=await db.rpc("cancel_timetable_substitution",{p_payload:{assignment_id:body.assignmentId,actor_name:principal.name,actor_type:principal.type}});
        if(cancelError)throw cancelError;
        return reply(200,{ok:true,assignment:data});
      }
      if (body.action==="timetable_substitution_cancel_batch") {
        const rawIds=Array.isArray(body.assignmentIds)?body.assignmentIds.map((value:any)=>String(value||"")):[];
        const assignmentDate=String(body.assignmentDate||"").trim();
        const absentName=String(body.absentTeacherName||"").trim();
        if(!rawIds.length||rawIds.length>500||rawIds.some((id:string)=>!validUuid(id))||new Set(rawIds).size!==rawIds.length||
          !absentName||!isValidSubstitutionDate(assignmentDate)) {
          return reply(400,{error:"حدد سجلات توزيع المعلم الغائب وتاريخها بصورة صحيحة."});
        }
        if(assignmentDate!==todayInMuscat)return reply(409,{error:"يمكن حذف التوزيع خلال يومه فقط، وحتى نهاية اليوم بتوقيت سلطنة عمان."});
        const {data:batchRows,error:batchRowsError}=await db.from("timetable_assignments")
          .select("id,version_id,absent_teacher_name,weekday,assignment_date,status")
          .in("id",rawIds).eq("version_id",activeVersion.id).eq("assignment_type","substitution");
        if(batchRowsError)throw batchRowsError;
        if(!batchRows||batchRows.length!==rawIds.length)return reply(404,{error:"تعذر العثور على جميع حصص التوزيع المطلوب حذفه."});
        if(batchRows.some((row:any)=>row.absent_teacher_name!==absentName||row.assignment_date!==assignmentDate||
          row.weekday!==weekday||!["assigned","confirmed"].includes(String(row.status||"")))) {
          return reply(409,{error:"تحتوي القائمة على حصص لا تنتمي إلى توزيع المعلم والتاريخ المحددين أو لم تعد نشطة."});
        }
        const {data,error:batchCancelError}=await db.rpc("cancel_timetable_substitution_batch",{p_payload:{
          assignment_ids:rawIds,actor_name:principal.name,actor_type:principal.type
        }});
        if(batchCancelError)throw batchCancelError;
        return reply(200,{ok:true,result:data,cancelledCount:batchRows.length});
      }

      if (absentTeacherName) {
        const absent=directory.find((t:any)=>t.name===absentTeacherName&&t.role==="teacher");
        if(!absent)return reply(404,{error:"المعلم المحدد غير موجود في دليل المعلمين."});
        if(principal.type!=="admin"&&absent.departmentId!==actorDepartmentId&&!hasReservePermission)return reply(403,{error:"يمكنك إدارة احتياط معلمي قسمك فقط إلا إذا كنت مخولاً بإدارة الاحتياط على مستوى المدرسة."});
      }
      if(body.action==="timetable_substitution_save") {
        const period=Number(body.period), assignmentDate=String(body.assignmentDate||""), substitute=String(body.substituteTeacherName||"").trim();
        if(!absentTeacherName||!substitute||!Number.isInteger(period)||period<1||period>Number(activeVersion.period_count||7)||!/^\d{4}-\d{2}-\d{2}$/.test(assignmentDate))return reply(400,{error:"حدد التاريخ والمعلم الغائب والبديل والحصة."});
        const substituteTeacher=directory.find((teacher:any)=>teacher.name===substitute&&teacher.role==="teacher");
        if(!substituteTeacher||!activeTeachingTeacherNames.has(substituteTeacher.name))return reply(404,{error:"المعلم البديل غير موجود ضمن معلمي التدريس في الجدول النشط."});
        const absentDepartmentId=directory.find((teacher:any)=>teacher.name===absentTeacherName&&teacher.role==="teacher")?.departmentId||"";
        const isSelectedSupportingTeacher=includeOtherDepartments&&substituteTeacher.departmentId===otherDepartmentId&&otherTeacherNames.includes(substituteTeacher.name);
        if(substituteTeacher.departmentId!==absentDepartmentId&&!isSelectedSupportingTeacher)return reply(403,{error:"يجب أن يكون البديل من قسم المعلم الغائب أو من المعلمين المحددين في القسم المساند."});
        const reserveReason=String(body.reserveReason||"").trim().slice(0,500)||"-";
        const {data,error}=await db.rpc("create_timetable_substitution_with_reason",{p_payload:{version_id:activeVersion.id,weekday,period,assignment_date:assignmentDate,absent_teacher_name:absentTeacherName,substitute_teacher_name:substitute,actor_name:principal.name,actor_type:principal.type,include_other_departments:includeOtherDepartments,reserve_reason:reserveReason}});
        if(error)throw error;
        return reply(201,{ok:true,assignment:data});
      }
      const date=String(body.assignmentDate||"");
      if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))return reply(400,{error:"تاريخ الغياب غير صالح."});
      const absentTeachers=getVisibleAbsentTeachers(dayCells.map((c:any)=>({matchedTeacherName:c.matched_teacher_name?String(c.matched_teacher_name):null,status:String(c.cell_status||"")})),directory,actorDepartmentId,principal.type==="admin");
      if(!absentTeacherName && !["timetable_substitution_batch_preview","timetable_substitution_batch_save","timetable_substitution_stats","timetable_substitution_archive","timetable_substitution_update","timetable_substitution_update_batch"].includes(String(body.action||"")))return reply(200,{ok:true,active:true,version:activeVersion,absentTeachers});
      const timetable:TimetableEntry[]=dayCells.filter((c:any)=>c.matched_teacher_name).map((c:any)=>({teacherId:String(c.matched_teacher_name),weekday:String(c.weekday),period:Number(c.period),className:Array.isArray(c.class_sections)?c.class_sections.join("، "):"",subject:String(c.subject||""),status:c.cell_status}));
      const assignmentRows=await fetchAllSubstitutionRows((from,to)=>db.from("timetable_assignments")
        .select("id,version_id,source_cell_id,teacher_name,absent_teacher_name,assignment_type,weekday,period,status,assignment_date,class_sections,subject,reserve_reason")
        .order("id").range(from,to));
      // Keep the full available history for fair cumulative ranking. The policy
      // separately scopes hard double-booking checks to the selected date/cell.
      const assignments:SubstitutionAssignment[]=(assignmentRows||[]).map((x:any)=>({substituteTeacherId:String(x.teacher_name),absentTeacherId:String(x.absent_teacher_name||""),weekday:String(x.weekday),period:Number(x.period),assignmentDate:x.assignment_date||null,versionId:String(x.version_id),assignmentType:String(x.assignment_type||""),status:x.status}));
      if(body.action==="timetable_substitution_archive"){
        const requestedDate=String(body.assignmentDate||"").trim();
        if(requestedDate&&!isValidSubstitutionDate(requestedDate))return reply(400,{error:"تاريخ الأرشيف غير صالح."});
        const visibleNames=new Set(directory.filter((teacher:any)=>teacher.role==="teacher"&&
          (principal.type==="admin"||hasReservePermission||teacher.departmentId===actorDepartmentId)).map((teacher:any)=>teacher.name));
        const archive=(assignmentRows||[]).filter((row:any)=>row.assignment_type==="substitution"&&
          visibleNames.has(String(row.absent_teacher_name||""))&&
          (!requestedDate||String(row.assignment_date||"")===requestedDate))
          .sort((a:any,b:any)=>String(b.assignment_date||"").localeCompare(String(a.assignment_date||""))||
            Number(a.period)-Number(b.period)||String(a.absent_teacher_name||"").localeCompare(String(b.absent_teacher_name||""),"ar"))
          .map((row:any)=>({
            id:String(row.id),assignmentDate:row.assignment_date||null,weekday:String(row.weekday||""),
            canEdit:String(row.version_id)===String(activeVersion.id)&&String(row.assignment_date||"")===todayInMuscat&&["assigned","confirmed"].includes(String(row.status||"")),
            absentTeacherName:String(row.absent_teacher_name||""),substituteTeacherName:String(row.teacher_name||""),
            period:Number(row.period),className:Array.isArray(row.class_sections)?row.class_sections.join("، "):"",
            subject:String(row.subject||""),reason:String(row.reserve_reason||"-"),
            status:String(row.status||"assigned"),versionId:String(row.version_id||""),
          }));
        return reply(200,{ok:true,archive});
      }
      if(body.action==="timetable_substitution_update_batch"){
        const proposed=Array.isArray(body.assignments)?body.assignments:[];
        if(!proposed.length||proposed.length>500)return reply(400,{error:"حدد تعديلات الأرشيف قبل الحفظ."});
        const normalized=proposed.map((item:any)=>({
          assignmentId:String(item?.assignmentId||""),
          absentTeacherName:String(item?.absentTeacherName||"").trim(),
          period:item?.period==null?null:Number(item.period),
          substituteTeacherName:String(item?.substituteTeacherName||"").trim(),
          reserveReason:String(item?.reserveReason||"").trim().slice(0,500)||"-",
        }));
        if(normalized.some((item:any)=>!validUuid(item.assignmentId)||!item.substituteTeacherName||
          (item.period!==null&&(!Number.isInteger(item.period)||item.period<1||item.period>Number(activeVersion.period_count||7))))){
          return reply(400,{error:"توجد بيانات غير مكتملة أو حصة غير صالحة في تعديلات الأرشيف."});
        }
        const {data,error}=await db.rpc("replace_timetable_substitution_batch_with_reason",{p_payload:{
          assignments:normalized,actor_name:principal.name,actor_type:principal.type,
          include_other_departments:includeOtherDepartments||principal.type==="admin",
        }});
        if(error)throw error;
        return reply(200,{ok:true,result:data,updatedCount:normalized.length});
      }
      if(body.action==="timetable_substitution_update"){
        const assignmentId=String(body.assignmentId||"");
        const substituteTeacherName=String(body.substituteTeacherName||"").trim();
        const absentTeacherName=String(body.absentTeacherName||"").trim();
        const reserveReason=String(body.reserveReason||"").trim().slice(0,500)||"-";
        if(!validUuid(assignmentId)||!substituteTeacherName)return reply(400,{error:"حدد سجل الاحتياط والبديل الجديد."});
        const {data:editableAssignment,error:editableError}=await db.from("timetable_assignments")
          .select("id,version_id,assignment_date,status,period").eq("id",assignmentId)
          .eq("version_id",activeVersion.id).eq("assignment_type","substitution").maybeSingle();
        if(editableError)throw editableError;
        if(!editableAssignment||String(editableAssignment.assignment_date||"")!==todayInMuscat||
          !["assigned","confirmed"].includes(String(editableAssignment.status||""))){
          return reply(409,{error:"لا يمكن تعديل هذا السجل إلا خلال يومه، ويجب أن يكون تكليفاً نشطاً في الجدول المعتمد."});
        }
        const requestedPeriod=body.period==null?Number(editableAssignment.period):Number(body.period);
        if(!Number.isInteger(requestedPeriod)||requestedPeriod<1||requestedPeriod>Number(activeVersion.period_count||7)){
          return reply(400,{error:"اختر حصة صحيحة ضمن حصص اليوم."});
        }
        const rpcName=absentTeacherName?"reassign_timetable_substitution_absent_with_reason":"replace_timetable_substitution_with_reason";
        const {data,error}=await db.rpc(rpcName,{p_payload:{
          assignment_id:assignmentId,absent_teacher_name:absentTeacherName,period:requestedPeriod,
          substitute_teacher_name:substituteTeacherName,reserve_reason:reserveReason,
          actor_name:principal.name,actor_type:principal.type,include_other_departments:includeOtherDepartments,
        }});
        if(error)throw error;
        return reply(200,{ok:true,result:data});
      }
      const pointsBalanceByTeacher=new Map<string,number>();
      for(const entry of pointsLedger||[]){
        const name=String(entry.teacher_name||"");
        pointsBalanceByTeacher.set(name,(pointsBalanceByTeacher.get(name)||0)+Number(entry.points_delta||0));
      }
      const candidates:SubstitutionTeacher[]=directory.filter((t:any)=>t.role==="teacher"&&activeTeachingTeacherNames.has(t.name)).map((t:any)=>({
        id:t.name,name:t.name,departmentId:t.departmentId,
        weeklyQuota:weeklyQuotaByTeacher.get(t.name)||0,
        pointsBalance:pointsBalanceByTeacher.get(t.name)||0,
      }));
      if(body.action==="timetable_substitution_batch_save"){
        const assignmentDate=String(body.assignmentDate||"");
        const selectedNames:string[]=Array.isArray(body.absentTeacherNames)?Array.from(new Set<string>(body.absentTeacherNames.map((name:any)=>String(name||"").trim()).filter(Boolean))):[];
        const proposed=Array.isArray(body.assignments)?body.assignments:[];
        if(!isValidSubstitutionDate(assignmentDate)||!selectedNames.length||!proposed.length||proposed.length>500){
          return reply(400,{error:"حدد تاريخ الغياب والمعلمين الغائبين وتوزيع الحصص قبل الحفظ."});
        }
        if(selectedNames.some((name:string)=>!absentTeachers.includes(name))){
          return reply(403,{error:"تتضمن القائمة معلماً خارج نطاق صلاحيتك أو لا توجد له حصة تدريس في هذا اليوم."});
        }
        const normalized=proposed.map((item:any)=>({
          absentTeacherName:String(item?.absentTeacherName||"").trim(),
          substituteTeacherName:String(item?.substituteTeacherName||"").trim(),
          period:Number(item?.period),
          reserveReason:String(item?.reserveReason||"").trim().slice(0,500)||"-",
        }));
        if(normalized.some((item:any)=>!selectedNames.includes(item.absentTeacherName)||!item.substituteTeacherName||!Number.isInteger(item.period)||item.period<1||item.period>Number(activeVersion.period_count||7))){
          return reply(400,{error:"توجد حصة غير مكتملة أو معلم بديل غير صالح في التوزيع المقترح."});
        }
        for(const item of normalized){
          const substituteTeacher=directory.find((teacher:any)=>teacher.name===item.substituteTeacherName&&teacher.role==="teacher");
          const absentTeacher=directory.find((teacher:any)=>teacher.name===item.absentTeacherName&&teacher.role==="teacher");
          if(!substituteTeacher||!activeTeachingTeacherNames.has(substituteTeacher.name)||!absentTeacher)return reply(404,{error:"تعذر العثور على المعلم الغائب أو البديل ضمن معلمي الجدول النشط."});
          const isSelectedSupportingTeacher=includeOtherDepartments&&substituteTeacher.departmentId===otherDepartmentId&&otherTeacherNames.includes(substituteTeacher.name);
          if(substituteTeacher.departmentId!==absentTeacher.departmentId&&!isSelectedSupportingTeacher){
            return reply(403,{error:"يجب أن يكون البديل من قسم المعلم الغائب أو من المعلمين المحددين في القسم المساند."});
          }
        }
        const {data,error}=await db.rpc("create_timetable_substitution_batch_with_reason",{p_payload:{
          version_id:activeVersion.id,weekday,assignment_date:assignmentDate,absent_teacher_names:selectedNames,
          assignments:normalized,actor_name:principal.name,actor_type:principal.type,
          include_other_departments:includeOtherDepartments,
        }});
        if(error)throw error;
        return reply(201,{ok:true,result:data,assignmentCount:normalized.length});
      }
      if(body.action==="timetable_substitution_batch_preview"){
        const selectedNames:string[]=Array.isArray(body.absentTeacherNames)?Array.from(new Set<string>(body.absentTeacherNames.map((name:any)=>String(name||"").trim()).filter(Boolean))):[];
        const assignmentDate=String(body.assignmentDate||"");
        if(!selectedNames.length||selectedNames.length>100||!isValidSubstitutionDate(assignmentDate)){
          return reply(400,{error:"اختر معلماً غائباً واحداً على الأقل وحدد تاريخ الغياب."});
        }
        if(selectedNames.some((name:string)=>!absentTeachers.includes(name))){
          return reply(403,{error:"تتضمن القائمة معلماً خارج نطاق صلاحيتك أو لا توجد له حصة تدريس في هذا اليوم."});
        }
        const selectedAbsent=selectedNames.map((name:string)=>directory.find((teacher:any)=>teacher.name===name&&teacher.role==="teacher"))
          .filter(Boolean).map((teacher:any)=>({id:teacher.name,name:teacher.name,departmentId:teacher.departmentId}));
        const selectedAbsentDepartmentIds=new Set(selectedAbsent.map((teacher:any)=>teacher.departmentId));
        const scopedCandidates=candidates.filter((teacher:any)=>selectedAbsentDepartmentIds.has(teacher.departmentId)||
          (includeOtherDepartments&&teacher.departmentId===otherDepartmentId&&otherTeacherNames.includes(teacher.name)));
        const plan=buildBatchSubstitutionPlan({
          teachers:scopedCandidates,timetable,assignments,absentTeachers:selectedAbsent,weekday,
          assignmentDate,versionId:activeVersion.id,includeOtherDepartments:includeOtherDepartments||false,
          otherDepartmentTeacherIds:includeOtherDepartments?otherTeacherNames:[],
        });
        const existingAssignments=(assignmentRows||[]).filter((row:any)=>
          row.assignment_type==="substitution"&&selectedNames.includes(String(row.absent_teacher_name||""))&&
          row.weekday===weekday&&row.status!=="cancelled"&&
          (row.assignment_date?String(row.assignment_date)===assignmentDate:String(row.version_id)===String(activeVersion.id))
        ).map((row:any)=>({
          id:String(row.id),assignmentDate:row.assignment_date||assignmentDate,canEdit:String(row.version_id)===String(activeVersion.id),
          absentTeacherName:String(row.absent_teacher_name||""),substituteTeacherName:String(row.teacher_name||""),
          weekday:String(row.weekday),period:Number(row.period),
          className:Array.isArray(row.class_sections)?row.class_sections.join("، "):"",
          reason:String(row.reserve_reason||"-"),status:String(row.status||"assigned"),
        }));
        return reply(200,{ok:true,active:true,version:activeVersion,weekday,assignmentDate,absentTeachers:selectedNames,existingAssignments,...plan});
      }
      if(body.action==="timetable_substitution_stats"){
        const visible=directory.filter((teacher:any)=>teacher.role==="teacher"&&(principal.type==="admin"||principal.schoolwideReserveStats===true||teacher.departmentId===actorDepartmentId));
        const activeRows=(assignmentRows||[]).filter((row:any)=>row.assignment_type==="substitution"&&row.status!=="cancelled");
        const stats=visible.map((teacher:any)=>{
          const own=activeRows.filter((row:any)=>String(row.teacher_name)===teacher.name);
          const points=pointsBalanceByTeacher.get(teacher.name)||0;
          const periods=Array.from({length:8},(_,i)=>({period:i+1,count:own.filter((row:any)=>Number(row.period)===i+1).length}));
          const coveredAbsenceDays=new Set(activeRows.filter((row:any)=>String(row.absent_teacher_name)===teacher.name).map((row:any)=>String(row.assignment_date||row.weekday))).size;
          return {teacherName:teacher.name,pointsBalance:points,substitutionCount:own.length,coveredAbsenceDays,periods};
        });
        const ownStats=stats.find((item:any)=>item.teacherName===principal.name)||null;
        return reply(200,{ok:true,ownStats,teachers:stats,topPoints:[...stats].sort((a:any,b:any)=>b.pointsBalance-a.pointsBalance).slice(0,10),mostSubstitutions:[...stats].sort((a:any,b:any)=>b.substitutionCount-a.substitutionCount).slice(0,10),mostCoveredAbsenceDays:[...stats].sort((a:any,b:any)=>b.coveredAbsenceDays-a.coveredAbsenceDays).slice(0,10)});
      }
      const absent=directory.find((t:any)=>t.name===absentTeacherName);
      const lessons=getAbsentTeacherLessons(timetable,absentTeacherName,weekday);
      const lessonOptions=lessons.map((lesson)=>{
        const eligible=getAvailableSubstitutionCandidates({teachers:candidates,timetable,assignments,absentTeacherId:absentTeacherName,weekday,period:lesson.period,departmentId:absent?.departmentId||"",includeOtherDepartments:includeOtherDepartments||false,otherDepartmentTeacherIds:includeOtherDepartments?otherTeacherNames:[],assignmentDate:date||undefined,versionId:activeVersion.id});
        const sourceCell=dayCells.find((c:any)=>c.matched_teacher_name===absentTeacherName&&Number(c.period)===lesson.period);
        const existing=(assignmentRows||[]).find((x:any)=>x.source_cell_id===sourceCell?.id&&(!date||!x.assignment_date||x.assignment_date===date)&&x.status!=="cancelled");
        return {...lesson,candidates:eligible,assignment:existing?{id:existing.id,substituteTeacherName:String(existing.teacher_name),status:String(existing.status)}:null};
      });
      return reply(200,{ok:true,active:true,version:activeVersion,weekday,absentTeacherName,lessons:lessonOptions,includeOtherDepartments});
    } catch(error) {
      console.error("Substitution request failed:",error instanceof Error?error.message:"unknown");
      return reply(400,{error:error instanceof Error?error.message:"تعذر إتمام إجراء الاحتياط."});
    }
  }

  return reply(404, { error: "Unsupported timetable action." });
}
Deno.serve(async (req: Request) => {
  try { return await handle(req); }
  catch (error) {
    console.error("Timetable management request failed:", error instanceof Error ? error.message : "unknown");
    return reply(500, { error: "حدث خطأ داخلي في خدمة الجداول." });
  }
});
