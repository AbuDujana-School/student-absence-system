import {
  APP_DATA_TABLES,
  allowedAppDataFields,
  authorizeAppDataOperation,
  projectAppDataRow,
  type AppDataPrincipal,
  type AppDataScope,
  type AppDataTable,
} from "./app_data_gateway_policy.ts";
import { isAppDataGatewayDate } from "./app_data_gateway_validation.ts";

type SessionIdentity = { principal: { type: string; name: string } } | null;
type GatewayDependencies = {
  db: { from(table: string): any };
  headers: HeadersInit;
  readSession(authorization: string | null): Promise<SessionIdentity>;
  currentPrincipal(type: string, name: string): Promise<AppDataPrincipal | null>;
  resolveScope(principal: AppDataPrincipal): Promise<AppDataScope>;
};

function gatewayReply(status: number, body: Record<string, unknown>, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** HTTP read handler with injectable identity/scope/database dependencies for isolated integration tests. */
export async function handleAppDataGatewayRead(
  req: Request,
  body: any,
  deps: GatewayDependencies,
): Promise<Response> {
  const session = await deps.readSession(req.headers.get("authorization"));
  if (!session) return gatewayReply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." }, deps.headers);
  const principal = await deps.currentPrincipal(session.principal.type, session.principal.name);
  if (!principal) return gatewayReply(401, { error: "تعذر التحقق من صلاحية الحساب الحالية." }, deps.headers);

  const tableValue = body?.table;
  if (typeof tableValue !== "string" || !(APP_DATA_TABLES as readonly string[]).includes(tableValue)) {
    return gatewayReply(400, { error: "نوع البيانات المطلوب غير مدعوم." }, deps.headers);
  }
  const table = tableValue as AppDataTable;
  if (body?.offset !== undefined && (!Number.isInteger(body.offset) || body.offset < 0 || body.offset > 100000)) {
    return gatewayReply(400, { error: "موضع الصفحة غير صالح." }, deps.headers);
  }
  if (body?.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 500)) {
    return gatewayReply(400, { error: "حجم الصفحة غير صالح." }, deps.headers);
  }
  const offset = body?.offset ?? 0;
  const limit = body?.limit ?? 200;
  const fromDate = body?.from_date;
  const toDate = body?.to_date;
  if ((fromDate !== undefined && !isAppDataGatewayDate(fromDate)) ||
      (toDate !== undefined && !isAppDataGatewayDate(toDate)) ||
      ((fromDate !== undefined || toDate !== undefined) && table !== "attendance" && table !== "behaviors") ||
      (fromDate && toDate && fromDate > toDate)) {
    return gatewayReply(400, { error: "نطاق التاريخ غير صالح." }, deps.headers);
  }

  const scope: AppDataScope = principal.type === "admin" || table === "teachers" || table === "school_settings"
    ? { allowedClasses: [] }
    : await deps.resolveScope(principal);
  const tableClasses = table === "attendance" ? (scope.allowedAttendanceClasses || scope.allowedClasses) :
    table === "behaviors" ? (scope.allowedBehaviorClasses || scope.allowedClasses) : scope.allowedClasses;
  const firstClass = tableClasses[0] || "";
  const probe: Record<string, unknown> | null =
    table === "classes" ? { name: firstClass } :
    table === "students" || table === "attendance" || table === "behaviors" || table === "duty_reports"
      ? { class_name: firstClass, teacher_name: principal.name } :
    table === "teachers" ? { name: principal.name } : null;
  if (!authorizeAppDataOperation(principal, table, "read", probe, scope)) {
    return gatewayReply(403, { error: "ليست لديك صلاحية قراءة هذا النوع من البيانات." }, deps.headers);
  }

  let query: any = deps.db.from(table).select(allowedAppDataFields(table).join(","));
  if (principal.type !== "admin") {
    if (table === "teachers") query = query.eq("name", principal.name);
    else if (table === "school_settings") {
      return gatewayReply(403, { error: "قراءة إعدادات النظام للمدير فقط." }, deps.headers);
    } else if (table === "classes") {
      if (!scope.allowedClasses.length) return gatewayReply(200, { rows: [], next_offset: null }, deps.headers);
      query = query.in("name", scope.allowedClasses);
    } else if (["students", "attendance", "behaviors", "duty_reports"].includes(table)) {
      if (!tableClasses.length) return gatewayReply(200, { rows: [], next_offset: null }, deps.headers);
      query = query.in("class_name", tableClasses);
    }
  }
  if (body?.class_name !== undefined) {
    if (typeof body.class_name !== "string" ||
        !["classes", "students", "attendance", "behaviors", "duty_reports"].includes(table)) {
      return gatewayReply(400, { error: "مرشح الصف غير صالح لهذا النوع من البيانات." }, deps.headers);
    }
    const className = body.class_name.trim();
    if (!className || className.length > 120 ||
      (principal.type !== "admin" && !tableClasses.includes(className))) {
      return gatewayReply(403, { error: "الصف المطلوب خارج نطاق صلاحيات الحساب." }, deps.headers);
    }
    query = table === "classes" ? query.eq("name", className) : query.eq("class_name", className);
  }
  if (table === "school_settings" && principal.type === "admin") {
    query = query.neq("key", "admin_pin");
  }
  if (table === "attendance" || table === "behaviors") {
    if (fromDate) query = query.gte("date_str", fromDate);
    if (toDate) query = query.lte("date_str", toDate);
    query = query.order("record_key", { ascending: true });
  } else if (table === "classes") query = query.order("name", { ascending: true });
  else if (table === "students") query = query.order("class_name", { ascending: true }).order("student_name", { ascending: true });
  else if (table === "teachers") query = query.order("name", { ascending: true });
  else if (table === "duty_reports") query = query.order("created_at", { ascending: true }).order("id", { ascending: true });
  else query = query.order("key", { ascending: true });

  const { data, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error("App data gateway read failed");
  const rows = (data || []).map((row: unknown) => projectAppDataRow(table, row)).filter(Boolean);
  return gatewayReply(200, { rows, next_offset: rows.length === limit ? offset + rows.length : null }, deps.headers);
}
