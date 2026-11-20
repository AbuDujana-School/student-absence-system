const { test, expect } = require("@playwright/test");

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
