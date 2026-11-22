const { test, expect, chromium } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const host = "abu-dujana-school-preview.localhost";
const port = 4173;
const baseUrl = `http://${host}:${port}/admin-login-lab.html`;
let server;
let browser;
let page;
const productionRequests = [];
const browserErrors = [];

test.setTimeout(120000);

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) && file !== path.join(root, "index.html")) {
      res.writeHead(403).end("Forbidden"); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end("Not found"); return; }
      const ext = path.extname(file);
      const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json", ".webmanifest":"application/manifest+json", ".png":"image/png" };
      res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control":"no-store" });
      res.end(data);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox"
    ]
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  page = await context.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("request", request => {
    try {
      const url = new URL(request.url());
      if (url.hostname === "ylsocrvwqibptuwfzbke.supabase.co") {
        productionRequests.push({ method: request.method(), url: request.url() });
      }
    } catch (_) {}
  });
  await page.route("https://**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith(".supabase.co")) return route.abort();
    return route.continue();
  });
});

test.afterAll(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function prepareCase(caseKey, buttonName, expectedLabel) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  const app = page.frameLocator("#app");
  // The preview banner is the stable readiness signal; its sync-status text may be hidden by responsive UI.\n  await expect(app.locator("#uiReviewLauncher")).toBeVisible({ timeout: 45000 });
  // Start the preview asynchronously and let Playwright poll the log.
  // Awaiting window.run inside page.evaluate can hold the protocol call open
  // while the iframe performs its own async work.
  await page.evaluate(key => {
    window.run(key);
    return true;
  }, caseKey);
  await expect(page.locator("#log")).toContainText(expectedLabel, { timeout: 60000 });
  const log = await page.locator("#log").innerText();
  expect(log, `case failed: ${expectedLabel}\n${log}`).not.toContain("تعثر |");
  expect(log, `case threw an exception: ${expectedLabel}\n${log}`).not.toContain("خطأ في تشغيل الاختبار");
  return log;
}

test("admin post-login finalization completes without starting Student Affairs or production calls", async () => {
  const log = await prepareCase("dashboard", "1. اختبار إنهاء تسجيل دخول المدير", "طلبات شؤون الطلبة أثناء تسجيل الدخول الرئيسي");
  expect(log).toContain('"appStudentAffairsSessionCalls":0');
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("administrator control panel opens independently after login", async () => {
  const log = await prepareCase("dashboardPanel", "2. فتح لوحة التحكم بعد الدخول", "فتح لوحة التحكم");
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("Student Affairs obtains its secondary session only after the administrator opens it", async () => {
  const log = await prepareCase("studentAffairs", "2. محاكاة تحميل شؤون الطلبة للمدير", "فتح شؤون الطلبة لأول مرة");
  expect(log).toContain("تهيئة منافسات وإشراف شؤون الطلبة");
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("reserve, duty, morning assembly and timetable modules initialize in the admin preview", async () => {
  for (const [button, label] of [
    ["3. اختبار واجهة الاحتياط", "فتح واجهة الاحتياط"],
    ["4. اختبار واجهة المناوبة", "فتح واجهة المناوبة"],
    ["5. اختبار الطابور الصباحي", "فتح واجهة الطابور وعرض الصفوف"],
    ["6. اختبار صلاحية الجدول", "فحص تهيئة صلاحية الجدول"]
  ]) {
    await prepareCase(({ "3. اختبار واجهة الاحتياط":"reserve", "4. اختبار واجهة المناوبة":"duty", "5. اختبار الطابور الصباحي":"morning", "6. اختبار صلاحية الجدول":"timetable" })[button], button, label);
    expect(productionRequests).toEqual([]);
    expect(browserErrors).toEqual([]);
  }
});
