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

test("startup restores local state but does not fetch school data before login", async () => {
  const startup = section(
    "window.addEventListener('DOMContentLoaded'",
    "function updateSyncStatus"
  );
  assert.match(startup, /await restoreOfflineState\(\)/);
  assert.match(startup, /await checkExistingSession\(\)/);
  assert.doesNotMatch(startup, /await loadSystemDataFromCloud\(\)/);
});

test("a server-validated saved app session loads cloud data only after validation", async () => {
  const auth = section("async function checkExistingSession()", "async function handleUserLogin");
  const validate = auth.indexOf('appAuthRequest({ action: "app_session" }');
  const load = auth.indexOf("await loadSystemDataFromCloud();");
  const finalize = auth.indexOf("await finalizeLoginState();");
  assert.ok(validate >= 0 && load > validate && finalize > load);
});

test("legacy saved sessions refresh only after a local identity has been resolved", async () => {
  const auth = section("async function checkExistingSession()", "async function handleUserLogin");
  const identity = auth.indexOf("activeUser = user;");
  const load = auth.indexOf("if (navigator.onLine) await loadSystemDataFromCloud();");
  const finalize = auth.indexOf("await finalizeLoginState();", identity);
  assert.ok(identity >= 0 && load > identity && finalize > load);
});

test("online PIN login fails closed if the server authentication endpoint is unavailable", async () => {
  const login = section("async function handleUserLogin", "async function findUserByPinWithRecord");
  assert.match(login, /if \(isLegacyAuthEndpointUnavailable\(serverError\)\) \{/);
  assert.match(login, /throw new Error\("خدمة تسجيل الدخول الآمن غير متاحة/);
  assert.doesNotMatch(login, /isLegacyAuthEndpointUnavailable\(serverError\)\) useLegacyLogin = true/);
});

test("successful server login loads cloud data after receiving a session and before rendering", async () => {
  const login = section("async function handleUserLogin", "async function findUserByPinWithRecord");
  const session = login.indexOf("saveAppAuthSession(serverLogin);");
  const load = login.indexOf("await loadSystemDataFromCloud();", session);
  const finalize = login.indexOf("await finalizeLoginState();", session);
  assert.ok(session >= 0 && load > session && finalize > load);
  assert.match(login, /if \(useLegacyLogin\)/);
});
