import { assertEquals } from "jsr:@std/assert";
import { projectCompetitionTeams } from "./competition_response_policy.ts";

const teams = [
  { grade: "9", teamId: "A", teamName: "فريق أ", leaderName: "أحمد", classNames: ["1/9"], score: 91, rank: 1, weeklyPoints: 10, totalPoints: 20, attendancePoints: 46, behaviorPoints: 45, complete: true, attendanceRate: 2.5, behaviorRate: 1.2, attendanceIncidents: 5, behaviorIncidents: 3, classCount: 1 },
  { grade: "10", teamId: "B", teamName: "فريق ب", leaderName: "خالد", classNames: ["1/10"], score: 80, rank: 2, weeklyPoints: 6, totalPoints: 10, attendancePoints: 40, behaviorPoints: 40, complete: true, attendanceRate: 4.5, behaviorRate: 3.2, attendanceIncidents: 9, behaviorIncidents: 8, classCount: 1 },
  { grade: "11", teamId: "C", teamName: "فريق ج", leaderName: "سالم", classNames: ["1/11"], score: 70, rank: 3, weeklyPoints: 3, totalPoints: 3, attendancePoints: 35, behaviorPoints: 35, complete: true, attendanceRate: 6.5, behaviorRate: 5.2, attendanceIncidents: 13, behaviorIncidents: 11, classCount: 1 },
  { grade: "12", teamId: "D", teamName: "فريق د", leaderName: "ناصر", classNames: ["1/12"], score: 60, rank: 4, weeklyPoints: 0, totalPoints: 0, attendancePoints: 30, behaviorPoints: 30, complete: true, attendanceRate: 8.5, behaviorRate: 7.2, attendanceIncidents: 17, behaviorIncidents: 14, classCount: 1 }
];

Deno.test("team leader receives detailed metrics only for their own stage", () => {
  const result = projectCompetitionTeams(teams, false, ["9", "11"], true);
  assertEquals(result[0].attendanceRate, 2.5);
  assertEquals(result[2].behaviorIncidents, 11);
  assertEquals(result[1].attendanceRate, 4.5);
  for (const index of [1, 3]) {
    assertEquals(typeof result[index].attendanceRate, "number");
    assertEquals(typeof result[index].behaviorRate, "number");
    assertEquals("attendanceIncidents" in result[index], false);
    assertEquals("behaviorIncidents" in result[index], false);
    assertEquals("classCount" in result[index], false);
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
  assertEquals(result[0].attendanceRate, null);
  assertEquals(result[1].attendanceRate, null);
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
  assertEquals(result.map(team => team.weeklyPoints), [10, 6, 3, 0]);
  assertEquals(result.map(team => team.totalPoints), [20, 10, 3, 0]);
  assertEquals(result.map(team => team.attendanceRate), [2.5, 4.5, 6.5, 8.5]);
  for (const team of result) for (const key of ["attendanceIncidents", "behaviorIncidents", "classCount", "studentNames", "attendanceRows", "behaviorRows"]) assertEquals(key in team, false);
});
