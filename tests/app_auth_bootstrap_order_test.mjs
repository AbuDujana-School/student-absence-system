import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

test("a successful server login stores its verified session before detached cloud bootstrap", () => {
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  const saveSession = login.indexOf("saveAppAuthSession(serverLogin)");
  const finalize = login.indexOf("void finalizeLoginState().catch", saveSession);
  const dashboard = login.indexOf("dashboardSelectionView", saveSession);
  assert.ok(saveSession >= 0 && finalize > saveSession);
  assert.ok(dashboard > saveSession);
  assert.match(login.slice(saveSession, finalize), /loginView.*classList\.add\('hidden'\)/);
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
  assert.match(loader, /const offlineSnapshotAvailable = offlineSnapshotRestoredAtBoot \|\| await restoreOfflineState\(\)/);
  const boot = section("window.addEventListener('DOMContentLoaded'", "function ");
  assert.match(boot, /offlineSnapshotRestoredAtBoot = await restoreOfflineState\(\)/);
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
