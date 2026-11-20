const { test, expect } = require("@playwright/test");

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
          series: [{ date: "2026-11-19", absent: 2, late: 1, escape: 0, outside: 0, eating: 1, talking: 0, tools: 0, chaos: 0, sleeping: 0, homework: 0, other: 0 }],
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
    document.getElementById("saSupervisionTo").value = "2026-11-20";
    await saLoadSupervisionTrend("team");
  });
  const call = traffic.functionCalls.find((item) => item.action === "supervision_trend");
  expect(call).toBeTruthy();
  expect(call.scope).toBe("team");
  expect(call.from).toBe("2026-11-18");
  expect(call.to).toBe("2026-11-20");
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

test("notice preview scans synthetic rows without issuing official notices", async ({ page }) => {
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
  await expect(page.locator("#saNoticePreviewPanel")).not.toHaveClass(/hidden/);
  await expect(page.locator("#saNoticePreviewSummary")).toContainText("عدد الطلاب المستحقين: 1");
  await expect(page.locator("#saNoticePreviewSummary")).toContainText("المخالفات الجديدة المحتسبة: 2");
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
