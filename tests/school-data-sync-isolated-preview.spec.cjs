const { test, expect } = require("@playwright/test");

const SUPABASE_HOST = "ylsocrvwqibptuwfzbke.supabase.co";
const TABLES = [
  "classes",
  "students",
  "teachers",
  "attendance",
  "behaviors",
  "school_settings",
  "duty_reports",
];

test("school sync projections and timetable access reads stay isolated and minimal", async ({ page }) => {
  test.setTimeout(120_000);

  const now = new Date().toISOString();
  const fixtures = {
    classes: [{ name: "QA_ONLY_CLASS" }],
    students: [{ class_name: "QA_ONLY_CLASS", student_name: "QA_ONLY_STUDENT" }],
    teachers: [{
      name: "QA_ONLY_TEACHER",
      role: "teacher",
      pin_hash: null,
      pin_salt: null,
      permissions: {},
      must_change_pin: false,
    }],
    attendance: [{
      record_key: "qa-attendance",
      class_name: "QA_ONLY_CLASS",
      teacher_name: "QA_ONLY_TEACHER",
      period: 1,
      records: { QA_ONLY_STUDENT: "absent" },
      updated_at: now,
    }],
    behaviors: [{
      record_key: "qa-behavior",
      class_name: "QA_ONLY_CLASS",
      teacher_name: "QA_ONLY_TEACHER",
      period: 1,
      records: { QA_ONLY_STUDENT: ["qa-only"] },
      updated_at: now,
    }],
    school_settings: [{ key: "custom_categories", value: [] }],
    duty_reports: [{
      id: "qa-duty-report",
      date_str: "2026-11-22",
      day_num: 4,
      period: 1,
      class_name: "QA_ONLY_CLASS",
      subject: "QA only",
      teacher_name: "QA_ONLY_TEACHER",
      reported_by: "QA_ONLY_TEACHER",
      status: "pending",
      reviewed_by: null,
      reviewed_at: null,
      created_at: now,
    }],
  };

  let manifest = {
    classes: 1,
    students: 1,
    teachers: 1,
    attendance: 1,
    behaviors: 1,
    school_settings: 1,
    duty_reports: 1,
  };
  let manifestCalls = 0;
  const reads = new Map();
  const projections = new Map();
  const functionActions = [];
  const gatewayReads = [];
  const blockedWrites = [];
  const unexpectedSupabaseTraffic = [];
  const pageErrors = [];

  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

  // Every Supabase request is intercepted before it can leave the browser.
  // Only synthetic QA rows are returned; no real credentials or school data are used.
  await page.route(/https:\/\/[^/]+\.supabase\.co\/.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== SUPABASE_HOST) {
      unexpectedSupabaseTraffic.push({ method: request.method(), url: request.url() });
      await route.abort();
      return;
    }

    const method = request.method();
    if (url.pathname === "/" && method === "HEAD") {
      await route.fulfill({ status: 200, headers: { date: new Date().toUTCString() } });
      return;
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
      "access-control-expose-headers": "content-range,content-location",
      "content-type": "application/json",
    };

    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }

    if (url.pathname === "/functions/v1/student-affairs" && method === "POST") {
      let payload = {};
      try { payload = JSON.parse(request.postData() || "{}"); } catch (_) {}
      if (payload.action === "app_data_gateway_read") {
        gatewayReads.push({ table: payload.table, offset: payload.offset, limit: payload.limit,
          authorization: request.headers()["authorization"] || "" });
        const rows = (fixtures[payload.table] || []).slice(payload.offset || 0, (payload.offset || 0) + (payload.limit || 200));
        await route.fulfill({ status: 200, headers, body: JSON.stringify({
          rows, next_offset: rows.length === (payload.limit || 200) ? (payload.offset || 0) + rows.length : null
        }) });
        return;
      }
      unexpectedSupabaseTraffic.push({ method, path: url.pathname, action: payload.action || "" });
      await route.fulfill({ status: 400, headers, body: JSON.stringify({ error: "Unexpected Student Affairs action" }) });
      return;
    }

    if (url.pathname === "/rest/v1/rpc/get_app_sync_manifest" && method === "POST") {
      manifestCalls += 1;
      await route.fulfill({ status: 200, headers, body: JSON.stringify(manifest) });
      return;
    }

    if (url.pathname.startsWith("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        blockedWrites.push({ method, path: url.pathname });
        await route.fulfill({ status: 405, headers, body: "Writes are disabled in isolated preview tests." });
        return;
      }
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (!TABLES.includes(table)) {
        unexpectedSupabaseTraffic.push({ method, url: request.url() });
        await route.fulfill({ status: 404, headers, body: "{}" });
        return;
      }
      reads.set(table, (reads.get(table) || 0) + 1);
      projections.set(table, url.searchParams.get("select"));
      const rows = fixtures[table] || [];
      await route.fulfill({
        status: 200,
        headers: {
          ...headers,
          "content-range": rows.length ? "0-" + (rows.length - 1) + "/" + rows.length : "*/0",
        },
        body: method === "HEAD" ? "" : JSON.stringify(rows),
      });
      return;
    }

    if (url.pathname === "/functions/v1/timetable-management" && method === "POST") {
      let action = "";
      try { action = JSON.parse(request.postData() || "{}").action || ""; } catch (_) {}
      functionActions.push(action);
      if (action === "timetable_list_access") {
        await route.fulfill({ status: 200, headers, body: JSON.stringify({ users: [] }) });
        return;
      }
      if (action === "timetable_list_imports") {
        await route.fulfill({ status: 200, headers, body: JSON.stringify({ imports: [] }) });
        return;
      }
      unexpectedSupabaseTraffic.push({ method, path: url.pathname, action });
      await route.fulfill({ status: 400, headers, body: JSON.stringify({ error: "Unexpected preview action" }) });
      return;
    }

    if (url.pathname.startsWith("/auth/v1/")) {
      await route.fulfill({ status: 200, headers, body: "{}" });
      return;
    }

    unexpectedSupabaseTraffic.push({ method, url: request.url() });
    await route.fulfill({ status: 404, headers, body: "{}" });
  });

  const previewUrl = process.env.PREVIEW_URL || "http://127.0.0.1:4173/";
  const response = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  expect(response, "Local preview must return an HTTP response").not.toBeNull();
  expect(response.status()).toBe(200);

  await page.waitForFunction(
    () => typeof loadSystemDataFromCloud === "function" &&
      typeof refreshCloudDataSilently === "function" &&
      typeof timetableLoadImports === "function",
    undefined,
    { timeout: 30_000 },
  );

  const initialLoad = await page.evaluate(async () => {
    activeUser = { type: "admin", name: "QA_ONLY_ADMIN", permissions: { admin: true } };
    appAuthSession = {
      token: "a".repeat(64),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      principal: { type: "admin", name: "QA_ONLY_ADMIN", permissions: { admin: true } },
    };
    return await loadSystemDataFromCloud();
  });
  expect(initialLoad, "Synthetic initial cloud snapshot must load").toBe(true);

  const mapped = await page.evaluate(() => ({
    classes: db.classes,
    students: db.students,
    teachers: db.teachers,
    attendance: db.attendance,
    behaviors: db.behaviors,
    dutyReports: db.dutyModule.records,
  }));
  expect(mapped.classes).toContain("QA_ONLY_CLASS");
  expect(mapped.students.QA_ONLY_CLASS).toContain("QA_ONLY_STUDENT");
  expect(mapped.teachers.some((item) => item.name === "QA_ONLY_TEACHER")).toBe(true);
  expect(mapped.attendance["qa-attendance"]?.className).toBe("QA_ONLY_CLASS");
  expect(mapped.behaviors["qa-behavior"]?.className).toBe("QA_ONLY_CLASS");
  expect(mapped.dutyReports.some((item) => item.id === "qa-duty-report")).toBe(true);

  const gatewayTables = ["classes", "students", "attendance", "behaviors", "duty_reports"];
  for (const table of gatewayTables) {
    expect(gatewayReads.filter((item) => item.table === table).length,
      "Administrator read must use the authenticated gateway for " + table).toBe(1);
    expect(reads.get(table) || 0, "No direct PostgREST read for migrated table " + table).toBe(0);
  }
  for (const table of ["teachers", "school_settings"]) {
    expect(reads.get(table) || 0, "Credential/settings compatibility read for " + table).toBe(1);
  }
  const expectedSelects = {
    teachers: "name,role,pin_hash,pin_salt,permissions,must_change_pin",
    school_settings: "key,value",
  };
  for (const [table, select] of Object.entries(expectedSelects)) {
    expect(projections.get(table), "Expected transitional projection for " + table).toBe(select);
  }
  expect(gatewayReads.every((item) => item.authorization === "Bearer " + "a".repeat(64))).toBe(true);

  const roleCompatibility = await page.evaluate(async () => {
    const gatewayBefore = window.__gatewayReadCount || 0;
    activeUser = { type: "teacher", name: "QA_ONLY_TEACHER", permissions: {} };
    const teacherRows = await fetchAllPaginated("classes", "name", 100);
    activeUser = { type: "custom", name: "QA_ONLY_CUSTOM", permissions: {} };
    const customRows = await fetchAllPaginated("classes", "name", 100);
    activeUser = { type: "admin", name: "QA_ONLY_ADMIN", permissions: { admin: true } };
    return { teacherRows, customRows, gatewayBefore };
  });
  expect(roleCompatibility.teacherRows).toEqual([{ name: "QA_ONLY_CLASS" }]);
  expect(roleCompatibility.customRows).toEqual([{ name: "QA_ONLY_CLASS" }]);
  expect(gatewayReads.filter((item) => item.table === "classes")).toHaveLength(1);
  expect(reads.get("classes") || 0).toBe(2);

  const unchangedRefresh = await page.evaluate(() => loadSystemDataFromCloud());
  expect(unchangedRefresh, "Unchanged manifest refresh must complete").toBe(true);
  for (const table of TABLES) {
    expect(reads.get(table) || 0, "Unchanged manifest must not reread " + table).toBe(1);
  }

  manifest.teachers = 2;
  manifest.school_settings = 2;
  const changedRefresh = await page.evaluate(() => loadSystemDataFromCloud());
  expect(changedRefresh, "Changed manifest refresh must complete").toBe(true);
  expect(reads.get("teachers") || 0).toBe(2);
  expect(reads.get("school_settings") || 0).toBe(2);
  for (const table of ["classes", "students", "attendance", "behaviors", "duty_reports"]) {
    expect(reads.get(table) || 0, "Unchanged table must not be fetched again: " + table).toBe(1);
  }

  await page.evaluate(async () => {
    timetableCanAccess = true;
    await timetableLoadImports();
    await timetableLoadImports({ refreshAccess: false });
  });
  expect(functionActions.filter((action) => action === "timetable_list_access")).toHaveLength(1);
  expect(functionActions.filter((action) => action === "timetable_list_imports")).toHaveLength(2);

  expect(manifestCalls).toBe(3);
  expect(gatewayReads.length).toBe(5);
  expect(blockedWrites, "No REST writes may occur in isolated browser tests").toEqual([]);
  expect(unexpectedSupabaseTraffic, "Only mocked, expected Supabase requests may occur").toEqual([]);
  expect(pageErrors, "The app must not throw uncaught browser errors").toEqual([]);
});
