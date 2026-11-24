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
  allowSupportingSubstitute?: boolean;
}): boolean {
  if (input.actorType !== "custom") return true;
  const actorDepartment = String(input.actorDepartmentId || "").trim();
  const absentDepartment = String(input.absentTeacherDepartmentId || "").trim();
  if (!actorDepartment || !absentDepartment || actorDepartment !== absentDepartment) return false;
  if (input.substituteTeacherDepartmentId !== undefined) {
    const substituteDepartment = String(input.substituteTeacherDepartmentId || "").trim();
    if (!substituteDepartment || (substituteDepartment !== absentDepartment && input.allowSupportingSubstitute !== true)) return false;
  }
  return true;
}
