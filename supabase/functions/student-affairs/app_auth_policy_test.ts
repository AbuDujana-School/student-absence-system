import {
  isAppSessionActive,
  isValidAppPin,
  isValidAppSessionToken,
  projectAppPrincipal,
} from "./app_auth_policy.ts";

Deno.test("general app PIN accepts only 4–10 numeric digits", () => {
  for (const pin of ["1234", "000000", "1234567890"]) if (!isValidAppPin(pin)) throw new Error(`Expected valid PIN: ${pin}`);
  for (const pin of ["123", "12345678901", "12a4", "", 1234, null]) if (isValidAppPin(pin)) throw new Error(`Expected invalid PIN: ${String(pin)}`);
});

Deno.test("principal projection accepts only supported types and non-empty names", () => {
  if (projectAppPrincipal({ type: "visitor", name: "A" }) !== null) throw new Error("Unsupported type accepted");
  if (projectAppPrincipal({ type: "teacher", name: "  " }) !== null) throw new Error("Empty name accepted");
  const projected = projectAppPrincipal({ type: "teacher", name: " Teacher A " });
  if (!projected || projected.name !== "Teacher A") throw new Error("Principal was not normalized");
});

Deno.test("principal projection excludes credential-shaped permission fields", () => {
  const projected = projectAppPrincipal({
    type: "teacher", name: "Teacher A",
    permissions: { attendance: true, studentAffairs: true, pin_hash: "x", pin_salt: "x", access_token: "x", nested: { apiKey: "x", visible: true } },
    mustChangePin: true,
  });
  if (!projected) throw new Error("Expected projected principal");
  if (projected.permissions.attendance !== true || projected.permissions.studentAffairs !== true) throw new Error("Permissions were not preserved");
  for (const key of ["pin_hash", "pin_salt", "access_token"]) if (key in projected.permissions) throw new Error(`Credential field leaked: ${key}`);
  const nested = projected.permissions.nested as Record<string, unknown>;
  if ("apiKey" in nested || nested.visible !== true) throw new Error("Nested credential field was not filtered safely");
  if (projected.mustChangePin !== true) throw new Error("mustChangePin flag was lost");
});

Deno.test("session token format requires 32 bytes encoded as hex", () => {
  if (!isValidAppSessionToken("a".repeat(64))) throw new Error("Valid token rejected");
  if (isValidAppSessionToken("a".repeat(63))) throw new Error("Short token accepted");
  if (isValidAppSessionToken("g".repeat(64))) throw new Error("Non-hex token accepted");
});

Deno.test("session expiry must be a valid future timestamp", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  if (!isAppSessionActive("2026-01-01T00:00:01.000Z", now)) throw new Error("Future session rejected");
  if (isAppSessionActive("2025-12-31T23:59:59.000Z", now)) throw new Error("Expired session accepted");
  if (isAppSessionActive("not-a-date", now)) throw new Error("Invalid date accepted");
  if (isAppSessionActive(null, now)) throw new Error("Missing expiry accepted");
});


Deno.test("server session tokens are opaque 256-bit hex values and hash deterministically", async () => {
  const first = createAppSessionToken();
  const second = createAppSessionToken();
  if (!isValidAppSessionToken(first) || !isValidAppSessionToken(second)) throw new Error("Generated token has invalid shape");
  if (first === second) throw new Error("Session token collision");
  const digest = await hashAppSessionToken(first);
  if (!/^[a-f0-9]{64}$/.test(digest) || digest === first) throw new Error("Token digest is invalid");
  let rejected = false;
  try { await hashAppSessionToken("not-a-token"); } catch { rejected = true; }
  if (!rejected) throw new Error("Invalid token was hashed");
});

Deno.test("Bearer extraction rejects missing, malformed, and public-key-like values", () => {
  const token = "a".repeat(64);
  if (extractAppBearerToken("Bearer " + token) !== token) throw new Error("Valid bearer token rejected");
  if (extractAppBearerToken("bearer " + token.toUpperCase()) !== token) throw new Error("Case normalization failed");
  for (const value of [null, "", "Bearer anon-key", "Basic " + token, "Bearer " + token + " extra", "Bearer " + "g".repeat(64)]) {
    if (extractAppBearerToken(value) !== null) throw new Error("Malformed authorization header accepted");
  }
});
