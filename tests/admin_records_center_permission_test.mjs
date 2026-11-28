import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const policy = fs.readFileSync(new URL("../supabase/functions/_shared/admin_principal_policy.ts", import.meta.url), "utf8");
const reportPolicy = fs.readFileSync(new URL("../supabase/functions/_shared/report_access_policy.ts", import.meta.url), "utf8");
const edge = fs.readFileSync(new URL("../supabase/functions/student-affairs/index.ts", import.meta.url), "utf8");
const timetableEdge = fs.readFileSync(new URL("../supabase/functions/timetable-management/index.ts", import.meta.url), "utf8");
const morningEdge = fs.readFileSync(new URL("../supabase/functions/morning-assembly-lateness/index.ts", import.meta.url), "utf8");
const centerStart = html.indexOf("/* Administrative records center:");
const centerEnd = html.indexOf("</script>", centerStart);
const centerScript = centerStart >= 0 && centerEnd > centerStart ? html.slice(centerStart, centerEnd) : "";

test("administrative records portal has a separate persisted permission", () => {
  assert.match(html, /id="perm_p_adminRecords"/);
  assert.ok(html.includes("p.additionalAdmin === true && p.additionalAdminOverrides"), "Additional-admin permission editor must read the explicit override");
  assert.ok(html.includes("adminRecords: document.getElementById('perm_p_adminRecords').checked"), "Additional-admin permission editor must persist the explicit override");
  assert.ok(html.includes("else { t.permissions.adminRecords = document.getElementById('perm_p_adminRecords').checked; }"), "Ordinary teachers must keep the direct permission field");
  assert.match(centerScript, /function canViewAdminRecords\(user=activeUser\)/);
  assert.match(centerScript, /user\.canViewAdminRecords===true\|\|p\.canViewAdminRecords===true\|\|p\.adminRecords===true\|\|p\.additionalAdminOverrides\?\.adminRecords===true/);
  assert.match(centerScript, /function allowed\(\)\{return canViewAdminRecords\(activeUser\);\}/);
});

test("the appended administrative center script parses as JavaScript", () => {
  assert.ok(centerScript.length > 1000, "Expected the administrative center module in the final inline script");
  assert.doesNotThrow(() => new vm.Script(centerScript));
});

test("daily pulse data requires portal access and the matching attendance permission", () => {
  const start = centerScript.indexOf("function pulseData()");
  const end = centerScript.indexOf("\nfunction metric", start);
  assert.ok(start >= 0 && end > start, "Could not locate pulseData");
  const source = centerScript.slice(start, end);
  assert.match(source, /if\(!allowed\(\)\)return[\s\S]*?restricted:true/);
  assert.match(source, /if\(tab\('studstats'\)\)Object\.entries\(db\.attendance/);
  assert.match(source, /if\(tab\('behaviorstats'\)\)Object\.entries\(db\.behaviors/);
});

test("trend aggregation is gated independently by attendance and behavior permissions", () => {
  const start = html.indexOf("async function updateAdvancedAnalytics()");
  const end = html.indexOf("\nfunction renderAdminOverview()", start);
  assert.ok(start >= 0 && end > start, "Could not locate updateAdvancedAnalytics");
  const source = html.slice(start, end);
  assert.match(source, /canAccessAdminTab\('studstats', activeUser\)/);
  assert.match(source, /canAccessAdminTab\('behaviorstats', activeUser\)/);
  assert.match(source, /if \(canReadAttendance\)\s*\{\s*Object\.entries\(db\.attendance/);
  assert.match(source, /if \(canReadBehavior\)\s*\{\s*Object\.entries\(db\.behaviors/);
  assert.match(source, /attendanceCard\.classList\.toggle\('hidden', !canReadAttendance\)/);
  assert.match(source, /behaviorCard\.classList\.toggle\('hidden', !canReadBehavior\)/);
  assert.match(source, /يتطلب هذا المؤشر صلاحية الاطلاع على إحصائيات السلوكيات/);
  const centerStart = html.indexOf("/* Administrative records center:");
  const centerEnd = html.indexOf("</script>", centerStart);
  const center = html.slice(centerStart, centerEnd);
  assert.match(center, /if\(!canAccessAdminTab\('studstats',activeUser\)\)/);
});

test("additional-admin permission projection defaults to denied and preserves an explicit grant", () => {
  assert.match(policy, /adminRecords: false/);
  assert.match(policy, /key === "adminRecords" && typeof permissions\.adminRecords === "boolean"/);
  assert.match(policy, /if \(typeof overrides\[key\] === "boolean"\) result\[key\] = overrides\[key\] as boolean;/);
});

test("administrative-records access unlocks the center only while its modal is open", () => {
  assert.ok(html.includes("function isAdminRecordsCenterScopedAccess(user = activeUser)"));
  assert.ok(html.includes("return granted && !!modal && !modal.classList.contains('hidden')"));
  assert.ok(html.includes("isAdminRecordsCenterScopedAccess(user) && ['studstats','behaviorstats','teachers'].includes(key)"));
  assert.ok(html.includes("isAdminRecordsCenterScopedAccess(user) && ['reportMorningAssemblyLateness','reportStudentAffairs','reportComprehensiveAbsence','reportClassLatenessFollowup','reportSubstitutionDistribution'].includes(key)"));
  const panelStart = html.indexOf("function hasAdminPanelAccess(user = activeUser)");
  const panelEnd = html.indexOf("function getSingleAdminPanelPermission", panelStart);
  const panelAccess = html.slice(panelStart, panelEnd);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  assert.ok(panelAccess.includes("return isGeneralAdminUser(user) || ADMIN_TAB_PERMISSIONS.some(key => canAccessAdminTab(key, user));"));
  assert.doesNotMatch(panelAccess, /adminRecords/);
  assert.ok(html.includes("function isAdminAuthorized() { if (isGeneralAdminUser() || isAdditionalAdminUser()) return true;"));
  assert.ok(centerScript.includes("function close(){if(!modal)return;modal.classList.add('hidden');document.body.style.overflow='';document.getElementById('dashboardSelectionView')?.classList.remove('hidden');view='hub';if(typeof refreshReportPanelsVisibility==='function')refreshReportPanelsVisibility();}"));
});

test("Student Affairs and morning-assembly reports retain their independent access checks", () => {
  assert.ok(centerScript.includes("allowed:rep('reportStudentAffairs')"));
  assert.ok(centerScript.includes("allowed:rep('reportMorningAssemblyLateness')"));
  assert.ok(centerScript.includes("function rep(k){return isAdminRecordsCenterScopedAccess(activeUser)?true:(k==='reportMorningAssemblyLateness'?canViewMorningAssemblyLatenessReport(activeUser):canAccessReport(k,activeUser));}"));
  assert.ok(centerScript.includes("allowed:rep('reportMorningAssemblyLateness')"));
});


test("Student Affairs reports open inside the records center without granting dashboard entry", () => {
  assert.ok(centerScript.includes("async function studentAffairsReportsView(from,to)"));
  assert.ok(centerScript.includes("modal.querySelector('#arcStudentAffairsReportHost').appendChild(panel)"));
  const actionStart = centerScript.indexOf("else if(k==='sa'&&rep('reportStudentAffairs'))");
  const actionEnd = actionStart + 700;
  assert.ok(actionStart >= 0);
  assert.ok(!centerScript.slice(actionStart, actionEnd > actionStart ? actionEnd : actionStart + 500).includes("openAdminModal"));
  assert.ok(html.includes("admin_records_center:true"));
  assert.ok(edge.includes("hasAdminRecordsCenterAccess(appPrincipal.type, appPrincipal.permissions"));
  assert.ok(edge.includes("permissionsFor(p, false, adminRecordsCenterAccess)"));
  assert.ok(edge.includes("mode === \"notice_issue_commit\""));
  assert.ok(timetableEdge.includes("isSchoolwideReport = action === \"timetable_substitution_report\""));
  assert.ok(timetableEdge.includes("principal.adminRecordsCenterReportOnly === true"));
  assert.ok(morningEdge.includes("hasAdminRecordsCenterAccess(principal.type, principal.permissions"));
  assert.ok(reportPolicy.includes("report === \"reportStudentAffairs\" && adminRecordsCenterAccess"));
});
