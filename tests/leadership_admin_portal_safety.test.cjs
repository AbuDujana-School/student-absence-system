const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const portal = fs.readFileSync(path.join(root, "leadership-admin-portal.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "leadership-admin-portal.css"), "utf8");

test("leadership portal is a separately loaded UI module, not an auth/bootstrap replacement", () => {
  assert.match(html, /leadership-admin-portal\.css\?v=/);
  assert.match(html, /leadership-admin-portal\.js\?v=/);
  assert.match(html, /function finalizeLoginState\(/);
  assert.match(html, /function renderAuthenticatedDashboardShell\(/);
  assert.doesNotMatch(portal, /\b(?:function|const|let|var)\s+(?:login|verifyTeacherPin|finalizeLoginState|appAuthRequest|saveSystemDataToCloud)\b/);
  assert.doesNotMatch(portal, /\bsetInterval\s*\(/);
  assert.doesNotMatch(portal, /\bfetch\s*\(/);
  assert.doesNotMatch(portal, /supabase\.from\s*\(/);
});

test("the new portal permission is an independent visibility gate and preserves the existing permission save path", () => {
  assert.match(portal, /const PORTAL_PERMISSION = 'canViewAdminRecords'/);
  assert.match(portal, /function hasPortalPermission\(user\)/);
  assert.match(portal, /target\?\.permissions\?\.\[PORTAL_PERMISSION\] === true/);
  assert.match(portal, /perm_p_canViewAdminRecords/);
  assert.match(portal, /const originalSave = window\.saveTeacherPermissions/);
  assert.match(portal, /await originalSave\.apply\(this, args\)/);
  assert.match(portal, /teacher\.permissions\[PORTAL_PERMISSION\] = checked/);
  assert.match(portal, /const teacherIndex = Number\(modal\.dataset\.adminRecordsTeacherIndex\)/);
  assert.doesNotMatch(portal, /db\.teachers\.find\(item => String\(item\?\.name/);
});

test("legacy admin dashboard access is not hidden by the new portal grant", () => {
  assert.match(portal, /adminButton\.classList\.toggle\('hidden', !showAdminPanel\)/);
  assert.doesNotMatch(portal, /adminButton\.classList\.toggle\('hidden', !showAdminPanel \|\| allowed\)/);
});

test("daily pulse reads are individually guarded by their original report/archive permissions", () => {
  assert.match(portal, /if \(canReport\('reportMorningAssemblyLateness'\) && cache\.morningAssemblyLoaded !== true\)/);
  assert.match(portal, /if \(canReadReserveArchive\(\) && cache\.reserveArchiveLoaded !== true\)/);
  assert.match(portal, /function canReadReserveArchive\(\)/);
  assert.match(portal, /function canAdminTab\(key\)/);
  assert.match(portal, /function canReport\(key\)/);
  assert.match(portal, /function restoreMovedModules\(\)/);
  assert.match(portal, /state\.placeholder\.parentNode\.insertBefore\(state\.node/);
  assert.doesNotMatch(portal, /setTimeout\s*\(|setInterval\s*\(/);
});

test("the visual layer uses the school brand palette and responsive RTL presentation", () => {
  assert.match(styles, /#183653/i);
  assert.match(styles, /#168C85/i);
  assert.match(styles, /#D5A64A/i);
  assert.match(portal, /setAttribute\('dir', 'rtl'\)/);
  assert.match(styles, /@media/);
  assert.match(styles, /backdrop-filter/);
});
