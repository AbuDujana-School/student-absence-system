const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const edge = await Deno.readTextFile(new URL("../supabase/functions/student-affairs/index.ts", import.meta.url));
const migration = await Deno.readTextFile(new URL("../supabase/migrations/20261116120000_atomic_student_transfer.sql", import.meta.url));

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
  assert(transfer.includes("item?.filters?.class_name === fromClass"), "Only the matching old student-delete request may be cleared");
});

Deno.test("Edge Function accepts transfers only from the active general admin session", () => {
  const action = section(edge, 'if (body?.action === "admin_transfer_student")', 'if (body?.action === "app_student_affairs_session")');
  assert(action.includes("readAppSession"), "Transfer must validate the general app session");
  assert(action.includes("principal.type !== \\"admin\\""), "Only the general admin may transfer students");
  assert(action.includes('db.rpc("admin_transfer_student"'), "Transfer must run in the database transaction");
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
