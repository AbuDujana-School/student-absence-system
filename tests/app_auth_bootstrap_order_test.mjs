import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function section(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = html.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section boundary: ${end}`);
  return html.slice(from, to);
}

test("online legacy browser sessions are not restored as authenticated cloud sessions", () => {
  const auth = section("async function checkExistingSession()", "async function handleUserLogin");
  const legacy = auth.indexOf("const token = await verifyStoredSession()");
  const onlineGuard = auth.indexOf("if (navigator.onLine)", legacy);
  const activation = auth.indexOf("activeUser = user;", legacy);
  assert.ok(legacy >= 0 && onlineGuard > legacy && activation > onlineGuard);
  const guard = auth.slice(onlineGuard, activation);
  assert.match(guard, /localStorage.removeItem\("abuDujana_session"\)/);
  assert.match(guard, /sessionStorage.removeItem\("abuDujana_session_secret"\)/);
  assert.match(guard, /return;/);
});

test("offline legacy login remains available without granting online cloud access", () => {
  const auth = section("async function checkExistingSession()", "async function handleUserLogin");
  const onlineGuard = auth.indexOf("if (navigator.onLine)");
  const activation = auth.indexOf("activeUser = user;");
  assert.ok(onlineGuard >= 0 && activation > onlineGuard);
  const finalizerStart = html.indexOf("async function finalizeLoginState()");
  const finalizerEnd = html.indexOf("\nfunction ", finalizerStart);
  assert.ok(finalizerStart >= 0 && finalizerEnd > finalizerStart);
  const finalizer = html.slice(finalizerStart, finalizerEnd);
  assert.match(finalizer, /else if \(!navigator\.onLine && cloudDataLoadState === 'not-started'\)/);
  assert.match(finalizer, /offlineSnapshotRestoredAtBoot/);
});

test("online cloud reads require an unexpired server-issued app session before any manifest request", () => {
  const helper = section("function hasUnexpiredAppAuthSession()", "async function revokeAppAuthSession()");
  assert.match(helper, /session\?\.token/);
  assert.match(helper, /Date\.parse\(session\.expires_at\) > Date\.now\(\)/);

  const loader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  const principalGuard = loader.indexOf("if (!activeUser)");
  const localOnlyGuard = loader.indexOf("if (localOnlySession)", principalGuard);
  const sessionGuard = loader.indexOf("if (navigator.onLine && !await ensureAppAuthSession())", localOnlyGuard);
  const manifest = loader.indexOf("fetchAppSyncManifest()");
  assert.ok(principalGuard >= 0 && localOnlyGuard > principalGuard);
  assert.ok(sessionGuard > localOnlyGuard && manifest > sessionGuard);
  assert.match(loader.slice(sessionGuard, manifest), /cloudDataLoadState = 'failed'/);
});

test("online cloud writes require an unexpired server-issued app session", () => {
  const start = html.indexOf("async function saveSystemDataToCloud(options = {})");
  const end = html.indexOf("async function checkExistingSession()", start);
  assert.ok(start >= 0 && end > start);
  const save = html.slice(start, end);
  const guard = save.indexOf("if (localOnlySession || (navigator.onLine && !hasUnexpiredAppAuthSession()))");
  const upload = save.indexOf("const syncSnapshotDb");
  assert.ok(guard >= 0 && upload > guard);
  assert.match(save.slice(guard, upload), /لم تُرسل أي بيانات/);
});

test("automatic and manual offline uploads stop before approval when secure session is absent", () => {
  const retry = section("async function retryOfflineSyncSilently()", "async function refreshCloudDataSilently()");
  const retryGuard = retry.indexOf("if (!hasUnexpiredAppAuthSession())");
  const approval = retry.indexOf("await showConfirm(");
  assert.ok(retryGuard >= 0 && approval > retryGuard);

  const manual = section("async function syncPendingLocalChanges()", "/* ============ LocalStorage ============ */");
  const manualGuard = manual.indexOf("if (!hasUnexpiredAppAuthSession())");
  const manualApproval = manual.indexOf("await showConfirm(");
  assert.ok(manualGuard >= 0 && manualApproval > manualGuard);
});

test("a successful server login stores its verified session and paints the dashboard before detached cloud bootstrap", () => {
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  const saveSession = login.indexOf("saveAppAuthSession(serverLogin)");
  const committed = login.indexOf("authenticatedLoginCommitted = true", saveSession);
  const shell = login.indexOf("renderAuthenticatedDashboardShell()", committed);
  const deferred = login.indexOf("const startPostLoginInitialization", shell);
  const finalize = login.indexOf("finalizeLoginState()", deferred);
  assert.ok(saveSession >= 0 && committed > saveSession);
  assert.ok(shell > committed && deferred > shell && finalize > deferred);
  assert.ok(login.slice(saveSession, shell).includes("activeUser = serverLogin.principal"));
  assert.ok(login.slice(shell, deferred).includes("login:authenticated-shell-shown"));
  assert.ok(login.slice(deferred).includes("window.setTimeout(startPostLoginInitialization, 50)"));
  const shellHelper = section("function renderAuthenticatedDashboardShell()", "async function finalizeLoginState()");
  assert.ok(shellHelper.includes("dashboardSelectionView") && shellHelper.includes("classList.remove"));
  assert.ok(shellHelper.includes("hasAdminPanelAccess(user)") && shellHelper.includes("isAdmin"));
});

test("admin cloud bootstrap has a five-minute manifest and table timeout without extending credential verification", () => {
  assert.ok(html.includes("APP_SYNC_MANIFEST_TIMEOUT_MS = 300000"));
  assert.ok(html.includes("APP_SYNC_TABLES_TIMEOUT_MS = 300000"));
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  assert.ok(login.includes("}, 15000)"));
  assert.equal(login.includes("300000"), false);
});

test("cloud bootstrap requests have bounded waits and preserve local data on timeout", () => {
  const manifest = section("async function fetchAppSyncManifest()", "function getChangedAppSyncTables");
  assert.match(manifest, /withAppSyncTimeout\(/);
  assert.match(manifest, /APP_SYNC_MANIFEST_TIMEOUT/);
  const loader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  assert.match(loader, /APP_SYNC_MANIFEST_TIMEOUT/);
  assert.match(loader, /APP_SYNC_TABLES_TIMEOUT/);
  assert.match(loader, /cloudWritesBlockedByManifestFailure = true/);
});

test("timed-out previous refresh polling is cancelled", () => {
  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess");
  assert.match(finalize, /pollingCancelled = false/);
  assert.match(finalize, /pollingCancelled = true/);
  assert.match(finalize, /clearTimeout\(pollTimer\)/);
});

test("logout resets the cloud bootstrap state before the next account signs in", () => {
  const logout = section("function _performLogout()", "function openChangePinModal()");
  assert.match(logout, /cloudDataLoadState = 'not-started'/);
  assert.match(logout, /cloudWritesBlockedByManifestFailure = false/);
  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess");
  assert.ok(finalize.includes("cloudDataLoadState !== 'ready'"));
});

test("each authenticated account starts a fresh cloud bootstrap", () => {
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  const session = login.indexOf("saveAppAuthSession(serverLogin)");
  const reset = login.indexOf("cloudDataLoadState = 'not-started'", session);
  const principal = login.indexOf("activeUser = serverLogin.principal", session);
  assert.ok(session >= 0 && reset > session && principal > reset);
  assert.match(login.slice(reset, principal), /cloudWritesBlockedByManifestFailure = false/);
  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess");
  assert.match(finalize, /if \(cloudRefreshInProgress\)/);
  assert.match(finalize, /waitForPreviousRefresh/);
  assert.match(finalize, /await loadSystemDataFromCloud\(\)/);
});

test("logout clears account-scoped cloud readiness", () => {
  const logout = section("function _performLogout()", "function openChangePinModal()");
  assert.match(logout, /cloudDataLoadState = 'not-started'/);
  assert.match(logout, /cloudWritesBlockedByManifestFailure = false/);
});

test("admin login defers full timetable portal status loading until the settings tab opens", () => {
  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess");
  assert.match(finalize, /timetableRefreshAccess\(\{ deferAdminPortalStatus: true \}\)/);
  const access = section("async function timetableRefreshAccess", "async function timetableLoadPortalStatus");
  assert.match(access, /options\.deferAdminPortalStatus !== true/);
  const settingsTab = section("function timetableSwitchDashboardTab", "function timetableDailyNormalizeName");
  const settingsGate = settingsTab.indexOf("if (settings && isAdmin)");
  assert.ok(settingsGate >= 0 && settingsTab.indexOf("timetableLoadPortalStatus();", settingsGate) > settingsGate);
});

test("authenticated cloud bootstrap reuses the offline snapshot already restored during app boot", () => {
  const loader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  assert.match(loader, /const offlineSnapshotAvailable = await ensureOfflineSnapshotRestored\(\)/);
  assert.match(html, /let offlineSnapshotRestorePromise = null/);
  assert.match(html, /function ensureOfflineSnapshotRestored\(\)/);
  const boot = section("window.addEventListener('DOMContentLoaded'", "function ");
  assert.match(boot, /offlineSnapshotRestoredAtBoot = await ensureOfflineSnapshotRestored\(\)/);
});

test("cloud bootstrap bounds IndexedDB snapshot persistence so verification cannot hang", () => {
  const persistence = section("async function persistOfflineStateWithTimeout", "async function fetchAppSyncManifest");
  assert.match(persistence, /withAppSyncTimeout\(/);
  assert.match(persistence, /APP_SYNC_LOCAL_SNAPSHOT_TIMEOUT/);
  const loader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  assert.equal((loader.match(/await persistOfflineStateWithTimeout\(\)/g) || []).length, 3);
  assert.doesNotMatch(loader, /await persistOfflineState\(\)/);
  assert.match(loader, /تعذر تحديث النسخة المحلية الدائمة/);
});

test("IndexedDB restore is bounded and falls back without blocking authenticated cloud bootstrap", () => {
  const restore = section("async function restoreOfflineState()", "function cloneOfflineValue");
  assert.match(restore, /withAppSyncTimeout\(/);
  assert.match(restore, /APP_OFFLINE_RESTORE_TIMEOUT/);
  assert.match(restore, /offlineDbPromise = null/);
  assert.match(restore, /restoreLocalStorageOfflineSnapshot\(\)/);
  assert.match(restore, /6000/);
  assert.match(restore, /database\.transaction\('state', 'readonly'\)/);
});

test("unchanged cloud manifests persist only queued deletion overlays", () => {
  const loader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  const noChangeStart = loader.indexOf("if (nextManifest && changedTables.length === 0)");
  const noChangeEnd = loader.indexOf("const shouldLoad =", noChangeStart);
  assert.ok(noChangeStart >= 0 && noChangeEnd > noChangeStart);
  const noChange = loader.slice(noChangeStart, noChangeEnd);
  assert.match(noChange, /applyPendingLocalDeletions\(\)/);
  assert.match(noChange, /if \(getPendingDeletes\(\)\.length\)/);
  assert.match(noChange, /deletionOverlaySaved = await persistOfflineStateWithTimeout\(\)/);
  assert.match(noChange, /if \(!deletionOverlaySaved\) deletionOverlaySaved = saveToLocalStorageSafe\(\)/);
  assert.match(noChange, /updateSyncStatus\(!pendingSync, pendingSync/);

  const capture = section("function captureDirtyLocalState()", "function mergeDirtyLocalState");
  assert.match(capture, /pickDirtyEntries\(db\.students, dirty\.students\)/);
  assert.match(capture, /pickDirtyEntries\(db\.attendance, dirty\.attendance\)/);
  assert.match(capture, /pickDirtyEntries\(db\.behaviors, dirty\.behaviors\)/);
  assert.doesNotMatch(capture, /cloneOfflineValue\(db\)/);

  const manifestSave = loader.lastIndexOf("if (nextManifest) lastLoadedCloudManifest = nextManifest");
  const finalPersist = loader.indexOf("const localSnapshotSaved = await persistOfflineStateWithTimeout()", manifestSave);
  const fallbackSave = loader.indexOf("saveToLocalStorageSafe()", finalPersist);
  assert.ok(manifestSave >= 0 && finalPersist > manifestSave && fallbackSave > finalPersist);
  const snapshotStateEnd = loader.indexOf("offlineSnapshotRestorePromise = null", fallbackSave);
  const snapshotStateUpdate = loader.slice(finalPersist, snapshotStateEnd + "offlineSnapshotRestorePromise = null".length);
  assert.match(snapshotStateUpdate, /if \(localSnapshotSaved\)/);
  assert.match(snapshotStateUpdate, /offlineSnapshotRestorePromise = Promise\.resolve\(true\)/);
  assert.match(snapshotStateUpdate, /offlineSnapshotRestoredAtBoot = true/);
  assert.match(snapshotStateUpdate, /else/);
  assert.match(snapshotStateUpdate, /offlineSnapshotRestorePromise = null/);
  assert.equal((loader.match(/await persistOfflineStateWithTimeout\(\)/g) || []).length, 3);
});


test("mobile session storage failure keeps the authenticated page session in memory", () => {
  const save = section("function saveAppAuthSession(session)", "function hasUnexpiredAppAuthSession()");
  assert.ok(save.includes("appAuthSession = session"));
  assert.ok(save.indexOf("appAuthSession = session") < save.indexOf("sessionStorage.setItem"));
  assert.equal(save.includes('throw new Error("تعذر حفظ جلسة الدخول الآمنة في هذا المتصفح.'), false);

  const read = section("function readAppAuthToken()", "function clearAppAuthSession()");
  assert.ok(read.includes("appAuthSession?.token"));
});

test("a secondary service 401 cannot clear a valid app session without canonical validation", () => {
  const request = section("async function appAuthRequest(body, token, signal)", "function isLegacyAuthEndpointUnavailable(error)");
  assert.ok(request.includes('if (action === "app_session") {'));
  assert.ok(request.includes("currentToken === token"));
  assert.ok(request.includes("await validateCanonicalAppAuthSession(token || readAppAuthToken())"));
  assert.equal(request.includes('if (response.status === 401 && action !== "app_login") clearAppAuthSession();'), false);

  const validation = section("async function validateCanonicalAppAuthSession(token)", "function isLegacyAuthEndpointUnavailable(error)");
  assert.ok(validation.includes('JSON.stringify({ action: "app_session" })'));
  assert.ok(validation.includes("if (response.status === 401)"));
  assert.ok(validation.includes("if (!response.ok) return null"));
  assert.ok(validation.includes("if (currentToken === token) clearAppAuthSession()"));
});


test("mobile PIN input normalizes Arabic, Persian, and full-width numerals before login", () => {
  const helper = section("function normalizeAppPinDigits(value)", "async function handleUserLogin(e)");
  const normalize = runInNewContext(helper + "\nnormalizeAppPinDigits");
  assert.equal(normalize("١٢٣٤"), "1234");
  assert.equal(normalize("۱۲۳۴"), "1234");
  assert.equal(normalize("１２３４"), "1234");
  assert.equal(normalize("1234"), "1234");
  assert.equal(normalize(" ١2۳٤ "), " 1234 ");

  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  assert.ok(login.includes('normalizeAppPinDigits(pinInput?.value?.trim() || "")'));
  assert.ok(login.includes("pinInput.value = pin"));
});


test("authenticated login refreshes all independent report panel visibility after role initialization", () => {
  const reports = section("function canAccessReport(key, user = activeUser)", "function switchAdminTab(tab)");
  assert.match(reports, /user\?\.type === 'admin'/);
  assert.match(reports, /reportMorningAssemblyLateness/);
  assert.match(reports, /reportStudentAffairs/);
  assert.match(reports, /reportComprehensiveAbsence/);
  assert.match(reports, /reportClassLatenessFollowup/);
  assert.match(reports, /reportSubstitutionDistribution/);

  const finalize = section("async function finalizeLoginState()", "function hasAdminPanelAccess");
  assert.ok(finalize.includes("refreshReportPanelsVisibility();"));
});


test("a new login supersedes stale session restoration and only one login may run per page", () => {
  assert.match(html, /let appLoginInProgress = false/);
  assert.match(html, /let appLoginGeneration = 0/);
  const restore = section("async function checkExistingSession()", "function normalizeAppPinDigits");
  assert.match(restore, /restoreGeneration = appLoginGeneration/);
  assert.match(restore, /restoreIsCurrent\(\)/);
  assert.match(restore, /controller\.abort\(\)/);
  assert.match(restore, /setTimeout\(\(\) => controller.abort\(\), 5000\)/);
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  assert.match(login, /if \(appLoginInProgress\)/);
  assert.match(login, /appLoginInProgress = true/);
  assert.match(login, /loginController\.signal/);
  assert.match(login, /loginController\.abort\(\)/);
  assert.match(login, /appLoginInProgress = false/);
  assert.match(login, /clearTimeout\(loginTimeoutId\)/);
});

test("secure login remains available after a local-only session and stale 401 cannot clear a newer session", () => {
  const request = section("async function appAuthRequest(body, token, signal)", "async function validateCanonicalAppAuthSession");
  assert.match(request, /localOnlySession && action !== "app_login"/);
  assert.match(request, /if \(token && currentToken === token\) clearAppAuthSession\(\)/);
});


test("authenticated dashboard shell is rendered immediately and post-login initialization has a timer fallback", () => {
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  const saveSession = login.indexOf("saveAppAuthSession(serverLogin)");
  const committed = login.indexOf("authenticatedLoginCommitted = true", saveSession);
  const shellCall = login.indexOf("renderAuthenticatedDashboardShell()", committed);
  const deferred = login.indexOf("const startPostLoginInitialization", shellCall);
  const frame = login.indexOf("requestAnimationFrame", deferred);
  const fallback = login.indexOf("window.setTimeout(startPostLoginInitialization, 50)", frame);
  const finalizer = login.indexOf("void finalizeLoginState().catch", deferred);
  const finallyBlock = login.indexOf("} finally {", finalizer);
  assert.ok(saveSession >= 0 && committed > saveSession && shellCall > committed);
  assert.ok(deferred > shellCall && frame > deferred && fallback > frame);
  assert.ok(finalizer > deferred && finallyBlock > finalizer);
  assert.match(login.slice(deferred, fallback), /postLoginInitializationStarted/);
  assert.match(login.slice(finallyBlock), /if \(authenticatedLoginCommitted\)/);
  assert.match(login.slice(finallyBlock), /loginView.*classList\.add\('hidden'\)/);
  assert.match(login.slice(finallyBlock), /dashboardSelectionView.*classList\.remove\('hidden'\)/);
  assert.match(login.slice(finallyBlock), /btn\.disabled = false/);
  const shell = section("function renderAuthenticatedDashboardShell()", "async function finalizeLoginState()");
  assert.match(shell, /dashboardSelectionView.*classList\.remove\(["']hidden["']\)/);
  assert.match(shell, /adminPanelBtn/);
  assert.match(shell, /studentAffairsBtn/);
});

test("first cloud manifest and table reads have explicit five-minute deadlines", () => {
  assert.match(html, /const APP_SYNC_MANIFEST_TIMEOUT_MS = 300000/);
  assert.match(html, /const APP_SYNC_TABLES_TIMEOUT_MS = 300000/);
  const manifest = section("async function fetchAppSyncManifest()", "function getChangedAppSyncTables");
  assert.match(manifest, /APP_SYNC_MANIFEST_TIMEOUT_MS/);
  const loader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  assert.match(loader, /APP_SYNC_TABLES_TIMEOUT_MS/);
  assert.match(loader, /APP_SYNC_MANIFEST_TIMEOUT/);
  assert.match(loader, /APP_SYNC_TABLES_TIMEOUT/);
});


test("publishable API keys are sent only as apikey while legacy JWT anon keys retain Bearer compatibility", () => {
  const helper = section("function getSupabasePublicDataHeaders(", "function installSupabaseAuthDiagnostics()");
  const publishableHeaders = runInNewContext(
    `${helper}
getSupabasePublicDataHeaders({ "Content-Type": "application/json" })`,
    { SUPABASE_ANON_KEY: "sb_publishable_test-key" },
  );
  assert.equal(
    JSON.stringify(publishableHeaders),
    JSON.stringify({ "Content-Type": "application/json", apikey: "sb_publishable_test-key" }),
  );

  const legacyKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature";
  const legacyHeaders = runInNewContext(
    `${helper}
getSupabasePublicDataHeaders()`,
    { SUPABASE_ANON_KEY: legacyKey },
  );
  assert.equal(
    JSON.stringify(legacyHeaders),
    JSON.stringify({ apikey: legacyKey, Authorization: `Bearer ${legacyKey}` }),
  );

  const manifest = section("async function fetchAppSyncManifest()", "function getChangedAppSyncTables");
  assert.match(manifest, /headers:\\s*getSupabasePublicDataHeaders\\(/);
  assert.doesNotMatch(manifest, /Authorization:\\s*`Bearer \\$\\{SUPABASE_ANON_KEY\\}`/);

  const tableReader = section("async function fetchAllPaginated(", "async function persistOfflineState()");
  assert.match(tableReader, /Object\\.entries\\(getSupabasePublicDataHeaders\\(\\)\\)/);
  assert.doesNotMatch(tableReader, /setRequestHeader\\(['"]Authorization['"]/);
});
