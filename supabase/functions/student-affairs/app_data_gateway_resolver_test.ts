import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { resolveAppDataScope } from "./app_data_gateway_resolver.ts";

type FixtureOptions = {
  versions?: unknown[];
  cells?: unknown[];
  grants?: Record<string, unknown> | null;
  errors?: Record<string, unknown>;
};

function fixture(options: FixtureOptions = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const results: Record<string, unknown> = {
    timetable_weekly_versions: options.versions ?? [{ id: "active-v1" }],
    timetable_weekly_cells: options.cells ?? [
      { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: ["5/1"] },
      { matched_teacher_name: "Teacher B", match_status: "matched", cell_status: "teaching", class_sections: ["9/1"] },
      { matched_teacher_name: "Teacher A", match_status: "unmatched", cell_status: "teaching", class_sections: ["8/1"] },
      { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "duty", class_sections: ["7/1"] },
      { matched_teacher_name: "Teacher A", match_status: "matched", cell_status: "teaching", class_sections: ["6/1"] },
    ],
    student_affairs_permissions: options.grants ?? null,
    classes: [{ name: "5/1" }, { name: "6/1" }, { name: "7/1" }],
  };
  const db = {
    from(table: string) {
      calls.push(["from", table]);
      const query: any = {
        select(value: string) { calls.push(["select", value]); return this; },
        eq(column: string, value: unknown) { calls.push(["eq", table, column, value]); return this; },
        async limit(value: number) {
          calls.push(["limit", table, value]);
          return { data: results[table], error: options.errors?.[table] ?? null };
        },
        async maybeSingle() {
          calls.push(["maybeSingle", table]);
          return { data: results[table], error: options.errors?.[table] ?? null };
        },
      };
      return query;
    },
  };
  return { db, calls };
}

Deno.test("teacher scope derives only matched teaching classes for the exact principal", async () => {
  const { db, calls } = fixture();
  const scope = await resolveAppDataScope({ type: "teacher", name: "Teacher A", permissions: {} }, db);
  assertEquals(scope, {
    allowedClasses: ["5/1", "6/1"],
    allowedAttendanceClasses: ["5/1", "6/1"],
    allowedBehaviorClasses: ["5/1", "6/1"],
  });
  assert(calls.some(([kind, table, column, value]) =>
    kind === "eq" && table === "timetable_weekly_cells" &&
    column === "matched_teacher_name" && value === "Teacher A"));
});

Deno.test("Student Affairs grants expand only their explicitly enabled categories", async () => {
  const { db } = fixture({
    grants: {
      allowed_classes: ["10/1"],
      allowed_attendance_classes: ["11/1"],
      allowed_behavior_classes: ["12/1"],
      can_read_attendance: true,
      can_read_behavior: false,
    },
  });
  const scope = await resolveAppDataScope({
    type: "teacher", name: "Teacher A", permissions: { studentAffairs: true },
  }, db);
  assertEquals(scope, {
    allowedClasses: ["10/1", "5/1", "6/1"],
    allowedAttendanceClasses: ["11/1", "5/1", "6/1"],
    allowedBehaviorClasses: ["5/1", "6/1"],
  });
});

Deno.test("dedicated class grants cannot expand scope without the Student Affairs master permission", async () => {
  const { db } = fixture({
    grants: {
      allowed_classes: ["10/1"],
      allowed_attendance_classes: ["11/1"],
      allowed_behavior_classes: ["12/1"],
      can_read_attendance: true,
      can_read_behavior: true,
    },
  });
  const scope = await resolveAppDataScope({ type: "teacher", name: "Teacher A", permissions: {} }, db);
  assertEquals(scope.allowedClasses, ["5/1", "6/1"]);
  assertEquals(scope.allowedAttendanceClasses, ["5/1", "6/1"]);
  assertEquals(scope.allowedBehaviorClasses, ["5/1", "6/1"]);
});

Deno.test("ambiguous active timetable versions grant no timetable-derived classes", async () => {
  const { db } = fixture({ versions: [{ id: "active-v1" }, { id: "active-v2" }] });
  const scope = await resolveAppDataScope({ type: "teacher", name: "Teacher A", permissions: {} }, db);
  assertEquals(scope, { allowedClasses: [], allowedAttendanceClasses: [], allowedBehaviorClasses: [] });
});

Deno.test("a full 500-cell timetable result is discarded rather than treated as complete", async () => {
  const cells = Array.from({ length: 500 }, () => ({
    matched_teacher_name: "Teacher A", match_status: "matched",
    cell_status: "teaching", class_sections: ["5/1"],
  }));
  const { db } = fixture({ cells });
  const scope = await resolveAppDataScope({ type: "teacher", name: "Teacher A", permissions: {} }, db);
  assertEquals(scope, { allowedClasses: [], allowedAttendanceClasses: [], allowedBehaviorClasses: [] });
});

Deno.test("administrators do not trigger teacher timetable or class-grant queries", async () => {
  const { db, calls } = fixture();
  const scope = await resolveAppDataScope({ type: "admin", name: "Admin", permissions: {} }, db);
  assertEquals(scope, { allowedClasses: [] });
  assertEquals(calls, []);
});

Deno.test("resolver fails closed when active timetable lookup fails", async () => {
  const { db } = fixture({ errors: { timetable_weekly_versions: new Error("synthetic failure") } });
  await assertRejects(
    () => resolveAppDataScope({ type: "teacher", name: "Teacher A", permissions: {} }, db),
    Error,
    "Unable to resolve active timetable version",
  );
});


Deno.test("additional administrator data scope uses teacher grants and explicit student permission", async () => {
  const { db, calls } = fixture({
    grants: { allowed_classes: ["10/1"], allowed_attendance_classes: ["11/1"], allowed_behavior_classes: ["12/1"], can_read_attendance: true, can_read_behavior: true },
  });
  const scope = await resolveAppDataScope({
    type: "admin", adminScope: "additional", name: "Tester1",
    permissions: { students: true, studentAffairs: true },
  }, db);
  assertEquals(scope.allowedClasses, ["10/1", "5/1", "6/1", "7/1"]);
  assertEquals(scope.allowedAttendanceClasses, ["11/1", "5/1", "6/1", "7/1"]);
  assertEquals(scope.allowedBehaviorClasses, ["12/1", "5/1", "6/1", "7/1"]);
  assert(calls.some(([kind, table, column, value]) => kind === "eq" && table === "student_affairs_permissions" && column === "principal_type" && value === "teacher"));
});
