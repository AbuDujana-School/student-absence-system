import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyTeamLeaderNoticePrintAccess,
  buildVisitorAccess,
  isDirectSupervisionMember,
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

Deno.test("explicit supervisor assignment belongs to exactly one team leader", () => {
  const supervisor = {
    name: "Supervisor A",
    role: "teacher",
    permissions: {
      studentAffairs: true,
      student_affairs_role: "supervisor",
      student_affairs_team_name: "فريق العلوم",
      supervisor_team_leader_name: "Leader A"
    }
  };
  if (!isDirectSupervisionMember(supervisor, "Leader A", "فريق العلوم")) {
    throw new Error("the explicitly selected leader must see the assigned supervisor");
  }
  if (isDirectSupervisionMember(supervisor, "Leader B", "فريق العلوم")) {
    throw new Error("a second leader with the same team name must not see this supervisor");
  }
});

Deno.test("legacy supervisors retain team-name matching until explicitly linked", () => {
  const legacy = {
    name: "Legacy Supervisor",
    role: "teacher",
    permissions: { studentAffairs: true, student_affairs_role: "supervisor", student_affairs_team_name: "فريق العلوم" }
  };
  if (!isDirectSupervisionMember(legacy, "Leader A", "فريق العلوم")) {
    throw new Error("legacy supervisor must retain the existing team-name link");
  }
  if (isDirectSupervisionMember(legacy, "Leader B", "فريق آخر")) {
    throw new Error("legacy supervisor must not appear in an unrelated team");
  }
});


Deno.test("team leader receives notice-only print access for a resolved team member", () => {
  const base = { role: "team_leader", can_print_attendance: false, can_print_behavior: false, can_print_combined: false };
  const scoped = applyTeamLeaderNoticePrintAccess(base, "team_leader", colleague, "notice_issue_commit");
  assertEquals(scoped.can_print_attendance, true);
  assertEquals(scoped.can_print_behavior, true);
  assertEquals(scoped.can_print_combined, true);
});

Deno.test("team leader notice print grant does not expand ordinary report permissions", () => {
  const base = { role: "team_leader", can_print_attendance: false, can_print_behavior: false, can_print_combined: false };
  assertEquals(applyTeamLeaderNoticePrintAccess(base, "team_leader", colleague, "print_attendance"), base);
  assertEquals(applyTeamLeaderNoticePrintAccess(base, "supervisor", colleague, "notice_issue_commit"), base);
  assertEquals(applyTeamLeaderNoticePrintAccess(base, "team_leader", null, "notice_issue_commit"), base);
});
