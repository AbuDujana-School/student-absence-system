import { assertEquals } from "jsr:@std/assert";
import { authorizeCompetitionAccess } from "./competition_authorization.ts";

const classesByGrade = {
  "9": ["9/1", "9/2"],
  "10": ["10/1", "10/2"],
  "11": ["11/1"],
  "12": ["12/1", "12/2"]
};

Deno.test("admin is authorized for all configured stages", () => {
  assertEquals(authorizeCompetitionAccess("admin", {}, classesByGrade), {
    allowed: true, ownGrades: ["9", "10", "11", "12"]
  });
});

Deno.test("competition permission alone grants aggregate stage scoreboard access", () => {
  assertEquals(authorizeCompetitionAccess("teacher", { can_view_competition: true }, classesByGrade), {
    allowed: true, ownGrades: []
  });
});

Deno.test("competition permission does not require report analytics or detail-read flags", () => {
  assertEquals(authorizeCompetitionAccess("teacher", {
    can_view_competition: true,
    allowed_attendance_classes: ["9/1"],
    allowed_behavior_classes: ["9/1"]
  }, classesByGrade), { allowed: true, ownGrades: [] });
});

Deno.test("teacher without independent competition permission is rejected", () => {
  const result = authorizeCompetitionAccess("teacher", {
    allowed_attendance_classes: Object.values(classesByGrade).flat(),
    allowed_behavior_classes: Object.values(classesByGrade).flat()
  }, classesByGrade);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "missing_competition_permission");
});

Deno.test("full assignment of a stage retains detailed insights only for that stage", () => {
  assertEquals(authorizeCompetitionAccess("teacher", {
    can_view_competition: true,
    allowed_attendance_classes: ["9/1", "9/2", "10/1"],
    allowed_behavior_classes: ["9/1", "9/2", "10/1"]
  }, classesByGrade), { allowed: true, ownGrades: ["9"] });
});

Deno.test("partial class assignment allows aggregate scoreboard but not stage details", () => {
  assertEquals(authorizeCompetitionAccess("teacher", {
    can_view_competition: true,
    allowed_attendance_classes: ["9/1"],
    allowed_behavior_classes: ["9/1", "9/2"]
  }, classesByGrade), { allowed: true, ownGrades: [] });
});

Deno.test("attendance-only or behavior-only class assignment never unlocks detailed stage insights", () => {
  assertEquals(authorizeCompetitionAccess("teacher", {
    can_view_competition: true,
    allowed_attendance_classes: ["9/1", "9/2"],
    allowed_behavior_classes: ["9/1"]
  }, classesByGrade), { allowed: true, ownGrades: [] });
});
