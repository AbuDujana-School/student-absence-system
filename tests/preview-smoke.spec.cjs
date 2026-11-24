const { test, expect } = require("@playwright/test");

const previewUrl =
  process.env.PREVIEW_URL ||
  "https://refactor-reserve-ui-phase2.student-absence-system.pages.dev/";

test("PR branch preview serves the actual school app without touching production", async ({ page, request }) => {
  test.setTimeout(180_000);
  let ready = false;
  let lastStatus = "no response";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await request.get(previewUrl, { timeout: 10_000 });
      lastStatus = String(response.status());
      if (response.status() === 200) { ready = true; break; }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  expect(ready, `PR preview did not become ready. Last result: ${lastStatus}`).toBe(true);

  const errors = [];
  const productionRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => {
    if (/^https:\/\/ylsocrvwqibptuwfzbke\.supabase\.co(?:\/|$)/i.test(req.url())) {
      productionRequests.push({ method: req.method(), url: req.url() });
    }
  });
  const response = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toBeVisible();
  await page.waitForTimeout(4_000);
  const body = (await page.locator("body").innerText()).trim();
  expect(body.length, "The school application must render non-empty content").toBeGreaterThan(100);
  expect(await page.title(), "The preview must return an HTML document title").not.toBe("");
  await page.screenshot({ path: "test-results/reserve-pr-preview.png", fullPage: true, animations: "disabled" });
  expect(productionRequests, "The PR preview must not call the production Supabase project").toEqual([]);
  expect(errors, "The PR preview must not throw uncaught page errors on initial load").toEqual([]);
  console.log(`Preview: ${previewUrl}; rendered characters: ${body.length}; page errors: ${JSON.stringify(errors)}`);
});
