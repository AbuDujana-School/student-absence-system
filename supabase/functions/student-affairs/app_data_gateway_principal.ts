/**
 * Normalize server-loaded permissions to the legacy browser feature contract.
 *
 * The existing UI grants ordinary teachers attendance/behavior access unless
 * the corresponding flag is explicitly false. Custom accounts are opt-in and
 * must keep explicit grants. This helper is used only after reloading the
 * current principal from the server; request JSON is never trusted.
 */
export function normalizeAppDataPrincipalPermissions(
  type: string,
  permissions: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const normalized = { ...(permissions && typeof permissions === "object" ? permissions : {}) };
  if (type === "teacher") {
    normalized.attendance = normalized.attendance !== false;
    normalized.behavior = normalized.behavior !== false;
  }
  return normalized;
}
