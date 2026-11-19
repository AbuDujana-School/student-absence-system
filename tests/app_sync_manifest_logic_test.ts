const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
function loadManifestLogic() {
  const start = html.indexOf("const APP_SYNC_TABLES =");
  const end = html.indexOf("async function loadSystemDataFromCloud()", start);
  assert(start >= 0 && end > start, "Revision manifest helpers must exist before cloud loading");
  const source = html.slice(start, end);
  const factory = new Function(`${source}
    return {
      tables: APP_SYNC_TABLES,
      normalize: normalizeAppSyncManifest,
      changed: getChangedAppSyncTables,
      setPrevious(value) { lastLoadedCloudManifest = value; }
    };
  `);
  return factory();
}
const logic = loadManifestLogic();
const baseline = {
  classes: 1,
  students: 1,
  teachers: 1,
  attendance: 1,
  behaviors: 1,
  school_settings: 1,
  duty_reports: 1
};

Deno.test("manifest normalization accepts the complete seven-table revision map", () => {
  const result = logic.normalize(baseline);
  assert(result !== null, "A valid manifest must normalize");
  assert(logic.tables.length === 7, "Exactly seven application tables must be tracked");
  assert(logic.tables.every((table: string) => result[table] === 1), "Every table revision must be retained");
});

Deno.test("manifest normalization rejects incomplete, malformed, and unsafe revisions", () => {
  assert(logic.normalize(null) === null, "Null manifest must be rejected");
  assert(logic.normalize([]) === null, "Array manifest must be rejected");
  const missing = { ...baseline };
  delete (missing as Record<string, number>).attendance;
  assert(logic.normalize(missing) === null, "Missing table revision must be rejected");
  assert(logic.normalize({ ...baseline, classes: 0 }) === null, "Zero revision must be rejected");
  assert(logic.normalize({ ...baseline, classes: 1.5 }) === null, "Fractional revision must be rejected");
  assert(logic.normalize({ ...baseline, classes: Number.MAX_SAFE_INTEGER + 1 }) === null, "Unsafe integer revision must be rejected");
});

Deno.test("first load always fetches all seven tables", () => {
  logic.setPrevious(null);
  const changed = logic.changed(baseline, false);
  assert(changed.length === 7, "First load without a snapshot must fetch all seven tables");
  assert(logic.tables.every((table: string) => changed.includes(table)), "Every application table must be included on first load");
});

Deno.test("unchanged manifest produces no table downloads", () => {
  logic.setPrevious({ ...baseline });
  const changed = logic.changed({ ...baseline }, true);
  assert(changed.length === 0, "No revision changes must produce an empty download list");
});

Deno.test("a single attendance revision downloads only attendance", () => {
  logic.setPrevious({ ...baseline });
  const changed = logic.changed({ ...baseline, attendance: 2 }, true);
  assert(changed.length === 1 && changed[0] === "attendance", "Attendance-only change must not download unrelated tables");
});

Deno.test("a class revision also refreshes the coupled student roster", () => {
  logic.setPrevious({ ...baseline });
  const changed = logic.changed({ ...baseline, classes: 2 }, true);
  assert(changed.length === 2, "Class changes must refresh two coupled datasets");
  assert(changed.includes("classes") && changed.includes("students"), "Class changes must refresh both classes and students");
});

Deno.test("multiple changed revisions download only the changed datasets", () => {
  logic.setPrevious({ ...baseline });
  const changed = logic.changed({ ...baseline, teachers: 3, behaviors: 2, duty_reports: 4 }, true);
  assert(changed.length === 3, "Only three changed datasets must be downloaded");
  assert(["teachers", "behaviors", "duty_reports"].every(table => changed.includes(table)), "All and only changed datasets must be selected");
});

Deno.test("a missing cached manifest safely forces a full refresh", () => {
  logic.setPrevious(null);
  const changed = logic.changed({ ...baseline, attendance: 8 }, true);
  assert(changed.length === 7, "A snapshot without a trusted manifest must force full synchronization");
});

Deno.test("Cloudflare branch previews select the isolated Supabase project only", () => {
  const start = html.indexOf("// Cloudflare branch previews must never point at the live school database.");
  const end = html.indexOf("const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);", start);
  assert(start >= 0 && end > start, "Supabase preview routing configuration must exist");
  const source = html.slice(start, end);
  const select = new Function("location", `${source} return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };`);
  const branchPreview = select({ hostname: "fix-revision-sync-optimizati.student-absence-system.pages.dev" });
  const hashedPreview = select({ hostname: "7f978965.student-absence-system.pages.dev" });
  const pagesRoot = select({ hostname: "student-absence-system.pages.dev" });
  const githubProduction = select({ hostname: "abudujana-school.github.io" });
  assert(branchPreview.url === "https://wawplttrpiinoukpjqqx.supabase.co", "Branch preview must use isolated Supabase");
  assert(hashedPreview.url === "https://wawplttrpiinoukpjqqx.supabase.co", "Hashed preview must use isolated Supabase");
  assert(pagesRoot.url === "https://ylsocrvwqibptuwfzbke.supabase.co", "Cloudflare production root must keep production backend");
  assert(githubProduction.url === "https://ylsocrvwqibptuwfzbke.supabase.co", "GitHub Pages production must keep production backend");
  assert(branchPreview.key !== pagesRoot.key, "Preview and production public keys must be distinct");
});

Deno.test("cloud refresh uses a manifest gate and guards every full-table request", () => {
  const start = html.indexOf("async function loadSystemDataFromCloud()");
  const end = html.indexOf("async function saveSystemDataToCloud(", start);
  assert(start >= 0 && end > start, "Cloud refresh implementation must exist");
  const load = html.slice(start, end);
  assert(load.includes("nextManifest = await fetchAppSyncManifest()"), "Each refresh must check the small manifest first");
  assert(load.includes("nextManifest ? getChangedAppSyncTables(nextManifest, offlineSnapshotAvailable)"), "A valid manifest must select changed tables");
  assert(load.includes(": [...APP_SYNC_TABLES]"), "Manifest failure must retain the safe full-sync fallback");
  const noChangeStart = load.indexOf("if (nextManifest && changedTables.length === 0)");
  const noChangeEnd = load.indexOf("const shouldLoad =", noChangeStart);
  assert(noChangeStart >= 0 && noChangeEnd > noChangeStart, "No-change branch must return before table fetch setup");
  assert(!load.slice(noChangeStart, noChangeEnd).includes("fetchAllPaginated("), "No-change refresh must not download any school table");
  for (const table of logic.tables) {
    assert(load.includes(`shouldLoad('${table}') ? fetchAllPaginated('${table}'`), `${table} download must be guarded by its revision`);
  }
});
