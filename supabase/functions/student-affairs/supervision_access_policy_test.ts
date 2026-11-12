import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVisitorAccess,
  projectSupervisionReportPermissions,
  resolveSupervisionTeacher,
  resolveTeamLeader,
} from "./supervision_access_policy.ts";

const colleague = {
  name: "معلم الفريق",
  allowed_attendance_classes: ["تاسع رابع"],
  allowed_behavior_classes: ["تاسع خامس"],
  attendance_statuses: ["absent", "late"],
  can_read_attendance: true,
  can_read_behavior: true,
};
const directory = [colleague, { name: "معلم آخر", allowed_attendance_classes: ["عاشر أول"] }];

Deno.test("leader can resolve only a directly supervised colleague", () => {
  assertEquals(resolveSupervisionTeacher("team_leader", "معلم الفريق", [colleague], directory), colleague);
  assertEquals(resolveSupervisionTeacher("team_leader", "معلم آخر", [colleague], directory), null);
});

Deno.test("supervisor cannot resolve another teacher", () => {
  assertEquals(resolveSupervisionTeacher("supervisor", "معلم الفريق", [colleague], directory), null);
});

Deno.test("visitor can resolve any teacher in the Student Affairs directory", () => {
  assertEquals(resolveSupervisionTeacher("visitor", "معلم آخر", [], directory), directory[1]);
  assertEquals(resolveSupervisionTeacher("visitor", "غير مسجل", [], directory), null);
});

Deno.test("visitor has global read, analytics and print access without owned classes or competition entry", () => {
  const permissions = buildVisitorAccess(["تاسع رابع", "تاسع خامس"], directory);
  assertEquals(permissions.allowed_attendance_classes, ["تاسع رابع", "تاسع خامس"]);
  assertEquals(permissions.own_allowed_attendance_classes, []);
  assertEquals(permissions.can_read_attendance, true);
  assertEquals(permissions.can_read_behavior, true);
  assertEquals(permissions.can_view_analytics, true);
  assertEquals(permissions.can_print_combined, true);
  assertEquals(permissions.competition_participant, false);
});

Deno.test("supervisor assignment resolves only an active team leader and inherits the leader's team", () => {
  const leaders = [
    { name: "قائد نشط", role: "team_leader", studentAffairs: true, teamName: "فريق التاسع" },
    { name: "قائد غير مفعل", role: "team_leader", studentAffairs: false, teamName: "فريق آخر" },
    { name: "معلم عادي", role: "supervisor", studentAffairs: true, teamName: "فريق التاسع" },
  ];
  assertEquals(resolveTeamLeader("قائد نشط", "معلم مشرف", leaders), leaders[0]);
  assertEquals(resolveTeamLeader("قائد غير مفعل", "معلم مشرف", leaders), null);
  assertEquals(resolveTeamLeader("معلم عادي", "معلم مشرف", leaders), null);
  assertEquals(resolveTeamLeader("قائد نشط", "قائد نشط", leaders), null);
  assertEquals(resolveTeamLeader("", "معلم مشرف", leaders), null);
});

Deno.test("colleague report scope does not overwrite leader ownership", () => {
  const base = { own_allowed_attendance_classes: ["تاسع أول"], own_allowed_behavior_classes: ["تاسع ثاني"], can_view_analytics: true };
  const scoped = projectSupervisionReportPermissions(base, colleague, false);
  assertEquals(scoped.allowed_attendance_classes, ["تاسع رابع"]);
  assertEquals(scoped.allowed_behavior_classes, ["تاسع خامس"]);
  assertEquals(scoped.own_allowed_attendance_classes, ["تاسع أول"]);
  assertEquals(scoped.can_read_attendance, true);
});
