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


test("teacher permission editor saves the explicit portal flag through the original permission workflow", async ({ page }) => {
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    window.saveSystemDataToCloud = async () => true;
    window.renderTeachersList = () => {};
    window.showToast = () => {};
    window.canManageReportPermissions = () => false;
    db.teachers = [{ name: "QA Synthetic Teacher", permissions: { attendance: true, behavior: true } }];
    activeUser = { type: "teacher", name: "QA Synthetic Teacher", permissions: {} };
    window.openPermissionsModal(0);
  });

  const portalPermission = page.locator("#perm_p_canViewAdminRecords");
  await expect(portalPermission).toBeVisible();
  await expect(portalPermission).not.toBeChecked();
  await portalPermission.check();
  await page.locator('#teacherPermissionsModal button[onclick="saveTeacherPermissions()"]').click();
  await expect(page.locator("#teacherPermissionsModal")).toHaveClass(/hidden/);
  const saved = await page.evaluate(() => ({
    teacher: db.teachers[0].permissions.canViewAdminRecords,
    session: activeUser.permissions.canViewAdminRecords,
    attendance: db.teachers[0].permissions.attendance,
    behavior: db.teachers[0].permissions.behavior
  }));
  expect(saved).toEqual({ teacher: true, session: true, attendance: true, behavior: true });
});


test("class discipline ranking uses only the selected range and recorded attendance statuses", async ({ page }) => {
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    window.startDistronDashboardStages = () => {};
    window.isGeneralAdminUser = () => false;
    window.isAdminAuthorized = () => false;
    window.hasAdminPanelAccess = () => false;
    window.distronDashboardStagePending = () => false;
    window.canAccessAdminTab = key => key === "studstats";
    window.canAccessReport = () => false;
    window.canAccessAnyReport = () => false;
    window.renderAdminOverview = () => {};
    window.updateAdvancedAnalytics = () => {
      document.getElementById("analyticsStartDate").value = "2026-11-26";
      document.getElementById("analyticsEndDate").value = "2026-11-26";
    };
    db.attendance = {
      qa_class_a_period_1: {
        date: "2026-11-26", className: "10/1", period: 1,
        records: { "طالب أ": "present", "طالب ب": "present", "طالب ج": "present", "طالب د": "present" }
      },
      qa_class_b_period_1: {
        date: "2026-11-26", className: "10/2", period: 1,
        records: { "طالب هـ": "present", "طالب و": "absent", "طالب ز": "late", "طالب ح": "escape" }
      },
      qa_outside_range: {
        date: "2026-11-25", className: "10/3", period: 1,
        records: { "طالب ط": "present" }
      }
    };
    activeUser = {
      type: "teacher", name: "QA Synthetic Statistics User",
      permissions: { canViewAdminRecords: true, studstats: true }
    };
    window.renderAuthenticatedDashboardShell();
  });

  await page.locator("#adminPortalOpenButton").click();
  await page.locator('[data-admin-portal-open="stats"]').click();
  await expect(page.locator(".admin-portal-original-stats-button")).toBeVisible();
  const ranking = page.locator("#adminPortalClassDisciplineList");
  await expect(ranking).toContainText("10/1");
  await expect(ranking).toContainText("100%");
  await expect(ranking).toContainText("10/2");
  await expect(ranking).toContainText("25%");
  await expect(ranking).not.toContainText("10/3");
});


test("behavior ranking is shown only with behaviorstats permission and counts normalized multi-type records", async ({ page }) => {
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    window.startDistronDashboardStages = () => {};
    window.isGeneralAdminUser = () => false;
    window.isAdminAuthorized = () => false;
    window.hasAdminPanelAccess = () => false;
    window.distronDashboardStagePending = () => false;
    window.canAccessAdminTab = key => key === "studstats" || key === "behaviorstats";
    window.canAccessReport = () => false;
    window.canAccessAnyReport = () => false;
    window.renderAdminOverview = () => {};
    window.updateAdvancedAnalytics = () => {
      document.getElementById("analyticsStartDate").value = "2026-11-26";
      document.getElementById("analyticsEndDate").value = "2026-11-26";
    };
    db.behaviors = {
      "2026-11-26_10/1_p1": {
        date: "2026-11-26", className: "10/1",
        records: {
          "طالب متكرر": { types: ["talking", "chaos"] },
          "طالب آخر": { type: "eating" }
        }
      },
      "2026-11-26_10/1_p2": {
        date: "2026-11-26", className: "10/1",
        records: { "طالب متكرر": { types: ["talking", "sleeping"] } }
      },
      "2026-11-25_10/1_p3": {
        date: "2026-11-25", className: "10/1",
        records: { "طالب خارج الفترة": { type: "chaos" } }
      }
    };
    activeUser = {
      type: "teacher", name: "QA Synthetic Behavior Statistics User",
      permissions: { canViewAdminRecords: true, studstats: true, behaviorstats: true }
    };
    window.renderAuthenticatedDashboardShell();
  });

  await page.locator("#adminPortalOpenButton").click();
  await page.locator('[data-admin-portal-open="stats"]').click();
  const ranking = page.locator("#adminPortalBehaviorRankingList");
  await expect(ranking).toContainText("طالب متكرر");
  await expect(ranking).toContainText("4 مخالفة");
  await expect(ranking).toContainText("طالب آخر");
  await expect(ranking).not.toContainText("طالب خارج الفترة");
});

test("behavior names remain absent from the statistics portal without behaviorstats permission", async ({ page }) => {
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    window.startDistronDashboardStages = () => {};
    window.isGeneralAdminUser = () => false;
    window.isAdminAuthorized = () => false;
    window.hasAdminPanelAccess = () => false;
    window.distronDashboardStagePending = () => false;
    window.canAccessAdminTab = key => key === "studstats";
    window.canAccessReport = () => false;
    window.canAccessAnyReport = () => false;
    window.renderAdminOverview = () => {};
    window.updateAdvancedAnalytics = () => {
      document.getElementById("analyticsStartDate").value = "2026-11-26";
      document.getElementById("analyticsEndDate").value = "2026-11-26";
    };
    db.behaviors = {
      "2026-11-26_10/1_p1": {
        date: "2026-11-26", className: "10/1",
        records: { "اسم طالب سري": { type: "talking" } }
      }
    };
    activeUser = {
      type: "teacher", name: "QA Synthetic Attendance Statistics User",
      permissions: { canViewAdminRecords: true, studstats: true }
    };
    window.renderAuthenticatedDashboardShell();
  });

  await page.locator("#adminPortalOpenButton").click();
  await page.locator('[data-admin-portal-open="stats"]').click();
  await expect(page.locator("#adminPortalBehaviorRankingList")).toHaveCount(0);
  await expect(page.locator("#adminPortalStatsHost")).not.toContainText("اسم طالب سري");
});


test("portal-only permission does not grant report or statistics access and keeps legacy admin entry", async ({ page }) => {
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    window.startDistronDashboardStages = () => {};
    window.isGeneralAdminUser = () => false;
    window.isAdminAuthorized = () => false;
    window.hasAdminPanelAccess = () => true;
    window.distronDashboardStagePending = () => false;
    window.canAccessAdminTab = () => false;
    window.canAccessReport = () => false;
    window.canAccessAnyReport = () => false;
    activeUser = {
      type: "teacher", name: "QA Portal-Only User",
      permissions: { canViewAdminRecords: true }
    };
    window.renderAuthenticatedDashboardShell();
  });

  await expect(page.locator("#adminPortalBanner")).not.toHaveClass(/hidden/);
  await expect(page.locator("#adminPanelBtn")).not.toHaveClass(/hidden/);
  await page.locator("#adminPortalOpenButton").click();
  await page.locator('[data-admin-portal-open="reports"]').click();
  await expect(page.locator("#adminPortalModalBody")).toContainText("لا توجد صلاحيات تقارير");
  await page.locator("#adminPortalModalBack").click();
  await page.locator('[data-admin-portal-open="stats"]').click();
  await expect(page.locator("#adminPortalModalBody")).toContainText("لا تملك صلاحية الاطلاع على الإحصائيات");
});

test("morning assembly calm themes and report tab opens the original permission-gated report", async ({ page }) => {
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, route => route.abort());
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("https://cdnjs.cloudflare.com/**", route => route.abort());
  await page.route("https://cdn.tailwindcss.com/**", route => route.abort());
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    window.startDistronDashboardStages = () => {};
    window.isGeneralAdminUser = () => true;
    window.isAdminAuthorized = () => true;
    window.hasAdminPanelAccess = () => true;
    window.distronDashboardStagePending = () => false;
    window.canAccessAdminTab = () => true;
    window.canAccessReport = () => true;
    window.canAccessAnyReport = () => true;
    window.loadMorningAssemblyLatenessReport = async () => {};
    activeUser = {
      type: "admin",
      name: "QA Morning Assembly Theme User",
      permissions: { canViewAdminRecords: true, reportMorningAssemblyLateness: true }
    };
    window.renderAuthenticatedDashboardShell();
    document.getElementById("morningAssemblyLatenessView")?.classList.remove("hidden");
  });

  const view = page.locator("#morningAssemblyLatenessView");
  await expect(view).toBeAttached();
  const themes = view.locator(".ma-theme-switcher");
  await expect(themes).toBeAttached();
  await themes.locator('[data-ma-theme="dusk"]').click();
  await expect(view).toHaveClass(/ma-theme-dusk/);
  await themes.locator('[data-ma-theme="light"]').click();
  await expect(view).toHaveClass(/ma-theme-light/);

  const tabs = view.locator(".ma-section-tabs");
  await expect(tabs).toBeAttached();
  const quick = tabs.locator('[data-ma-tab="quick"]');
  const report = tabs.locator('[data-ma-tab="report"]');
  await expect(quick).toHaveAttribute("aria-selected", "true");

  const classSection = view.locator("#morningAssemblyClassesGrid").locator("xpath=ancestor::section[1]");
  const studentSection = view.locator("#morningAssemblySearch").locator("xpath=ancestor::section[1]");
  await expect(classSection).not.toHaveClass(/hidden/);
  await expect(studentSection).not.toHaveClass(/hidden/);

  await report.click();
  await expect(report).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#adminModal")).not.toHaveClass(/hidden/);
  await expect(page.locator("#sec-reports")).not.toHaveClass(/hidden/);
  await expect(page.locator("#morningAssemblyLatenessReportPanel")).not.toHaveClass(/hidden/);

  await page.evaluate(() => closeAdminModal());
  await quick.click();
  await expect(quick).toHaveAttribute("aria-selected", "true");
  await expect(classSection).not.toHaveClass(/hidden/);
  await expect(studentSection).not.toHaveClass(/hidden/);
});

