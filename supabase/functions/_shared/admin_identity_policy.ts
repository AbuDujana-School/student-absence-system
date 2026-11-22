export const SYSTEM_ADMIN_NAME = "مدير النظام العام";

/**
 * A secondary administrator is an existing teacher account with an explicit,
 * server-stored boolean admin grant. Custom accounts are never promoted by this
 * helper, even if malformed permission data contains an admin flag.
 */
export function isSecondaryAdminTeacher(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const user = value as { role?: unknown; permissions?: unknown };
  if (user.role !== "teacher" || !user.permissions || typeof user.permissions !== "object") return false;
  return (user.permissions as Record<string, unknown>).admin === true;
}
