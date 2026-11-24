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
      <div id="substitutionDashboardCard" role="button" tabindex="0" onclick="window.openSubstitutionView()">توزيع الاحتياط</div>
      <section id="substitutionView" class="hidden">
        <div class="subx-stepper"></div><div class="grid"><input id="substitutionDate"></div>
        <div class="rounded-3xl"><div id="substitutionAbsenteeList"></div></div>
        <div id="substitutionPlanPanel"></div><div id="subxFloatingBar"></div>
        <div id="substitutionStatsPanel">stats</div><div id="timetableDailyArchivePanel">archive</div>
      </section>
      <section id="timetableOrigin"><div id="timetableSubstitutionPanel" class="hidden">
        <button id="timetableDailyOtherDepartmentsButton">other departments</button>
      </div></section>`);
    await page.evaluate(({ role, integration, generalAdminHelper, reserveCapabilityHelper }) => {
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
      window.timetableLoadSubstitutionOptions = async () => { window.calls.options++; await new Promise(resolve => { window.releaseOptions = resolve; }); };
      window.timetableDailyLoadArchive = () => { window.calls.archive++; return new Promise(() => {}); };
      window.substitutionLoadStats = () => { window.calls.stats++; return new Promise(() => {}); };
      window.openSubstitutionView = async () => {};
      window.closeSubstitutionView = () => {};
      window.refreshSubstitutionDashboardCard = () => {};
      const install = new Function("$", "activeUser", "appAuthSession", "canManageReserveWorkspace", "showToast", "getOmanLocalDate", "status", "openAbsenceReasonPicker", integration + "; return installMainSubstitutionViewIntegration;")($, activeUser, appAuthSession, canManageReserveWorkspace, showToast, getOmanLocalDate, status, openAbsenceReasonPicker);
      window.installMainReserveView = install;
      install();
    }, { role, integration, generalAdminHelper, reserveCapabilityHelper });
    await page.evaluate(() => {
      const root = document.getElementById("substitutionView");
      // Reproduce the real visibility observer re-entering the open handler.
      const observer = new MutationObserver(() => {
        if (!root.classList.contains("hidden")) window.openSubstitutionView();
      });
      observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    });
    await page.locator("#substitutionDashboardCard").click();
    if (role.allowed) {
      await page.waitForFunction(() => window.calls.options === 1);
      await page.waitForTimeout(0);
      const inFlightCalls = await page.evaluate(() => window.calls.options);
      expect(inFlightCalls, role.id + " duplicate observer open").toBe(1);
      await page.evaluate(() => window.releaseOptions());
      // The workspace must finish opening even if archive/statistics requests never settle.
      await page.waitForFunction(() => window.__canonicalReserveOpening === false);
      await page.waitForTimeout(0);
    } else {
      await page.waitForFunction(() => window.denials === 1);
    }
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

test("cumulative reserve archive renders from its own cache, not the daily archive cache", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const render = extractFunction(source, "window.substitutionRenderCumulativeArchive = function()");
  const host = { innerHTML: "", querySelectorAll: () => [] };
  const fakeWindow = {};
  const run = new Function("window", "$", "reserveCumulativeArchive", "esc",
    render + "; return window.substitutionRenderCumulativeArchive;");
  const renderCumulative = run(fakeWindow, id => id === "substitutionCumulativeArchiveResults" ? host : null,
    [{ id: "cumulative-only", assignmentDate: "2026-11-01", absentTeacherName: "سجل تراكمي", substituteTeacherName: "بديل", period: 1, status: "completed" }],
    value => String(value ?? ""));
  renderCumulative();
  expect(host.innerHTML).toContain("سجل تراكمي");
  expect(source).toContain("let reserveCumulativeArchive = [];");
  expect(source).toContain("reserveCumulativeArchive=Array.isArray(response.archive)?response.archive:[];");
});

test("home reserve observer ignores nested canonical workspace mutations", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  expect(source).toContain("substitutionContentObserver.observe(substitutionView,{childList:true});");
  expect(source).not.toContain("substitutionContentObserver.observe(substitutionView,{subtree:true,childList:true});");
});
