import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
function section(start, end) {
  const from = html.indexOf(start); assert.notEqual(from, -1, `missing section: ${start}`);
  const to = html.indexOf(end, from + start.length); assert.notEqual(to, -1, `missing boundary: ${end}`);
  return html.slice(from, to);
}
test("network failures are distinguished from explicit authentication denials", () => {
  assert.match(html, /error\.networkFailure = networkError instanceof TypeError \|\| networkError\?\.name === "NetworkError"/);
  assert.match(html, /function isNetworkFailureForOfflineFallback\(error\) \{ return error\?\.status === 0 && error\?\.networkFailure === true; \}/);
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  assert.match(login, /isLegacyAuthEndpointUnavailable\(serverError\) \|\| isNetworkFailureForOfflineFallback\(serverError\)/);
  assert.match(login, /if \(useLegacyLogin && !hasUsableOfflineLoginSnapshot\(\)\)/);
  assert.doesNotMatch(login, /serverError\.status === (401|403|429)[\s\S]{0,120}useLegacyLogin = true/);
});
test("offline PIN validation requires a restored snapshot with credential hashes", () => {
  const policy = section("function isNetworkFailureForOfflineFallback(error)", "function saveAppAuthSession(session)");
  assert.match(policy, /if \(!offlineSnapshotRestoredAtBoot\) return false/);
  assert.match(policy, /db\.adminPin/); assert.match(policy, /db\.customUsers/); assert.match(policy, /db\.teachers/);
  const login = section("async function handleUserLogin(e)", "async function findUserByPinWithRecord");
  assert.ok(login.indexOf("hasUsableOfflineLoginSnapshot()") < login.indexOf("findUserByPinWithRecord(pin)"));
});
test("local-only mode blocks cloud reads, writes, and sync entry points", () => {
  const cloudLoader = section("async function loadSystemDataFromCloud()", "function syncValuesEqual");
  assert.match(cloudLoader, /if \(localOnlySession\)/);
  assert.match(cloudLoader, /if \(navigator\.onLine && !await ensureAppAuthSession\(\)\)/);
  assert.match(section("async function saveSystemDataToCloud(options = {})", "async function checkExistingSession()"), /if \(localOnlySession \|\|/);
  assert.match(section("async function retryOfflineSyncSilently()", "async function refreshCloudDataSilently()"), /if \(localOnlySession \|\|/);
  assert.match(section("async function syncPendingLocalChanges()", "/* ============ LocalStorage ============ */"), /if \(localOnlySession\)/);
  assert.match(section("async function finalizeLoginState()", "function hasAdminPanelAccess"), /if \(localOnlySession\)/);
  assert.match(section("async function appAuthRequest(body, token)", "function isLegacyAuthEndpointUnavailable(error)"), /if \(localOnlySession\) throw/);
  assert.match(section("async function saRequest(body)", "async function appAuthRequest(body, token)"), /if \(localOnlySession\) throw/);
});
test("reconnection requires secure authentication before sync", () => {
  const init = section("window.addEventListener('offline'", "function initDarkMode()");
  assert.match(init, /localOnlySession \|\| !hasUnexpiredAppAuthSession\(\)/);
  assert.match(init, /if \(localOnlySession\) \{[\s\S]*?أعد تسجيل الدخول الآمن/);
  assert.match(section("function saveAppAuthSession(session)", "function readAppAuthToken()"), /localOnlySession = false/);
  assert.match(section("function _performLogout()", "function openChangePinModal()"), /localOnlySession = false/);
});
test("explicit HTTP auth and rate-limit denials are not converted to offline login", () => {
  const request = section("async function appAuthRequest(body, token)", "function isLegacyAuthEndpointUnavailable(error)");
  assert.match(request, /if \(!response\.ok\)[\s\S]*?error\.status = response\.status/);
  assert.doesNotMatch(request, /response\.status === (401|403|429)[\s\S]*?useLegacyLogin/);
});
