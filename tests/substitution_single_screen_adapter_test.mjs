import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const adapter=html.match(/<script id="substitution-single-screen-adapter">([\s\S]*?)<\/script>/)?.[1]||'';
const style=html.match(/<style id="substitution-single-screen-theme-v3">([\s\S]*?)<\/style>/)?.[1]||'';
test('single-screen adapter is installed and creates the four independent portal destinations',()=>{
 assert.ok(adapter.length>5000);for(const name of ['date','edit','archive','stats','absentees','smart'])assert.ok(adapter.includes("'"+name+"'"));
 assert.match(adapter,/subx-hub-rect/);assert.match(style,/\.subx-screen\.is-visible/);assert.match(style,/\.subx-hub-rect/);assert.match(html,/#substitutionView>\.hidden\{display:none!important\}/);
});
test('date and distribution transitions wait for their asynchronous data operations',()=>{
 assert.match(adapter,/await window\.substitutionLoadAbsentees\?\.\(\);go\('absentees'\)/);
 assert.match(adapter,/await window\.substitutionGeneratePlan\?\.\(\);if\(plan/);
});
test('absence reason popup feeds the original reason callback',()=>{
 assert.match(adapter,/window\.openSubstitutionAbsenceReasonPicker=function/);
 assert.match(adapter,/reasonCallback\?\.\(draft\)/);
});
test('archive is loaded from the department-scoped backend archive action and has A4 print styling',()=>{
 assert.match(adapter,/action:'timetable_substitution_archive'/);
 assert.match(ad¶»§q«^