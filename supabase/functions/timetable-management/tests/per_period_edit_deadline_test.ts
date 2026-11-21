const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve server permissions follow each lesson's configured end time", () => {
  assert(source.includes("function substitutionPeriodDeadlineMs"), "The server must calculate a deadline for each period");
  assert(source.includes("function isSubstitutionPeriodOpen"), "The server must expose a shared per-period open-window check");
  assert(source.includes("loadSubstitutionPeriodTimings"), "The server must read the school's configured period timings");
  assert(source.includes("isSubstitutionPeriodOpen(cancellationDate,assignment.period,periodTimings)"), "Individual deletion must validate the assigned period deadline");
  assert(source.includes("isSubstitutionPeriodOpen(assignmentDate,row.period,periodTimings)"), "Group deletion must validate every lesson independently");
  assert(source.includes("isSubstitutionPeriodOpen(editableAssignment.assignment_date,requestedPeriod,periodTimings)"), "A reassignment must also validate the destination period deadline");
  assert(source.includes("hasReservePermission&&isSubstitutionPeriodOpen(row.assignment_date,row.period,periodTimings)"), "Undated legacy assignments must not inherit the selected date's edit grant");
  assert(source.includes("canDelete:Boolean(activeVersion.data"), "Archive rows must expose a separate delete permission");
});
