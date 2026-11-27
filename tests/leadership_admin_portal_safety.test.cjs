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

test("shared calm-glass theme keeps dusk contrast readable and avoids pure black", () => {
  assert.match(styles, /--school-glass-navy:#2b4157/);
  assert.match(styles, /#182635/);
  assert.match(styles, /#223447/);
  assert.match(styles, /#e2e8f0/);
  assert.match(styles, /#cbd5e1/);
  assert.doesNotMatch(styles, /#000(?:000)?\b/i);
  assert.match(styles, /overflow-x:auto/);
  assert.match(styles, /min-width:720px/);
});

test("morning assembly exposes explicit local calm-light and calm-dusk controls", () => {
  assert.match(portal, /function installMorningAssemblyThemeControls\(\)/);
  assert.match(portal, /data-ma-theme="light"/);
  assert.match(portal, /data-ma-theme="dusk"/);
  assert.match(portal, /applyTheme\('light'\)/);
  assert.match(styles, /#morningAssemblyLatenessView\.ma-theme-light/);
  assert.match(styles, /#morningAssemblyLatenessView\.ma-theme-dusk/);
  assert.match(portal, /نور الصباح الهادئ/);
  assert.match(portal, /ضباب الغسق الهادئ/);
});

test("morning assembly separates quick monitoring from report details without replacing existing section IDs", () => {
  assert.match(portal, /function installMorningAssemblyNavigation\(\)/);
  assert.match(portal, /data-ma-tab="quick"/);
  assert.match(portal, /data-ma-tab="report"/);
  assert.match(portal, /morningAssemblyClassesGrid/);
  assert.match(portal, /morningAssemblyReportContainer/);
  assert.match(portal, /classList\.toggle\('hidden', reportMode\)/);
  assert.match(styles, /\.ma-section-tabs/);
  assert.match(styles, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test("morning assembly quick view uses live school counts and clear Arabic guidance", () => {
  assert.match(portal, /morningAssemblyLatenessToday\.size/);
  assert.match(portal, /db\.classes\.length/);
  assert.match(portal, /مرصود اليوم:/);
  assert.match(portal, /تسجيل طالب متأخر/);
  assert.match(portal, /ابحث باسم الطالب من جميع الصفوف لرصد التأخر بلمسة واحدة/);
  assert.match(portal, /بحث ذكي باسم الطالب أو الصف من جميع الصفوف/);
  assert.match(styles, /\.ma-today-summary/);
});
