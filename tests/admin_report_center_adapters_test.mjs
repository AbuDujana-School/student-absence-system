import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const html=fs.readFileSync(new URL("../index.html",import.meta.url),"utf8");
const adapterSource=fs.readFileSync(new URL("../admin-report-center-adapters.js",import.meta.url),"utf8");
function loadRegistry(){const context={window:{}};vm.runInNewContext(adapterSource,context);return context.window.AdminReportCenterAdapters;}

test("the independent registry contains all seven live school report adapters",()=>{
 const registry=loadRegistry();
 assert.deepEqual(Array.from(registry.keys),["absence","behavior","late","morning","reserve","sa","teachers"]);
 const rows=registry.list(()=>true);
 assert.equal(rows.length,7);
 assert.equal(new Set(rows.map(row=>row.key)).size,7);
 assert.ok(rows.every(row=>row.readOnly===true));
 assert.ok(rows.every(row=>row.source?.module&&row.source?.reader&&row.source?.authority));
 assert.ok(rows.every(row=>row.permission?.key&&row.handler));
});
test("each adapter resolves its original permission independently",()=>{
 const registry=loadRegistry();
 const rows=registry.list(permission=>permission.key==="reportStudentAffairs");
 assert.equal(rows.filter(row=>row.allowed).length,1);
 assert.equal(rows.find(row=>row.allowed).key,"sa");
 const teacherRows=registry.list(permission=>permission.type==="tab"&&permission.key==="teachers");
 assert.equal(teacherRows.find(row=>row.allowed).key,"teachers");
});
test("adapter execution delegates only to the selected original-section handler",async()=>{
 const registry=loadRegistry();let called="";
 const result=await registry.execute("reserve",{from:"2026-11-01",to:"2026-11-28"},{reserve:async context=>{called=context.from+"|"+context.to;return "loaded";},absence:async()=>{throw new Error("wrong handler");}});
 assert.equal(called,"2026-11-01|2026-11-28");assert.equal(result,"loaded");
});
test("unknown reports and missing adapters fail closed",async()=>{
 const registry=loadRegistry();
 await assert.rejects(registry.execute("unknown",{},{}),/غير معروف/);
 await assert.rejects(registry.execute("absence",{},{ }),/محوّل التقرير غير محمّل/);
});
test("the report center uses the detachable registry for catalog and dispatch",()=>{
 assert.match(html,/<script src="\.\/admin-report-center-adapters\.js\?v=20261128-independent-1"><\/script>/);
 const cs=html.indexOf("function reportCatalog()"),ce=html.indexOf("\nfunction reportsView()",cs);
 assert.ok(cs>=0&&ce>cs);assert.match(html.slice(cs,ce),/registry\.list/);
 const as=html.indexOf("async function reportAction(k,from,to)"),ae=html.indexOf("\nfunction statsView()",as);
 assert.ok(as>=0&&ae>as);assert.match(html.slice(as,ae),/registry\.execute/);
});
test("the adapter module is metadata and dispatch only; it performs no school-data writes",()=>{
 assert.doesNotMatch(adapterSource,/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|fetch\s*\(/);
});

test("all seven source handlers are registered and the original fallback remains available",()=>{
 const start=html.indexOf("async function reportAction(k,from,to)");
 const end=html.indexOf("\nfunction statsView()",start);
 assert.ok(start>=0&&end>start);
 const source=html.slice(start,end);
 for(const key of ["absence","behavior","late","morning","reserve","sa","teachers"]) assert.ok(source.includes(key+":async function"),"Missing report handler: "+key);
 assert.match(source,/else if\(typeof handlers\[k\]==='function'\)await handlers\[k\]\(\)/);
 const catalogStart=html.indexOf("function reportCatalog()");
 const catalogEnd=html.indexOf("\nfunction reportsView()",catalogStart);
 assert.match(html.slice(catalogStart,catalogEnd),/return \[/);
});

test("every report preserves the original section PDF or print view instead of using a replacement template",()=>{
 const registry=loadRegistry();
 const expected={
  absence:"printHorizontalReport",
  behavior:"printHorizontalBehaviorReport",
  late:"printLateFollowupReport",
  morning:"printMorningAssemblyLatenessReport",
  reserve:"printSubstitutionDistributionReport",
  sa:"studentAffairsReportsView",
  teachers:"teacherComplianceReportsView"
 };
 for(const [key,renderer] of Object.entries(expected)){
  const item=registry.get(key);
  assert.ok(item, "Missing report adapter: "+key);
  assert.ok(item.pdfRenderer.includes(renderer), "Wrong PDF renderer for "+key);
 }
 const start=html.indexOf("async function reportAction(k,from,to)");
 const end=html.indexOf("\\nfunction statsView()",start);
 assert.ok(start>=0&&end>start);
 const source=html.slice(start,end);
 for(const renderer of ["printHorizontalReport()","printHorizontalBehaviorReport()","printLateFollowupReport()","printMorningAssemblyLatenessReport()","printSubstitutionDistributionReport()","studentAffairsReportsView(from,to)","teacherComplianceReportsView(from,to)"]){
  assert.ok(source.includes(renderer), "Center must call the original report output: "+renderer);
 }
});
