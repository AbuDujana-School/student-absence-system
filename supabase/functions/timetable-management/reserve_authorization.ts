/**
 * Custom timetable accounts are department-scoped coordinators, not schoolwide
 * reserve administrators. Every mutation must keep the absent teacher inside
 * the actor's department; a replacement substitute must remain in that same
 * department. General admins and explicitly reserve-enabled teachers continue
 * to use their existing authorization path.
 */
export function canCustomCoordinatorManageDepartment(input: {
  actorType: string;
  actorDepartmentId: unknown;
  absentTeacherDepartmentId: unknown;
  substituteTeacherDepartmentId?: unknown;
}): boolean {
  if (input.actorType !== "custom") return true;
  const actorDepartment = String(input.actorDepartmentId || "").trim();
  const absentDepartment = String(input.absentTeacherDepartmentId || "").trim();
  if (!actorDepartment || !absentDepartment || actorDepartment !== absentDepartment) return false;
  if (input.substituteTeacherDepartmentId !== undefined) {
    const substituteDepartment = String(input.substituteTeacherDepartmentId || "").trim();
    if (!substituteDepartment || substituteDepartment !== absentDepartment) return false;
  }
  return true;
}


/**
 * The caller supplies this grant only after server-side session and permission checks:
 * system administrator, teacher reserve permission, or absence-coordinator timetable access.
 * These explicitly authorized principals may view both archive scopes.
 */
export function canViewSchoolwideReserveArchive(principalType: string, hasArchivePermission = false): boolean {
  return principalType === "admin" || hasArchivePermission === true;
}
