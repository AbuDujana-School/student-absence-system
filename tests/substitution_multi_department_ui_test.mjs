import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const between=(a,b)=>{const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,`missing section ${a}`);return html.slice(i,j);};
test('supporting departments selector allows multiple departments',()=>{
 const tag=html.match(/<select[^>]*id="substitutionOtherDepartmentSelect"[^>]*>/)?.[0]||'';
 assert.match(tag,/\bmultiple\b/);assert.match(tag,/size="4"/);
});
test('selected department IDs are read from all selected options with legacy fallback',()=>{
 const helper=between('function substitutionOtherDepartmentIds(){','function substitutionOtherDepartmentsEnabled()');
 assert.ok(helper.includes("e.multiple"));assert.match(helper,/selectedOptions/);
});
test('teacher lists are rendered for every selected department and selection is restricted to those departments',()=>{
 const render=between('function renderSubstitutionOtherTeacherChoices(){','async function timetableToggleOtherDepartments');
 assert.match(render,/ids\.map\(id=>window\.substitutionOtherDepartmentsData\.find/);
 assert.match(render,/deps\.map\(d=>/);assert.match(render,/allowed\.has\(n\)/);
});
test('preview, refresh and batch save send otherDepartmentIds',()=>{
 const generate=between('window.substitutionGeneratePlan=async function(){','window.subxRefreshExistingPlan=async function(){');
 const refresh=between('window.subxRef¶»§q«^