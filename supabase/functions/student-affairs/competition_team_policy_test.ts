import { buildCompetitionTeams, findCompetitionClassesOutsidePersonalScope } from "./competition_team_policy.ts";
import { isDirectSupervisionMember } from "./supervision_access_policy.ts";

Deno.test("only explicitly enrolled teachers become competition teams", () => {
  const teams = buildCompetitionTeams([
    { name: "Teacher A", permissions: { competition_participant: true, competition_team_name: "فريق الأمل", competition_team_classes: ["1/9", "2/9"] } },
    { name: "Counselor", role: "custom", permissions: { competition_participant: false } },
    { name: "Teacher B", permissions: { competition_participant: false, competition_team_name: "ignored", competition_team_classes: ["3/9"] } }
  ], ["1/9", "2/9", "3/9"]);
  if (teams.length !== 1 || teams[0].leaderName !== "Teacher A" || teams[0].classNames.length !== 2) throw new Error("non-participants must not enter the competition");
});

Deno.test("explicit supervisor assignment belongs to exactly one team leader", () => {
  const supervisor = {
    name: "Supervisor A",
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
    permissions: { studentAffairs: true, student_affairs_role: "supervisor", student_affairs_team_name: "فريق العلوم" }
  };
  if (!isDirectSupervisionMember(legacy, "Leader A", "فريق العلوم")) {
    throw new Error("legacy same-team assignment should remain visible");
  }
  if (isDirectSupervisionMember(legacy, "Leader B", "فريق آخر")) {
    throw new Error("legacy supervisor must not appear outside the matching team");
  }
});

Deno.test("leader competition classes must stay within personal class assignments", () => {
  if (findCompetitionClassesOutsidePersonalScope(["تاسع أول", "تاسع ثالث"], ["تاسع أول", "تاسع ثاني"]).join("|") !== "تاسع ثالث") {
    throw new Error("classes assigned to supervisors must be rejected from the leader's competition scope");
  }
  if (findCompetitionClassesOutsidePersonalScope(["تاسع أول", "تاسع ثاني"], ["تاسع أول", "تاسع ثاني"]).length) {
    throw new Error("the leader's own classes should be accepted");
  }
});

Deno.test("team name and assigned classes are mandatory", () => {
  for (const permissions of [
    { competition_participant: true, competition_team_name: "", competition_team_classes: ["1/9"] },
    { competition_participant: true, competition_team_name: "فريق", competition_team_classes: [] }
  ]) {
    let rejected = false;
    try { buildCompetitionTeams([{ name: "Teacher", permissions }], ["1/9"]); } catch { rejected = true; }
    if (!rejected) throw new Error("invalid team configuration must be rejected");
  }
});

Deno.test("a class cannot be assigned to more than one team", () => {
  let rejected = false;
  try {
    buildCompetitionTeams([
      { name: "A", permissions: { competition_participant: true, competition_team_name: "A", competition_team_classes: ["1/9"] } },
      { name: "B", permissions: { competition_participant: true, competition_team_name: "B", competition_team_classes: ["1/9"] } }
    ], ["1/9"]);
  } catch { rejected = true; }
  if (!rejected) throw new Error("duplicate class assignments must be rejected");
});

Deno.test("custom users cannot become competition participants", () => {
  let rejected = false;
  try {
    buildCompetitionTeams([{ name: "Counselor", role: "custom", permissions: { competition_participant: true, competition_team_name: "Team", competition_team_classes: ["1/9"] } }], ["1/9"]);
  } catch { rejected = true; }
  if (!rejected) throw new Error("custom users must remain outside the competition");
});
