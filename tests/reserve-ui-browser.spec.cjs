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

test("reserve dashboard keeps the original home workflow and does not relocate the timetable panel", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const integration = extractFunction(source, "function installMainSubstitutionViewIntegration()");
  await page.setContent(`
    <main id="dashboardSelectionView"></main>
    <div id="substitutionDashboardCard" role="button" tabindex="0" onclick="window.openSubstitutionView()">توزيع الاحتياط</div>
    <section id="substitutionView" class="hidden">
      <div class="subx-stepper"></div>
      <div class="grid"><input id="substitutionDate"></div>
      <div class="rounded-3xl"><div id="substitutionAbsenteeList"></div></div>
      <div id="substitutionPlanPanel"></div><div id="subxFloatingBar"></div>
      <div id="substitutionStatsPanel">stats</div>
    </section>
    <section id="timetableOrigin"><div id="timetableSubstitutionPanel" class="hidden">
      <button id="timetableDailyOtherDepartmentsButton">other departments</button>
    </div></section>
  `);
  await page.evaluate(({ integration }) => {
    const $ = id => document.getElementById(id);
    const activeUser = { type: "teacher", permissions: { reserve: true } };
    const appAuthSession = { principal: { type: "teacher", permissions: { reserve: true } } };
    const canManageReserveWorkspace = () => true;
    const showToast = () => {};
    const getOmanLocalDate = () => "2026-11-24";
    const status = () => {};
    const openAbsenceReasonPicker = () => {};
    window.calls = { originalOpen: 0, timetableOptions: 0 };
    window.openSubstitutionView = async () => {
      window.calls.originalOpen++;
      $("substitutionView").classList.remove("hidden");
    };
    const originalOpener = window.openSubstitutionView;
    window.timetableLoadSubstitutionOptions = async () => { window.calls.timetableOptions++; };
    window.closeSubstitutionView = () => $("substitutionView").classList.add("hidden");
    const install = new Function("$", "activeUser", "appAuthSession", "canManageReserveWorkspace", "showToast", "getOmanLocalDate", "status", "openAbsenceReasonPicker", integration + "; return installMainSubstitutionViewIntegration;")($, activeUser, appAuthSession, canManageReserveWorkspace, showToast, getOmanLocalDate, status, openAbsenceReasonPicker);
    install();
    window.originalOpener = originalOpener;
  }, { integration });
  await page.locator("#substitutionDashboardCard").click();
  await expect(page.locator("#substitutionView")).toBeVisible();
  const result = await page.evaluate(() => ({
    originalOpenerPreserved: window.openSubstitutionView === window.originalOpener,
    calls: window.calls,
    panelParent: document.getElementById("timetableSubstitutionPanel").parentElement.id,
    canonicalHostExists: !!document.getElementById("substitutionCanonicalWorkspace"),
    legacyControlsHidden: ["substitutionDate", "substitutionAbsenteeList", "substitutionPlanPanel", "subxFloatingBar"]
      .some(id => document.getElementById(id)?.classList.contains("hidden"))
  }));
  expect(result.originalOpenerPreserved).toBe(true);
  expect(result.calls.originalOpen).toBe(1);
  expect(result.calls.timetableOptions).toBe(0);
  expect(result.panelParent).toBe("timetableOrigin");
  expect(result.canonicalHostExists).toBe(false);
  expect(result.legacyControlsHidden).toBe(false);
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
