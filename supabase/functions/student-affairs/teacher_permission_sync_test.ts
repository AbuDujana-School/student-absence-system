const html = await Deno.readTextFile(new URL("../../../index.html", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("server-managed teacher permissions override stale local values", () => {
  const match = html.match(/function saMergeServerManagedTeacherPermissions\(localPermissions,serverPermissions\)\{[\s\S]*?\n\}/);
  if (!match) throw new Error("Permission merge helper must exist in index.html");
  const merge = new Function(`${match[0]}; return saMergeServerManagedTeacherPermissions;`)() as
    (local: Record<string, unknown>, server: Record<string, unknown>) => Record<string, unknown>;

  const merged = merge(
    { attendance: true, studentAffairs: false, can_view_competition: false, competition_participant: false, competition_team_name: "stale", competition_team_classes: ["old"], duty: true },
    { studentAffairs: true, can_view_competition: true, competition_participant: true, competition_team_name: "فريق النخبة", competition_team_classes: ["1/9", "2/9"] }
  );
  assert(merged.studentAffairs === true, "Server Student Affairs access must win");
  assert(merged.can_view_competition === true, "Server competition permission must win");
  assert(merged.competition_participant === true && merged.competition_team_name === "فريق النخبة", "Server competition team membership must win");
  assert(JSON.stringify(merged.competition_team_classes) === JSON.stringify(["1/9", "2/9"]), "Server team classes must win");
  assert(merged.attendance === true && merged.duty === true, "Unrelated local permissions must remain unchanged");

  const absent = merge(
    { studentAffairs: true, can_view_competition: true, competition_participant: true, competition_team_name: "old", competition_team_classes: ["1/9"], attendance: true },
    {}
  );
  assert(!("studentAffairs" in absent) && !("can_view_competition" in absent) && !("competition_participant" in absent) && !("competition_team_name" in absent) && !("competition_team_classes" in absent), "Missing server-managed keys must not be resurrected from stale local state");
  assert(absent.attendance === true, "Unrelated permissions must remain unchanged");
});

Deno.test("Student Affairs save does not enqueue a stale full teacher overwrite", () => {
  const saveStart = html.indexOf("async function saSavePermissions()");
  const saveEnd = html.indexOf("async function saLoadReport()", saveStart);
  assert(saveStart >= 0 && saveEnd > saveStart, "Could not locate saSavePermissions");
  const save = html.slice(saveStart, saveEnd);
  assert(save.includes("saMergeServerManagedTeacherPermissions"), "Save must update local managed flags from the successful request");
  assert(!save.includes("dirtySets.teachers.add(name)"), "Student Affairs save must not enqueue a stale full teacher upsert");
});

Deno.test("general teacher sync preserves server-managed permissions before full-row upsert", () => {
  const syncStart = html.indexOf("const teacherKeys = [...(syncDirty.teachers || [])]");
  const syncEnd = html.indexOf("clearSyncedDirtyKeys('teachers', teacherKeys, syncSnapshotDb)", syncStart);
  assert(syncStart >= 0 && syncEnd > syncStart, "Could not locate teacher sync block");
  const sync = html.slice(syncStart, syncEnd);
  assert(sync.includes(".select('name,permissions')"), "Teacher sync must read canonical server permissions");
  assert(sync.includes("saMergeServerManagedTeacherPermissions"), "Teacher sync must merge canonical Student Affairs flags");
  assert(sync.includes("await robustUpsert('teachers', rows, 'name', 100)"), "Teacher sync must keep the existing upsert path");
});

const edgeIndex = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("verified app principals reuse Student Affairs permissions without a duplicate teachers lookup", () => {
  const accessStart = edgeIndex.indexOf("async function hasStudentAffairsAccess");
  const accessEnd = edgeIndex.indexOf("async function getSession", accessStart);
  assert(accessStart >= 0 && accessEnd > accessStart, "Could not locate Student Affairs access helper");
  const access = edgeIndex.slice(accessStart, accessEnd);
  const principalCheck = access.indexOf('if (p.permissions && typeof p.permissions === "object")');
  const teacherLookup = access.indexOf('db.from("teachers")');
  assert(principalCheck >= 0 && teacherLookup > principalCheck, "Verified principal permissions must be checked before the legacy teachers lookup");
  assert(access.includes("p.permissions.studentAffairs === true"), "Verified additional-admin permissions must use the explicit Student Affairs grant");
  assert(!access.includes("p.permissions.admin === true"), "The admin marker must not grant Student Affairs access");

  const permissionsStart = edgeIndex.indexOf("async function permissionsFor");
  const legacyStart = edgeIndex.indexOf("const legacy = Array.isArray(data?.allowed_classes)", permissionsStart);
  assert(permissionsStart >= 0 && legacyStart > permissionsStart, "Could not locate permissionsFor lookup");
  const permissions = edgeIndex.slice(permissionsStart, legacyStart);
  assert(permissions.includes("const principalPermissions = p.permissions"), "permissionsFor must recognize permissions from a verified app principal");
  assert(permissions.includes("Promise.resolve({ data: { name: p.name"), "Verified principals must avoid a second teachers request");
  assert(permissions.includes('db.from("teachers").select("name,role,permissions")'), "Legacy Student Affairs sessions must retain the database fallback");
});

Deno.test("competition term calendar and visibility settings use one database request", () => {
  const start = edgeIndex.indexOf("async function readCompetitionTermSettings()");
  const end = edgeIndex.indexOf("async function buildTermCompetitionSnapshot", start);
  assert(start >= 0 && end > start, "Could not locate competition term settings reader");
  const reader = edgeIndex.slice(start, end);
  const tableReads = reader.match(/db\.from\("school_settings"\)/g) || [];
  assert(tableReads.length === 1, "Competition settings must use one school_settings request");
  assert(reader.includes('.select("key,value")'), "The combined request must retrieve only key and value");
  assert(reader.includes('.in("key", ["competition_term_calendar", "competition_visibility_mode"])'), "The combined request must fetch both required settings");
  assert(reader.includes('settings.get("competition_term_calendar")'), "Calendar data must retain its original setting key");
  assert(reader.includes('settings.get("competition_visibility_mode")'), "Visibility data must retain its original setting key");
  assert(reader.includes("visibility?.showBothTerms === true"), "The visibility behavior must remain unchanged");
});

Deno.test("report permissions are independent and legacy broad access is denied", () => {
  const helperStart = html.indexOf("const REPORT_PERMISSION_KEYS");
  const helperEnd = html.indexOf("function switchAdminTab", helperStart);
  assert(helperStart >= 0 && helperEnd > helperStart, "Could not locate report permission helpers");
  const helperSource = html.slice(helperStart, helperEnd);
  const create = new Function("activeUser", "isAdminAuthorized", "isGeneralAdminUser", "isAdminRecordsCenterScopedAccess", `${helperSource}; return { canAccessReport, canAccessAnyReport };`) as
    (user: Record<string, unknown>, isAdminAuthorized: () => boolean, isGeneralAdminUser: (user: Record<string, unknown>) => boolean, isAdminRecordsCenterScopedAccess: () => boolean) => {
      canAccessReport: (key: string) => boolean;
      canAccessAnyReport: () => boolean;
    };

  const isGeneralAdminUser = (user: Record<string, unknown>) => user.type === "admin" && (user.adminScope === "general" || user.name === "مدير النظام العام");
  const legacy = create({ type: "teacher", permissions: { reports: true } }, () => false, isGeneralAdminUser, () => false);
  assert(!legacy.canAccessAnyReport(), "Legacy broad reports permission must not open the reports section");
  for (const key of ["reportMorningAssemblyLateness", "reportStudentAffairs", "reportComprehensiveAbsence", "reportClassLatenessFollowup", "reportSubstitutionDistribution"]) {
    assert(!legacy.canAccessReport(key), "Each report requires its own explicit permission");
  }

  const limited = create({ type: "teacher", permissions: {
    reports: true,
    reportMorningAssemblyLateness: false,
    reportStudentAffairs: true,
    reportComprehensiveAbsence: false,
    reportClassLatenessFollowup: false
  } }, () => false, isGeneralAdminUser, () => false);
  assert(limited.canAccessReport("reportStudentAffairs"), "The selected report must be accessible");
  assert(!limited.canAccessReport("reportMorningAssemblyLateness"), "Unselected morning report must be hidden");
  assert(!limited.canAccessReport("reportComprehensiveAbsence"), "Unselected absence report must be hidden");
  assert(!limited.canAccessReport("reportClassLatenessFollowup"), "Unselected class-lateness report must be hidden");

  const centerOnly = create({ type: "teacher", permissions: { adminRecords: true } }, () => false, isGeneralAdminUser, () => true);
  assert(centerOnly.canAccessReport("reportComprehensiveAbsence"), "Center access must enable the absence report while the center is open");
  assert(centerOnly.canAccessReport("reportClassLatenessFollowup"), "Center access must enable the class-lateness report while the center is open");
  assert(centerOnly.canAccessReport("reportSubstitutionDistribution"), "Center access must enable the reserve report while the center is open");
  assert(centerOnly.canAccessReport("reportStudentAffairs"), "Center access must enable Student Affairs reports while the center is open");
});

Deno.test("only administrators can change report permissions in the teacher editor", () => {
  const openStart = html.indexOf("function openPermissionsModal(idx)");
  const saveStart = html.indexOf("async function saveTeacherPermissions()", openStart);
  const saveEnd = html.indexOf("/* ============ Custom Users ============ */", saveStart);
  assert(openStart >= 0 && saveStart > openStart && saveEnd > saveStart, "Could not locate teacher permission editor");
  const editor = html.slice(openStart, saveEnd);
  assert(editor.includes("control.disabled = !canManageReportPermissions()"), "Non-admin report permission controls must be disabled");
  assert(editor.includes("if (canManageReportPermissions())"), "Save must ignore report permission edits from non-admin accounts");
  for (const key of ["reportMorningAssemblyLateness", "reportStudentAffairs", "reportComprehensiveAbsence", "reportClassLatenessFollowup", "reportSubstitutionDistribution"]) {
    assert(editor.includes("t.permissions." + key), "Teacher permission save must persist " + key);
  }
});
