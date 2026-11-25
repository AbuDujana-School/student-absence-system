const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
const migration = await Deno.readTextFile(new URL("../../../migrations/20261125120000_substitution_assignment_day_edit_window.sql", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("new reserve assignments and direct deletions retain period deadlines while saved edits last through Muscat midnight", () => {
  assert(source.includes("function substitutionPeriodDeadlineMs"), "The server must calculate a deadline for each period");
  assert(source.includes("function isSubstitutionPeriodOpen"), "The server must preserve the per-period gate for new assignments and direct deletes");
  assert(source.includes("function isSubstitutionAssignmentDayOpen"), "The server must calculate editability from the assignment date");
  assert(source.includes("isSubstitutionPeriodOpen(assignmentDate,period,periodTimings)"), "Single new assignments must be blocked after the lesson deadline");
  assert(source.includes("normalized.some((item:any)=>!isSubstitutionPeriodOpen(assignmentDate,item.period,periodTimings))"), "Batch additions must validate every proposed lesson deadline");
  assert(source.includes('if(principal.type!=="admin"&&!isSubstitutionPeriodOpen(assignmentDate,period,periodTimings))'), "Single additions must retain the lesson deadline");
  assert(source.includes("planningTimetable=principal.type===\\"admin\\"?timetable:"), "Batch preview must not suggest new assignments for expired lessons");
  assert(source.includes("isSubstitutionPeriodOpen(cancellationDate,assignment.period,periodTimings)"), "Individual deletion must retain the assigned period deadline");
  assert(source.includes("isSubstitutionPeriodOpen(assignmentDate,row.period,periodTimings)"), "Group deletion must retain the assigned period deadline");
  assert(source.includes("const withinWindow=isSubstitutionAssignmentDayOpen(editableAssignment.assignment_date,todayInMuscat)"), "Single edits must remain open through the end of their assignment date");
  assert(source.includes("return !isSubstitutionAssignmentDayOpen(row.assignment_date,todayInMuscat)"), "Batch edits must use the same assignment-day deadline");
  assert(source.includes("allowPastPeriodForExisting=body.allowPastPeriodForEdit===true"), "An existing assignment must be editable after its period ends, but only through its date");
  assert(source.includes("canEdit:Boolean(activeVersion.data"), "Archive rows must expose a separate edit permission");
  assert(source.includes("hasReservePermission&&isSubstitutionAssignmentDayOpen(row.assignment_date,todayInMuscat)"), "Reserve editors must retain future assignments until their scheduled day ends");
  assert(migration.includes("timetable_substitution_assignment_day_is_open"), "The database must enforce the Muscat assignment-day window");
  assert(migration.includes("set_config('app.allow_reserve_edit_until_day_end','true',true)"), "Only replacement operations may temporarily bypass the period deadline");
  assert(migration.includes("absence_reason=v_absence_reason"), "Editing a reserve record must preserve its existing absence reason");
});
