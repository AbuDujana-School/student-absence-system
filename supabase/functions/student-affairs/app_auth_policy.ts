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

const SECRET_FIELD = /(pin|hash|salt|token|secret|password|credential)/i;

export function isValidAppPin(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4,10}$/.test(value);
}

export function projectAppPrincipal(input: AppPrincipalInput): AppPrincipal | null {
  const type = input.type;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if ((type !== "admin" && type !== "teacher" && type !== "custom") || !name) return null;
  const source = input.permissions && typeof input.permissions === "object" && !Array.isArray(input.permissions)
    ? input.permissions as Record<string, unknown>
    : {};
  const permissions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SECRET_FIELD.test(key)) permissions[key] = value;
  }
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
