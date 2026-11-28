import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { academicYearKey, canUseMorningLateness, canViewMorningLatenessReport } from "./policy.ts";
import { buildAdditionalAdminPermissions, isAdditionalAdminTeacher } from "../_shared/admin_principal_policy.ts";
import { hasAdminRecordsCenterAccess } from "../_shared/report_access_policy.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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
const DAY_NAMES: Record<string,string> = {
  Sunday:"الأحد", Monday:"الاثنين", Tuesday:"الثلاثاء", Wednesday:"الأربعاء", Thursday:"الخميس",
};
function omanNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"Asia/Muscat", year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23",
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map(p => [p.type,p.value]));
  const weekday = new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Muscat",weekday:"long"}).format(now);
  const date = String(v.year)+"-"+String(v.month).padStart(2,"0")+"-"+String(v.day).padStart(2,"0");
  return {
    date, weekday:DAY_NAMES[weekday] || "",
    minutes:Number(v.hour)*60+Number(v.minute),
    time:String(v.hour).padStart(2,"0")+":"+String(v.minute).padStart(2,"0")+":"+String(v.second).padStart(2,"0"),
    academicYear: academicYearKey(date),
  };
}
async function sha256(value:string) {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
type Principal = { type:"admin"|"teacher"|"custom"; name:string; permissions:Record<string,any> };
async function authenticate(req:Request):Promise<Principal|null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i,"").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const tokenHash = await sha256(token);
  const nowIso = new Date().toISOString();
  const {data:session,error:sessionError} = await db.from("app_sessions")
    .select("principal_type,principal_name,expires_at")
    .eq("token_hash",tokenHash).gt("expires_at",nowIso).maybeSingle();
  if (sessionError || !session) return null;
  if (session.principal_type === "admin") {
    const principalName = String(session.principal_name || "");
    if (principalName === "مدير النظام العام") {
      const {data:setting,error} = await db.from("school_settings").select("value")
        .eq("key","admin_pin").maybeSingle();
      if (error || !setting?.value?.hash || !setting?.value?.salt) return null;
      return {type:"admin",name:principalName,permissions:{admin:true,reports:true,morningAssemblyLateness:true}};
    }
    const {data:user,error} = await db.from("teachers").select("name,role,permissions")
      .eq("name",principalName).maybeSingle();
    if (error || !user || !isAdditionalAdminTeacher(user)) return null;
    return {type:"teacher",name:principalName,permissions:buildAdditionalAdminPermissions(user)};
  }
  const {data:user,error} = await db.from("teachers").select("name,role,permissions")
    .eq("name",session.principal_name).maybeSingle();
  if (error || !user || user.role !== session.principal_type) return null;
  return {
    type:session.principal_type as "teacher"|"custom",
    name:String(user.name),
    permissions:user.permissions && typeof user.permissions==="object" ? user.permissions : {},
  };
}
function canUse(principal:Principal, ctx:ReturnType<typeof omanNow>, duty:any) {
  const personal = principal.permissions.dutyDay;
  const category = String(principal.permissions.category || "");
  const assignedDay = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"].includes(personal)
    ? personal : String(duty?.subjectDays?.[category] || "");
  return canUseMorningLateness({
    principalType: principal.type,
    permission: principal.permissions.morningAssemblyLateness === true,
    nonDutyPermission: principal.permissions.morningAssemblyLatenessNonDuty === true,
    dutyToday: principal.permissions.dutyToday !== false,
    weekday: ctx.weekday,
    assignedDutyDay: assignedDay,
    minutes: ctx.minutes,
  });
}
async function dutySettings() {
  const {data,error} = await db.from("school_settings").select("value")
    .eq("key","duty_module").maybeSingle();
  if (error) throw error;
  return data?.value || {};
}
async function handle(req:Request) {
  if (req.method === "OPTIONS") return new Response("ok",{headers:cors});
  if (req.method !== "POST") return reply(405,{error:"Method not allowed"});
  let body:any;
  try { body=await req.json(); } catch { return reply(400,{error:"Invalid request"}); }
  const principal=await authenticate(req);
  if (!principal) return reply(401,{error:"انتهت جلسة الدخول أو تعذر التحقق منها. سجل الدخول مجدداً."});
  const ctx=omanNow();
  const action=String(body?.action || "");
  if (action === "report") {
    const adminRecordsCenterAccess = body?.admin_records_center === true && hasAdminRecordsCenterAccess(principal.type, principal.permissions, principal.type === "admin");
    if (!adminRecordsCenterAccess && !canViewMorningLatenessReport({principalType:principal.type,nonDutyPermission:principal.permissions.morningAssemblyLatenessNonDuty === true,customPermission:principal.permissions.morningAssemblyLateness === true})) {
      return reply(403,{error:"لا تملك صلاحية عرض تقرير التأخر."});
    }
    const requestedYear = String(body?.academic_year || ctx.academicYear);
    if (!/^[0-9]{4}\/[0-9]{4}$/.test(requestedYear)) return reply(400,{error:"العام الدراسي المحدد غير صالح."});
    const yearRows:any[] = [];
    for (let from=0; ; from+=1000) {
      const {data,error}=await db.from("morning_assembly_lateness")
        .select("academic_year")
        .order("academic_year",{ascending:false})
        .range(from,from+999);
      if (error) throw error;
      yearRows.push(...(data||[]));
      if (!data || data.length<1000) break;
    }
    const years = [...new Set(yearRows.map(row=>String(row.academic_year)))].sort((a,b)=>b.localeCompare(a));
    const selectedYear = years.includes(requestedYear) || requestedYear===ctx.academicYear ? requestedYear : (years[0] || ctx.academicYear);
    const reportRows:any[] = [];
    for (let from=0; ; from+=1000) {
      const {data,error}=await db.from("morning_assembly_lateness")
        .select("id,student_id,student_name_snapshot,class_name_snapshot,late_date,recorded_at,recorder_name,academic_year")
        .eq("academic_year",selectedYear)
        .is("cancelled_at",null)
        .order("late_date",{ascending:false}).order("recorded_at",{ascending:false})
        .range(from,from+999);
      if (error) throw error;
      reportRows.push(...(data||[]));
      if (!data || data.length<1000) break;
    }
    return reply(200,{academic_year:selectedYear,available_years:[...new Set([ctx.academicYear,...years])].sort((a,b)=>b.localeCompare(a)),rows:reportRows});
  }
  if (action !== "today" && action !== "record" && action !== "toggle") return reply(400,{error:"طلب غير معروف."});
  const localMonth = Number(ctx.date.slice(5,7));
  if (localMonth === 7 || localMonth === 8) return reply(403,{error:"التسجيل متاح خلال العام الدراسي فقط (من 1 سبتمبر إلى 30 يونيو)."});
  let duty:any={};
  if (principal.type === "teacher") {
    try { duty=await dutySettings(); } catch { return reply(503,{error:"تعذر التحقق من جدول المناوبة حالياً."}); }
  }
  if (!canUse(principal,ctx,duty)) {
    return reply(403,{error:"لا تملك صلاحية التسجيل الآن، أو أنك لست مناوباً اليوم، أو انتهت فترة التسجيل (7:00–8:30 صباحاً)."});
  }
  if (action === "today") {
    const {data:rows,error}=await db.from("morning_assembly_lateness")
      .select("student_id,student_name_snapshot,class_name_snapshot")
      .eq("late_date",ctx.date)
      .is("cancelled_at",null);
    if (error) {
      console.error("morning assembly lateness today lookup failed",error);
      return reply(500,{error:"تعذر تحميل حالة تسجيل الطلاب لهذا اليوم."});
    }
    return reply(200,{date:ctx.date,rows:rows||[]});
  }
  const className=String(body?.class_name || "").trim();
  const studentName=String(body?.student_name || "").trim();
  if (!className || !studentName || className.length > 120 || studentName.length > 180) {
    return reply(400,{error:"بيانات الصف أو الطالب غير مكتملة أو أطول من الحد المسموح."});
  }
  const {data:students,error:studentError}=await db.from("students").select("id,class_name,student_name")
    .eq("class_name",className).eq("student_name",studentName).limit(2);
  if (studentError || !students?.length) return reply(404,{error:"لم يتم العثور على الطالب في الصف المحدد. حدّث الصفحة وحاول مجدداً."});
  if (students.length > 1) return reply(409,{error:"توجد سجلات متطابقة للطالب في الصف. يرجى مراجعة بيانات الطلاب قبل التسجيل."});
  const student=students[0];
  if (action === "toggle") {
    const {data:existing,error:lookupError}=await db.from("morning_assembly_lateness")
      .select("id").eq("student_id",student.id).eq("late_date",ctx.date).is("cancelled_at",null).maybeSingle();
    if (lookupError) {
      console.error("morning assembly lateness toggle lookup failed",lookupError);
      return reply(500,{error:"تعذر التحقق من حالة تأخر الطالب."});
    }
    if (existing) {
      const {data:removed,error:cancelError}=await db.from("morning_assembly_lateness")
        .update({
          cancelled_at:new Date().toISOString(),
          cancelled_by:principal.name,
          cancelled_by_type:principal.type,
        })
        .eq("id",existing.id).is("cancelled_at",null).select("id").maybeSingle();
      if (cancelError) {
        console.error("morning assembly lateness toggle cancellation failed",cancelError);
        return reply(500,{error:"تعذر توثيق إلغاء التأخر. لم يتم تغيير السجل."});
      }
      // A concurrent toggle may already have cancelled this same record.
      // Treat that as a successful idempotent cancellation, never as a delete.
      if (!removed) {
        const {data:stillActive,error:verifyError}=await db.from("morning_assembly_lateness")
          .select("id").eq("id",existing.id).is("cancelled_at",null).maybeSingle();
        if (verifyError || stillActive) {
          console.error("morning assembly lateness cancellation could not be confirmed",verifyError);
          return reply(500,{error:"تعذر تأكيد إلغاء التأخر. لم يتم تغيير السجل."});
        }
      }
      return reply(200,{success:true,action:"removed",student_name:student.student_name,class_name:student.class_name});
    }
  }
  const {data,error}=await db.from("morning_assembly_lateness").insert({
    student_id:student.id,
    student_name_snapshot:student.student_name,
    class_name_snapshot:student.class_name,
    late_date:ctx.date,
    recorded_at:new Date().toISOString(),
    recorder_type:principal.type,
    recorder_name:principal.name,
    academic_year:ctx.academicYear,
  }).select("id,late_date,recorded_at").single();
  if (error) {
    if (error.code === "23505") {
      const {data:existing}=await db.from("morning_assembly_lateness")
        .select("recorded_at").eq("student_id",student.id).eq("late_date",ctx.date).maybeSingle();
      return reply(409,{duplicate:true,error:"هذا الطالب تم تسجيل تأخره مسبقاً اليوم.",message:"هذا الطالب تم تسجيل تأخره مسبقاً اليوم.",recorded_at:existing?.recorded_at||null});
    }
    console.error("morning assembly lateness insert failed",error);
    return reply(500,{error:"تعذر حفظ التسجيل. لم يتم تغيير أي سجل آخر."});
  }
  return reply(201,{success:true,action:"recorded",record:data,student_name:student.student_name,class_name:student.class_name});
}
Deno.serve(async (req:Request) => {
  try { return await handle(req); }
  catch (error) {
    console.error("morning-assembly-lateness error",error);
    return reply(500,{error:"حدث خطأ غير متوقع أثناء تنفيذ الطلب."});
  }
});
