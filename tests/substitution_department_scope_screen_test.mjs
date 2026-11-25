import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const backend=readFileSync(new URL('../supabase/functions/timetable-management/index.ts',import.meta.url),'utf8');
const section=(source,start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`missing section: ${start}`);
  return source.slice(a,b);
};

test('substitution flow inserts a dedicated scope step after the absent-teacher list',()=>{
  assert.match(html,/\['date','absentees','scope','smart','edit','archive','stats'\]/);
  const adapter=html.match(/<script id="substitution-single-screen-adapter">([\s\S]*?)<\/script>/)?.[1]||'';
  assert.ok(adapter);
  assert.match(adapter,/التالي: تحديد نطاق التوزيع/);
  assert.match(adapter,/go\('scope'\)/);
  assert.match(adapter,/scope:'نطاق توزيع الاحتياط'/);
  assert.match(adapter,/function scopeAvailableDepartments\(\)/);
  assert.match(adapter,/ownId\?String\(d\.id\)!==ownId/);
  assert.doesNotThrow(()=>new Function(adapter));
});

test('scope screen presents the two requested large cards and the prominent smart-distribution action',()=>{
  for(const label of ['التوزيع لمعلمي القسم','الاستعانة بالأقسام الأخرى','موافق وإضافة الأقسام','التوزيع الذكي للاحتياط'])assert.ok(html.includes(label),`missing UI label: ${label}`);
  assert.match(html,/id="subxOwnDepartmentName"/);
  assert.match(html,/id="subxDepartmentChecklist"/);
  assert.match(html,/class="subx-department-option"/);
  assert.match(html,/subx-scope-card/);
  assert.match(html,/subx-scope-start/);
});

test('the own-department name is sourced from the authenticated coordinator directory record',()=>{
  assert.match(html,/window\.substitutionActorDepartmentName=String\(response\.actorDepartmentName\|\|""\)\.trim\(\)/);
  assert.match(html,/id="subxOwnDepartmentName"/);
  assert.match(backend,/const actorDepartmentName=String\(actor\?\.departmentName\|\|""\)\.trim\(\)/);
  assert.match(backend,/const actorDepartmentId=String\(actor\?\.departmentId\|\|""\)/);
});

test('confirming selected departments includes all active timetable teachers from those departments',()=>{
  const adapter=html.match(/<script id="substitution-single-screen-adapter">([\s\S]*?)<\/script>/)?.[1]||'';
  const apply=section(adapter,'function applyScopeDepartments(ids){','async function loadScopeDepartments()');
  assert.match(apply,/select\.options/);
  assert.match(apply,/valid\.includes\(String\(option\.value\)\)/);
  assert.match(apply,/d\.teachers\|\|\[\]/);
  assert.match(apply,/window\.substitutionSelectedOtherTeacherNames=new Set\(teachers\)/);
  assert.match(apply,/dispatchEvent\(new Event\('change'/);
});

test('the existing smart algorithm receives selected department IDs and their teachers without changing the algorithm',()=>{
  const generate=section(html,'window.substitutionGeneratePlan=async function(){','window.subxRefreshExistingPlan=async function(){');
  assert.match(generate,/otherDepartmentIds/);
  assert.match(generate,/otherTeacherNames/);
  assert.match(generate,/timetable_substitution_batch_preview/);
  assert.match(generate,/substitutionOtherDepartmentsEnabled\(\)/);
  const save=section(html,'window.substitutionSavePlan=async function(){','window.substitutionShareWhatsapp=');
  assert.match(save,/otherDepartmentIds/);
  assert.match(save,/otherTeacherNames/);
});

test('the absent-teacher request remains scoped to the coordinator department',()=>{
  const loader=section(html,'window.substitutionLoadAbsentees=async function(){','window.substitutionGeneratePlan=async function(){');
  assert.match(loader,/action:'timetable_substitution_preview'/);
  assert.doesNotMatch(loader,/includeOtherDepartments|otherDepartmentIds|otherTeacherNames/);
  const endpoint=section(backend,'if (action === "timetable_substitution_departments")','if (action === "timetable_reserve_stats_access_list")');
  assert.match(endpoint,/principal\.type==="admin"\|\|teacher\.departmentId!==ownDepartment/);
  assert.match(endpoint,/actorDepartmentId/);
});

test('department sharing remains protected by the existing coordinator permission gate',()=>{
  const adapter=html.match(/<script id="substitution-single-screen-adapter">([\s\S]*?)<\/script>/)?.[1]||'';
  assert.match(adapter,/const allowed=canManageReserveWorkspace\(activeUser\)/);
  assert.match(adapter,/if\(!canManageReserveWorkspace\(activeUser\)\)/);
  assert.match(backend,/actor\?\.canManageSubstitutions\s*!==\s*true/);
  assert.match(backend,/canIncludeOtherDepartments\(principal\.type,body\.includeOtherDepartments,actorDirectoryEntry\?\.canManageSubstitutions===true\)/);
});
