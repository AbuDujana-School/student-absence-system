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
        <div id="substitutionStatsPanel">stats</div><div id="substitutionOtherDepartmentsWrap" class="hidden">other departments</div>
        <section id="subxEditPanel"><div id="subxEditContent"></div></section>
        <section id="subxArchivePanel"><div id="subxArchiveContent"></div></section>
      </section>
      <section id="timetableOrigin"><div id="timetableSubstitutionPanel" class="hidden">
        <button id="timetableDailyOtherDepartmentsButton">other departments</button>
        <div id="timetableDailyActivePanel">active assignments</div>
        <div id="timetableDailyArchivePanel" class="hidden">archive</div>
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
      window.substitutionLoadAbsentees = async () => { window.calls.options++; await new Promise(resolve => { window.releaseOptions = resolve; }); };
      window.timetableDailyInstallAdminTools = async () => {
        if (role.user.type === "admin" || role.user.permissions?.admin === true) {
          $("timetableSubstitutionPanel").insertAdjacentHTML("beforeend", '<div id="ttAdminReserveTools">admin tools</div>');
        }
      };
      window.timetableDailyInstallDepartmentTools = async () => {
        if (role.user.permissions?.reserve === true) {
          $("timetableSubstitutionPanel").insertAdjacentHTML("beforeend", '<div id="ttDepartmentReserveTools">department tools</div>');
        }
      };
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
      const quickDateNav = page.locator("#subxCanonicalDateQuickNav");
      await expect(quickDateNav, role.id + " visible canonical date navigation").toBeVisible();
      await expect(quickDateNav.locator('[data-date-offset="-1"]')).toHaveCount(0);
      await quickDateNav.locator('[data-date-offset="0"]').click();
      expect(await page.locator("#substitutionDate").inputValue(), role.id + " today shortcut").toBe("2026-11-24");
      await expect(quickDateNav.locator('[data-date-offset="1"]')).toHaveCount(1);
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
        legacyHidden: $("timetableSubstitutionPanel").classList.contains("hidden"),
        legacyStillInOrigin: $("timetableSubstitutionPanel").parentElement?.id === "timetableOrigin",
        editMounted: $("timetableDailyActivePanel").parentElement?.id === "subxEditContent",
        archiveMounted: $("timetableDailyArchivePanel").parentElement?.id === "subxArchiveContent",
        adminToolsMounted: $("ttAdminReserveTools")?.parentElement?.id === "subxArchiveContent",
        departmentToolsMounted: $("ttDepartmentReserveTools")?.parentElement?.id === "subxArchiveContent",
        crossDepartment: !$("substitutionOtherDepartmentsWrap").classList.contains("hidden"),
        stats: !$("substitutionStatsPanel").classList.contains("hidden"),
        archive: !$("timetableDailyArchivePanel").classList.contains("hidden"),
        calls: window.calls,
        denials: window.denials || 0
      };
    });
    if (role.allowed) {
      expect(result.visible, role.id).toBe(true);
      expect(result.legacyHidden, role.id).toBe(true);
      expect(result.legacyStillInOrigin, role.id).toBe(true);
      expect(result.editMounted, role.id).toBe(true);
      expect(result.archiveMounted, role.id).toBe(true);
      expect(result.adminToolsMounted, role.id).toBe(role.id === "general admin" || role.id === "delegated admin");
      expect(result.departmentToolsMounted, role.id).toBe(role.id === "reserve teacher");
      expect(result.crossDepartment, role.id).toBe(role.expand);
      expect(result.stats, role.id).toBe(!role.custom);
      expect(result.archive, role.id).toBe(!role.custom);
      expect(result.calls.options, role.id).toBe(1);
      expect(result.calls.archive, role.id).toBe(role.custom ? 0 : 1);
      expect(result.calls.stats, role.id).toBe(role.custom ? 0 : 1);
      await page.evaluate(() => window.closeSubstitutionView());
      expect(await page.locator("#timetableOrigin > #timetableSubstitutionPanel").count(), role.id + " compatibility engine remains mounted").toBe(1);
      expect(await page.locator("#timetableOrigin > #timetableSubstitutionPanel.hidden").count(), role.id + " compatibility engine stays hidden").toBe(1);
    } else {
      expect(result.legacyHidden, role.id).toBe(true);
      expect(result.legacyStillInOrigin, role.id).toBe(true);
      expect(result.editMounted, role.id).toBe(false);
      expect(result.archiveMounted, role.id).toBe(false);
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

test("premium reserve wizard advances progressively from date to absence and approval", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const premium = extractFunction(source, "function installPremiumReserveExperience(");
  const checklist = extractFunction(source, "function installReserveAbsenteeChecklist(panel)");
  await page.setContent(`
    <section id="timetableSubstitutionPanel">
      <div><h3>توزيع الاحتياط اليومي</h3><p>اختيار اليوم وإعداد التوزيع</p></div>
      <nav class="tt-reserve-steps"></nav>
      <label><span>التاريخ</span><input id="timetableSubstitutionDate" type="date" onchange="window.__dateRefreshes=(window.__dateRefreshes||0)+1"></label>
      <div><label>بحث المعلم</label><input id="timetableDailyAbsentSearch"></div>
      <div id="timetableDailyAbsentTags"></div>
      <div class="tt-toolbar"><button id="timetableDailySaveBatchButton">حفظ</button></div>
      <div id="timetableSubstitutionResults"></div>
    </section>`);
  await page.evaluate(({ premium, checklist }) => {
    const $ = id => document.getElementById(id);
    const preview = { assignments: [], unassigned: [], existingAssignments: [] };
    const approved = new Set();
    const absentees = [];
    const install = new Function("$", "reserveBatchPreview", "reserveDraftApproved", "timetableDailyAbsentTeachers", "reserveCurrentMuscatDate", "timetableDailyAbsentOptions", "timetableDailyNormalizeName", "reserveAbsenceReasons", "persistStoredDraft", "status", "timetableDailyBusy", "esc",
      checklist + ";" + premium + "; return installPremiumReserveExperience;")($, preview, approved, absentees, () => "2026-11-24", [], value => String(value || "").toLowerCase(), Object.create(null), () => {}, () => {}, false, value => String(value ?? ""));
    install($("timetableSubstitutionPanel"));
    window.__premiumReserveState = { preview, approved, absentees };
  }, { premium, checklist });

  const initial = await page.evaluate(() => ({
    dateVisible: !document.getElementById("ttPremiumDateCard")?.hidden,
    absentHidden: document.getElementById("ttPremiumAbsentCard")?.hidden,
    toolbarHidden: document.getElementById("timetableDailySaveBatchButton").parentElement.hidden,
    resultsReady: document.getElementById("timetableSubstitutionResults").classList.contains("tt-premium-results-ready")
  }));
  expect(initial.dateVisible).toBe(true);
  await expect(page.locator("#timetableSubstitutionDate")).toHaveValue("2026-11-24");
  await expect.poll(() => page.evaluate(() => window.__dateRefreshes || 0)).toBe(1);
  await page.locator("#timetableSubstitutionDate").fill("2026-11-30");
  await expect(page.locator("#timetableSubstitutionDate")).toHaveValue("2026-11-30");
  await expect.poll(() => page.evaluate(() => window.__dateRefreshes || 0)).toBe(2);
  await expect(page.locator("#ttPremiumAbsentCard")).toBeVisible();
  expect(initial.absentHidden).toBe(false);
  expect(initial.toolbarHidden).toBe(true);
  expect(initial.resultsReady).toBe(false);

  await page.locator('[data-premium-step="2"]').click();
  await expect(page.locator("#timetableDailyAbsentSearch")).toBeFocused();

  await page.evaluate(() => {
    window.__premiumReserveState.absentees.push("معلم تجريبي");
    window.__premiumReserveState.preview.assignments.push({ absentTeacherName: "معلم تجريبي" });
    document.getElementById("timetableDailyAbsentSearch").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#timetableDailySaveBatchButton").locator("..")).toBeVisible();
  await expect(page.locator("#timetableSubstitutionResults")).toHaveClass(/tt-premium-results-ready/);

  await page.evaluate(() => {
    window.__premiumReserveState.approved.add("معلم تجريبي");
    document.getElementById("timetableDailyAbsentSearch").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator('[data-premium-step="4"]')).toHaveClass(/is-active/);
});


test("reserve absentee checklist selects teachers and edits absence reasons independently", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const checklist = extractFunction(source, "function installReserveAbsenteeChecklist(panel)");
  await page.setContent('<section id="timetableSubstitutionPanel"><div><input id="timetableDailyAbsentSearch" type="search"></div><div id="timetableDailySuggestions" class="hidden"></div><div id="timetableDailyAbsentTags"></div></section>');
  await page.evaluate(({ checklist }) => {
    const options = ["أحمد علي", "سالم محمد"];
    const absent = [];
    const reasons = Object.create(null);
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    window.openSubstitutionAbsenceReasonPicker = (name, current, callback) => {
      window.__lastReasonPicker = { name, current };
      window.__reasonCallback = callback;
    };
    window.timetableDailyAddAbsent = async name => { if (!absent.includes(name)) absent.push(name); };
    window.timetableDailyRemoveAbsent = name => {
      const index = absent.indexOf(name);
      if (index >= 0) absent.splice(index, 1);
      delete reasons[name];
    };
    window.timetableDailyRenderTags = () => {};
    window.timetableDailyRenderLessons = () => {};
    window.timetableDailyFilterAbsentTeachers = () => {};
    window.timetableLoadSubstitutionOptions = async () => {};
    window.timetableDailySetBusy = () => {};
    const install = new Function(
      "$", "timetableDailyAbsentOptions", "timetableDailyAbsentTeachers",
      "timetableDailyNormalizeName", "reserveAbsenceReasons", "persistStoredDraft",
      "status", "timetableDailyBusy", "esc",
      checklist + "; return installReserveAbsenteeChecklist;"
    )($, options, absent, normalize, reasons, () => {}, () => {}, false, esc);
    install($("timetableSubstitutionPanel"));
    window.__checklistState = { options, absent, reasons };
  }, { checklist });

  const checkbox = page.locator('[data-tt-check-absent="أحمد علي"]');
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(page.locator("#timetableDailyAbsenceReasonModal")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__checklistState.absent)).toContain("أحمد علي");
  expect(await page.evaluate(() => window.__checklistState.reasons["أحمد علي"])).toBeUndefined();

  await page.locator('[data-tt-open-absence-reason="أحمد علي"]').click();
  expect(await page.evaluate(() => window.__lastReasonPicker.name)).toBe("أحمد علي");
  expect(await page.evaluate(() => window.__lastReasonPicker.current)).toBe("");
  await page.evaluate(() => window.__reasonCallback("مرضية"));
  expect(await page.evaluate(() => window.__checklistState.reasons["أحمد علي"])).toBe("مرضية");

  await page.locator('[data-tt-open-absence-reason="أحمد علي"]').click();
  expect(await page.evaluate(() => window.__lastReasonPicker.current)).toBe("مرضية");
  await page.evaluate(() => window.__reasonCallback("موعد مستشفى"));
  expect(await page.evaluate(() => window.__checklistState.reasons["أحمد علي"])).toBe("موعد مستشفى");

  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  expect(await page.evaluate(() => window.__checklistState.absent)).not.toContain("أحمد علي");

  await page.locator("#timetableDailyAbsentSearch").fill("سالم");
  await expect(page.locator('[data-tt-check-absent="سالم محمد"]')).toBeVisible();
  await expect(page.locator('[data-tt-check-absent="أحمد علي"]')).toHaveCount(0);
});


test("the original polished absence picker is the only modal and preserves legacy reasons", async ({ page }) => {
  const workflow = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const delegate = extractFunction(workflow, "function openAbsenceReasonPicker(");
  const pickerStart = html.indexOf("const popup=document.createElement('div');popup.id='subxReasonPopup'");
  const pickerEnd = html.indexOf("if(document.getElementById('substitutionOtherDepartmentSelect'))", pickerStart);
  expect(pickerStart).toBeGreaterThanOrEqual(0);
  expect(pickerEnd).toBeGreaterThan(pickerStart);
  const pickerMarkup = html.slice(pickerStart, pickerEnd);

  await page.setContent("<main></main>");
  await page.evaluate(({ pickerMarkup, delegate }) => {
    new Function("root", pickerMarkup)(document.querySelector("main"));
    window.__openReason = new Function("status", "window", delegate + "; return openAbsenceReasonPicker;")(() => {}, window);
    window.__reasonResult = undefined;
  }, { pickerMarkup, delegate });

  await page.evaluate(() => window.__openReason("معلم تجريبي", value => { window.__reasonResult = value; }, "مرضية"));
  await expect(page.locator("#subxReasonPopup [data-reason]")).toHaveCount(5);
  await expect(page.locator('#subxReasonPopup [data-reason="مرضية"]')).toHaveClass(/is-active/);
  await expect(page.locator("#subxReasonPopup").filter({ hasText: "إجازة مرضية" })).toBeVisible();
  await expect(page.locator("#subxReasonPopup")).toHaveCount(1);
  await expect(page.locator("#timetableDailyAbsenceReasonModal")).toHaveCount(0);

  await page.locator('#subxReasonPopup [data-reason="أخرى"]').click();
  await page.locator("#subxReasonConfirm").click();
  expect(await page.evaluate(() => window.__reasonResult)).toBe("أخرى");
  expect(workflow).not.toContain("timetableDailyAbsenceReasonModal");
});

test("official reserve archive printing orders days newest first and creates one A4 sheet per day", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const printRange = extractFunction(source, "window.timetableDailyPrintArchiveRange = function (sourceRecords) {");
  const calls = [];
  const printed = [];
  const run = new Function("window", "status", "reserveArchive", "reserveOfficialPrintPages", "printOfficialReservePages",
    printRange + "; return window.timetableDailyPrintArchiveRange;");
  const print = run({}, () => {}, [], (groups, date, weekday, subject, options) => {
    calls.push({ date, weekday, groups, options });
    return ["A4:" + date];
  }, pages => printed.push(...pages));
  print([
    { id: "older-a", assignmentDate: "2026-11-23", absentTeacherName: "أحمد", substituteTeacherName: "سالم", period: 2, status: "completed" },
    { id: "newer-a", assignmentDate: "2026-11-24", absentTeacherName: "محمد", substituteTeacherName: "علي", period: 1, status: "assigned" },
    { id: "newer-b", assignmentDate: "2026-11-24", absentTeacherName: "محمد", substituteTeacherName: "ناصر", period: 3, status: "confirmed" },
    { id: "cancelled", assignmentDate: "2026-11-25", absentTeacherName: "ملغى", period: 1, status: "cancelled" },
    { id: "undated", absentTeacherName: "بلا تاريخ", period: 1, status: "completed" }
  ]);
  expect(calls.map(call => call.date)).toEqual(["2026-11-24", "2026-11-23"]);
  expect(calls.map(call => call.options.singlePage)).toEqual([true, true]);
  expect(calls[0].groups).toHaveLength(1);
  expect(calls[0].groups[0].absentName).toBe("محمد");
  expect(calls[0].groups[0].rows).toHaveLength(2);
  expect(printed).toEqual(["A4:2026-11-24", "A4:2026-11-23"]);
});

test("crowded A4 archive days split into readable sheets instead of shrinking text", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const estimateStart = source.indexOf("function reserveOfficialPrintRowHeightEstimate(");
  const pagesStart = source.indexOf("function reserveOfficialPrintPages(");
  const markupStart = source.indexOf("function reserveOfficialPrintMarkup(");
  const documentTitleStart = source.indexOf("function reservePrintDocumentTitle(");
  if (estimateStart < 0 || pagesStart < 0 || markupStart < 0 || documentTitleStart < 0) throw new Error("Missing official print functions");
  const estimate = source.slice(estimateStart, pagesStart);
  const pages = source.slice(pagesStart, markupStart);
  const markup = source.slice(markupStart, documentTitleStart);
  const period = extractFunction(source, "function formatReservePrintPeriod(");
  const build = new Function("esc", "formatReserveDateArabic", "RESERVE_OFFICIAL_ROWS_PER_PAGE", "RESERVE_OFFICIAL_SINGLE_PAGE_CONTENT_MM",
    period + "; function formatReservePrintFullDate(value){return String(value || \"\");}" +
    estimate + ";" + markup + ";" + pages + "; return reserveOfficialPrintPages;"
  )(value => String(value ?? ""), () => "التاريخ", 22, 176);
  const rows = Array.from({ length: 40 }, (_, index) => ({
    period: index % 8 + 1, className: "الصف " + (index + 1), substitute: "معلم " + (index + 1)
  }));
  const output = build([{ absentName: "معلم غائب", absenceReason: "مرضية", rows }], "2026-11-24", "", "", { singlePage: true });
  expect(output).toHaveLength(2);
  await page.setContent("<div id='pages'>" + output.join("") + "</div>");
  const sheets = page.locator(".tt-official-page");
  await expect(sheets).toHaveCount(2);
  await expect(sheets.nth(0).locator(".tt-official-table tbody tr")).toHaveCount(22);
  await expect(sheets.nth(1).locator(".tt-official-table tbody tr")).toHaveCount(18);
  await expect(sheets.nth(0).locator(".tt-official-subject")).toContainText("كشف توزيع");
  await expect(sheets.nth(1).locator(".tt-official-subject")).toContainText("تابع كشف توزيع الاحتياط");
  await expect(sheets.nth(0).locator(".tt-official-table")).toHaveAttribute("style", "font-size:9.2pt");
  const names = await page.locator(".tt-official-substitute").allTextContents();
  expect(names.slice().sort()).toEqual(rows.map(row => row.substitute).sort());
  expect(source).toContain(".tt-official-page{box-sizing:border-box;width:100%;height:281mm;max-height:281mm");
  expect(source).toContain(".tt-official-table.tt-official-single-page tbody td{height:auto!important;font-size:inherit!important");
});
test("crowded schoolwide reserve day uses real A4 print geometry and preserves every assignment", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const extractBetween = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error("Missing print source boundary: " + startMarker);
    return source.slice(start, end);
  };
  const estimate = extractBetween("function reserveOfficialPrintRowHeightEstimate(", "function reserveOfficialPrintPages(");
  const pages = extractBetween("function reserveOfficialPrintPages(", "function reserveOfficialPrintMarkup(");
  const markup = extractBetween("function reserveOfficialPrintMarkup(", "function reservePrintDocumentTitle(");
  const period = extractFunction(source, "function formatReservePrintPeriod(");
  const printDocumentTitle = extractBetween("function reservePrintDocumentTitle(", "function printOfficialReservePages(");
  const printFunction = extractBetween("function printOfficialReservePages(", "async function reservePrintActorSubject(");
  const build = new Function("esc", "formatReserveDateArabic", "RESERVE_OFFICIAL_ROWS_PER_PAGE", "RESERVE_OFFICIAL_SINGLE_PAGE_CONTENT_MM",
    period + "; function formatReservePrintFullDate(value){return String(value || \"\");}" +
    estimate + ";" + markup + ";" + pages + "; return reserveOfficialPrintPages;"
  )(value => String(value ?? ""), () => "التاريخ", 22, 176);
  const rows = Array.from({ length: 50 }, (_, index) => ({
    period: index % 8 + 1,
    className: "الصف الدراسي التجريبي رقم " + (index + 1) + " — شعبة طويلة",
    substitute: "محمد بن سالم الخروصي — معلم احتياط تجريبي رقم " + (index + 1)
  }));
  const output = build([{ absentName: "أحمد سعيد الهنائي — المعلم الغائب", absenceReason: "مرضية", rows }], "2026-11-24", "الثلاثاء", "", {
    singlePage: true, title: "توزيع الاحتياط", continuationTitle: "تابع كشف توزيع الاحتياط"
  });
  expect(output.length).toBeGreaterThan(1);
  await page.setContent("<main></main>");
  await page.evaluate(({ output, printDocumentTitle, printFunction }) => {
    window.print = () => {};
    const print = new Function("reservePrintDocumentTitle", printDocumentTitle + ";" + printFunction + "; return printOfficialReservePages;")(() => "توزيع الاحتياط");
    print(output, "", {});
  }, { output, printDocumentTitle, printFunction });
  await page.emulateMedia({ media: "print" });
  const sheets = page.locator(".tt-official-page");
  await expect(sheets).toHaveCount(output.length);
  const rowCounts = await sheets.evaluateAll(items => items.map(sheet => sheet.querySelectorAll(".tt-official-table tbody tr").length));
  expect(rowCounts.reduce((sum, count) => sum + count, 0)).toBe(50);
  const printedNames = await page.locator(".tt-official-table .tt-official-substitute").allTextContents();
  expect(printedNames).toEqual(rows.slice().sort((a, b) => a.period - b.period).map(row => row.substitute));
  await expect(sheets.nth(0).locator(".tt-official-subject")).toContainText("توزيع الاحتياط");
  for (const sheet of await sheets.all()) {
    await expect(sheet.locator(".tt-official-table thead")).toBeVisible();
    await expect(sheet.locator(".tt-official-footer")).toBeAttached();
    await expect(sheet.locator(".tt-official-meta")).toContainText("2026");
  }
  const geometry = await sheets.evaluateAll(items => items.map(sheet => {
    const pageRect = sheet.getBoundingClientRect();
    const tableRect = sheet.querySelector(".tt-official-table").getBoundingClientRect();
    const footerRect = sheet.querySelector(".tt-official-footer").getBoundingClientRect();
    return {
      overflow: sheet.scrollHeight - sheet.clientHeight,
      tableBottom: tableRect.bottom - pageRect.top,
      footerTop: footerRect.top - pageRect.top,
      footerBottom: footerRect.bottom - pageRect.top,
      pageHeight: pageRect.height
    };
  }));
  for (const metric of geometry) {
    expect(metric.overflow).toBeLessThanOrEqual(1);
    expect(metric.tableBottom).toBeLessThanOrEqual(metric.footerTop + 1);
    expect(metric.footerBottom).toBeLessThanOrEqual(metric.pageHeight + 1);
  }
  const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  expect(pdf.byteLength).toBeGreaterThan(1000);
});


test("long Arabic teacher and class names paginate before the A4 signature area", async ({ page }) => {
  const source = fs.readFileSync(path.join(process.cwd(), "reserve-workflow.js"), "utf8");
  const estimateStart = source.indexOf("function reserveOfficialPrintRowHeightEstimate(");
  const pagesStart = source.indexOf("function reserveOfficialPrintPages(");
  const markupStart = source.indexOf("function reserveOfficialPrintMarkup(");
  const documentTitleStart = source.indexOf("function reservePrintDocumentTitle(");
  if (estimateStart < 0 || pagesStart < 0 || markupStart < 0 || documentTitleStart < 0) throw new Error("Missing official print functions");
  const estimate = source.slice(estimateStart, pagesStart);
  const pages = source.slice(pagesStart, markupStart);
  const markup = source.slice(markupStart, documentTitleStart);
  const period = extractFunction(source, "function formatReservePrintPeriod(");
  const build = new Function("esc", "formatReserveDateArabic", "RESERVE_OFFICIAL_ROWS_PER_PAGE", "RESERVE_OFFICIAL_SINGLE_PAGE_CONTENT_MM",
    period + "; function formatReservePrintFullDate(value){return String(value || \"\");}" +
    estimate + ";" + markup + ";" + pages + "; return reserveOfficialPrintPages;"
  )(value => String(value ?? ""), () => "التاريخ", 22, 176);
  const rows = Array.from({ length: 22 }, (_, index) => ({
    period: index % 8 + 1,
    className: "الصف الثالث الأساسي الشعبة الأولى للعام الدراسي ٢٠٢٦",
    substitute: "محمد سعيد عبدالله الخروصي الهنائي معلم احتياط تجريبي " + (index + 1)
  }));
  const output = build([{ absentName: "أحمد سعيد عبدالله الهنائي", absenceReason: "إجازة مرضية", rows }],
    "2026-11-25", "الأربعاء", "", { singlePage: true, title: "توزيع الاحتياط" });
  expect(output).toHaveLength(3);
  await page.setContent(output.join(""));
  const sheets = page.locator(".tt-official-page");
  await expect(sheets.nth(0).locator("tbody tr")).toHaveCount(10);
  await expect(sheets.nth(1).locator("tbody tr")).toHaveCount(10);
  await expect(sheets.nth(2).locator("tbody tr")).toHaveCount(2);
  expect(await page.locator(".tt-official-substitute").count()).toBe(22);
  expect((await page.locator(".tt-official-substitute").allTextContents()).sort((a, b) => a.localeCompare(b, "ar"))).toEqual(
    rows.map(row => row.substitute).sort((a, b) => a.localeCompare(b, "ar"))
  );
  await expect(sheets.nth(1).locator(".tt-official-subject")).toContainText("تابع كشف توزيع الاحتياط");
});
