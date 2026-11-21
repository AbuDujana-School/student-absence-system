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
  const guard = loader.indexOf("if (localOnlySession || (navigator.onLine && !hasUnexpiredAppAuthSession()))");
  const manifest = loader.indexOf("fetchAppSyncManifest()");
  assert.ok(guard >= 0 && manifest > guard);
  assert.match(loader.slice(guard, manifest), /cloudDataLoadState = 'failed'/);
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

test("a successful server login stores its verified session before cloud bootstrap", () => {
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  const saveSession = login.indexOf("saveAppAuthSession(serverLogin)");
  const load = login.indexOf("await finalizeLoginState()", saveSession);
  assert.ok(saveSession >= 0 && load > saveSession);
});
