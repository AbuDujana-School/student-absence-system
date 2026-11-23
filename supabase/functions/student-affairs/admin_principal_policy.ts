export function isAdditionalAdminTeacher(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  const permissions = user.permissions && typeof user.permissions === "object" && !Array.isArray(user.permissions)
    ? user.permissions as Record<string, unknown> : {};
  return user.role === "teacher" && permissions.admin === true && permissions.additionalAdmin === true;
}


const ADDITIONAL_ADMIN_PERMISSION_DEFAULTS: Record<string, boolean> = {
  studstats: true, behaviorstats: true, users: true, students: true, teachers: true,
  duty: true, alerts: true, reports: true, sync: true, security: true, admin: true,
  studentAffairs: true, morningAssemblyLateness: true,
};

/** Apply explicit per-account overrides without mixing them with ordinary teacher permissions. */
export function buildAdditionalAdminPermissions(value: unknown): Record<string, boolean> {
  const user = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const permissions = user.permissions && typeof user.permissions === "object" && !Array.isArray(user.permissions)
    ? user.permissions as Record<string, unknown> : {};
  const overrides = permissions.additionalAdminOverrides && typeof permissions.additionalAdminOverrides === "object" && !Array.isArray(permissions.additionalAdminOverrides)
    ? permissions.additionalAdminOverrides as Record<string, unknown> : {};
  const result = { ...ADDITIONAL_ADMIN_PERMISSION_DEFAULTS };
  for (const key of Object.keys(ADDITIONAL_ADMIN_PERMISSION_DEFAULTS)) {
    if (typeof overrides[key] === "boolean") result[key] = overrides[key] as boolean;
  }
  return result;
}
