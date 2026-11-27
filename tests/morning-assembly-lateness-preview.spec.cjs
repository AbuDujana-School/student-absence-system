const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

const previewUrl = process.env.PREVIEW_URL;
const productionSupabase = "ylsocrvwqibptuwfzbke.supabase.co";

test("morning assembly lateness appears in isolated branch preview without production traffic", async ({ page, request }) => {
  expect(previewUrl, "PREVIEW_URL must be set explicitly by the workflow").toBeTruthy();
  const preview = new URL(previewUrl);
  expect(preview.protocol).toBe("https:");
  expect(preview.hostname.endsWith(".abu-dujana-school-preview.pages.dev")).toBe(true);
  expect(preview.hostname).not.toBe("abudujana-school.github.io");

  const response = await request.get(previewUrl, { timeout: 30_000 });
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('location.hostname.endsWith(".abu-dujana-school-preview.pages.dev")');
  expect(html).toContain('IS_CLOUDFLARE_BRANCH_PREVIEW ? "https://wawplttrpiinoukpjqqx.supabase.co"');
  expect(html).toContain('const SA_API_URL = IS_CLOUDFLARE_BRANCH_PREVIEW');
  expect(html).toContain('const TIMETABLE_API_URL = IS_CLOUDFLARE_BRANCH_PREVIEW');
  // Assert the current append-only recording flow, not the retired today/toggle API contract.
  expect(html).toContain('const SUPABASE_URL = IS_CLOUDFLARE_BRANCH_PREVIEW ? "https://wawplttrpiinoukpjqqx.supabase.co"');
  expect(html).toContain('id="morningAssemblyLatenessView"');
  expect(html).toContain('id="morningAssemblySearch"');
  expect(html).toContain("function callMorningAssemblyLatenessApi(body)");
  expect(html).toContain("'/functions/v1/morning-assembly-lateness'");
  expect(html).toContain("action:'record'");
  expect(html).toContain("recordMorningAssemblyLateness(className,studentName,button)");

  const productionRequests = [];
  const pageErrors = [];
  page.on("request", (req) => {
    try {
      if (new URL(req.url()).hostname === productionSupabase) {
        productionRequests.push({ method: req.method(), url: req.url() });
      }
    } catch (_) {}
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(page.locator("body")).toContainText("التأخر عن الطابور الصباحي", { timeout: 20_000 });
  await expect(page.locator("body")).toContainText("يتم الحفظ فور اختيار الطالب");
  await expect(page.locator("body")).toContainText("الأحد – الخميس");

  await page.screenshot({
    path: "test-results/morning-assembly-lateness-preview.png",
    fullPage: true,
    animations: "disabled",
  });

  expect(productionRequests, "Branch preview must never contact production Supabase").toEqual([]);
  expect(pageErrors, "Preview must not throw uncaught browser errors on initial load").toEqual([]);
});


test("vibrant glass themes are isolated to the morning assembly workspace", async ({ page }) => {
  const source = fs.readFileSync("index.html", "utf8");
  const style = source.match(/<style id="morning-assembly-vibrant-glass-theme">([\s\S]*?)<\/style>/);
  expect(style, "the queue-specific vivid theme stylesheet must exist").toBeTruthy();
  expect(style[1]).toContain("#morningAssemblyLatenessView.ma-dusk");
  expect(style[1]).toContain("#morningAssemblyLatenessDashboardCard");
  expect(style[1]).not.toContain("body>header");
  const runtime = source.match(/<script id="morning-assembly-calm-glass-ui-runtime">([\s\S]*?)<\/script>/);
  expect(runtime, "the queue theme runtime must exist").toBeTruthy();
  expect(runtime[1]).toContain("view.classList.toggle('ma-dusk',dusk)");
  expect(runtime[1]).not.toContain("document.body.classList.toggle('dark'");
  expect(runtime[1]).not.toContain("document.documentElement.classList.toggle('dark'");

  await page.setContent(
    '<style>' + style[1] + '</style>' +
    '<main id="morningAssemblyLatenessView" dir="rtl">' +
      '<section class="ma-hero"><h2>مدرسة أبو دجانة الأنصاري</h2><p>قسم التأخر عن الطابور الصباحي</p><button class="ma-theme-btn" aria-pressed="true">نور الصباح</button></section>' +
      '<nav class="ma-tabs"><button class="ma-tab" aria-selected="true">الرصد السريع</button><button class="ma-tab">التقرير</button></nav>' +
      '<section class="ma-glass-card"><h3>اختر الصف</h3><div id="morningAssemblyClassesGrid"><button>9 / 1</button><button>9 / 2</button><button>10 / 1</button><button>10 / 2</button></div></section>' +
      '<section class="ma-glass-card"><h3>تسجيل طالب</h3><div id="morningAssemblyStudentsList"><button>طالب تجريبي</button><button>طالب تجريبي آخر</button></div></section>' +
    '</main>'
  );
  const light = await page.evaluate(() => ({
    root: getComputedStyle(document.querySelector("#morningAssemblyLatenessView")).backgroundImage,
    hero: getComputedStyle(document.querySelector(".ma-hero")).backgroundImage,
    tile: getComputedStyle(document.querySelector("#morningAssemblyClassesGrid button:nth-child(2)")).backgroundImage,
    bodyDark: document.body.classList.contains("dark"),
    htmlDark: document.documentElement.classList.contains("dark")
  }));
  expect(light.root).toContain("radial-gradient");
  expect(light.hero).toContain("linear-gradient");
  expect(light.tile).toContain("linear-gradient");
  expect(light.bodyDark).toBe(false);
  expect(light.htmlDark).toBe(false);

  await page.locator("#morningAssemblyLatenessView").screenshot({
    path: "test-results/morning-assembly-vibrant-theme-morning.png",
    animations: "disabled"
  });

  await page.locator("#morningAssemblyLatenessView").evaluate(el => el.classList.add("ma-dusk"));
  const dusk = await page.evaluate(() => ({
    root: getComputedStyle(document.querySelector("#morningAssemblyLatenessView")).backgroundImage,
    hero: getComputedStyle(document.querySelector(".ma-hero")).backgroundImage,
    bodyDark: document.body.classList.contains("dark"),
    htmlDark: document.documentElement.classList.contains("dark")
  }));
  expect(dusk.root).toContain("linear-gradient");
  expect(dusk.hero).toContain("linear-gradient");
  expect(dusk.bodyDark).toBe(false);
  expect(dusk.htmlDark).toBe(false);

  await page.locator("#morningAssemblyLatenessView").screenshot({
    path: "test-results/morning-assembly-vibrant-theme-fixture.png",
    animations: "disabled"
  });
});
