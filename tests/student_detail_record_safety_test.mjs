import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const feature = readFileSync(new URL("../student-detail-record.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/student-affairs/index.ts", import.meta.url), "utf8");

test("student detail script is loaded after the final inline script, immediately before the real document end", () => {
  const marker = '<script src="./student-detail-record.js?v=20261126-safe-multiselect-2" defer></script>';
  const scriptPosition = indexHtml.indexOf(marker);
  const finalBodyPosition = indexHtml.toLowerCase().lastIndexOf("</body>");
  const previousScriptClosePosition = indexHtml.toLowerCase().lastIndexOf("</script>", scriptPosition - 1);

  assert.notEqual(scriptPosition, -1, "the feature script reference is missing");
  assert.ok(previousScriptClosePosition >= 0 && scriptPosition > previousScriptClosePosition, "the feature script was inserted before the previous inline script finished");
  assert.ok(scriptPosition < finalBodyPosition, "the feature script must remain inside the document body");
  assert.equal(indexHtml.slice(scriptPosition + marker.length, finalBodyPosition).trim(), "", "the script must sit directly before the document's final body close");
});

test("Service Worker does not rewrite or inject scripts into HTML responses", () => {
  assert.doesNotMatch(worker, /withStudentDetailScript/i);
  assert.doesNotMatch(worker, /html\.replace\s*\(/i);
  assert.doesNotMatch(worker, /student-detail-record\.js/i);
});

test("multi-student notice history is fetched once per selected class and only for selected names", () => {
  assert.equal((feature.match(/report_mode:\s*'notice_history'/g) || []).length, 1);
  assert.match(feature, /notice_classes:\s*\[className\],\s*student_names:\s*namesByClass\.get\(className\)/);
  assert.match(edge, /requestedStudentNames/);
  assert.match(edge, /\.in\("student_name",\s*requestedStudentNames\)/);
  assert.match(edge, /filterNoticeHistoryRows\(data\s*\|\|\s*\[\],\s*studentName,\s*requestedStudentNames\)/);
});

test("multi-student search locks mutable selection controls while results are loading", () => {
  assert.match(feature, /function setLoadingState\(isLoading\)/);
  assert.match(feature, /setLoadingState\(true\)/);
  assert.match(feature, /setLoadingState\(false\)/);
});


test("multi-class reports fall back per class only when the 5,000-row response cap is reached", () => {
  assert.ok(feature.includes("if (a.length >= 5000 || b.length >= 5000)"));
  assert.ok(feature.includes("for (const className of classNames)"));
  assert.ok(feature.includes("attendance_classes: scope.attendance ? [className] : []"));
  assert.ok(feature.includes("behavior_classes: scope.behavior ? [className] : []"));
  assert.ok(feature.includes("classAttendance.length >= 5000 || classBehaviors.length >= 5000"));
});


test("student selections are cleared when Student Affairs logs out or the principal session changes", () => {
  assert.ok(feature.includes("function syncSelectionOwner()"));
  assert.ok(feature.includes("function resetSelectionOnLogout()"));
  assert.ok(feature.includes("window.saLogout = wrappedLogout"));
  assert.ok(feature.includes("selected.clear()"));
  assert.ok(feature.includes("syncSelectionOwner()"));
});
