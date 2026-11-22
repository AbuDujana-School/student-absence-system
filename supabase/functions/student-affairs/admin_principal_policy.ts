export function isAdditionalAdminTeacher(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  const permissions = user.permissions && typeof user.permissions === "object" && !Array.isArray(user.permissions)
    ? user.permissions as Record<string, unknown> : {};
  return user.role === "teacher" && permissions.admin === true && permissions.additionalAdmin === true;
}
