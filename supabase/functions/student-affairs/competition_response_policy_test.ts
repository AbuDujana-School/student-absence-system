import { assertEquals } from "jsr:@std/assert";
import { projectCompetitionTeams, projectCompetitionClassComparison } from "./competition_response_policy.ts";

const teams = [
  { grade: "9", score: 91, rank: 1, attendancePoints: 46, behaviorPoints: 45, complete: true, attendanceRate: 2.5, behaviorRate: 1.2, attendanceIncidents: 5, behaviorIncidents: 3, studentDays: 2000 },
  { grade: "10", score: 80, rank: 2, attendancePoints: 40, behaviorPoints: 40, complete: true, attendanceRate: 4.5, behaviorRate: 3.2, attendanceIncidents: 9, behaviorIncidents: 8, studentDays: 2000 },
  { grade: "11", score: 70, rank: 3, attendancePoints: 35, behaviorPoints: 35, complete: true, attendanceRate: 6.5, behaviorRate: 5.2, attendanceIncidents: 13, behaviorIncidents: 11, studentDays: 2000 },
  { grade: "12", score: 60, rank: 4, attendancePoints: 30, behaviorPoints: 30, complete: true, attendanceRate: 8.5, behaviorRate: 7.2, attendanceIncidents: 17, behaviorIncidents: 14, studentDays: 2000 }
];

Deno.test("team leader receives detailed metrics only for their own stage", () => {
  const result = projectCompetitionTeams(teams, false, ["9", "11"], true);
  assertEquals(result[0].attendanceRate, 2.5);
  assertEquals(result[2].behaviorIncidents, 11);
  for (const index of [1, 3]) {
    assertEquals("attendanceRate" in result[index], false);
    assertEquals("behaviorRate" in result[index], false);
    assertEquals("attendanceIncidents" in result[index], false);
    assertEquals("behaviorIncidents" in result[index], false);
    assertEquals("studentDays" in result[index], false);
  }
});

Deno.test("administrator receives detailed metrics for every stage", () => {
  const result = projectCompetitionTeams(teams, true, [], true);
  assertEquals(result.map(team => team.attendanceRate), [2.5, 4.5, 6.5, 8.5]);
});

Deno.test("no team scores or ranks are exposed while any team is incomplete", () => {
  const result = projectCompetitionTeams(teams, false, ["9"], false);
  for (const team of result) {
    assertEquals(team.score, null);
    assertEquals(team.rank, null);
    assertEquals(team.attendancePoints, null);
    assertEquals(team.behaviorPoints, null);
    assertEquals(team.complete, false);
  }
  assertEquals(result[0].attendanceRate, 2.5);
  assertEquals("attendanceRate" in result[1], false);
});

Deno.test("response never includes student names or raw attendance and behavior rows", () => {
  const result = projectCompetitionTeams(teams, false, ["9"], true);
  for (const team of result) {
    assertEquals("studentNames" in team, false);
    assertEquals("students" in team, false);
    assertEquals("attendanceRows" in team, false);
    assertEquals("behaviorRows" in team, false);
  }
});

Deno.test("competition-only teacher receives aggregate points for all stages without detailed metrics", () => {
  const result = projectCompetitionTeams(teams, false, [], true);
  assertEquals(result.map(team => team.score), [91, 80, 70, 60]);
  assertEquals(result.map(team => team.rank), [1, 2, 3, 4]);
  assertEquals(result.map(team => team.attendancePoints), [46, 40, 35, 30]);
  assertEquals(result.map(team => team.behaviorPoints), [45, 40, 35, 30]);
  for (const team of result) for (const key of ["attendanceRate", "behaviorRate", "attendanceIncidents", "behaviorIncidents", "studentDays", "studentNames", "attendanceRows", "behaviorRows"]) assertEquals(key in team, false);
});

Deno.test("class comparison exposes only the leader's assigned classes to teachers", () => {
  const rows = [
    { teamId: "A", teamName: "فريق أ", leaderName: "أحمد", className: "1/9", complete: true, attendanceRate: 2, behaviorRate: 1, attendanceIncidents: 9, attendanceStatusCounts: { absent: 2, late: 3 }, behaviorTypeCounts: { talking: 4 }, repeatAttendanceStudents: 2, repeatBehaviorStudents: 1 },
    { teamId: "B", teamName: "فريق ب", leaderName: "خالد", className: "1/10", complete: true, attendanceRate: 5, behaviorRate: 4, attendanceIncidents: 30 }
  ];
  const result = projectCompetitionClassComparison(rows, false, ["A"]);
  assertEquals(result.length, 1);
  assertEquals(result[0].className, "1/9");
  assertEquals("attendanceIncidents" in result[0], false);
});

Deno.test("administrator may compare class rates across all teams", () => {
  const rows = [
    { teamId: "A", teamName: "فريق أ", leaderName: "أحمد", className: "1/9", complete: true, attendanceRate: 2, behaviorRate: 1 },
    { teamId: "B", teamName: "فريق ب", leaderName: "خالد", className: "1/10", complete: true, attendanceRate: 5, behaviorRate: 4 }
  ];
  assertEquals(projectCompetitionClassComparison(rows, true, []).length, 2);
});

Deno.test("class coaching projection returns only safe aggregate counts for the leader's own team", () => {
  const rows = [
    { teamId: "A", teamName: "فريق أ", leaderName: "أحمد", className: "1/9", complete: true, attendanceRate: 2, behaviorRate: 1, attendanceStatusCounts: { absent: 2, late: 3 }, behaviorTypeCounts: { talking: 4 }, repeatAttendanceStudents: 2, repeatBehaviorStudents: 1 },
    { teamId: "B", teamName: "فريق ب", leaderName: "خالد", className: "1/10", complete: true, attendanceRate: 5, behaviorRate: 4, attendanceStatusCounts: { absent: 20 }, behaviorTypeCounts: { chaos: 10 }, repeatAttendanceStudents: 7, repeatBehaviorStudents: 5 }
  ];
  const result = projectCompetitionClassComparison(rows, false, ["A"]);
  assertEquals(result.length, 1);
  assertEquals(result[0].attendanceStatusCounts, { absent: 2, late: 3 });
  assertEquals(result[0].behaviorTypeCounts, { talking: 4 });
  assertEquals(result[0].repeatAttendanceStudents, 2);
  assertEquals(result[0].repeatBehaviorStudents, 1);
  assertEquals("studentNames" in result[0], false);
});
Deno.test("incomplete classes do not receive recommendation metrics", () => {
  const result = projectCompetitionClassComparison([
    { teamId: "A", teamName: "فريق أ", className: "1/9", complete: false, attendanceRate: null, behaviorRate: null, attendanceStatusCounts: { absent: 4 }, behaviorTypeCounts: { talking: 3 }, repeatAttendanceStudents: 2, repeatBehaviorStudents: 1 }
  ], false, ["A"]);
  assertEquals(result[0].attendanceStatusCounts, null);
  assertEquals(result[0].behaviorTypeCounts, null);
  assertEquals(result[0].repeatAttendanceStudents, null);
  assertEquals(result[0].repeatBehaviorStudents, null);
});
