import { canUseTimetableAction } from "../supabase/functions/timetable-management/session_auth.ts";
import { canCustomCoordinatorManageDepartment } from "../supabase/functions/timetable-management/reserve_authorization.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("custom reserve coordinators can use the scoped batch workflow and active edit actions", () => {
  const allowed = [
    "timetable_substitution_preview",
    "timetable_substitution_save",
    "timetable_substitution_cancel",
    "timetable_substitution_cancel_batch",
    "timetable_substitution_batch_preview",
    "timetable_substitution_batch_save",
    "timetable_substitution_update",
    "timetable_substitution_update_batch",
  ];
  for (const action of allowed) {
    assert(
      canUseTimetableAction("custom", action),
      "Custom timetable coordinator must be able to use the department-scoped action: " + action,
    );
  }
});

Deno.test("custom reserve coordinators cannot gain schoolwide statistics, archive, or reset actions", () => {
  for (const action of [
    "timetable_substitution_stats",
    "timetable_substitution_archive",
    "timetable_substitution_reset_options",
    "timetable_substitution_reset",
    "timetable_substitution_departments",
  ]) {
    assert(
      !canUseTimetableAction("custom", action),
      "Custom timetable coordinator must not receive schoolwide capability: " + action,
    );
  }
});

Deno.test("custom reserve mutations stay inside the coordinator department", () => {
  const base = {
    actorType: "custom",
    actorDepartmentId: "لغة إنجليزية",
    absentTeacherDepartmentId: "لغة إنجليزية",
  };
  assert(canCustomCoordinatorManageDepartment(base), "Coordinator may manage an absent teacher in their department");
  assert(
    !canCustomCoordinatorManageDepartment({ ...base, absentTeacherDepartmentId: "لغة عربية" }),
    "Coordinator must not manage an absent teacher in another department",
  );
  assert(
    !canCustomCoordinatorManageDepartment({ ...base, substituteTeacherDepartmentId: "علوم" }),
    "Coordinator must not assign a substitute from another department",
  );
  assert(
    !canCustomCoordinatorManageDepartment({ ...base, actorDepartmentId: "" }),
    "A custom coordinator without a department must be denied",
  );
  assert(
    !canCustomCoordinatorManageDepartment({ ...base, absentTeacherDepartmentId: "" }),
    "An absent teacher without a known department must be denied",
  );
});

Deno.test("general admin and explicitly reserve-enabled teachers keep their existing action authority", () => {
  const actions = [
    "timetable_substitution_batch_preview",
    "timetable_substitution_batch_save",
    "timetable_substitution_update",
    "timetable_substitution_update_batch",
    "timetable_substitution_reset",
  ];
  for (const action of actions) {
    assert(canUseTimetableAction("admin", action), "General admin must retain existing authority: " + action);
    assert(
      canUseTimetableAction("teacher", action, false, true),
      "Reserve-enabled teacher must retain existing authority: " + action,
    );
  }
  assert(
    canCustomCoordinatorManageDepartment({
      actorType: "admin",
      actorDepartmentId: "",
      absentTeacherDepartmentId: "لغة إنجليزية",
      substituteTeacherDepartmentId: "علوم",
    }),
    "The custom department guard must not change the general admin authorization path",
  );
});
