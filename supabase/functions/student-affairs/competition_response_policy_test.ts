import { assertEquals } from "jsr:@std/assert";
import { projectCompetitionTeams } from "./competition_response_policy.ts";

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
