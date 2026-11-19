const { test, expect } = require("@playwright/test");

const previewUrl =
  process.env.PREVIEW_URL ||
  "https://fix-timetable-fallback-null.student-absence-system.pages.dev/?live-preview=1";

const DEV_HOST = "wawplttrpiinoukpjqqx.supabase.co";
const PROD_HOST = "ylsocrvwqibptuwfzbke.supabase.co";
const TABLES = [
  "classes",
  "students",
  "teachers",
  "attendance",
  "behaviors",
  "school_settings",
  "duty_reports",
];

test("isolated preview reduces full background reads and preserves manual refresh", async ({ page, request }) => {
  test.setTimeout(240_000);

  let previewReady = false;
  let lastPreviewStatus = "no response";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await request.get(previewUrl, { timeout: 10_000 });
      lastPreviewStatus = String(response.status());
      if (response.status() === 200) {
        previewReady = true;
        break;
      }
    } catch (error) {
      lastPreviewStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  expect(previewReady, `Preview did not become ready. Last result: ${lastPreviewStatus}`).toBe(true);

  const reads = new Map();
  const productionRequests = [];
  const writeRequests = [];
  const functionRequests = [];
  const pageErrors = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route(`https://${PROD_HOST}/**`, async (route) => {
    productionRequests.push({
      method: route.request().method(),
      url: route.request().url(),
    });
    await route.abort();
  });

  await page.route(`https://${DEV_HOST}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/" && method === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: { date: new Date().toUTCString() },
      });
      return;
    }

    if (url.pathname.startsWith("/rest/v1/")) {
      if (method === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,HEAD,OPTIONS",
            "access-control-allow-headers": "*",
            "access-control-max-age": "600",
          },
        });
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        writeRequests.push({ method, path: url.pathname });
        await route.fulfill({ status: 405, body: "Writes are disabled in preview tests." });
        return;
      }

      const table = url.pathname.split("/").filter(Boolean).pop();
      reads.set(table, (reads.get(table) || 0) + 1);
      const rows = table === "classes" ? [{ name: "QA-ONLY-CLASS" }] : [];

      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "content-range, content-location",
          "content-type": "application/json",
          "content-range": rows.length ? "0-0/1" : "*/0",
        },
        body: JSON.stringify(rows),
      });
      return;
    }

    if (url.pathname.startsWith("/functions/v1/")) {
      functionRequests.push({ method, path: url.pathname });
      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "content-type": "application/json",
        },
        body: "{}",
      });
      return;
    }

    if (url.pathname.startsWith("/auth/v1/")) {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "{}",
      });
      return;
    }

    await route.fulfill({ status: 200, body: "{}" });
  });

  const response = await page.goto(previewUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  expect(response, "Preview navigation must return an HTTP response").not.toBeNull();
  expect(response.status()).toBe(200);

  await page.waitForFunction(
    () =>
      typeof loadSystemDataFromCloud === "function" &&
      typeof refreshCloudDataSilently === "function" &&
      cloudDataLoadState === "ready",
    undefined,
    { timeout: 30_000 },
  );

  expect(await page.evaluate(() => IS_UI_REVIEW_PREVIEW)).toBe(false);

  for (const table of TABLES) {
    expect(reads.get(table) || 0, `Initial read for ${table}`).toBe(1);
  }

  await page.evaluate(() => {
    activeUser = {
      type: "admin",
      name: "Preview QA",
      permissions: { admin: true, teachers: true, users: true },
    };
  });

  // The full reconciliation timer is five minutes. No second full read should
  // occur during this 65-second observation window.
  await page.waitForTimeout(65_000);
  for (const table of TABLES) {
    expect(reads.get(table) || 0, `Background reads for ${table}`).toBe(1);
  }

  const manualRefreshSucceeded = await page.evaluate(() => refreshCloudDataSilently());
  expect(manualRefreshSucceeded).toBe(true);

  for (const table of TABLES) {
    await expect.poll(() => reads.get(table) || 0, { timeout: 15_000 }).toBe(2);
  }

  expect(productionRequests, "Preview must never contact production Supabase").toEqual([]);
  expect(writeRequests, "Preview test must not write to any database").toEqual([]);
  expect(functionRequests, "No authenticated Edge Function calls are expected in this read-only test").toEqual([]);
  expect(pageErrors, "The page must not throw uncaught JavaScript errors").toEqual([]);
});
