export type AppPrincipalType = "admin" | "teacher" | "custom";

export interface AppPrincipalInput {
  type: unknown;
  name: unknown;
  permissions?: unknown;
  mustChangePin?: unknown;
}

export interface AppPrincipal {
  type: AppPrincipalType;
  name: string;
  permissions: Record<string, unknown>;
  mustChangePin: boolean;
}

const SECRET_FIELD = /(pin|hash|salt|token|secret|password|credential|api.?key|private.?key)/i;

export function isValidAppPin(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4,10}$/.test(value);
}

function removeSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSecretFields);
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!SECRET_FIELD.test(key)) clean[key] = removeSecretFields(nested);
  }
  return clean;
}

export function projectAppPrincipal(input: AppPrincipalInput): AppPrincipal | null {
  const type = input.type;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if ((type !== "admin" && type !== "teacher" && type !== "custom") || !name) return null;
  const source = input.permissions && typeof input.permissions === "object" && !Array.isArray(input.permissions)
    ? input.permissions
    : {};
  const permissions = removeSecretFields(source) as Record<string, unknown>;
  return { type, name, permissions, mustChangePin: input.mustChangePin === true };
}

export function isValidAppSessionToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function isAppSessionActive(expiresAt: unknown, now = Date.now()): boolean {
  if (typeof expiresAt !== "string") return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}
