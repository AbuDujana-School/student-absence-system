import { assertEquals } from "jsr:@std/assert";
import { authorizeCompetitionAccess } from "./competition_authorization.ts";

const classesByGrade = {
  "9": ["9/1", "9/2"],
  "10": ["10/1", "10/2"],
  "11": ["11/1"],
  "12": ["12/1", "12/2"]
};
const fullPermissions = {
  can_view_analytics: true,
  can_read_attendance: true,
  can_read_behavior: true,
  attendance_statuses: ["absent", "late", "outside", "escape"],
  allowed_attendance_classes: Object.values(classesByGrade).flat(),
  allowed_behavior_classes: Object.values(classesByGrade).flat()
};

Deno.test("admin is authorized for all configured stages", () => {
  assertEquals(
    authorizeCompetitionAccess("admin", {}, classesByGrade),
    { allowed: true, ownGrades: ["9", "10", "11", "12"] }
  );
});

Deno.test("ordinary teacher without all three permissions is rejected", () => {
  const result = authorizeCompetitionAccess("teacher", {
    ...fullPermissions,
    can_view_analytics: false
  }, classesByGrade);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "missing_permissions");
});

Deno.test("missing attendance status permission is rejected", () => {
  const result = authorizeCompetitionAccess("teacher", {
    ...fullPermissions,
    attendance_statuses: ["absent", "late", "outside"]
  }, classesByGrade);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "missing_statuses");
});

Deno.test("partial stage coverage cannot unlock that stage", () => {
  const result = authorizeCompetitionAccess("teacher", {
    ...fullPermissions,
    allowed_attendance_classes: ["9/1"],
    allowed_behavior_classes: ["9/1", "9/2"]
  }, classesByGrade);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "incomplete_grade_scope");
});

Deno.test("one complete stage is authorized and incomplete stages are excluded", () => {
  const result = authorizeCompetitionAccess("teacher", {
    ...fullPermissions,
    allowed_attendance_classes: ["9/1", "9/2", "10/1"],
    allowed_behavior_classes: ["9/1", "9/2", "10/1"]
  }, classesByGrade);
  assertEquals(result, { allowed: true, ownGrades: ["9"] });
});

Deno.test("multiple complete stages are authorized without granting other stages", () => {
  const result = authorizeCompetitionAccess("teacher", {
    ...fullPermissions,
    allowed_attendance_classes: ["9/1", "9/2", "11/1"],
    allowed_behavior_classes: ["9/1", "9/2", "11/1"]
  }, classesByGrade);
  assertEquals(result, { allowed: true, ownGrades: ["9", "11"] });
});

Deno.test("empty stages cannot be treated as fully authorized", () => {
  const result = authorizeCompetitionAccess("teacher", fullPermissions, {
    "9": [],
    "10": ["10/1"]
  }, ["9", "10"]);
  assertEquals(result, { allowed: true, ownGrades: ["10"] });
});
