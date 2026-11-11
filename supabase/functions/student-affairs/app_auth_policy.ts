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


/** Create an opaque 256-bit bearer token. Store only its SHA-256 digest server-side. */
export function createAppSessionToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash a validated bearer token before looking it up in a session store. */
export async function hashAppSessionToken(token: unknown): Promise<string> {
  if (!isValidAppSessionToken(token)) throw new TypeError("Invalid application session token");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Accept only a single well-formed Bearer token; never treat the public API key as a session. */
export function extractAppBearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header.trim());
  return match ? match[1].toLowerCase() : null;
}


export interface AppLoginCandidate extends AppPrincipalInput {
  hash: unknown;
  salt: unknown;
}

/**
 * Resolve an application identity without coupling it to Student Affairs access.
 * Candidate order is normalized to the legacy login precedence: admin, custom, teacher.
 * The caller supplies the server-side credential verifier; raw credentials never leave this module.
 */
export async function resolveAppPrincipal(
  pin: unknown,
  candidates: AppLoginCandidate[],
  verify: (pin: string, salt: string, hash: string) => Promise<boolean>,
): Promise<AppPrincipal | null> {
  if (!isValidAppPin(pin) || !Array.isArray(candidates)) return null;
  const priority: Record<AppPrincipalType, number> = { admin: 0, custom: 1, teacher: 2 };
  const ordered = candidates
    .filter((candidate) =>
      (candidate.type === "admin" || candidate.type === "custom" || candidate.type === "teacher") &&
      typeof candidate.name === "string" && candidate.name.trim() !== "" &&
      typeof candidate.hash === "string" && candidate.hash.length > 0 &&
      typeof candidate.salt === "string" && candidate.salt.length > 0
    )
    .slice()
    .sort((a, b) => priority[a.type as AppPrincipalType] - priority[b.type as AppPrincipalType]);
  for (const candidate of ordered) {
    if (await verify(pin, candidate.salt as string, candidate.hash as string)) {
      return projectAppPrincipal(candidate);
    }
  }
  return null;
}
