const html = await Deno.readTextFile(new URL("../../index.html", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function section(startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Missing source section: ${startMarker}`);
  return html.slice(start, end);
}

Deno.test("cloud writes are blocked until a complete cloud load succeeds", () => {
  assert(html.includes("let cloudDataLoadState = 'not-started'"), "Load state must start closed");
  assert(html.includes("if (cloudDataLoadState !== 'ready')"), "Cloud save must fail closed before readiness");
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(load.includes("cloudDataLoadState = 'loading'"), "Load must enter loading state");
  assert(load.includes("cloudDataLoadState = 'failed'"), "Load errors must leave cloud writes blocked");
  assert(load.includes("cloudDataLoadState = 'ready'"), "Successful load must explicitly become ready");
  assert(!load.includes("saveSystemDataToCloud("), "Loading must never push data back to the cloud");
});

Deno.test("loading does not rename classes or rewrite related school records", () => {
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(load.includes("db.classes = [...new Set(classesData.map(r => r.name))]"), "Server class names must be preserved exactly");
  assert(!load.includes("queueCloudDelete("), "Loading must not queue class/student/attendance/behavior deletions");
  assert(!load.includes("dirtySets.attendance.add("), "Loading must not create attendance key rewrites");
  assert(!load.includes("dirtySets.behaviors.add("), "Loading must not create behavior key rewrites");
  assert(!load.includes("dirtySets.duty_reports.add("), "Loading must not create duty report class rewrites");
});

Deno.test("queued cloud deletions remain inert and require a separate reviewed workflow", () => {
  const queue = section("async function queueCloudDelete(", "// Fail-closed protection");
  const flush = section("async function flushPendingDeletes()", "async function robustUpsert(");
  assert(queue.includes("setPendingDeletes(arr)"), "Deletion intent may be retained locally for review");
  assert(!queue.includes(".delete("), "Queueing must not delete server data");
  assert(flush.includes("return false"), "Pending deletion executor must remain disabled");
  assert(!flush.includes(".delete("), "Pending deletion executor must not issue server deletes");
});

Deno.test("reconnect and tab-resume handlers cannot upload local snapshots automatically", () => {
  const retry = section("async function retryOfflineSyncSilently()", "/* ============ LocalStorage ============ */");
  assert(retry.includes("return false"), "Background retry must remain disabled");
  assert(!retry.includes("saveSystemDataToCloud("), "Background retry must not write cloud data");
});

Deno.test("default PIN initialization and credential migration are not invoked automatically", () => {
  const initCalls = html.match(/(?<!function )initDefaults\s*\(/g) || [];
  const migrationCalls = html.match(/(?<!function )migrateCredentialsIfNeeded\s*\(/g) || [];
  assert(initCalls.length === 0, "Default database initializer must have no automatic call sites");
  assert(migrationCalls.length === 0, "Credential migration must have no automatic call sites");
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(!load.includes("createPinRecord("), "Cloud loading must not create or replace PIN credentials");
});
