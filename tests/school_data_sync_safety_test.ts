const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));

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


Deno.test("localStorage fallback restores pending edits before a successful cloud load", () => {
  const restore = section("async function restoreOfflineState()", "function cloneOfflineValue(");
  assert(restore.includes("localStorage.getItem('abuDujana_db_v30')"), "A missing IndexedDB snapshot must fall back to the localStorage database");
  assert(restore.includes("loadDirtySetsFromLocal()"), "Fallback must restore dirty markers with the local database");
  assert(restore.indexOf("db={...db,...localDb}") < restore.indexOf("return true"), "Fallback data must be restored before reporting success");
});

Deno.test("older pending attendance and behavior edits survive the local cache age filter", () => {
  const localSave = section("function saveToLocalStorageSafe()", "function loadDirtySetsFromLocal()");
  assert(localSave.includes("p.date >= cutoffStr || dirtySets.attendance.has(k)"), "Dirty attendance older than the cache window must be retained");
  assert(localSave.includes("p.date >= cutoffStr || dirtySets.behaviors.has(k)"), "Dirty behavior records older than the cache window must be retained");
});

Deno.test("cloud writes stop if neither local persistence layer can confirm a snapshot", () => {
  const save = section("async function saveSystemDataToCloud(", "function forceSyncWithCloud()");
  assert(save.includes("const localCacheSaved = saveToLocalStorageSafe()"), "Cloud save must inspect localStorage persistence");
  assert(save.includes("const durableSaved = await persistOfflineState()"), "Cloud save must inspect IndexedDB persistence");
  const guard = save.indexOf("if (!localCacheSaved && !durableSaved)");
  const firstWrite = save.search(/robustUpsert\s*\(|sb\.from\([^)]*\)\.upsert\s*\(/);
  assert(guard >= 0 && firstWrite > guard, "No cloud write may happen before at least one local persistence layer succeeds");
});


Deno.test("queued deletions remain local and are reapplied after cloud data is merged", () => {
  const helper = section("function applyPendingLocalDeletions()", "function markOfflineDatabaseForUpload()");
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  for (const table of ["classes", "students", "attendance", "behaviors", "teachers", "duty_reports"]) {
    assert(helper.includes("item.table === '" + table + "'"), "Pending " + table + " deletions must be reflected in the local view");
  }
  assert(helper.includes("dirtySets.classes.delete(name)"), "A locally deleted class must not be re-upserted by the dirty class set");
  assert(helper.includes("dirtySets.attendance.delete(key)"), "A locally deleted attendance record must not be re-upserted");
  assert(load.indexOf("mergeDirtyLocalState(pendingLocalState)") < load.indexOf("applyPendingLocalDeletions()"), "Queued deletions must be applied after dirty edits are merged");
  assert(load.indexOf("applyPendingLocalDeletions()") < load.indexOf("cloudDataLoadState = 'ready'"), "Deletion overlay must be in place before cloud saves become available");
  assert(!helper.includes(".from(") && !helper.includes(".delete("), "Applying local deletion intent must not contact Supabase");
});


Deno.test("local fallback snapshot carries its own dirty markers and pending deletions", () => {
  const localSave = section("function saveToLocalStorageSafe()", "function loadDirtySetsFromLocal()");
  const restore = section("async function restoreOfflineState()", "function cloneOfflineValue(");
  assert(localSave.includes("__offlineDirtySets: dirtyObj"), "The fallback database snapshot must carry its dirty markers atomically");
  assert(localSave.includes("__offlinePendingDeletes: pendingDeletes"), "The fallback database snapshot must carry queued deletions");
  assert(restore.includes("const localDirtySets = localDb.__offlineDirtySets"), "Fallback restore must recover embedded dirty markers");
  assert(restore.includes("restoreDirtySetsObject(localDirtySets)"), "Embedded dirty markers must be restored before cloud merge");
  assert(restore.includes("setPendingDeletes(localPendingDeletes)"), "Fallback restore must retain pending deletion intent");
});
