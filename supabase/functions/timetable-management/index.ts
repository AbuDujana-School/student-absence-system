import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseTimetableDay, validateSchoolTeacherCount } from "./timetable_grid.ts";
import { matchSystemTeacherName, parseTimetableWorkbook, type SystemTeacher } from "./timetable_import.ts";
import { getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, type TimetableEntry, type SubstitutionAssignment, type SubstitutionTeacher } from "./substitution_policy.ts";
import { canUseTimetableAction, resolveTimetablePrincipal, type TimetableAuthStore, type TimetablePrincipal } from "./session_auth.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const DAYS = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
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
};

async function requirePrincipal(req: Request): Promise<TimetablePrincipal | null> {
  return resolveTimetablePrincipal(req.headers.get("authorization"), timetableAuthStore);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  })).filter((item: any) => item.name);
}
async function handle(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "Invalid request" }); }
  const principal = await requirePrincipal(req);
  if (!principal) return reply(401, { error: "انتهت جلسة الدخول أو لا تملك صلاحية الوصول إلى الجداول." });

  const action = String(body.action || "");
  if (!canUseTimetableAction(principal.type, action)) {
    return reply(403, { error: "يمكن لمنسق القسم المخوّل إدارة احتياط قسمه فقط؛ بقية عمليات تعديل الجداول متاحة لمدير النظام." });
  }

  if (["timetable_preview", "timetable_save_import"].includes(action)) {
    if (principal.type !== "admin") return reply(403, { error: "استيراد الجداول متاح لمدير النظام العام فقط." });
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
      return reply(413, { error: action === "timetable_preview"
        ? "حجم بيانات الجدول أكبر من الحد المسموح للمعاينة."
        : "حجم بيانات الجدول أكبر من الحد المسموح للاستيراد." });
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
      if (action === "timetable_preview") {
        return reply(200, {
          ok: true, fileName: String(body.fileName || "ملف Excel").slice(0, 180),
          importedAt: new Date().toISOString(), importedBy: principal.name, result: parsed,
        });
      }
      const { data, error } = await db.rpc("save_timetable_import", {
        p_payload: { file_name: String(body.fileName || "ملف Excel").slice(0, 180), actor_name: principal.name, result: parsed },
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
    return reply(200, { canAccess: true, isAdmin: principal.type === "admin", isTeacher: principal.type === "teacher" || principal.type === "custom" });
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
        const { data: cells, error: cellsError } = await db.from("timetable_weekly_cells")
          .select("weekday,teacher_source_name").eq("version_id", draft.id);
        if (cellsError) throw cellsError;
        const rows = cells || [];
        return reply(200, { ok: true, draft: {
          id: draft.id, version: draft.version, expectedTeacherCount: draft.expected_teacher_count,
          weekdays: [...new Set(rows.map((row: any) => String(row.weekday || "")))].filter(Boolean),
          teacherCount: new Set(rows.map((row: any) => String(row.teacher_source_name || ""))).size,
          cellCount: rows.length, createdAt: draft.created_at,
        }});
      }
      if (body.action === "timetable_activate_weekly_version") {
        if (!validUuid(body.versionId)) return reply(400, { error: "رقم نسخة الجدول غير صالح." });
        const { data, error } = await db.rpc("activate_timetable_weekly_version", {
          p_payload: { version_id: body.versionId, actor_name: principal.name },
        });
        if (error) throw error;
        return reply(200, { ok: true, result: data });
      }
      const weekday = String(body.weekday || "");
      const sourceText = String(body.text || "");
      if (!DAYS.includes(weekday)) return reply(400, { error: "اختر يوماً دراسياً صحيحاً." });
      if (!sourceText.trim() || sourceText.length > 500000) return reply(400, { error: "أدخل نص يوم دراسي صحيحاً." });
      const parsed = parseTimetableDay(weekday, sourceText);
      validateSchoolTeacherCount(parsed, 69);
      const directory = await teacherDirectory();
      const systemTeachers: SystemTeacher[] = directory.filter((t: any) => t.role === "teacher").map((t: any) => ({
        name: t.name, departmentId: t.departmentId, departmentName: t.departmentName,
      }));
      const matchedTeachers = parsed.teachers.map((teacher) => {
        const match = matchSystemTeacherName(teacher.sourceName, systemTeachers);
        return { ...teacher, matchedTeacherName: match.teacherName, matchStatus: match.matchStatus };
      });
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
        p_payload: { version_id: versionId, weekday: parsed.weekday, teachers: matchedTeachers, actor_name: principal.name },
      });
      if (error) throw error;
      return reply(200, { ok: true, result: data, matchingTotals });
    } catch (error) {
      console.error("Timetable day operation failed:", error instanceof Error ? error.message : "unknown");
      return reply(400, { error: error instanceof Error ? error.message : "تعذر معالجة اليوم." });
    }
  }

  if (body.action === "timetable_teacher_weekly_get") {
    try {
      const teacherName = String(body.teacherName || "").trim();
      if (!teacherName || teacherName.length > 160) return reply(400, { error: "أدخل اسم المعلم كاملاً." });
      if (principal.type !== "admin" && teacherName !== principal.name) {
        return reply(403, { error: "لا يمكنك استعراض جدول معلم آخر." });
      }
      let query = db.from("timetable_weekly_versions").select("id,version,status,activated_at");
      query = validUuid(body.versionId) ? query.eq("id", body.versionId) : query.eq("status", "active");
      const { data: version, error } = await query.maybeSingle();
      if (error) throw error;
      if (!version) return reply(404, { error: "لا توجد نسخة جدول مطلوبة." });
      const { data: cells, error: cellsError } = await db.from("timetable_weekly_cells")
        .select("weekday,period,cell_status,class_sections,subject,source_page,teacher_source_name,matched_teacher_name,match_status")
        .eq("version_id", version.id).eq("matched_teacher_name", teacherName).order("weekday").order("period");
      if (cellsError) throw cellsError;
      const order = new Map(DAYS.map((day, i) => [day, i]));
      const sorted = (cells || []).sort((a: any,b: any) => (order.get(a.weekday) ?? 99)-(order.get(b.weekday) ?? 99) || Number(a.period)-Number(b.period));
      if (!sorted.length) return reply(404, { error: "لم يُعثر على جدول مرتبط بهذا الاسم." });
      return reply(200, { ok: true, teacherName, version, cells: sorted, expectedCellCount: 35, actualCellCount: sorted.length, complete: sorted.length === 35 });
    } catch (error) {
      console.error("Teacher weekly timetable read failed:", error instanceof Error ? error.message : "unknown");
      return reply(500, { error: "تعذر استعراض جدول المعلم." });
    }
  }

  if (body.action === "teacher_timetable_get_own") {
    try {
      const { data: version, error } = await db.from("timetable_weekly_versions").select("id,version,status,activated_at").eq("status","active").maybeSingle();
      if (error) throw error;
      if (!version) return reply(200, { ok:true, teacherName: principal.name, version:null, cells:[], assignments:[] });
      const [{data:cells,error:cellsError},{data:assignments,error:assignError}] = await Promise.all([
        db.from("timetable_weekly_cells").select("weekday,period,cell_status,class_sections,subject,source_page").eq("version_id",version.id).eq("matched_teacher_name",principal.name),
        db.from("timetable_assignments").select("id,assignment_type,weekday,period,assignment_date,class_sections,subject,absent_teacher_name,status").eq("version_id",version.id).eq("teacher_name",principal.name).neq("status","cancelled"),
      ]);
      if (cellsError) throw cellsError;
      if (assignError) throw assignError;
      const order = new Map(DAYS.map((day,i)=>[day,i]));
      const sort = (a:any,b:any)=>(order.get(a.weekday)??99)-(order.get(b.weekday)??99)||a.period-b.period;
      return reply(200,{ok:true,teacherName:principal.name,version,cells:(cells||[]).sort(sort),assignments:(assignments||[]).sort(sort)});
    } catch (error) {
      console.error("Own timetable read failed:", error instanceof Error ? error.message : "unknown");
      return reply(500,{error:"تعذر تحميل الجدول الشخصي."});
    }
  }

  if (["timetable_substitution_preview","timetable_substitution_save","timetable_substitution_cancel"].includes(String(body.action || ""))) {
    try {
      const weekday = String(body.weekday || "");
      if (!DAYS.includes(weekday)) return reply(400,{error:"اختر يوماً دراسياً صحيحاً."});
      const {data:activeVersion,error:versionError}=await db.from("timetable_weekly_versions").select("id,version,status").eq("status","active").maybeSingle();
      if (versionError) throw versionError;
      if (!activeVersion) return reply(200,{ok:true,active:false,absentTeachers:[],lessons:[]});
      const [directory,dayCellsResult]=await Promise.all([
        teacherDirectory(),
        db.from("timetable_weekly_cells").select("id,matched_teacher_name,weekday,period,cell_status,class_sections,subject").eq("version_id",activeVersion.id).eq("weekday",weekday),
      ]);
      if (dayCellsResult.error) throw dayCellsResult.error;
      const dayCells=dayCellsResult.data||[];
      const actorDirectoryEntry=directory.find((t:any)=>t.name===principal.name);
      const actorDepartmentId=actorDirectoryEntry?.departmentId||"";
      if(principal.type!=="admin"&&!actorDepartmentId)return reply(403,{error:"حسابك غير مرتبط بقسم واضح في دليل المعلمين. راجع مدير النظام."});
      const absentTeacherName=String(body.absentTeacherName||"").trim();
      const includeOtherDepartments=body.includeOtherDepartments===true;
      if (body.action==="timetable_substitution_cancel") {
        if (!validUuid(body.assignmentId)) return reply(400,{error:"رقم تكليف الاحتياط غير صالح."});
        const {data:assignment,error}=await db.from("timetable_assignments").select("id,version_id,absent_teacher_name,weekday,assignment_date").eq("id",body.assignmentId).eq("version_id",activeVersion.id).eq("assignment_type","substitution").maybeSingle();
        if(error)throw error;
        const cancellationDate=String(body.assignmentDate||"");
        if(!assignment||assignment.weekday!==weekday||(assignment.assignment_date&&assignment.assignment_date!==cancellationDate))return reply(404,{error:"تكليف الاحتياط غير موجود في التاريخ المحدد."});
        const {data,error:cancelError}=await db.rpc("cancel_timetable_substitution",{p_payload:{assignment_id:body.assignmentId,actor_name:principal.name,actor_type:principal.type}});
        if(cancelError)throw cancelError;
        return reply(200,{ok:true,assignment:data});
      }
      if (absentTeacherName) {
        const absent=directory.find((t:any)=>t.name===absentTeacherName&&t.role==="teacher");
        if(!absent)return reply(404,{error:"المعلم المحدد غير موجود في دليل المعلمين."});
        if(principal.type!=="admin"&&absent.departmentId!==actorDepartmentId)return reply(403,{error:"يمكنك إدارة احتياط معلمي قسمك فقط."});
      }
      if(body.action==="timetable_substitution_save") {
        const period=Number(body.period), assignmentDate=String(body.assignmentDate||""), substitute=String(body.substituteTeacherName||"").trim();
        if(!absentTeacherName||!substitute||!Number.isInteger(period)||period<1||period>7||!/^\d{4}-\d{2}-\d{2}$/.test(assignmentDate))return reply(400,{error:"حدد التاريخ والمعلم الغائب والبديل والحصة."});
        const {data,error}=await db.rpc("create_timetable_substitution",{p_payload:{version_id:activeVersion.id,weekday,period,assignment_date:assignmentDate,absent_teacher_name:absentTeacherName,substitute_teacher_name:substitute,actor_name:principal.name,actor_type:principal.type,include_other_departments:includeOtherDepartments}});
        if(error)throw error;
        return reply(201,{ok:true,assignment:data});
      }
      const date=String(body.assignmentDate||"");
      if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))return reply(400,{error:"تاريخ الغياب غير صالح."});
      const absentTeachers=getVisibleAbsentTeachers(dayCells.map((c:any)=>({matchedTeacherName:c.matched_teacher_name?String(c.matched_teacher_name):null,status:String(c.cell_status||"")})),directory,actorDepartmentId,principal.type==="admin");
      if(!absentTeacherName)return reply(200,{ok:true,active:true,version:activeVersion,absentTeachers});
      const timetable:TimetableEntry[]=dayCells.filter((c:any)=>c.matched_teacher_name).map((c:any)=>({teacherId:String(c.matched_teacher_name),weekday:String(c.weekday),period:Number(c.period),className:Array.isArray(c.class_sections)?c.class_sections.join("، "):"",subject:String(c.subject||""),status:c.cell_status}));
      const {data:assignmentRows,error:assignmentError}=await db.from("timetable_assignments").select("id,source_cell_id,teacher_name,weekday,period,status,assignment_date").eq("version_id",activeVersion.id).in("status",["assigned","confirmed","completed"]);
      if(assignmentError)throw assignmentError;
      // Keep the full available history for fair cumulative ranking. The policy
      // separately scopes hard double-booking checks to the selected date/cell.
      const assignments:SubstitutionAssignment[]=(assignmentRows||[]).map((x:any)=>({substituteTeacherId:String(x.teacher_name),weekday:String(x.weekday),period:Number(x.period),assignmentDate:x.assignment_date||null,status:x.status}));
      const candidates:SubstitutionTeacher[]=directory.filter((t:any)=>t.role==="teacher").map((t:any)=>({id:t.name,name:t.name,departmentId:t.departmentId}));
      const absent=directory.find((t:any)=>t.name===absentTeacherName);
      const lessons=getAbsentTeacherLessons(timetable,absentTeacherName,weekday);
      const lessonOptions=lessons.map((lesson)=>{
        const eligible=getAvailableSubstitutionCandidates({teachers:candidates,timetable,assignments,absentTeacherId:absentTeacherName,weekday,period:lesson.period,departmentId:absent?.departmentId||"",includeOtherDepartments,assignmentDate:date||undefined});
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
