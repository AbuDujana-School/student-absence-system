const html = await Deno.readTextFile(new URL("../../../index.html", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("server-managed teacher permissions override stale local values", () => {
  const match = html.match(/function saMergeServerManagedTeacherPermissions\(localPermissions,serverPermissions\)\{[\s\S]*?\n\}/);
  if (!match) throw new Error("Permission merge helper must exist in index.html");
  const merge = new Function(`${match[0]}; return saMergeServerManagedTeacherPermissions;`)() as
    (local: Record<string, unknown>, server: Record<string, unknown>) => Record<string, unknown>;

  const merged = merge(
    { attendance: true, studentAffairs: false, can_view_competition: false, duty: true },
    { studentAffairs: true, can_view_competition: true }
  );
  assert(merged.studentAffairs === true, "Server Student Affairs access must win");
  assert(merged.can_view_competition === true, "Server competition permission must win");
  assert(merged.attendance === true && merged.duty === true, "Unrelated local permissions must remain unchanged");

  const absent = merge(
    { studentAffairs: true, can_view_competition: true, attendance: true },
    {}
  );
  assert(!("studentAffairs" in absent) && !("can_view_competition" in absent), "Missing server-managed keys must not be resurrected from stale local state");
  assert(absent.attendance === true, "Unrelated permissions must remain unchanged");
});

Deno.test("Student Affairs save does not enqueue a stale full teacher overwrite", () => {
  const saveStart = html.indexOf("async function saSavePermissions()");
  const saveEnd = html.indexOf("async function saLoadReport()", saveStart);
  assert(saveStart >= 0 && saveEnd > saveStart, "Could not locate saSavePermissions");
  const save = html.slice(saveStart, saveEnd);
  assert(save.includes("saMergeServerManagedTeacherPermissions"), "Save must update local managed flags from the successful request");
  assert(!save.includes("dirtySets.teachers.add(name)"), "Student Affairs save must not enqueue a stale full teacher upsert");
});

Deno.test("general teacher sync preserves server-managed permissions before full-row upsert", () => {
  const syncStart = html.indexOf("if (dirtySets.teachers.size > 0)");
  const syncEnd = html.indexOf("dirtySets.teachers.clear();", syncStart);
  assert(syncStart >= 0 && syncEnd > syncStart, "Could not locate teacher sync block");
  const sync = html.slice(syncStart, syncEnd);
  assert(sync.includes(".select('name,permissions')"), "Teacher sync must read canonical server permissions");
  assert(sync.includes("saMergeServerManagedTeacherPermissions"), "Teacher sync must merge canonical Student Affairs flags");
  assert(sync.includes("await robustUpsert('teachers', rows, 'name', 100)"), "Teacher sync must keep the existing upsert path");
});
