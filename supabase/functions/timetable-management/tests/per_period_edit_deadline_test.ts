const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve server permissions follow each lesson's configured end time", () => {
  assert(source.includes("function substitutionPeriodDeadlineMs"), "The server must calculate a deadline for each period");
  assert(source.includes("function isSubstitutionPeriodOpen"), "The server must expose a shared per-period open-window check");
  assert(source.includes("loadSubstitutionPeriodTimings"), "The server must read the school's configured period timings");
  assert(source.includes("isSubstitutionPeriodOpen(assignmentDate,period,periodTimings)"), "Single new assignments must be blocked after the lesson deadline");
  assert(source.includes("normalized.some((item:any)=>!isSubstitutionPeriodOpen(assignmentDate,item.period,periodTimings))"), "Batch additions must validate every proposed lesson deadline");
  assert(source.includes('if(principal.type!=="admin"&&!isSubstitutionPeriodOpen(assignmentDate,period,periodTimings))'), "Single additions must be blocked after the lesson deadline");
  assert(source.includes("planningTimetable=principal.type===\"admin\"?timetable:"), "Batch preview must not suggest new assignments for expired lessons");
  assert(source.includes('blockReason:periodOpen?null:"period_passed"'), "Single preview must explain that an expired lesson cannot receive a new assignment");
  assert(source.includes("isSubstitutionAssignmentEditableUntilDayEnd(cancellationDate,todayInMuscat)"), "Individual deletion must remain available through the assigned day");
  assert(source.includes("isSubstitutionAssignmentEditableUntilDayEnd(assignmentDate,todayInMuscat)"), "Group deletion must remain available through the assigned day");
  assert(source.includes("isSubstitutionAssignmentEditableUntilDayEnd(editableAssignment.assignment_date,todayInMuscat)"), "Saved assignment reassignment must remain available through the assigned day");
  assert(source.includes("hasReservePermission&&isSubstitutionAssignmentEditableUntilDayEnd(row.assignment_date,todayInMuscat)"), "Archive edit grants must follow the assignment day and coordinator scope");
  assert(source.includes("canDelete:Boolean(activeVersion.data"), "Archive rows must expose a separate delete permission");
});

Deno.test("authorized future reserve assignments remain editable and deletable until their assigned Muscat day ends", () => {
  assert(source.includes('import { isSubstitutionDayOpen } from "./reserve_edit_window.ts";') &&
    source.includes("return isSubstitutionDayOpen(assignmentDate);"),
    "Today and future dates must remain editable through the shared validated Muscat-day window");
  assert(source.includes('principal.type==="admin"?isSubstitutionAssignmentEditableUntilDayEnd(row.assignment_date,todayInMuscat)'),
    "Admin deletion permissions must use the same assigned-day cutoff as coordinators");
  assert(source.includes('return !isSubstitutionAssignmentEditableUntilDayEnd(row.assignment_date,todayInMuscat);'),
    "Batch edits must allow future dates while rejecting dates already in the past");
  assert(!source.includes('String(row.assignment_date||"")!==todayInMuscat'),
    "Admin batch edits must not be restricted to today when the assignment is in the future");
});
