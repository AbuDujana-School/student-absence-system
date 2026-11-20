import {
  APP_DATA_TABLES,
  authorizeAppDataOperation,
  validateAppDataWriteRows,
  type AppDataPrincipal,
  type AppDataScope,
  type AppDataTable,
} from "./app_data_gateway_policy.ts";

type SessionIdentity = { principal: { type: string; name: string } } | null;
type GatewayDependencies = {
  db: { from(table: string): any };
  headers: HeadersInit;
  readSession(authorization: string | null): Promise<SessionIdentity>;
  currentPrincipal(type: string, name: string): Promise<AppDataPrincipal | null>;
  resolveScope(principal: AppDataPrincipal): Promise<AppDataScope>;
};

const CONFLICT_TARGETS: Record<AppDataTable, string> = {
  classes: "name",
  students: "class_name,student_name",
  teachers: "name",
  attendance: "record_key",
  behaviors: "record_key",
  school_settings: "key",
  duty_reports: "id",
};

function reply(status: number, body: Record<string, unknown>, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Authenticated, allowlisted bulk-upsert handler.
 * Deletes are intentionally unsupported; credential/PIN fields are rejected by the policy projection.
 */
export async function handleAppDataGatewayWrite(
  req: Request,
  body: any,
  deps: GatewayDependencies,
): Promise<Response> {
  const session = await deps.readSession(req.headers.get("authorization"));
  if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." }, deps.headers);

  const principal = await deps.currentPrincipal(session.principal.type, session.principal.name);
  if (!principal) return reply(401, { error: "تعذر التحقق من صلاحية الحساب الحالية." }, deps.headers);

  if (body?.operation !== undefined && body.operation !== "write") {\n    return reply(400, { error: "عملية البيانات المطلوبة غير مدعومة." }, deps.headers);\n  }\n\n  const tableValue = body?.table;
  if (typeof tableValue !== "string" || !(APP_DATA_TABLES as readonly string[]).includes(tableValue)) {
    return reply(400, { error: "نوع البيانات المطلوب غير مدعوم." }, deps.headers);
  }
  const table = tableValue as AppDataTable;
  const rows = validateAppDataWriteRows(table, body?.rows);
  if (!rows) return reply(400, { error: "بيانات الحفظ غير صالحة أو تحتوي حقولاً غير مسموحة." }, deps.headers);

  const scope: AppDataScope = principal.type === "admin"
    ? { allowedClasses: [] }
    : await deps.resolveScope(principal);

  for (const row of rows) {
    if (!authorizeAppDataOperation(principal, table, "write", row, scope)) {
      return reply(403, { error: "ليست لديك صلاحية حفظ هذه البيانات." }, deps.headers);
    }
  }

  const conflictTarget = CONFLICT_TARGETS[table];
  const conflictColumns = conflictTarget.split(",");
  const conflictKeys = new Set<string>();
  for (const row of rows) {
    const key = conflictColumns.map((column) => String(row[column] ?? "")).join("\u001f");
    if (conflictColumns.some((column) => !String(row[column] ?? "").trim()) || conflictKeys.has(key)) {
      return reply(400, { error: "مفتاح السجل مفقود أو مكرر ضمن عملية الحفظ." }, deps.headers);
    }
    conflictKeys.add(key);
  }

  // A teacher must not overwrite a record owned by another teacher through a colliding record key.
  if (principal.type !== "admin" && (table === "attendance" || table === "behaviors")) {
    const keys = rows.map((row) => String(row.record_key));
    const { data: existing, error: lookupError } = await deps.db.from(table)
      .select("record_key,teacher_name")
      .in("record_key", keys);
    if (lookupError) return reply(503, { error: "تعذر التحقق من السجلات الحالية. لم يتم الحفظ." }, deps.headers);
    if ((existing || []).some((row: any) => String(row.teacher_name || "") !== principal.name)) {
      return reply(403, { error: "يوجد سجل محفوظ لمعلم آخر. لم يتم تغيير أي سجل." }, deps.headers);
    }
  }

  const { error } = await deps.db.from(table).upsert(rows, { onConflict: conflictTarget });
  if (error) return reply(503, { error: "تعذر حفظ البيانات حالياً. احتُفظ بالتغييرات المحلية." }, deps.headers);
  return reply(200, { saved: rows.length }, deps.headers);
}
