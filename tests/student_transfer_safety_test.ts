const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const edge = await Deno.readTextFile(new URL("../supabase/functions/student-affairs/index.ts", import.meta.url));
const migration = await Deno.readTextFile(new URL("../supabase/migrations/20261116120000_atomic_student_transfer.sql", import.meta.url));
const recoveryMigration = await Deno.readTextFile(new URL("../supabase/migrations/20261116133000_student_transfer_existing_destination_recovery.sql", import.meta.url));
const rosterMigration = await Deno.readTextFile(new URL("../supabase/migrations/20261118103000_student_roster_direct_save.sql", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, "Missing source section: " + startMarker);
  return source.slice(start, end);
}

Deno.test("student roster removal preserves historical attendance and behavior", () => {
  const bulk = section(html, "async function saveBulkStudents()", "function handleStudentFileImport");
  const remove = section(html, "async function removeStudent(className, idx)", "async function addNewClassPrompt");
  assert(!bulk.includes("delete sess.records[r]"), "Bulk roster removal must not erase student attendance entries");
  assert(!bulk.includes("delete sess.records[r]"), "Bulk roster removal must not erase student behavior entries");
  assert(!remove.includes("delete s.records[n]"), "Single roster removal must not erase historical entries");
});

Deno.test("student transfer UI requires admin authorization and uses the server transaction", () => {
  const transfer = section(html, "async function transferStudentToClass(", "async function saveBulkStudents()");
  assert(transfer.includes("isAdminAuthorized()"), "Transfer UI must require admin authorization");
  assert(transfer.includes("hasPendingOfflineRecordChanges()"), "Transfer must stop when local changes are pending");
  assert(transfer.includes("action: 'admin_transfer_student'"), "Transfer must use the dedicated server action");
  assert(transfer.includes("loadSystemDataFromCloud()"), "Transfer must reload the committed server state");
  assert(transfer.includes("clearStudentDeleteIntents(fromClass, [studentName])"), "Only the transferred student's obsolete local deletion intent may be cleared");
});

Deno.test("Edge Function accepts transfers only from the active general admin session", () => {
  const action = section(edge, 'if (body?.action === "admin_transfer_student")', 'if (body?.action === "app_student_affairs_session")');
  assert(action.includes("readAuthorizedAppSession"), "Transfer must validate and revalidate the general app session");
  assert(action.includes("!isGeneralAdminPrincipal(principal)"), "Only the general admin may transfer students");
  assert(action.includes('db.rpc("admin_transfer_student"'), "Transfer must run in the database transaction");
});

Deno.test("a queued student removal can be converted into a transfer", () => {
  const review = section(html, "function openPendingDeleteReview()", "async function queueCloudDelete(");
  assert(review.includes("data-pending-delete-action=\"transfer-student\""), "Student delete requests must offer a direct transfer action");
  assert(review.includes("item?.filters?.student_name"), "The transfer action must use the exact queued student");
  assert(review.includes("promptStudentTransferClass(studentName, fromClass)"), "The queued transfer must request a destination class");
  assert(review.includes("transferStudentToClass(studentName, fromClass, toClass)"), "The queued transfer must use the atomic transfer workflow");
});
Deno.test("existing destination membership is preserved while stale source membership is removed", () => {
  assert(recoveryMigration.includes("v_destination_student_id"), "Recovery migration must detect an existing destination membership");
  assert(recoveryMigration.includes("DELETE FROM public.students"), "Recovery migration must remove only the stale source membership");
  assert(recoveryMigration.includes("LOCK TABLE public.students IN SHARE ROW EXCLUSIVE MODE"), "Recovery must serialize roster writes while reconciling memberships");
  assert(recoveryMigration.includes("destination_membership_reused"), "Transfer response must identify the recovery path");
});
Deno.test("database transfer is atomic and scoped to one student's records", () => {
  assert(migration.includes("SECURITY DEFINER"), "RPC must execute in its controlled server context");
  assert(migration.includes("REVOKE ALL ON FUNCTION"), "RPC must not be directly callable by public or authenticated clients");
  assert(migration.includes("GRANT EXECUTE ON FUNCTION public.admin_transfer_student"), "Only service role may call the RPC");
  assert(migration.includes("records = records - p_student_name"), "Only the moved student's source JSON key may be removed");
  assert(migration.includes("student_affairs_notice_issues"), "Official student notices must move with the student");
  assert(migration.includes("student_transfer_audit"), "Every transfer must be auditable");
  assert(!/UPDATE public\.(teachers|school_settings|duty_reports|timetable_[a-z_]+)/i.test(migration), "Transfer must not rewrite teacher, school, duty, or timetable data");
});

Deno.test("single and bulk student deletion use direct server roster save, never the generic pending-delete queue", () => {
  const handlers = section(html, "async function saveStudentRoster(", "async function addNewClassPrompt()");
  assert(handlers.includes("action: 'admin_save_student_roster'"), "Student list changes must use the dedicated server save action");
  assert(handlers.includes("appAuthRequest"), "Roster changes must be sent to the authenticated server");
  assert(handlers.includes("clearStudentDeleteIntents(className)"), "Legacy student delete intents for the saved class must be cleared after commit");
  assert(handlers.includes("...queuedNames"), "Legacy queued student removals must be counted and confirmed before reconciliation");
  assert(!handlers.includes("queueCloudDelete("), "Student deletion must not create a local-only deletion intent");
  assert(handlers.includes("async function saveBulkStudents()"), "Bulk roster editing must use the unified save workflow");
  assert(handlers.includes("async function removeStudent(className, idx)"), "Single student removal must use the unified save workflow");
  assert(handlers.includes("await saveStudentRoster(className, nextNames)"), "Single student removal must commit the new class roster directly");
});

Deno.test("old student deletion intents are pruned only after a successful cloud read confirms the membership is gone", () => {
  const helper = section(html, "async function clearCompletedStudentDeleteIntentsFromCloud(", "function pendingDeleteTableLabel(");
  assert(helper.includes("serverMemberships.has(className + '\\u001f' + studentName)"), "Cleanup must compare both class and exact student name");
  assert(helper.includes("item?.table !== 'students'"), "Other queued table deletions must remain untouched");
  const load = section(html, "async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(load.includes("await clearCompletedStudentDeleteIntentsFromCloud(studentsData)"), "Completed student deletions must be reconciled after an authoritative cloud read");
});

Deno.test("Edge Function roster save requires the active general-admin session and uses its database transaction", () => {
  const action = section(edge, 'if (body?.action === "admin_save_student_roster")', 'if (body?.action === "admin_transfer_student")');
  assert(action.includes("readAuthorizedAppSession"), "Roster save must validate and revalidate the active app session");
  assert(action.includes("!isGeneralAdminPrincipal(principal)"), "Roster save must reject non-admin principals");
  assert(action.includes('db.rpc("admin_save_student_roster"'), "Roster save must use the atomic database function");
});

Deno.test("atomic roster save is restricted to service_role and never mutates student history", () => {
  assert(rosterMigration.includes("SECURITY DEFINER"), "Roster save must run in a controlled server transaction");
  assert(rosterMigration.includes("REVOKE ALL ON FUNCTION public.admin_save_student_roster"), "Browser roles must not execute the roster RPC");
  assert(rosterMigration.includes("GRANT EXECUTE ON FUNCTION public.admin_save_student_roster"), "Only service_role may execute the roster RPC");
  assert(rosterMigration.includes("DELETE FROM public.students"), "The transaction must remove stale class memberships");
  assert(!/DELETE FROM public\.(attendance|behaviors|student_affairs_notice_issues)/i.test(rosterMigration), "Roster removal must preserve all student history");
  assert(rosterMigration.includes("student_roster_audit"), "Roster edits must be auditable");
});


Deno.test("legacy pending student removals can be explicitly committed from the review panel", () => {
  const executor = section(html, "async function executePendingStudentDeleteIntents()", "async function saveBulkStudents()");
  const review = section(html, "function openPendingDeleteReview()", "async function queueCloudDelete(");
  assert(executor.includes("isAdminAuthorized()"), "Only an authorized admin can commit old student deletion requests");
  assert(executor.includes("showConfirm("), "Legacy requests must require confirmation before server mutation");
  assert(executor.includes("saveStudentRoster("), "Legacy requests must use the direct server roster transaction");
  assert(executor.includes("silentSuccess: true"), "Batch execution must not show a success toast for each class");
  assert(review.includes("execute-student-deletes"), "The review dialog must expose the direct legacy cleanup action");
});

Deno.test("direct roster save keeps its persisted success status separate from local refresh failures", () => {
  const save = section(html, "async function saveStudentRoster(", "async function executePendingStudentDeleteIntents()");
  assert(save.includes("action: 'admin_save_student_roster'"), "Roster changes must commit through the admin Edge Function");
  assert(save.includes("clearStudentDeleteIntents(className)"), "Old local deletion intents must be cleared after successful server commit");
  assert(save.includes("if (!loaded)"), "A local reload failure must not misreport a committed server save as a failed transaction");
});


Deno.test("student roster commits cannot overlap with another roster save or transfer", () => {
  const save = section(html, "async function saveStudentRoster(", "async function executePendingStudentDeleteIntents()");
  const transfer = section(html, "async function transferStudentToClass(", "async function saveStudentRoster(");
  assert(save.includes("studentRosterSaveInProgress"), "Roster save must set and check an in-flight guard");
  assert(save.includes("cloudSaveInProgress") && save.includes("manualOfflineSyncInProgress"), "Roster save must not overlap the generic cloud uploader");
  assert(save.includes("finally") && save.includes("studentRosterSaveInProgress = false"), "The in-flight guard must always be released");
  assert(transfer.includes("studentRosterSaveInProgress"), "Student transfer must not overlap a roster save");
});
