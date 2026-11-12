import { buildCompetitionTeams, findCompetitionClassesOutsidePersonalScope } from "./competition_team_policy.ts";

Deno.test("only explicitly enrolled teachers become competition teams", () => {
  const teams = buildCompetitionTeams([
    { name: "Teacher A", permissions: { competition_participant: true, competition_team_name: "فريق الأمل", competition_team_classes: ["1/9", "2/9"] } },
    { name: "Counselor", role: "custom", permissions: { competition_participant: false } },
    { name: "Teacher B", permissions: { competition_participant: false, competition_team_name: "ignored", competition_team_classes: ["3/9"] } }
  ], ["1/9", "2/9", "3/9"]);
  if (teams.length !== 1 || teams[0].leaderName !== "Teacher A" || teams[0].classNames.length !== 2) throw new Error("non-participants must not enter the competition");
});

Deno.test("supervision team assignments do not expand competition classes", () => {
  const teams = buildCompetitionTeams([
    { name: "قائد الفريق", permissions: { student_affairs_role: "team_leader", student_affairs_team_name: "فريق التاسع", competition_participant: true, competition_team_name: "فريق المسابقة", competition_team_classes: ["تاسع أول", "تاسع ثاني"] } },
    { name: "معلم مشرف", permissions: { student_affairs_role: "supervisor", supervisor_team_leader_name: "قائد الفريق", student_affairs_team_name: "فريق التاسع", competition_participant: false, competition_team_classes: ["تاسع ثالث"] } }
  ], ["تاسع أول", "تاسع ثاني", "تاسع ثالث"]);
  if (teams.length !== 1) throw new Error("supervisors must not become competition participants automatically");
  if (teams[0].classNames.join("|") !== "تاسع أول|تاسع ثاني") throw new Error("supervisor classes must never be added to the leader's competition classes");
});

Deno.test("leader competition classes must stay within personal class assignments", () => {
  if (findCompetitionClassesOutsidePersonalScope(["تاسع أول", "تاسع ثالث"], ["تاسع أول", "تاسع ثاني"]).join("|") !== "تاسع ثالث") {
    throw new Error("classes assigned to supervisors must be rejected from the leader's competition scope");
  }
  if (findCompetitionClassesOutsidePersonalScope(["تاسع أول", "تاسع ثاني"], ["تاسع أول", "تاسع ثاني"]).length) {
    throw new Error("the leader's own classes should be accepted");
  }
});

Deno.test("legacy visitor accounts are excluded from the competition even if an old flag is true", () => {
  const teams = buildCompetitionTeams([
    { name: "زائر", permissions: { student_affairs_role: "visitor", competition_participant: true, competition_team_name: "فريق قديم", competition_team_classes: ["1/9"] } },
    { name: "قائد", permissions: { student_affairs_role: "team_leader", competition_participant: true, competition_team_name: "فريق القائد", competition_team_classes: ["2/9"] } }
  ], ["1/9", "2/9"]);
  if (teams.length !== 1 || teams[0].leaderName !== "قائد") throw new Error("visitors must never become competition participants");
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
