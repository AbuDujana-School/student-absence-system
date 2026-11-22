export function isAdminStudentAffairsAccessEnabled(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const setting = value as Record<string, unknown>;
  if (setting.enabled !== false) return true;
  const expiresAt = typeof setting.expires_at === "string"
    ? Date.parse(setting.expires_at)
    : Number.NaN;
  // A timed diagnostic lock automatically expires. A missing/invalid expiry
  // remains disabled until the setting is explicitly removed or enabled.
  return Number.isFinite(expiresAt) && now >= expiresAt;
}
