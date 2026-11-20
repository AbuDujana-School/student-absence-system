import type { AppDataPrincipal } from "./app_data_gateway_policy.ts";

type SessionIdentity = { principal: { type: string; name: string } } | null;
type CredentialGatewayDependencies = {
  db: { from(table: string): any; rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
  headers: HeadersInit;
  readSession(authorization: string | null): Promise<SessionIdentity>;
  currentPrincipal(type: string, name: string): Promise<AppDataPrincipal | null>;
};

function reply(status: number, body: Record<string, unknown>, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function cleanPermissionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanPermissionValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(pin|hash|salt|token|secret|password|credential|api.?key|private.?key)/i.test(key)) continue;
    result[key] = cleanPermissionValue(nested);
  }
  return result;
}

/**
 * Narrow, session-protected credential snapshot used only to preserve the
 * existing offline PIN login contract. Never expose this through generic table reads.
 */
export async function handleAppCredentialSnapshot(
  req: Request,
  deps: CredentialGatewayDependencies,
): Promise<Response> {
  const session = await deps.readSession(req.headers.get("authorization"));
  if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." }, deps.headers);
  const principal = await deps.currentPrincipal(session.principal.type, session.principal.name);
  if (!principal) return reply(401, { error: "تعذر التحقق من صلاحية الحساب الحالية." }, deps.headers);

  const [{ data: adminSetting, error: adminError }, { data: accounts, error: accountsError }] = await Promise.all([
    deps.db.from("school_settings").select("value").eq("key", "admin_pin").maybeSingle(),
    deps.db.from("teachers").select("name,role,pin_hash,pin_salt,permissions,must_change_pin").order("name", { ascending: true }),
  ]);
  if (adminError || accountsError) {
    return reply(503, { error: "تعذر تحميل بيانات التحقق الآمن حالياً." }, deps.headers);
  }

  const adminPin = adminSetting?.value && typeof adminSetting.value.hash === "string" &&
    typeof adminSetting.value.salt === "string"
    ? { hash: adminSetting.value.hash, salt: adminSetting.value.salt } : null;
  const safeAccounts = (accounts || []).map((account: any) => ({
    name: String(account.name || ""),
    role: account.role === "custom" ? "custom" : "teacher",
    pin_hash: typeof account.pin_hash === "string" ? account.pin_hash : null,
    pin_salt: typeof account.pin_salt === "string" ? account.pin_salt : null,
    must_change_pin: account.must_change_pin === true,
    permissions: cleanPermissionValue(account.permissions || {}),
  })).filter((account: any) => account.name);

  return reply(200, { admin_pin: adminPin, accounts: safeAccounts }, deps.headers);
}

/** Set a PIN record only for the current account or by a verified administrator. */
export async function handleAppCredentialWrite(
  req: Request,
  body: any,
  deps: CredentialGatewayDependencies,
): Promise<Response> {
  const session = await deps.readSession(req.headers.get("authorization"));
  if (!session) return reply(401, { error: "انتهت الجلسة. أعد تسجيل الدخول." }, deps.headers);
  const principal = await deps.currentPrincipal(session.principal.type, session.principal.name);
  if (!principal) return reply(401, { error: "تعذر التحقق من صلاحية الحساب الحالية." }, deps.headers);

  const targetType = body?.target_type;
  const targetName = typeof body?.target_name === "string" ? body.target_name.trim() : "";
  const hash = body?.hash;
  const salt = body?.salt;
  const mustChangePin = body?.must_change_pin === true;
  if (!["admin", "teacher", "custom"].includes(targetType) ||
      !/^[a-f0-9]{64}$/i.test(String(hash || "")) ||
      !/^[a-f0-9]{32}$/i.test(String(salt || ""))) {
    return reply(400, { error: "بيانات تغيير الرمز غير صالحة." }, deps.headers);
  }

  if (targetType === "admin") {
    if (principal.type !== "admin" || targetName !== principal.name) {
      return reply(403, { error: "ليست لديك صلاحية تغيير رمز المدير." }, deps.headers);
    }
  } else if (principal.type !== "admin" &&
      (principal.type !== targetType || principal.name !== targetName)) {
    return reply(403, { error: "لا يمكنك تغيير رمز حساب آخر." }, deps.headers);
  }

  const { data, error } = await deps.db.rpc("app_data_gateway_set_pin_record", {
    p_target_type: targetType,
    p_target_name: targetName,
    p_hash: hash,
    p_salt: salt,
    p_must_change_pin: mustChangePin,
  });
  if (error || Number(data) !== 1) {
    return reply(503, { error: "تعذر تحديث الرمز بأمان. لم يتم اعتماد التغيير." }, deps.headers);
  }
  return reply(200, { updated: true }, deps.headers);
}
