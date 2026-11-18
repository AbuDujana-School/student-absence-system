const { test, expect } = require("@playwright/test");

const previewUrl =
  process.env.PREVIEW_URL ||
  "https://fix-timetable-fallback-null.student-absence-system.pages.dev/";

test("Cloudflare branch preview serves the school application", async ({ page, request }) => {
  test.setTimeout(240_000);

  // Cloudflare Pages may still be publishing the commit when this job starts.
  let ready = false;
  let lastStatus = "no response";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await request.get(previewUrl, { timeout: 10_000 });
      lastStatus = String(response.status());
      if (response.status() === 200) {
        ready = true;
        break;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  expect(ready, `Preview did not become ready. Last result: ${lastStatus}`).toBe(true);

  const uncaughtErrors = [];
  page.on("pageerror", (error) => uncaughtErrors.push(error.message));

  const response = await page.goto(previewUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  expect(response, "Navigation should return an HTTP response").not.toBeNull();
  expect(response.status()).toBe(200);

  await expect(page.locator("body")).toBeVisible();
  await page.waitForTimeout(5_000);

  const bodyText = (await page.locator("body").innerText()).trim();
  expect(bodyText.length, "Application must not render a blank page").toBeGreaterThan(30);

  await page.screenshot({
    path: "test-results/preview-home.png",
    fullPage: true,
    animations: "disabled",
  });

  console.log(`Preview URL: ${previewUrl}`);
  console.log(`Rendered body characters: ${bodyText.length}`);
  console.log(`Uncaught page errors: ${JSON.stringify(uncaughtErrors)}`);

  expect(
    uncaughtErrors,
    "The application should not throw uncaught JavaScript errors during initial load",
  ).toEqual([]);
});
