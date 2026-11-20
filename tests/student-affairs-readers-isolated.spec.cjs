const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const SUPABASE_HOST = "ylsocrvwqibptuwfzbke.supabase.co";
const BASE_URL = process.env.APP_PREVIEW_URL || "http://127.0.0.1:4173/index.html";

async function openIsolatedApp(page) {
  const traffic = { functionCalls: [], blockedWrites: [], unexpected: [], pageErrors: [] };
  page.on("pageerror", (error) => traffic.pageErrors.push(error.stack || error.message));

  await page.route(/^https:\/\/[^/]+\.supabase\.co\/.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
      "access-control-expose-headers": "content-range,content-location",
      "content-type": "application/json",
    };
    if (url.hostname !== SUPABASE_HOST) {
      traffic.unexpected.push({ method, url: request.url() });
      await route.abort();
      return;
    }
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    // Supabase JS performs a lightweight HEAD health check against the project root.
    if (url.pathname === "/" && (method === "HEAD" || method === "GET")) {
      await route.fulfill({ status: 200, headers, body: "" });
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        traffic.blockedWrites.push({ method, path: url.pathname });
        await route.fulfill({ status: 405, headers, body: JSON.stringify({ error: "Writes disabled in isolated browser tests" }) });
        return;
      }
      await route.fulfill({ status: 200, headers: { ...headers, "content-range": "*/0" }, body: method === "HEAD" ? "" : "[]" });
      return;
    }
    if (url.pathname.startsWith("/auth/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        traffic.blockedWrites.push({ method, path: url.pathname });
        await route.fulfill({ status: 405, headers, body: JSON.stringify({ error: "Auth writes disabled in isolated browser tests" }) });
        return;
      }
      await route.fulfill({ status: 200, headers, body: "{}" });
      return;
    }
    if (url.pathname === "/functions/v1/student-affairs" && method === "POST") {
      let body = {};
      try { body = JSON.parse(request.postData() || "{}"); } catch (_) {}
      traffic.functionCalls.push(body);
      if (body.action === "supervision_trend") {
        await route.fulfill({ status: 200, headers, body: JSON.stringify({
          class_count: 1,
          series: [
            { date: "2026-11-18", absent: 1, late: 0, escape: 0, outside: 0, eating: 0, talking: 1, tools: 0, chaos: 0, sleeping: 0, homework: 0, other: 0 },
            { date: "2026-11-19", absent: 2, late: 1, escape: 0, outside: 0, eating: 1, talking: 0, tools: 0, chaos: 1, sleeping: 0, homework: 0, other: 0 },
            { date: "2026-11-20", absent: 9, late: 9, escape: 0, outside: 0, eating: 0, talking: 9, tools: 0, chaos: 9, sleeping: 0, homework: 0, other: 0 },
            { date: "2026-11-21", absent: 8, late: 8, escape: 0, outside: 0, eating: 0, talking: 8, tools: 0, chaos: 8, sleeping: 0, homework: 0, other: 0 },
            { date: "2026-11-22", absent: 3, late: 1, escape: 0, outside: 0, eating: 0, talking: 2, tools: 0, chaos: 1, sleeping: 0, homework: 0, other: 0 },
          ],
        }) });
        return;
      }
      if (body.action === "reports" && body.report_mode === "view") {
        await route.fulfill({ status: 200, headers, body: JSON.stringify({ attendance: [], behaviors: [] }) });
        return;
      }
      if (body.action === "reports" && body.report_mode === "analytics") {
        await route.fulfill({ status: 200, headers, body: JSON.stringify({
          analytics: { QA_ONLY_CLASS: { selected_attendance_records: 3, behavior_sessions: 2 } },
        }) });
        return;
      }
      if (body.action === "reports" && body.report_mode === "notice_scan") {
        const className = (body.attendance_classes || body.behavior_classes || [])[0] || "QA_ONLY_CLASS";
        await route.fulfill({ status: 200, headers, body: JSON.stringify({
          attendance: [
            { class_name: className, date_str: body.from, period: 1, records: { QA_ONLY_STUDENT: "absent" } },
            { class_name: className, date_str: body.to, period: 1, records: { QA_ONLY_STUDENT: "absent" } },
          ],
          behaviors: [],
        }) });
        return;
      }
      if (body.action === "reports" && body.report_mode === "notice_history") {
        await route.fulfill({ status: 200, headers, body: JSON.stringify({ notices: [] }) });
        return;
      }
      if (body.action === "reports" && body.report_mode === "notice_issue_commit") {
        traffic.blockedWrites.push({ method, action: body.report_mode });
        await route.fulfill({ status: 405, headers, body: JSON.stringify({ error: "Official issue commits are forbidden in QA" }) });
        return;
      }
      traffic.unexpected.push({ method, path: url.pathname, body });
      await route.fulfill({ status: 400, headers, body: JSON.stringify({ error: "Unexpected QA action" }) });
      return;
    }
    traffic.unexpected.push({ method, url: request.url() });
    await route.fulfill({ status: 404, headers, body: "{}" });
  });

  const response = await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  expect(response, "Local app must return an HTTP response").not.toBeNull();
  expect(response.status()).toBe(200);
  await page.waitForFunction(
    () => typeof saLoadAnalytics === "function" &&
      typeof saLoadSupervisionTrend === "function" &&
      typeof saGenerateAutomaticNotices === "function",
    undefined,
    { timeout: 30_000 },
  );
  return traffic;
}

test("analytics screen renders only the selected synthetic class", async ({ page }) => {
  const traffic = await openIsolatedApp(page);
  const analyticsDebug = await page.evaluate(async () => {
    saReportPermissions = {
      role: "admin", can_read_attendance: true, can_view_analytics: true,
      allowed_attendance_classes: ["QA_ONLY_CLASS"],
      attendance_statuses: ["absent", "late", "escape", "outside"],
    };
    saDomain = "attendance";
    // Populate only the permitted QA class. Avoid saSetDomain here because it
    // intentionally auto-loads the ordinary report as part of real navigation.
    document.getElementById("saReportClassesContainer").innerHTML =
      '<input type="checkbox" class="sa-report-class-chk" value="QA_ONLY_CLASS" checked>';
    saPopulateStatusFilter();
    const allStatuses = document.querySelector('.sa-status-filter-chk[value="all"]');
    if (allStatuses) allStatuses.checked = true;
    document.getElementById("saFrom").value = "2026-11-18";
    document.getElementById("saTo").value = "2026-11-20";
    await saLoadAnalytics();
    return {
      domain: saDomain,
      permission: saReportPermissions?.can_view_analytics,
      allowed: saGetAllowedReportClasses("attendance"),
      selected: saGetSelectedReportClasses("attendance"),
      resultText: document.getElementById("saResults")?.innerText || "",
      statusSelection: saGetSelectedStatusFilters(),
    };
  });
  const call = traffic.functionCalls.find((item) => item.report_mode === "analytics");
  expect(call, "Analytics request missing; browser state: " + JSON.stringify(analyticsDebug) + "; observed calls: " + JSON.stringify(traffic.functionCalls)).toBeTruthy();
  expect(call.attendance_classes).toEqual(["QA_ONLY_CLASS"]);
  expect(call.behavior_classes).toEqual([]);
  expect(call.from).toBe("2026-11-18");
  expect(call.to).toBe("2026-11-20");
  await expect(page.locator("#saResults")).toContainText("QA_ONLY_CLASS");
  await expect(page.locator("#saResults")).toContainText("3");
  expect(traffic.blockedWrites).toEqual([]);
  expect(traffic.unexpected).toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
});

test("supervision screen renders the synthetic team trend", async ({ page }) => {
  const traffic = await openIsolatedApp(page);
  await page.evaluate(async () => {
    const permissions = {
      role: "team_leader", can_read_attendance: true, can_read_behavior: true,
      can_view_analytics: true, allowed_attendance_classes: ["QA_ONLY_CLASS"],
      allowed_behavior_classes: ["QA_ONLY_CLASS"],
      attendance_statuses: ["absent", "late", "escape", "outside"],
    };
    saBaseReportPermissions = permissions;
    saReportPermissions = { ...permissions };
    saDomain = "attendance";
    saPopulateReportClasses();
    document.getElementById("saSupervisionPanel").classList.remove("hidden");
    document.getElementById("saSupervisionFrom").value = "2026-11-18";
    document.getElementById("saSupervisionTo").value = "2026-11-22";
    window.Chart = class { constructor(_ctx, config) { this.data = config.data; this.options = config.options; } destroy() {} };
    await saLoadSupervisionTrend("team");
  });
  const call = traffic.functionCalls.find((item) => item.action === "supervision_trend");
  expect(call).toBeTruthy();
  expect(call.scope).toBe("team");
  expect(call.from).toBe("2026-11-18");
  expect(call.to).toBe("2026-11-22");
  const chart = await page.evaluate(() => ({
    dates: saSupervisionTrendChart?.data?.labels || [],
    talking: saSupervisionBehaviorChart?.data?.datasets?.find(item => item.label === "الكلام")?.borderColor,
    chaos: saSupervisionBehaviorChart?.data?.datasets?.find(item => item.label === "الفوضى")?.borderColor,
  }));
  expect(chart.dates).toEqual(["2026-11-18", "2026-11-19", "2026-11-22"]);
  expect(chart.talking).toBe("#2563eb");
  expect(chart.chaos).toBe("#7c3aed");
  await expect(page.locator("#saSupervisionStatus")).toContainText("عدد الصفوف المشمولة: 1");
  expect(traffic.blockedWrites).toEqual([]);
  expect(traffic.unexpected).toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
});

test("notice class checklist supports multi-select and retains team target selector", async ({ page }) => {
  const traffic = await openIsolatedApp(page);
  await page.evaluate(() => {
    saReportPermissions = {
      role: "team_leader", can_read_attendance: true, can_read_behavior: true,
      can_print_attendance: true, can_print_behavior: true, can_print_combined: true,
      allowed_attendance_classes: ["QA_OWN_CLASS"], allowed_behavior_classes: ["QA_OWN_CLASS"],
      attendance_statuses: ["absent", "late", "escape", "outside"],
      team_members: [{
        name: "QA_TEAM_TEACHER",
        allowed_attendance_classes: ["QA_TEAM_CLASS"],
        allowed_behavior_classes: ["QA_TEAM_CLASS"],
        attendance_statuses: ["absent", "late", "escape", "outside"],
      }],
    };
    saSession = { token: "a".repeat(64) };
    saOpenNoticeModal();
  });

  await expect(page.locator("#saNoticeTargetSelect")).toBeVisible();
  await expect(page.locator("#saNoticeTargetSelect option")).toHaveCount(2);
  await expect(page.locator('#saNoticeClassesGrid input[data-sa-notice-class="QA_OWN_CLASS"]')).toBeChecked();
  await page.locator("#saNoticeTargetSelect").selectOption("QA_TEAM_TEACHER");
  await expect(page.locator('#saNoticeClassesGrid input[data-sa-notice-class="QA_TEAM_CLASS"]')).toBeChecked();
  await expect(page.locator('#saNoticeClassesGrid input[data-sa-notice-class="QA_OWN_CLASS"]')).toHaveCount(0);

  await page.locator("#saNoticeTargetSelect").selectOption("__self__");
  await page.locator('#saNoticeClassesGrid input[data-sa-notice-class="QA_OWN_CLASS"]').uncheck();
  await page.evaluate(() => {
    saReportPermissions.allowed_attendance_classes = ["QA_OWN_CLASS", "QA_SECOND_CLASS"];
    saReportPermissions.allowed_behavior_classes = [];
    saNoticeTargetChanged();
    document.querySelectorAll("#saNoticeClassesGrid input[data-sa-notice-class]").forEach(input => { input.checked = false; });
    document.querySelector('#saNoticeClassesGrid input[data-sa-notice-class="QA_SECOND_CLASS"]').checked = true;
  });
  await expect(page.locator("#saNoticeClassesGrid input[data-sa-notice-class]:checked")).toHaveCount(1);
  const selected = await page.evaluate(() => saNoticeSelectedClasses());
  expect(selected).toEqual(["QA_SECOND_CLASS"]);
  expect(traffic.functionCalls.some((item) => item.report_mode === "notice_issue_commit")).toBe(false);
  expect(traffic.blockedWrites).toEqual([]);
  expect(traffic.unexpected).toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
});

test("notice PDF generation scans synthetic rows without showing an on-screen preview", async ({ page }) => {
  const traffic = await openIsolatedApp(page);
  const dates = await page.evaluate(() => {
    const today = getOmanLocalDate();
    const parts = today.split("-").map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] - 2));
    const from = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("-");
    return { today, from };
  });
  await page.evaluate(async ({ today, from }) => {
    saReportPermissions = {
      role: "admin", can_read_attendance: true, can_read_behavior: false,
      can_print_attendance: true, can_print_behavior: false, can_print_combined: true,
      allowed_attendance_classes: ["QA_ONLY_CLASS"], allowed_behavior_classes: [],
      attendance_statuses: ["absent", "late", "escape", "outside"],
    };
    saSession = { token: "a".repeat(64) };
    db.students = { QA_ONLY_CLASS: ["QA_ONLY_STUDENT"] };
    saOpenNoticeModal();
    document.getElementById("saNoticeThreshold").value = "2";
    document.getElementById("saNoticeFromDate").value = from;
    document.getElementById("saNoticeToDate").value = today;
    document.getElementById("saNoticeDate").value = today;
    document.getElementById("saNoticeIssueMode").value = "test";
    const absent = document.querySelector('#saNoticeTypeFilters input[data-sa-notice-type="absent"]');
    if (!absent) throw new Error("Absent filter was not rendered for permitted synthetic scope");
    absent.checked = true;
    await saGenerateAutomaticNotices();
  }, dates);

  const scans = traffic.functionCalls.filter((item) => item.report_mode === "notice_scan");
  const history = traffic.functionCalls.filter((item) => item.report_mode === "notice_history");
  expect(scans).toHaveLength(1);
  expect(scans[0].attendance_classes).toEqual(["QA_ONLY_CLASS"]);
  expect(scans[0].behavior_classes).toEqual([]);
  expect(history).toHaveLength(1);
  expect(history[0].notice_classes).toEqual(["QA_ONLY_CLASS"]);
  await expect(page.locator("#saNoticePreviewPanel")).toHaveClass(/hidden/);
  await expect(page.locator("#saNoticePrintAction")).toBeVisible();
  await expect(page.locator("#saNoticePrintAction")).toBeEnabled();
  await expect(page.locator("#saNoticeStatus")).toContainText("اكتمل الفحص");
  const generated = await page.evaluate(() => ({
    count: saNoticeLastGenerated.length,
    student: saNoticeLastGenerated[0]?.name,
    className: saNoticeLastGenerated[0]?.className,
    issueNumber: saNoticeLastGenerated[0]?.issue_number,
    officialCommitted: saNoticeOfficialCommitted,
  }));
  expect(generated).toEqual({
    count: 1, student: "QA_ONLY_STUDENT", className: "QA_ONLY_CLASS",
    issueNumber: 1, officialCommitted: false,
  });
  expect(traffic.functionCalls.some((item) => item.report_mode === "notice_issue_commit")).toBe(false);
  expect(traffic.blockedWrites).toEqual([]);
  expect(traffic.unexpected).toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
});



test("notice PDF packs three short notices while keeping the screen preview hidden", async ({ page }) => {
  await openIsolatedApp(page);
  const result = await page.evaluate(async () => {
    const panel = document.getElementById("saNoticePreviewPanel");
    panel.classList.add("hidden");
    const students = Array.from({ length: 3 }, (_, i) => ({
      className: "QA_ONLY_CLASS",
      name: "QA_SHORT_NOTICE_" + (i + 1),
      issue_number: i + 1,
      events: [{ type: "absent", date: "2026/11/20", period: "1", note: "" }],
      groups: new Map([["absent", {
        type: "absent", note: "",
        events: [{ date: "2026/11/20", period: "1" }],
      }]]),
    }));
    saNoticeRenderPreview(students, 3);
    const ready = await saNoticePreviewReady;
    const root = document.getElementById("saNoticePrintRoot");
    const pages = [...root.querySelectorAll(":scope > .sa-notice-page")];
    return {
      ready,
      previewVisible: !panel.classList.contains("hidden"),
      pageCount: pages.length,
      cardCounts: pages.map(item => item.querySelectorAll(".sa-notice-card").length),
      capacities: pages.map(item => Number(item.dataset.capacity)),
      failedCards: root.querySelectorAll('.sa-notice-card[data-fit-failed="true"]').length,
      cardDisplay: getComputedStyle(pages[0]?.querySelector(".sa-notice-card")).display,
      cardFlexGrow: getComputedStyle(pages[0]?.querySelector(".sa-notice-card")).flexGrow,
      pageHeight: getComputedStyle(pages[0]).height,
    };
  });
  expect(result.ready).toBe(true);
  expect(result.previewVisible).toBe(false);
  expect(result.pageCount).toBe(1);
  expect(result.cardCounts).toEqual([3]);
  expect(result.cardDisplay).toBe("block");
  expect(result.cardFlexGrow).toBe("0");
  expect(result.pageHeight).not.toBe("287mm");
  expect(result.capacities).toEqual([3]);
  expect(result.failedCards).toBe(0);
});



test("notice PDF uses natural-height A4 packing without flex expansion", async ({ page }) => {
  await openIsolatedApp(page);
  const result = await page.evaluate(() => {
    const style = document.getElementById("sa-notice-natural-height-layout");
    const css = style?.textContent || "";
    const source = saNoticeRenderPreview.toString();
    return {
      stylePresent: Boolean(style),
      previewWidth: /width:200mm!important/.test(css),
      naturalPageHeight: /height:auto!important;min-height:0!important;max-height:none!important/.test(css),
      printMargins: /@page\s*\{size:A4 portrait;margin:5mm\}/.test(css),
      printWidth: /width:100%!important;min-width:0!important;max-width:none!important/.test(css),
      avoidPageBreak: /break-inside:avoid!important;page-break-inside:avoid!important/.test(css),
      naturalCard: /flex:none!important;flex-grow:0!important;flex-shrink:0!important/.test(css),
      readableFont: /font-size:11pt!important;line-height:1\.38!important/.test(css),
      naturalMeasurement: /getBoundingClientRect\(\)/.test(source)&&/Math\.max\(rect\.height,item\.card\.scrollHeight\)/.test(source),
      cappedAtThree: /Math\.min\(3,Number\(perPage\)\|\|3\)/.test(source),
    };
  });
  expect(result).toEqual({
    stylePresent: true,
    previewWidth: true,
    naturalPageHeight: true,
    printMargins: true,
    printWidth: true,
    avoidPageBreak: true,
    naturalCard: true,
    readableFont: true,
    naturalMeasurement: true,
    cappedAtThree: true,
  });
});

test("notice PDF keeps short violation lines grouped without vertical space distribution", async ({ page }) => {
  await openIsolatedApp(page);
  const result = await page.evaluate(async () => {
    const panel = document.getElementById("saNoticePreviewPanel");
    panel.classList.remove("hidden");
    const students = Array.from({ length: 3 }, (_, i) => ({
      className: "QA_ONLY_CLASS",
      name: "QA_COMPACT_NOTICE_" + (i + 1),
      issue_number: i + 1,
      events: [{ type: "absent", date: "2026/11/20", period: "1", note: "" }],
      groups: new Map([["absent", {
        type: "absent", note: "",
        events: [{ date: "2026/11/20", period: "1" }],
      }]]),
    }));
    saNoticeRenderPreview(students, 3);
    const ready = await saNoticePreviewReady;
    const root = document.getElementById("saNoticePrintRoot");
    const page = root.querySelector(".sa-notice-page");
    const card = page?.querySelector(".sa-notice-card");
    const list = card?.querySelector(".notice-items");
    const inner = card?.firstElementChild;
    const style = element => element ? getComputedStyle(element) : null;
    return {
      ready,
      pageCount: root.querySelectorAll(":scope > .sa-notice-page").length,
      cardCount: page?.querySelectorAll(".sa-notice-card").length || 0,
      cardJustify: style(card)?.justifyContent,
      innerDisplay: style(inner)?.display,
      listDisplay: style(list)?.display,
      listJustify: style(list)?.justifyContent,
      failedCards: root.querySelectorAll('.sa-notice-card[data-fit-failed="true"]').length,
    };
  });
  expect(result.ready).toBe(true);
  expect(result.pageCount).toBe(1);
  expect(result.cardCount).toBe(3);
  expect(result.cardJustify).toBe("flow-start");
  expect(result.innerDisplay).toBe("block");
  expect(result.listDisplay).toBe("block");
  expect(result.listJustify).toBe("flow-start");
  expect(result.failedCards).toBe(0);
});

test("notice PDF keeps each complete notice on one page with readable minimum font", async ({ page }) => {
  await openIsolatedApp(page);
  const result = await page.evaluate(async () => {
    const student = {
      className: "QA_ONLY_CLASS",
      name: "QA_NOTICE_STUDENT",
      issue_number: 1,
      events: [{ type: "absent", date: "2026/11/20", period: "1", note: "" }],
      groups: new Map([["absent", {
        type: "absent", note: "",
        events: Array.from({ length: 8 }, (_, i) => ({ date: "2026/11/" + String(20 - i).padStart(2, "0"), period: String(i + 1) })),
      }]]),
    };
    saNoticeRenderPreview([student], 3);
    const ready = await saNoticePreviewReady;
    const root = document.getElementById("saNoticePrintRoot");
    const page = root.querySelector(".sa-notice-page");
    const card = root.querySelector(".sa-notice-card");
    return {
      ready,
      pageCount: root.querySelectorAll(":scope > .sa-notice-page").length,
      cardCount: page?.querySelectorAll(".sa-notice-card").length || 0,
      hasHeading: !!card?.querySelector(".notice-title"),
      hasIntro: !!card?.querySelector(".notice-intro"),
      hasAllEvents: card?.querySelectorAll(".notice-items li").length === 1,
      hasConclusion: !!card?.querySelector(".notice-conclusion"),
      hasSignatures: !!card?.querySelector(".notice-signatures"),
      failed: card?.dataset.fitFailed === "true",
      fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
    };
  });
  expect(result.ready).toBe(true);
  expect(result.pageCount).toBe(1);
  expect(result.cardCount).toBe(1);
  expect(result.hasHeading).toBe(true);
  expect(result.hasIntro).toBe(true);
  expect(result.hasAllEvents).toBe(true);
  expect(result.hasConclusion).toBe(true);
  expect(result.hasSignatures).toBe(true);
  expect(result.failed).toBe(false);
  expect(result.fontSize).toBeGreaterThanOrEqual(14);
});


test("weekly discipline championship has no manual refresh button", async ({ page }) => {
  await openIsolatedApp(page);
  await expect(page.locator('#saCompetitionPanel button[onclick="saLoadCompetition()"]')).toHaveCount(0);
  await expect(page.locator("#saCompetitionPanel")).toContainText("تُعتمد النتيجة تلقائياً كل يوم خميس الساعة 1:50 ظهراً بتوقيت عُمان");
});

test("weekly discipline championship is scheduled once at 13:50 Oman time", () => {
  const migrationPath = path.join(process.cwd(), "supabase/migrations/20261121135000_student_affairs_competition_single_weekly_run.sql");
  const migration = fs.readFileSync(migrationPath, "utf8");
  expect(migration).toContain("'50 9 * * 4'");
  expect(migration).toContain("student-affairs-competition-finalize-weekly");
  expect(migration).toContain("student-affairs-competition-finalize-retry");
  expect(migration).toContain("09:50 UTC is 13:50 in Oman");
  expect(migration).not.toContain("*/5");
});

test("student affairs report prepares direct PDF output without rendering report rows", async ({ page }) => {
  await openIsolatedApp(page);
  const result = await page.evaluate(async () => {
    saReportPermissions = {
      role: "admin", can_read_attendance: true, can_print_attendance: true,
      attendance_statuses: ["absent", "late", "escape", "outside"],
      allowed_attendance_classes: ["QA_ONLY_CLASS"],
    };
    saDomain = "attendance";
    document.getElementById("saReportClassesContainer").innerHTML =
      '<input type="checkbox" class="sa-report-class-chk" value="QA_ONLY_CLASS" checked>';
    saPopulateStatusFilter();
    const all = document.querySelector('.sa-status-filter-chk[value="all"]');
    if (all) all.checked = true;
    document.getElementById("saFrom").value = "2026-11-18";
    document.getElementById("saTo").value = "2026-11-20";
    const ok = await saLoadReport();
    return {
      ok,
      summaryHidden: document.getElementById("saSummary").classList.contains("hidden"),
      resultsHidden: document.getElementById("saResults").classList.contains("hidden"),
      status: document.getElementById("saReportPdfStatus").innerText,
      viewButtonVisible: !document.getElementById("saViewButton").classList.contains("hidden"),
      reportCalls: window.__unused || 0,
    };
  });
  expect(result.ok).toBe(true);
  expect(result.summaryHidden).toBe(true);
  expect(result.resultsHidden).toBe(true);
  expect(result.status).toContain("دون معاينة");
  expect(result.viewButtonVisible).toBe(false);
});
