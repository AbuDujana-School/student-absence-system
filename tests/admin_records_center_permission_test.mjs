import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const policy = fs.readFileSync(new URL("../supabase/functions/_shared/admin_principal_policy.ts", import.meta.url), "utf8");
const centerStart = html.indexOf("/* Administrative records center:");
const centerEnd = html.indexOf("</script>", centerStart);
const centerScript = centerStart >= 0 && centerEnd > centerStart ? html.slice(centerStart, centerEnd) : "";

test("administrative records portal has a separate persisted permission", () => {
  assert.match(html, /id="perm_p_adminRecords"/);
  assert.match(html, /perm_p_adminRecords'\)\.checked = p\.adminRecords === true/);
  assert.match(html, /t\.permissions\.adminRecords = document\.getElementById\('perm_p_adminRecords'\)\.checked/);
  assert.match(centerScript, /function allowed\(\)\{return !!activeUser&&activeUser\.permissions\?\.adminRecords===true;\}/);
  assert.doesNotMatch(centerScript, /function allowed\(\)\{[^}]*isGeneralAdminUser/);
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

test("trend aggregation applies the same schoolwide guard to attendance and behavior", () => {
  const start = centerScript.indexOf("function statsView()");
  const end = centerScript.indexOf("\nfunction action", start);
  assert.ok(start >= 0 && end > start, "Could not locate statsView");
  const source = centerScript.slice(start, end);
  assert.match(source, /schoolWide=isGeneralAdminUser\(activeUser\)\|\|isAdminAuthorized\(\)/);
  assert.match(source, /if\(tab\('studstats'\)&&schoolWide\)Object\.entries\(db\.attendance/);
  assert.match(source, /if\(tab\('behaviorstats'\)&&schoolWide\)Object\.entries\(db\.behaviors/);
  assert.match(source, /if\(!schoolWide\)[\s\S]*?نطاق الإحصاء المدرسي/);
});

test("additional-admin permission projection defaults to denied and preserves an explicit grant", () => {
  assert.match(policy, /adminRecords: false/);
  assert.match(policy, /key === "adminRecords" && typeof permissions\.adminRecords === "boolean"/);
  assert.match(policy, /if \(typeof overrides\[key\] === "boolean"\) result\[key\] = overrides\[key\] as boolean;/);
});

test("report center remains bound to existing per-report authorization", () => {
  for (const key of [
    "reportComprehensiveAbsence",
    "reportMorningAssemblyLateness",
    "reportClassLatenessFollowup",
    "reportSubstitutionDistribution",
    "reportStudentAffairs",
  ]) assert.ok(centerScript.includes("rep('" + key + "')"), "Missing permission gate for " + key);
});
