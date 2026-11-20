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

Deno.test("robust upsert uses only batched writes with verified conflict targets", () => {
  const upsert = section("async function robustUpsert(", "async function fetchAllPaginated(");
  assert(upsert.includes("sb.from(table).upsert(chunk, { onConflict: onConflictCols })"), "Writes must stay batched by the verified conflict target");
  assert(!upsert.includes(".select(") && !upsert.includes(".update(") && !upsert.includes(".insert("), "A failed batch must not fan out into per-row requests");
  assert(upsert.includes("if (error)"), "A failed bulk request must enter the fail-closed path");
});

Deno.test("robust upsert diagnostics never expose row payloads or raw database messages", () => {
  const upsert = section("async function robustUpsert(", "async function fetchAllPaginated(");
  assert(upsert.includes("const code = String(error?.code || error?.status || 'unknown')"), "Diagnostics must retain only a safe database error code");
  assert(upsert.includes("local dirty state retained"), "Failure diagnostics must state that local edits remain available");
  assert(!upsert.includes("error.message"), "Raw database error messages must not be logged or surfaced");
  assert(!upsert.includes("rowErr") && !upsert.includes("failures.push"), "Failed row payloads and raw messages must not be retained");
});

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

Deno.test("reconnect retries upload only after explicit approval of an unchanged local snapshot", () => {
  const retry = section("async function retryOfflineSyncSilently()", "let manualOfflineSyncInProgress");
  assert(retry.includes("await showConfirm("), "Automatic retry must obtain explicit user approval");
  assert(retry.includes("offlineAutoSyncApprovedFingerprint"), "Approval must be bound to the exact local snapshot");
  assert(retry.includes("offlineSyncApprovalFingerprint() !== offlineAutoSyncApprovedFingerprint"), "Changed local data must invalidate prior approval");
  assert(retry.includes("saveSystemDataToCloud({ silent: true, automatic: true })"), "Approved retries must reuse the existing scoped dirty-record uploader");
  assert(retry.includes("scheduleOfflineAutoSyncRetry()"), "Failed approved uploads must retry with backoff");
  assert(retry.includes("offlineSyncApprovalFingerprint()"), "Retries must remain tied to the unchanged local data snapshot");
  assert(!retry.includes("flushPendingDeletes("), "Background retry must never execute queued deletions");
});

Deno.test("daily reserve notice polling is visible-only and resumes promptly", () => {
  const watcher = section("function teacherStartDailySubstitutionWatcher()", "async function openTeacherTimetableView()");
  assert(watcher.includes("navigator.onLine"), "Daily notice polling must pause while offline");
  assert(watcher.includes('document.visibilityState === "visible"'), "Daily notice polling must pause for hidden pages");
  assert(watcher.includes("}, 120000);"), "Daily notice polling must use the two-minute interval");
  const events = section("const resumeCloudSync =", "});\n\nfunction initDarkMode()");
  assert(events.includes("teacherShowDailySubstitutionWelcome()"), "Returning online or to a visible page must refresh the daily notice promptly");
});

Deno.test("cloud refresh polling is read-only whenever local edits or live capture are pending", () => {
  const refresh = section("async function refreshCloudDataSilently()", "let manualOfflineSyncInProgress");
  assert(refresh.includes("hasPendingOfflineRecordChanges()"), "Refresh must stop when local dirty records exist");
  assert(refresh.includes("attendanceDirty || behaviorDirty"), "Refresh must not replace an active unsaved capture session");
  assert(refresh.includes("await loadSystemDataFromCloud()"), "Safe refresh must fetch the latest cloud state");
  const events = section("const resumeCloudSync =", "});\n\nfunction initDarkMode()");
  assert(events.includes("}, 120000);"), "Active sessions must use the reduced two-minute polling interval");
  assert(events.includes("window.addEventListener('online'"), "Network reconnect must still trigger a prompt refresh");
  assert(events.includes("window.addEventListener('pageshow'"), "Returning to the app must still trigger a prompt refresh");
  assert(events.includes("document.addEventListener('visibilitychange'"), "Making the app visible must still trigger a prompt refresh");
  assert(events.includes("}, 1200);"), "Resume refreshes must remain prompt rather than waiting for the next poll");
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
  const fallback = section("function restoreLocalStorageOfflineSnapshot()", "async function restoreOfflineState()");
  assert(fallback.includes("localStorage.getItem('abuDujana_db_v30')"), "A missing IndexedDB snapshot must fall back to the localStorage database");
  assert(fallback.includes("loadDirtySetsFromLocal()"), "Fallback must restore dirty markers with the local database");
  assert(fallback.indexOf("db={...db,...localDb}") < fallback.indexOf("return true"), "Fallback data must be restored before reporting success");
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
  const noChangeStart = load.indexOf("if (nextManifest && changedTables.length === 0)");
  const noChangeEnd = load.indexOf("const shouldLoad =", noChangeStart);
  assert(noChangeStart >= 0 && noChangeEnd > noChangeStart, "Manifest no-change path must be explicit");
  const noChangePath = load.slice(noChangeStart, noChangeEnd);
  assert(noChangePath.indexOf("applyPendingLocalDeletions()") >= 0, "No-change refresh must reapply queued local deletion overlays");
  assert(noChangePath.indexOf("applyPendingLocalDeletions()") < noChangePath.indexOf("saveToLocalStorageSafe()"), "No-change deletion overlays must be persisted before returning");
  const changedPath = load.slice(noChangeEnd);
  assert(changedPath.indexOf("mergeDirtyLocalState(pendingLocalState)") < changedPath.indexOf("applyPendingLocalDeletions()"), "Changed-table refresh must merge dirty edits before applying queued deletion overlays");
  assert(changedPath.indexOf("applyPendingLocalDeletions()") < changedPath.indexOf("cloudDataLoadState = 'ready'"), "Changed-table deletion overlay must be in place before cloud saves become available");
  assert(!helper.includes("sb.from(") && !helper.includes("flushPendingDeletes("), "Applying local deletion intent must not contact Supabase");
});


Deno.test("local fallback snapshot carries its own dirty markers and pending deletions", () => {
  const localSave = section("function saveToLocalStorageSafe()", "function loadDirtySetsFromLocal()");
  assert(localSave.includes("__offlineDirtySets: dirtyObj"), "The fallback database snapshot must carry its dirty markers atomically");
  assert(localSave.includes("__offlinePendingDeletes: pendingDeletes"), "The fallback database snapshot must carry queued deletions");
  assert(localSave.includes("__offlineCloudSyncManifest: lastLoadedCloudManifest"), "The fallback database snapshot must carry its matching cloud revision manifest");
  const fallback = section("function restoreLocalStorageOfflineSnapshot()", "async function restoreOfflineState()");
  assert(fallback.includes("const localDirtySets = localDb.__offlineDirtySets"), "Fallback restore must recover embedded dirty markers");
  assert(fallback.includes("restoreDirtySetsObject(localDirtySets)"), "Embedded dirty markers must be restored before cloud merge");
  assert(fallback.includes("setPendingDeletes(localPendingDeletes)"), "Fallback restore must retain pending deletion intent");
});


Deno.test("sync indicator routes pending local records to the explicit upload workflow", () => {
  const refresh = section("function forceSyncWithCloud()", "function doForceSync()");
  assert(refresh.includes("if (attendanceDirty || behaviorDirty)"), "Refresh must stop while a live attendance or behavior session is dirty");
  assert(refresh.includes("احفظ تغييرات الرصد الحالية"), "The user must be told to save the active session first");
  assert(refresh.includes("if (hasPendingOfflineRecordChanges())"), "Pending record edits must be detected before cloud refresh");
  assert(refresh.includes("void syncPendingLocalChanges()"), "Pending record edits must enter the explicit upload-and-confirm workflow");
  assert(refresh.indexOf("syncPendingLocalChanges()") < refresh.indexOf("doForceSync()"), "Dirty records must never be routed to read-only refresh");
  assert(refresh.includes("getPendingDeletes().length"), "Queued deletions must be handled separately");
  assert(refresh.includes("لن تُرفع تعديلات أو تُنفذ عمليات حذف"), "Delete-only refresh must not claim to upload or delete");
});

Deno.test("successful record saves do not report full sync while deletions remain queued", () => {
  const save = section("async function saveSystemDataToCloud(", "function forceSyncWithCloud()");
  assert(save.includes("const pendingDeleteCount = getPendingDeletes().length"), "Save completion must inspect queued deletions");
  assert(save.includes("updateSyncStatus(!pendingDeleteCount && !pendingRecords"), "Pending deletions or newer local edits must keep the status unsynced");
  assert(save.includes("طلب حذف بانتظار المراجعة"), "The status must explain why synchronization is incomplete");
});


Deno.test("queued deletions immediately remain visibly pending instead of appearing synced", () => {
  const queue = section("async function queueCloudDelete(", "// Fail-closed protection");
  assert(queue.includes("updateSyncStatus(false"), "Queueing a deletion must immediately show an unsynced state");
  assert(queue.includes("طلب حذف بانتظار المراجعة"), "The sync status must explain that deletion is pending review");
});

Deno.test("destructive UI actions do not claim that server-side deletion completed", () => {
  for (const message of [
    "حذف بياناته من الخادم بانتظار المراجعة",
    "حذف سجله من الخادم بانتظار المراجعة",
    "حذفها من الخادم لم يُنفذ وهو بانتظار المراجعة"
  ]) assert(html.includes(message), "Missing clear local-only deletion notice: " + message);
});


Deno.test("pending deletion intent survives localStorage failure through the durable snapshot path", () => {
  const queue = section("let pendingDeleteQueueCache = null;", "async function flushPendingDeletes()");
  assert(queue.includes("pendingDeleteQueueCache = Array.isArray(arr) ? arr : []"), "Deletion intent must remain in memory if localStorage is unavailable");
  assert(queue.includes("const localStorageSaved = setPendingDeletes(arr)"), "Queueing must verify localStorage persistence");
  assert(queue.includes("const indexedDbSaved = await persistOfflineState()"), "Queueing must attempt durable IndexedDB persistence");
  assert(queue.includes("if (!localStorageSaved && !indexedDbSaved)"), "Queueing must report failure if both local persistence paths fail");
  assert(!queue.includes("sb.from("), "Queueing deletion intent must never write to Supabase");
});



Deno.test("teacher deletion UI does not claim the server record was deleted", () => {
  const removeTeacher = section("async function deleteTeacher(", "function openPermissionsModal(");
  assert(removeTeacher.includes("حذف سجله من الخادم لم يُنفذ وهو بانتظار المراجعة"), "Teacher deletion must be described as local-only and pending review");
  assert(!removeTeacher.includes("showToast('تم الحذف.'"), "Teacher deletion must not report completed server deletion");
});


Deno.test("cloud loading never references removed legacy class-rename globals", () => {
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(!load.includes("classesFixed"), "Cloud loading must not read an undeclared legacy classesFixed flag");
  assert(!load.includes("oldClassesMap"), "Cloud loading must not remap student class names through a removed legacy map");
  assert(load.includes("const cn = r.class_name;") || load.includes("let cn = r.class_name;"), "Student class names must be copied verbatim from the server without renaming");
});

Deno.test("deleting a class locally never marks the deleted class for cloud upsert", () => {
  const at = html.indexOf("async function deleteClass");
  const fallbackAt = html.indexOf("async function removeClass");
  const candidates = [at, fallbackAt, html.indexOf("async function deleteClassPrompt"), html.indexOf("async function removeClassPrompt")].filter(x => x >= 0);
  const deleteAt = candidates.length ? Math.min(...candidates) : html.indexOf("db.classes = db.classes.filter(c => c !== s);");
  assert(deleteAt >= 0, "Class deletion handler must exist");
  const fragment = html.slice(deleteAt, deleteAt + 1800);
  assert(fragment.includes("dirtySets.classes.delete(s)"), "A locally deleted class must not be queued for class upsert");
  assert(!fragment.includes("dirtySets.classes.add(s)"), "Deleted class must not be re-created by the next save");
});


Deno.test("legacy PIN login does not rewrite stored credential hashes or trigger cloud saves", () => {
  const login = section("async function handleUserLogin(", "async function findUserByPinWithRecord(");
  assert(!login.includes("isLegacyHash("), "Login must not trigger an automatic legacy PIN hash migration");
  assert(!login.includes("createPinRecord("), "Login must not replace a saved PIN hash or salt");
  assert(!login.includes("saveSystemDataToCloud("), "Login must not write credential changes to the cloud");
});

Deno.test("offline fallback restores cached data but does not report a successful cloud refresh", () => {
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  const fallbackStart = load.indexOf("if (offlineSnapshotAvailable || saved)");
  assert(fallbackStart >= 0, "Offline fallback path must remain available");
  const fallback = load.slice(fallbackStart);
  assert(fallback.includes('updateSyncStatus(false, "محفوظ محلياً - بانتظار الاتصال");'), "Fallback must clearly show that data is local and waiting for connection");
  assert(fallback.includes("return false;"), "A local fallback must not be reported as a successful cloud refresh");
});


Deno.test("manual offline sync is explicit, scoped to dirty records, and never executes queued deletions", () => {
  const manual = section("async function syncPendingLocalChanges()", "/* ============ LocalStorage ============ */");
  assert(manual.includes("if (!navigator.onLine)"), "Manual sync must require an online connection");
  assert(manual.includes("cloudDataLoadState !== 'ready'"), "Manual sync must wait for a successful cloud load");
  assert(manual.includes("attendanceDirty || behaviorDirty"), "Manual sync must stop while a live capture session is unsaved");
  assert(manual.includes("await showConfirm("), "Manual sync must require user confirmation");
  assert(manual.includes("saveSystemDataToCloud({ manual: true })"), "Manual sync must reuse the existing dirty-record uploader");
  assert(manual.includes("getPendingDeletes().length"), "Manual sync must keep queued deletions visible");
  assert(!manual.includes("flushPendingDeletes("), "Manual sync must never execute queued deletions");
  const recovery = manual.indexOf("await loadSystemDataFromCloud()");
  const captureGuard = manual.indexOf("if (attendanceDirty || behaviorDirty)");
  assert(recovery >= 0 && captureGuard >= 0 && captureGuard < recovery, "Manual sync may recover cloud readiness only after protecting live capture");
  assert(recovery < manual.indexOf("await showConfirm("), "Manual sync must recover the cloud snapshot before asking permission to upload");
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(load.includes("mergeDirtyLocalState(pendingLocalState)"), "Recovery must merge pending local edits instead of replacing them");
});

Deno.test("sync indicator distinguishes upload, review-only deletion requests, and cloud refresh", () => {
  const status = section("function updateSyncStatus(", "async function initDefaults()");
  assert(status.includes("if (hasPendingOfflineRecordChanges()) void syncPendingLocalChanges()"), "Dirty records must route to the explicit upload workflow");
  assert(status.includes("else if (getPendingDeletes().length) openPendingDeleteReview()"), "Delete-only state must open local review rather than show a false upload state");
  assert(status.includes("const reviewOnly = !pendingRecords && pendingDeletes > 0"), "Delete-only state must be distinct from unsynced record edits");
  assert(status.includes("المزامنة مكتملة؛"), "A successful cloud sync with queued deletions must be reported as synced with review pending");
});
Deno.test("pending deletion review can cancel one or all local intents without server deletion", () => {
  const review = section("function pendingDeleteTableLabel(", "async function robustUpsert(");
  assert(review.includes("async function cancelPendingDeleteAt(index)"), "A single queued deletion must be cancellable");
  assert(review.includes("async function cancelAllPendingDeletes()"), "All queued deletion intents must be cancellable");
  assert(review.includes("setPendingDeletes(nextQueue)"), "Cancellation must update only the local deletion queue");
  assert(review.includes("await persistOfflineState()"), "Cancellation must persist the updated local queue durably");
  assert(!review.includes(".delete("), "Cancellation must never delete a server record");
  assert(review.includes("لم يتغير أي سجل على الخادم"), "The user must be told that cancellation changes no server data");
});

Deno.test("sync settings button invokes the explicit local upload workflow", () => {
  assert(html.includes('onclick="syncPendingLocalChanges()"'), "Settings sync action must invoke the safe manual upload");
  assert(!html.includes('onclick="forceSyncWithCloud()" class="bg-emerald-700'), "Settings upload button must not be a read-only cloud refresh");
});


Deno.test("in-flight local edits remain dirty after an earlier snapshot is uploaded", () => {
  const save = section("async function saveSystemDataToCloud(", "function forceSyncWithCloud()");
  assert(save.includes("const syncSnapshotDb = cloneOfflineValue(db)"), "The upload must freeze a local data snapshot before asynchronous persistence or network work");
  assert(save.includes("const syncDirty = serializeDirtySets()"), "The upload must freeze the exact dirty-key set");
  assert(save.includes("syncSnapshotDb.students?.[c]"), "Student upload rows must come from the frozen snapshot");
  assert(save.includes("clearSyncedDirtyKeys('students', studentKeys, syncSnapshotDb)"), "Student dirty markers must be cleared selectively");
  assert(html.includes("if (syncValuesEqual(before, now)) set.delete(key)"), "A dirty key must remain queued if its value changed during upload");
  assert(save.includes("const pendingRecords = hasPendingOfflineRecordChanges()"), "Completion must report newer local edits as still pending");
  assert(save.includes("return !pendingRecords"), "An upload with concurrent local edits must not report full success");
});

Deno.test("sync upload does not clear whole dirty sets after network writes", () => {
  const save = section("async function saveSystemDataToCloud(", "function forceSyncWithCloud()");
  assert(!save.includes("dirtySets.classes.clear()"), "Class upload must not clear edits created while the request is in flight");
  assert(!save.includes("dirtySets.teachers.clear()"), "Teacher upload must not clear edits created while the request is in flight");
  assert(!save.includes("dirtySets.students.clear()"), "Student upload must not clear edits created while the request is in flight");
  assert(!save.includes("dirtySets.attendance.clear()"), "Attendance upload must not clear edits created while the request is in flight");
  assert(!save.includes("dirtySets.behaviors.clear()"), "Behavior upload must not clear edits created while the request is in flight");
  assert(!save.includes("dirtySets.duty_reports.clear()"), "Duty report upload must not clear edits created while the request is in flight");
});


Deno.test("boolean sync flags are cleared only when the uploaded setting still matches local state", () => {
  const save = section("function syncValuesEqual(", "function forceSyncWithCloud()");
  assert(save.includes("function clearSyncedDirtyFlag(kind, uploadedSnapshot)"), "Boolean dirty flags need a snapshot-aware clearing helper");
  assert(save.includes("if (syncValuesEqual(before, now)) dirtySets[kind] = false"), "A newer setting edit must keep its dirty flag set");
  assert(save.includes("clearSyncedDirtyFlag('admin_pin', syncSnapshotDb)"), "Admin PIN flag must use snapshot-aware clearing");
  assert(save.includes("clearSyncedDirtyFlag('custom_categories', syncSnapshotDb)"), "Custom categories flag must use snapshot-aware clearing");
  assert(save.includes("clearSyncedDirtyFlag('duty_module', syncSnapshotDb)"), "Duty module flag must use snapshot-aware clearing");
});

Deno.test("each cloud payload is built from the frozen upload snapshot, not live mutable state", () => {
  const save = section("async function saveSystemDataToCloud(", "function forceSyncWithCloud()");
  assert(save.includes("const syncSnapshotDb = cloneOfflineValue(db)"), "Snapshot must be captured before awaiting persistence");
  assert(save.includes("const syncDirty = serializeDirtySets()"), "Dirty intent must be frozen before awaiting persistence");
  assert(!save.includes("for (const name of dirtySets.teachers)"), "Teacher iteration must not read the live dirty set");
  assert(!save.includes("(db.students[c] || [])"), "Student rows must not be read from the live database");
  assert(!save.includes("const v = db[kind][key]"), "Attendance/behavior rows must not be read from the live database");
  assert(!save.includes("const r = (db.dutyModule.records"), "Duty report rows must not be read from the live database");
});

Deno.test("a newer edit to a setting remains pending after an older snapshot upload", () => {
  const helper = section("function syncValuesEqual(", "async function saveSystemDataToCloud(");
  assert(helper.includes("syncSnapshotValue(kind, true, uploadedSnapshot)"), "Flag comparison must inspect the uploaded snapshot");
  assert(helper.includes("syncSnapshotValue(kind, true, db)"), "Flag comparison must inspect current local state after the request");
  assert(helper.includes("if (syncValuesEqual(before, now)) dirtySets[kind] = false"), "Only an unchanged setting may be marked clean");
});

Deno.test("delete-only pending state is review-only and never masquerades as an offline upload", () => {
  const status = section("function updateSyncStatus(", "async function initDefaults()");
  assert(status.includes("!pendingRecords && pendingDeletes > 0"), "Queued deletions without dirty records must use review-only state");
  assert(status.includes("ind.onclick = openPendingDeleteReview"), "Review-only status must expose the local review action");
  assert(status.includes("!pendingRecords && !pendingDeletes"), "Green synced state must require an empty deletion queue");
});
Deno.test("mixed dirty edits and queued deletions remain separately visible", () => {
  const status = section("function updateSyncStatus(", "async function initDefaults()");
  assert(status.includes("pendingRecords && pendingDeletes"), "The status must detect simultaneous edits and queued deletions");
  assert(status.includes("طلب حذف للمراجعة"), "The status must disclose queued deletion review alongside pending uploads");
  assert(status.includes("void syncPendingLocalChanges()"), "The primary action must upload dirty records without executing deletions");
});


Deno.test("an empty successful permission-gateway response never falls back to direct teacher REST", () => {
  const refresh = section("async function refreshActiveUserPermissions()", "async function finalizeLoginState()");
  assert(refresh.includes("let allowLegacyFallback = !token"), "Legacy fallback must be disabled whenever an app session token exists");
  assert(refresh.includes("allowLegacyFallback = false"), "A successful gateway response must permanently disable legacy fallback for this request");
  assert(refresh.includes("allowLegacyFallback = true"), "Only an explicitly unsupported legacy deployment may re-enable fallback");
  assert(refresh.includes("if (!data && allowLegacyFallback)"), "A missing teacher row after a successful gateway response must not trigger direct REST");
  assert(refresh.includes("if (!isLegacyAuthEndpointUnavailable(gatewayError)) throw gatewayError"), "Expired or denied gateway sessions must fail closed without direct REST fallback");
  const gatewaySuccess = refresh.indexOf("allowLegacyFallback = false");
  const directRead = refresh.indexOf("sb.from('teachers')");
  assert(gatewaySuccess >= 0 && directRead > gatewaySuccess, "Direct teacher REST must be gated behind explicit legacy compatibility only");
});


Deno.test("unauthenticated startup does not fetch protected school tables", () => {
  const boot = section("window.addEventListener('DOMContentLoaded', async () => {", "function initDarkMode()");
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  assert(boot.includes("offlineSnapshotRestoredAtBoot = await restoreOfflineState()"), "Startup may restore only the local snapshot before login");
  assert(boot.indexOf("await checkExistingSession()") > boot.indexOf("offlineSnapshotRestoredAtBoot = await restoreOfflineState()"), "Session validation must follow local-only restoration");
  const sessionCheck = boot.indexOf("await checkExistingSession()");
  const startupBeforeSession = sessionCheck >= 0 ? boot.slice(0, sessionCheck) : boot;
  assert(!startupBeforeSession.includes("loadSystemDataFromCloud("), "Startup must not directly download school tables before session validation");
  const noUserGuard = load.indexOf("if (!activeUser)");
  const secureSessionGuard = load.indexOf("if (navigator.onLine && !hasUnexpiredAppAuthSession())");
  const localRestore = load.indexOf("const offlineSnapshotAvailable = await restoreOfflineState()");
  const manifestFetch = load.indexOf("fetchAppSyncManifest()");
  assert(noUserGuard >= 0 && noUserGuard < localRestore, "No active principal must stop cloud loading before any snapshot or table fetch");
  assert(secureSessionGuard > noUserGuard && secureSessionGuard < localRestore, "Online reads must require a validated secure application session");
  assert(localRestore < manifestFetch, "The manifest request may occur only after the authentication guards");
});

Deno.test("secure session validation completes before cloud loading begins", () => {
  const check = section("async function checkExistingSession()", "async function handleUserLogin(e)");
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord(");
  const validate = check.indexOf("appAuthRequest({ action: \"app_session\" }, appToken)");
  const activate = check.indexOf("activeUser = result.principal");
  const finalize = check.indexOf("await finalizeLoginState()");
  assert(validate >= 0 && validate < activate && activate < finalize, "A stored app session must be validated before activating the principal");
  const saveToken = login.indexOf("saveAppAuthSession(serverLogin)");
  const loginFinalize = login.indexOf("await finalizeLoginState()");
  assert(saveToken >= 0 && saveToken < loginFinalize, "A new secure token must be stored before loading protected school data");
});




Deno.test("online cloud saves without a secure session stay local and never upload", () => {
  const save = section("async function saveSystemDataToCloud(options = {})", "async function checkExistingSession()");
  const guard = save.indexOf("if (navigator.onLine && !hasUnexpiredAppAuthSession())");
  const localSave = save.indexOf("saveToLocalStorageSafe()", guard);
  const durableSave = save.indexOf("await persistOfflineState()", localSave);
  const noUpload = save.indexOf("return false;", durableSave);
  const upload = save.indexOf("const syncSnapshotDb");
  assert(guard >= 0 && localSave > guard && durableSave > localSave, "Unauthenticated cloud saves must persist local changes first");
  assert(noUpload > durableSave && upload > noUpload, "Unauthenticated saves must return before any cloud upload snapshot is created");
});

Deno.test("verified secure sessions reuse server-returned permissions without a duplicate gateway read", () => {
  const refresh = section("async function refreshActiveUserPermissions()", "async function finalizeLoginState()");
  const securePrincipal = refresh.indexOf("const securePrincipal = appAuthSession?.principal");
  const gatewayRead = refresh.indexOf("action: 'app_data_gateway_read'");
  assert(securePrincipal >= 0 && gatewayRead > securePrincipal, "Verified server permissions must be reused before the legacy gateway refresh");
  assert(refresh.includes("securePrincipal?.name === user.name && securePrincipal?.type === user.type"), "Only the matching verified principal may bypass the duplicate read");
  assert(refresh.includes("let allowLegacyFallback = !token"), "Legacy sessions must retain their compatibility fallback");
  assert(refresh.includes("if (!data && allowLegacyFallback)"), "Legacy sessions must retain the existing permissions refresh path");

  const restore = section("async function checkExistingSession()", "async function handleUserLogin(");
  assert(restore.indexOf("appAuthSession = { token: appToken") < restore.indexOf("await finalizeLoginState()"), "A restored secure session must be verified before permissions are reused");
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  assert(login.indexOf("saveAppAuthSession(serverLogin)") < login.indexOf("await finalizeLoginState()"), "A new secure login must save its verified principal before permissions are reused");
});


Deno.test("reconnect restores cloud readiness before retrying or manually uploading offline edits", () => {
  const events = section("const resumeCloudSync =", "});\n\nfunction initDarkMode()");
  const resumeStart = events.indexOf("const resumeCloudSync =");
  const resumeEnd = events.indexOf("window.addEventListener('online'", resumeStart);
  const resume = events.slice(resumeStart, resumeEnd);
  const recoveryLoad = resume.indexOf("await loadSystemDataFromCloud()");
  const retryUpload = resume.indexOf("await retryOfflineSyncSilently()");
  assert(recoveryLoad >= 0, "Reconnect must reload the read-only cloud snapshot when readiness was lost");
  assert(retryUpload > recoveryLoad, "Pending local edits may only enter the approved retry after cloud recovery");
  const captureGuard = resume.indexOf("attendanceDirty || behaviorDirty");
  assert(captureGuard >= 0 && captureGuard < recoveryLoad, "Reconnect must not reload over an active unsaved attendance or behavior capture");
  assert(resume.includes("cloudDataLoadState !== 'ready'"), "Reconnect must detect failed or not-yet-started cloud state");
  assert(resume.includes("cloudDataLoadState === 'loading'"), "Reconnect must not overlap an active cloud load");
  assert(resume.includes("let recoveredCloud = false"), "Reconnect must track when the cloud snapshot was already recovered");
  assert(resume.includes("else if (recoveredCloud) refreshCloudDependentViews()"), "Recovered data must refresh visible views without issuing a second cloud load");
  assert(events.includes("resumeCloudSync();"), "Online, visibility, and periodic refresh must share the recovery path");
  assert(resume.includes('teacherShowDailySubstitutionWelcome()'), "Teacher return-to-app welcome behavior must remain intact");

  const manual = section("async function syncPendingLocalChanges()", "/* ============ LocalStorage ============ */");
  const manualRecovery = manual.indexOf("await loadSystemDataFromCloud()");
  const approval = manual.indexOf("await showConfirm(");
  assert(manualRecovery >= 0 && approval > manualRecovery, "Manual upload must recover the cloud snapshot before asking for upload approval");
  const manualCaptureGuard = manual.indexOf("if (attendanceDirty || behaviorDirty)");
  assert(manualCaptureGuard >= 0 && manualCaptureGuard < manualRecovery, "Manual recovery must not reload over an active unsaved capture");
  assert(manual.includes("لم يتم رفعها"), "A failed recovery must explicitly confirm that local edits were not uploaded");
});


Deno.test("cloud sync fetches only the columns consumed by the local school snapshot", () => {
  const load = section("async function loadSystemDataFromCloud()", "async function saveSystemDataToCloud(");
  const projections = [
    "shouldLoad('teachers') ? fetchAllPaginated('teachers', 'name,role,pin_hash,pin_salt,permissions,must_change_pin') : Promise.resolve(null)",
    "shouldLoad('attendance') ? fetchAllPaginated('attendance', 'record_key,class_name,teacher_name,period,records,updated_at') : Promise.resolve(null)",
    "shouldLoad('behaviors') ? fetchAllPaginated('behaviors', 'record_key,class_name,teacher_name,period,records,updated_at') : Promise.resolve(null)",
    "shouldLoad('school_settings') ? fetchAllPaginated('school_settings', 'key,value') : Promise.resolve(null)",
    "shouldLoad('duty_reports') ? fetchAllPaginated('duty_reports', 'id,date_str,day_num,period,class_name,subject,teacher_name,reported_by,status,reviewed_by,reviewed_at,created_at') : Promise.resolve(null)",
  ];
  for (const projection of projections) assert(load.includes(projection), "Missing narrow cloud projection: " + projection);
  for (const table of ["teachers", "attendance", "behaviors", "school_settings", "duty_reports"]) {
    assert(!load.includes("fetchAllPaginated('" + table + "', '*')"), "Cloud sync must not fetch unused columns from " + table);
  }
});

Deno.test("timetable settings load the access list once and import saves do not reload permissions", () => {
  const settingsStart = html.indexOf("if (settings && isAdmin)");
  const settingsEnd = html.indexOf("if(classes&&isAdmin)", settingsStart);
  assert(settingsStart >= 0 && settingsEnd > settingsStart, "Timetable settings tab loader must exist");
  const settingsBlock = html.slice(settingsStart, settingsEnd);
  assert(settingsBlock.includes("timetableLoadImports();"), "Opening timetable settings must load saved imports");
  assert(!settingsBlock.includes("timetableLoadAccessManagement();"), "Settings tab must not repeat the access read already owned by timetableLoadImports");
  assert(html.includes("if (activeUser?.type === \"admin\" && options.refreshAccess !== false) await timetableLoadAccessManagement();"), "Import loader must retain its default access refresh for settings entry");
  assert(html.includes("await timetableLoadImports({ refreshAccess: false });"), "Saving an import must not reload unchanged access permissions");
});


Deno.test("teacher timetable polling pauses in the background and refreshes once when visible again", () => {
  const portal = section("async function openTeacherTimetableView()", "function closeTeacherTimetableView()");
  assert(portal.includes("if (document.hidden || document.getElementById(\"teacherTimetableView\")?.classList.contains(\"hidden\")) return;"), "The periodic timetable poll must stop while the app is backgrounded or the view is closed");
  assert(portal.includes("Date.now() - teacherTimetableLastFetchAt >= 60000"), "The visible view must keep the existing 60-second freshness limit");
  const visibility = section("window.addEventListener('pageshow', resumeCloudSync);", "  // Periodic polling");
  assert(visibility.includes("if (document.hidden) return;"), "Visibility recovery must run only when the app becomes visible");
  assert(visibility.includes("void teacherTimetableLoad(false)"), "Returning to a stale open timetable must refresh it");
  assert(visibility.includes("!timetableView.classList.contains(\"hidden\")"), "Returning to the app must not fetch a timetable the teacher is not viewing");
});

Deno.test("production Supabase client uses the active publishable key and keeps preview isolated", () => {
  const config = section("const SUPABASE_URL =", "const sb = window.supabase.createClient");
  assert(config.includes("https://wawplttrpiinoukpjqqx.supabase.co"), "Cloudflare preview must keep its isolated Supabase project");
  assert(config.includes("  ? \"eyJhbGciOiJIUzI1NiIs"), "Preview must retain its project-scoped preview key");
  assert(config.includes("  : \"sb_publishable_"), "Production must use a publishable API key rather than the legacy JWT key");
  assert(!config.includes("  : \"eyJhbGciOiJIUzI1NiIs"), "Production must not fall back to the legacy JWT API key");
});