const { test, expect } = require("@playwright/test");

test("leadership portal visibility and daily-data gate do not grant permissions", async ({ page }) => {
  const supabaseRequests = [];
  page.on("request", request => {
    if (/\.supabase\.co\//i.test(request.url())) supabaseRequests.push(request.url());
  });
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());

  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#adminPortalBanner")).toBeAttached();

  await page.evaluate(() => {
    window.startDistronDashboardStages = () => {};
    window.isGeneralAdminUser = () => false;
    window.isAdminAuthorized = () => false;
    window.hasAdminPanelAccess = () => false;
    window.distronDashboardStagePending = () => false;
    window.canAccessAdminTab = () => false;
    window.canAccessReport = () => false;
    window.canAccessAnyReport = () => false;
    activeUser = { type: "teacher", name: "QA Synthetic Teacher", permissions: { canViewAdminRecords: true } };
    window.renderAuthenticatedDashboardShell();
  });

  await expect(page.locator("#adminPortalBanner")).not.toHaveClass(/hidden/);
  await page.locator("#adminPortalOpenButton").click();
  await expect(page.locator("#adminSectionView")).not.toHaveClass(/hidden/);
  await page.locator('[data-admin-portal-open="pulse"]').click();
  await expect(page.locator("#adminSubModal")).not.toHaveClass(/hidden/);
  await expect(page.locator("#adminPortalModalBody")).toContainText("لا تملك صلاحية لأي من مؤشرات اليوم المدرسي");
  const requestCountAfterDeniedPulse = supabaseRequests.length;

  await page.locator("#adminPortalModalClose").click();
  await page.evaluate(() => {
    activeUser = { type: "teacher", name: "QA Synthetic Teacher", permissions: {} };
    window.renderAuthenticatedDashboardShell();
  });
  await expect(page.locator("#adminPortalBanner")).toHaveClass(/hidden/);
  expect(supabaseRequests.length).toBe(requestCountAfterDeniedPulse);
});
