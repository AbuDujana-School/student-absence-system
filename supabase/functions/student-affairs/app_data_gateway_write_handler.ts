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
  db: { from(table: string): any; rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
  headers: HeadersInit;
  readSession(authorization: string | null): Promise<SessionIdentity>;
  currentPrincipal(type: string, name: string): Promise<AppDataPrincipal | null>;
  resolveScope(principal: AppDataPrincipal): Promise<AppDataScope>;
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

  if (body?.operation !== undefined && body.operation !== "write") {
    return reply(400, { error: "عملية البيانات المطلوبة غير مدعومة." }, deps.headers);
  }

  const tableValue = body?.table;
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

  const conflictColumns: Record<AppDataTable, string[]> = {
    classes: ["name"],
    students: ["class_name", "student_name"],
    teachers: ["name"],
    attendance: ["record_key"],
    behaviors: ["record_key"],
    school_settings: ["key"],
    duty_reports: ["id"],
  };
  const seenKeys = new Set<string>();
  for (const row of rows) {
    const values = conflictColumns[table].map((column) => String(row[column] ?? "").trim());
    if (values.some((value) => !value)) {
      return reply(400, { error: "مفتاح أحد السجلات مفقود." }, deps.headers);
    }
    const key = JSON.stringify(values);
    if (seenKeys.has(key)) return reply(400, { error: "توجد سجلات مكررة ضمن عملية الحفظ." }, deps.headers);
    seenKeys.add(key);
  }

  // The database function performs ownership checks and upserts atomically in one transaction.
  const { data: saved, error } = await deps.db.rpc("app_data_gateway_write_records", {
    p_table: table,
    p_rows: rows,
    p_allow_owner_overwrite: principal.type === "admin",
  });
  if (error || Number(saved) !== rows.length) {
    return reply(503, { error: "تعذر حفظ البيانات بأمان حالياً. احتُفظ بالتغييرات المحلية." }, deps.headers);
  }
  return reply(200, { saved: Number(saved) }, deps.headers);
}
