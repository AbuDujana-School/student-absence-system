const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
const lifecycleSql = await Deno.readTextFile(new URL("../../../migrations/20261125170000_reserve_edit_until_assignment_day_end.sql", import.meta.url));

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
  assert(source.includes("isSubstitutionDayOpen(cancellationDate)"), "Individual deletion must remain available through the end of the assignment day");
  assert(source.includes("isSubstitutionDayOpen(assignmentDate)"), "Group deletion must remain available through the end of the assignment day");
  assert(source.includes("isSubstitutionDayOpen(editableAssignment.assignment_date)"), "A reassignment must use the assignment-day edit window rather than the period end");
  assert(source.includes(`(hasReservePermission||principal.type==="custom")&&isSubstitutionDayOpen(row.assignment_date)`), "Archive edit controls must remain available through the end of the assignment day");
  assert(source.includes("isSubstitutionPeriodOpen(assignmentDate,period,periodTimings)"), "New single assignments must still obey the period-end creation deadline");
  assert(source.includes("normalized.some((item:any)=>!isSubstitutionPeriodOpen(assignmentDate,item.period,periodTimings))"), "New batch assignments must still obey each period-end creation deadline");
  assert(source.includes(`(principal.type==="custom"||hasReservePermission)&&dateScopedCreateActions.has(actionName)`), "Subject coordinators must be blocked from creating or previewing a past-date distribution");
  assert(source.includes("canDelete:Boolean(activeVersion.data"), "Archive rows must expose a separate delete permission");
  assert(source.includes('body.editableOnly===true&&principal.type==="custom"'), "Scoped custom coordinators must be able to query all future active assignments without widening schoolwide archive access");
});

Deno.test("saved reserve assignments stay editable until Muscat midnight while new assignments keep lesson deadlines", () => {
  assert(lifecycleSql.includes("timetable_substitution_day_is_open"), "The migration must add a separate full-day edit window");
  assert(lifecycleSql.includes("(p_assignment_date + 1)::timestamp AT TIME ZONE 'Asia/Muscat'"), "The edit window must close at midnight in Muscat");
  assert(lifecycleSql.includes("timetable_substitution_period_is_open(v_date,v_period)"), "The SQL creation path must preserve its lesson-end deadline");
  assert(lifecycleSql.includes("not v_internal_edit and not public.timetable_substitution_period_is_open(v_date,v_period)"), "Only internal replacements may bypass the new-assignment deadline");
  assert(lifecycleSql.includes("timetable_substitution_day_is_open(v_assignment.assignment_date)"), "SQL cancellation must use the assignment-day deadline");
  assert(lifecycleSql.includes("timetable_substitution_day_is_open(v_old.assignment_date)"), "SQL replacements must use the assignment-day deadline");
});
