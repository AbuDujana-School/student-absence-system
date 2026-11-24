const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("Missing " + marker);
  const brace = source.indexOf("{", start);
  let depth = 0, quote = null, escaped = false, line = false, block = false;
  for (let i = brace; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; } if (c === quote) quote = null; continue; }
    if (c === "/" && n === "/") { line = true; i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === "'" || c === '"' || c === String.fromCharCode(96)) { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("Unbalanced function");
}

test("canonical reserve UI opens with the correct five role boundaries", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const integration = extractFunction(source, "function installMainSubstitutionViewIntegration()");
  const generalAdminHelper = extractFunction(html, "function isGeneralAdminUser(");
  const reserveCapabilityHelper = extractFunction(html, "function canManageReserveWorkspace(");
  const roles = [
    { id: "general admin", user: { type: "admin", name: "مدير النظام العام" }, principal: { type: "admin", name: "مدير النظام العام" }, allowed: true, expand: true, custom: false },
    { id: "delegated admin", user: { type: "teacher", name: "مدير مفوض", permissions: { admin: true } }, principal: { type: "admin", name: "مدير مفوض" }, allowed: true, expand: true, custom: false },
    { id: "reserve teacher", user: { type: "teacher", name: "معلم احتياط", permissions: { reserve: true } }, principal: { type: "teacher", name: "معلم احتياط", permissions: { reserve: true } }, allowed: true, expand: true, custom: false },
    { id: "custom coordinator", user: { type: "teacher", name: "منسق مخصص" }, principal: { type: "custom", name: "منسق مخصص", departmentId: "science" }, allowed: true, expand: false, custom: true },
    { id: "ordinary teacher", user: { type: "teacher", name: "معلم عادي", permissions: {} }, principal: { type: "teacher", name: "معلم عادي", permissions: {} }, allowed: false, expand: false, custom: false },
  ];
  for (const role of roles) {
    await page.setContent(`
      <main id="dashboardSelectionView"></main>
      <section id="substitutionView" class="hidden">
        <div class="subx-stepper"></div><div class="grid"><input id="substitutionDate"></div>
        <div class="rounded-3xl"><div id="substitutionAbsenteeList"></div></div>
        <div id="substitutionPlanPanel"></div><div id="subxFloatingBar"></div>
        <div id="substitutionStatsPanel">stats</div><div id="timetableDailyArchivePanel">archive</div>
      </section>
      <section id="timetableOrigin"><div id="timetableSubstitutionPanel" class="hidden">
        <button id="timetableDailyOtherDepartmentsButton">other departments</button>
      </div></section>`);
    await page.evaluate(({ role, integration }) => {
      const $ = (id) => document.getElementById(id);
      const activeUser = role.user;
      const appAuthSession = { principal: role.principal };
      const canManageReserveWorkspace = new Function("activeUser", generalAdminHelper + ";" + reserveCapabilityHelper + "; return canManageReserveWorkspace;")(role.user);
      const showToast = (...args) => { window.denials = (window.denials || 0) + 1; };
      const getOmanLocalDate = () => "2026-11-24";
      const status = () => {};
      const openAbsenceReasonPicker = () => {};
      window.calls = { options: 0, archive: 0, stats: 0 };
      window.appAuthRequest = async () => ({});
      window.timetableLoadSubstitutionOptions = async () => { window.calls.options++; };
      window.timetableDailyLoadArchive = async () => { window.calls.archive++; };
      window.substitutionLoadStats = async () => { window.calls.stats++; };
      window.openSubstitutionView = async () => {};
      window.closeSubstitutionView = () => {};
      window.refreshSubstitutionDashboardCard = () => {};
      const install = new Function("$", "activeUser", "appAuthSession", "canManageReserveWorkspace", "showToast", "getOmanLocalDate", "status", "openAbsenceReasonPicker", integration + "; return installMainSubstitutionViewIntegration;")($, activeUser, appAuthSession, canManageReserveWorkspace, showToast, getOmanLocalDate, status, openAbsenceReasonPicker);
      install();
    }, { role, integration, generalAdminHelper, reserveCapabilityHelper });
    await page.evaluate(() => window.openSubstitutionView());
    const result = await page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      return {
        visible: !$("substitutionView").classList.contains("hidden"),
        mounted: $("timetableSubstitutionPanel").parentElement?.id === "substitutionCanonicalWorkspace",
        crossDepartment: !$("timetableDailyOtherDepartmentsButton").classList.contains("hidden"),
        stats: !$("substitutionStatsPanel").classList.contains("hidden"),
        archive: !$("timetableDailyArchivePanel").classList.contains("hidden"),
        calls: window.calls,
        denials: window.denials || 0
      };
    });
    if (role.allowed) {
      expect(result.visible, role.id).toBe(true);
      expect(result.mounted, role.id).toBe(true);
      expect(result.crossDepartment, role.id).toBe(role.expand);
      expect(result.stats, role.id).toBe(!role.custom);
      expect(result.archive, role.id).toBe(!role.custom);
      expect(result.calls.options, role.id).toBe(1);
      expect(result.calls.archive, role.id).toBe(role.custom ? 0 : 1);
      expect(result.calls.stats, role.id).toBe(role.custom ? 0 : 1);
      await page.evaluate(() => window.closeSubstitutionView());
      expect(await page.locator("#timetableOrigin > #timetableSubstitutionPanel").count(), role.id + " restore").toBe(1);
    } else {
      expect(result.mounted, role.id).toBe(false);
      expect(result.calls.options, role.id).toBe(0);
      expect(result.denials, role.id).toBe(1);
    }
  }
});
