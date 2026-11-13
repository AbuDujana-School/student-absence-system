import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseTimetableDay, validateSchoolTeacherCount } from "./timetable_grid.ts";
import { matchSystemTeacherName, type SystemTeacher } from "./timetable_import.ts";
import { getAbsentTeacherLessons, getAvailableSubstitutionCandidates, type TimetableEntry, type SubstitutionAssignment, type SubstitutionTeacher } from "./substitution_policy.ts";

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
async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
type TimetablePrincipal = { type: "admin" | "teacher" | "custom"; name: string };

async function requirePrincipal(req: Request): Promise<TimetablePrincipal | null> {
  const authorization = req.headers.get("authorization") || "";
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(authorization.trim());
  if (!match) return null;
  const tokenHash = await sha256(match[1].toLowerCase());
  const { data: session, error: sessionError } = await db.from("app_sessions")
    .select("principal_type,principal_name,expires_at")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (sessionError || !session || typeof session.principal_name !== "string") return null;

  if (session.principal_type === "admin" && session.principal_name === "مدير النظام العام") {
    const { data: setting, error } = await db.from("school_settings")
      .select("value").eq("key", "admin_pin").maybeSingle();
    if (error || !setting?.value?.hash || !setting?.value?.salt) return null;
    return { type: "admin", name: session.principal_name };
  }
  if (session.principal_type === "teacher" || session.principal_type === "custom") {
    const expectedRole = session.principal_type;
    const { data: teacher, error: teacherError } = await db.from("teachers")
      .select("name,role").eq("name", session.principal_name).maybeSingle();
    if (teacherError || !teacher || teacher.role !== expectedRole) return null;
    const { data: access, error: accessError } = await db.from("timetable_access_permissions")
      .select("can_access").eq("principal_type", expectedRole)
      .eq("principal_name", teacher.name).maybeSingle();
    if (accessError || access?.can_access !== true) return null;
    return { type: expectedRole, name: teacher.name };
  }
  return null;
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
  const teacherReadOnlyActions = new Set(["health", "timetable_check_access", "teacher_timetable_get_own"]);
  if (principal.type === "teacher" && !teacherReadOnlyActions.has(action)) {
    return reply(403, { error: "يمكن للمعلم استعراض جدوله الشخصي فقط." });
  }

  if (action === "health") {
    return reply(200, { ok: true, service: "timetable-management", authenticated: true, scope: "timetable-only" });
  }

  if (action === "timetable_check_access") {
    return reply(200, { canAccess: true, isAdmin: principal.type === "admin", isTeacher: principal.type === "teacher" });
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
      const absentTeachers=Array.from(new Set(dayCells.filter((c:any)=>c.cell_status==="teaching"&&c.matched_teacher_name).filter((c:any)=>directory.find((t:any)=>t.name===c.matched_teacher_name)?.role==="teacher").map((c:any)=>String(c.matched_teacher_name)))).sort((a,b)=>a.localeCompare(b,"ar"));
      if(!absentTeacherName)return reply(200,{ok:true,active:true,version:activeVersion,absentTeachers});
      const timetable:TimetableEntry[]=dayCells.filter((c:any)=>c.matched_teacher_name).map((c:any)=>({teacherId:String(c.matched_teacher_name),weekday:String(c.weekday),period:Number(c.period),className:Array.isArray(c.class_sections)?c.class_sections.join("، "):"",subject:String(c.subject||""),status:c.cell_status}));
      const {data:assignmentRows,error:assignmentError}=await db.from("timetable_assignments").select("id,source_cell_id,teacher_name,weekday,period,status,assignment_date").eq("version_id",activeVersion.id).in("status",["assigned","confirmed","completed"]);
      if(assignmentError)throw assignmentError;
      const selectedDate=date?new Date(date+"T12:00:00"):null;
      const weekStart=selectedDate?new Date(selectedDate.getFullYear(),selectedDate.getMonth(),selectedDate.getDate()-selectedDate.getDay(),12):null;
      const weekEnd=weekStart?new Date(weekStart.getFullYear(),weekStart.getMonth(),weekStart.getDate()+4,12):null;
      const iso=(v:Date)=>v.getFullYear()+"-"+String(v.getMonth()+1).padStart(2,"0")+"-"+String(v.getDate()).padStart(2,"0");
      const assignments:SubstitutionAssignment[]=(assignmentRows||[]).filter((x:any)=>!x.assignment_date||!weekStart||(x.assignment_date>=iso(weekStart)&&x.assignment_date<=iso(weekEnd!))).map((x:any)=>({substituteTeacherId:String(x.teacher_name),weekday:String(x.weekday),period:Number(x.period),assignmentDate:x.assignment_date||null,status:x.status}));
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
