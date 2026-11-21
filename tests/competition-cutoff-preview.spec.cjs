const { test, expect } = require("@playwright/test");

const PREVIEW_URL = process.env.COMPETITION_PREVIEW_URL ||
  "https://fix-competition-weekly-auto.abu-dujana-school-preview.pages.dev/?review=student-affairs";

test("deployed isolated preview opens Student Affairs competition without school data traffic", async ({ page }) => {
  const supabaseRequests = [];
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url());
  });
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  const response = await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  expect(response, "Cloudflare preview should return a document").not.toBeNull();
  expect(response.status()).toBe(200);
  await expect(page.locator("#saCompetitionPanel")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#saCompetitionPanel")).toContainText("بطولة الانضباط المدرسية");
  await expect(page.locator("#saCompetitionStatus")).toContainText("لا يوجد معلمون مشاركون");
  expect(await page.locator("#uiReviewLauncher").count()).toBe(1);
  expect(supabaseRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("visible competition panel schedules one refresh at 13:56 and one retry at 14:06 Oman time", async ({ page }) => {
  await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.locator("#saCompetitionPanel")).toBeVisible({ timeout: 30000 });

  const result = await page.evaluate(() => {
    // Thursday 26 November 2026, 13:55 Asia/Muscat = 09:55 UTC.
    serverTimeOffset = 0;
    let fixedNow = Date.parse("2026-11-26T09:55:00.000Z");
    Date.now = () => fixedNow;
    const originalSetTimeout = window.setTimeout;
    const captured = [];
    window.setTimeout = (callback, delay, ...args) => {
      captured.push({ callback, delay: Number(delay) });
      return originalSetTimeout(() => {}, 60 * 60 * 1000);
    };

    try {
      saScheduleCompetitionCutoffRefresh();
      const first = captured.at(-1)?.delay;
      // At 14:00 Oman, schedule the one delayed retry for 14:06.
      fixedNow = Date.parse("2026-11-26T10:00:00.000Z");
      saScheduleCompetitionCutoffRefresh();
      const retry = captured.at(-1)?.delay;
      const timerCount = captured.length;
      return { first, retry, timerCount, panelVisible: !document.getElementById("saCompetitionPanel").classList.contains("hidden") };
    } finally {
      window.setTimeout = originalSetTimeout;
    }
  });

  expect(result.panelVisible).toBe(true);
  expect(result.first).toBe(60_000);
  expect(result.retry).toBe(6 * 60_000);
  expect(result.timerCount).toBe(2);
});

test("cutoff refresh is not scheduled for a hidden or unauthorized competition panel", async ({ page }) => {
  await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.locator("#saCompetitionPanel")).toBeVisible({ timeout: 30000 });
  const result = await page.evaluate(() => {
    const panel = document.getElementById("saCompetitionPanel");
    const oldTimer = window.setTimeout;
    let scheduled = 0;
    window.setTimeout = (...args) => { scheduled++; return oldTimer(() => {}, 60 * 60 * 1000); };
    try {
      panel.classList.add("hidden");
      saScheduleCompetitionCutoffRefresh();
      const hiddenCount = scheduled;
      panel.classList.remove("hidden");
      saSession.principal.type = "teacher";
      window.saCanViewCompetition = () => false;
      saScheduleCompetitionCutoffRefresh();
      return { hiddenCount, unauthorizedCount: scheduled };
    } finally {
      window.setTimeout = oldTimer;
    }
  });
  expect(result.hiddenCount).toBe(0);
  expect(result.unauthorizedCount).toBe(0);
});
