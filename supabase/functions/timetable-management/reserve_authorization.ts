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
 * Archive permissions grant access to a principal's own department only.
 * The consolidated cross-department archive is reserved for system admins.
 */
export function canViewSchoolwideReserveArchive(principalType: string): boolean {
  return principalType === "admin";
}
