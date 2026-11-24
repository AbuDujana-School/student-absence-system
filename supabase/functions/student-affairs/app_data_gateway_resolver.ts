import { mergeAppDataClassScopes, projectAssignedClassScope } from "./app_data_gateway_scope.ts";
import type { AppDataScope } from "./app_data_gateway_policy.ts";

export type AppDataScopePrincipal = {
  type: string;
  name: string;
  permissions?: Record<string, unknown>;
  adminScope?: "general" | "additional";
};

type QueryResult = { data: any; error: unknown };
type ScopeDatabase = { from(table: string): any };

/** Resolve a teacher's data scope exclusively from server-side timetable and grants. */
export async function resolveAppDataScope(
  principal: AppDataScopePrincipal,
  db: ScopeDatabase,
): Promise<AppDataScope> {
  const principalType = principal.type === "admin" && principal.adminScope === "additional" ? "teacher" : principal.type;
  if (principalType !== "teacher" && principalType !== "custom") return { allowedClasses: [] };

  // A teacher with the explicit full-administrator capability receives the
  // same schoolwide data scope as the general administrator, without changing
  // the teacher identity or enabling Additional Admin.
  if (principal.type === "teacher" && principal.permissions?.admin === true) {
    const { data: classes, error: classesError } = await db.from("classes").select("name").limit(1000) as QueryResult;
    if (classesError) throw new Error("Unable to resolve delegated administrator class scope");
    const allClasses: string[] = [...new Set<string>((classes || []).map((item: any) => String(item.name || "").trim()).filter(Boolean))];
    return { allowedClasses: allClasses, allowedAttendanceClasses: allClasses, allowedBehaviorClasses: allClasses };
  }

  const { data: versions, error: versionError } = await db.from("timetable_weekly_versions")
    .select("id").eq("status", "active").limit(2) as QueryResult;
  if (versionError) throw new Error("Unable to resolve active timetable version");

  let timetableClasses: string[] = [];
  if (versions?.length === 1 && versions[0]?.id) {
    const { data: cells, error: cellsError } = await db.from("timetable_weekly_cells")
      .select("matched_teacher_name,match_status,cell_status,class_sections")
      .eq("version_id", versions[0].id)
      .eq("matched_teacher_name", principal.name)
      .eq("match_status", "matched")
      .eq("cell_status", "teaching")
      .limit(500) as QueryResult;
    if (cellsError) throw new Error("Unable to resolve teacher timetable assignments");
    if ((cells || []).length < 500) timetableClasses = projectAssignedClassScope(cells || [], principal.name);
  }

  if (principal.type === "admin" && principal.adminScope === "additional" && principal.permissions?.students === true) {
    const { data: classes, error: classesError } = await db.from("classes").select("name").limit(1000);
    if (classesError) throw new Error("Unable to resolve additional administrator class scope");
    timetableClasses = [...new Set([...timetableClasses, ...(classes || []).map((item: any) => String(item.name || "")).filter(Boolean)])];
  }

  const { data: grants, error: grantError } = await db.from("student_affairs_permissions")
    .select("allowed_classes,allowed_attendance_classes,allowed_behavior_classes,can_read_attendance,can_read_behavior")
    .eq("principal_type", principalType)
    .eq("principal_name", principal.name)
    .maybeSingle() as QueryResult;
  if (grantError) throw new Error("Unable to resolve explicit school-affairs class grants");

  const hasStudentAffairsAccess = principal.permissions?.studentAffairs === true;
  const explicitGeneral = principal.permissions?.studentAffairs === true ? grants?.allowed_classes : [];
  const explicitAttendance = grants?.can_read_attendance === true ? grants.allowed_attendance_classes : [];
  const explicitBehavior = grants?.can_read_behavior === true ? grants.allowed_behavior_classes : [];

  return mergeAppDataClassScopes(timetableClasses, {
    allowed_classes: explicitGeneral,
    allowed_attendance_classes: explicitAttendance,
    allowed_behavior_classes: explicitBehavior,
    can_read_attendance: grants?.can_read_attendance,
    can_read_behavior: grants?.can_read_behavior,
  }, hasStudentAffairsAccess);
}
