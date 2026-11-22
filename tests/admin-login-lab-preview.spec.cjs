const { test, expect } = require("@playwright/test");
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const host = "abu-dujana-school-preview.localhost";
const port = 4173;
const baseUrl = `http://${host}:${port}/?review=admin-login-lab`;

let server;
let browser;
let context;
let page;
const productionRequests = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://${host}:${port}`).pathname;
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(file);
      const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ serviceWorkers: "block" });
  page = await context.newPage();
  page.on("request", request => {
    if (request.url().includes(".supabase.co")) productionRequests.push(request.url());
  });
  await page.route("https://**/*", route => {
    if (new URL(route.request().url()).hostname.endsWith(".supabase.co")) return route.abort();
    return route.continue();
  });
});

test.afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openApp() {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.locator("#uiReviewLauncher")).toHaveCount(1);
}

test("administrator shell is shown without waiting for optional post-login checks", async () => {
  await openApp();
  const result = await page.evaluate(async () => {
    activeUser = { type: "admin", name: "مدير النظام العام", permissions: { admin: true } };
    appAuthSession = { token: "mock-app-session" };
    localOnlySession = true;
    cloudDataLoadState = "ready";
    refreshDutyDashboardCard = () => {};
    refreshSubstitutionDashboardCard = () => {};
    renderDutyTodayRecords = () => {};
    refreshReportPanelsVisibility = () => {};
    window.refreshCombinedReportTabs = () => {};
    await finalizeLoginState();
    return {
      loginHidden: document.getElementById("loginView").classList.contains("hidden"),
      dashboardVisible: !document.getElementById("dashboardSelectionView").classList.contains("hidden")
    };
  });
  expect(result).toEqual({ loginHidden: true, dashboardVisible: true });
  expect(productionRequests).toEqual([]);
});

test("Student Affairs creates its secondary session only when its module is opened", async () => {
  await openApp();
  const result = await page.evaluate(async () => {
    activeUser = { type: "admin", name: "مدير النظام العام", permissions: { admin: true } };
    appAuthSession = { token: "mock-app-session" };
    localOnlySession = false;
    saSession = null;
    const actions = [];
    const mockAuth = async body => {
      actions.push(body.action);
      if (body.action === "app_student_affairs_session") {
        return {
          token: "mock-student-affairs-session",
          principal: { name: "مدير النظام العام", type: "admin" },
          permissions: { can_read_attendance: true, can_read_behavior: true }
        };
      }
      return {};
    };
    window.appAuthRequest = mockAuth;
    try { appAuthRequest = mockAuth; } catch (_) {}
    window.saLoadAdmin = async () => {};
    try { saLoadAdmin = async () => {}; } catch (_) {}
    window.saSetDomain = () => {};
    try { saSetDomain = () => {}; } catch (_) {}
    window.saSetupCompetitionPanel = () => {};
    try { saSetupCompetitionPanel = () => {}; } catch (_) {}
    window.saSetupSupervisionPanel = () => {};
    try { saSetupSupervisionPanel = () => {}; } catch (_) {}
    window.refreshCombinedReportTabs = () => {};
    await openStudentAffairsView(true);
    return {
      actions,
      sessionToken: saSession?.token || null,
      contentVisible: !document.getElementById("saContent").classList.contains("hidden")
    };
  });
  expect(result.actions).toEqual(["app_student_affairs_session"]);
  expect(result.sessionToken).toBe("mock-student-affairs-session");
  expect(result.contentVisible).toBe(true);
  expect(productionRequests).toEqual([]);
});
