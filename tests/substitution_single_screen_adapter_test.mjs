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
 assert.match(adapter,/subxArchivePrint/);assert.match(style,/\.subx-a4-sheet/);
});
test('statistics use the selected multi-department state rather than a removed checkbox',()=>{
 assert.match(html,/includeOtherDepartments:\(typeof substitutionOtherDepartmentsEnabled==='function'\?substitutionOtherDepartmentsEnabled\(\):false\)/);
});

test('archive actions are shown only when the server authorizes edit or delete',()=>{
 assert.match(adapter,/x\.canEdit\?/);assert.match(adapter,/x\.canDelete\?/);
 assert.match(adapter,/action:'timetable_substitution_update'/);assert.match(adapter,/action:'timetable_substitution_cancel'/);
 assert.match(adapter,/weekday:subxWeekdayFor\(b\.dataset\.date\)/);
});
test('archive edit and delete refresh the database-backed archive after success',()=>{
 assert.match(adapter,/await loadArchive\(hostId\)/);assert.match(adapter,/تم تعديل التكليف/);
});

test('edit portal opens the same department-scoped archive with permitted actions',()=>{
 assert.ok(adapter.includes('id="subxEditMountArea"'));
 assert.ok(adapter.includes("if(n==='edit')loadArchive('subxEditMountArea')"));
 assert.ok(adapter.includes("if(n==='archive')loadArchive('subxArchiveMountArea')"));
});
test('archive cancellation UI never offers delete for completed rows',()=>{
 const backend=fs.readFileSync(new URL('../supabase/functions/timetable-management/index.ts',import.meta.url),'utf8');
 assert.match(backend,/canDelete:Boolean[\s\S]{0,500}\["assigned","confirmed"\]\.includes\(String\(row\.status\|\|""\)\)/);
});

test('navigation toggles the hub as well as each sub-screen so only one screen is visible',()=>{assert.match(adapter,/hub\.classList\.toggle\('is-visible',n==='hub'\)/);assert.match(adapter,/Object\.entries\(screens\)\.forEach/);});

test('archive mutations compute the backend weekday independently of the private distribution scope',()=>{assert.match(adapter,/function subxWeekdayFor\(date\)/);assert.match(adapter,/weekday:subxWeekdayFor\(b\.dataset\.date\)/);});

test('archive edit and delete refresh the active mount rather than a hidden archive panel',()=>{assert.equal((adapter.match(/await loadArchive\(hostId\)/g)||[]).length,2);});
test('absentee selection card is made visible after moving it into its dedicated screen',()=>{
 assert.match(adapter,/if\(absentee\)\{screens\.absentees\.append\(absentee\);absentee\.classList\.remove\('hidden'\);\}/);
});

test('absence reason picker is vertical, stable on every open, and keeps Other as the final option',()=>{
 assert.match(style,/#subxReasonPopup \.subx-reason-list\{display:flex;flex-direction:column/);
 assert.match(adapter,/\['طارئة','إجازة مرضية','دورة تدريبية','موعد مستشفى','أخرى'\]/);
 assert.match(adapter,/querySelectorAll\('\[data-reason\]'\)\.forEach\(x=>x\.classList\.remove\('is-active'\)\)/);
 assert.match(adapter,/other\.value='';other\.classList\.add\('hidden'\)/);
});
test('absence screen has a validated next step and smart distribution owns the generate action',()=>{
 assert.match(adapter,/id='subxAbsenteesNext'/);
 assert.match(adapter,/حدد معلماً غائباً واحداً على الأقل/);
 assert.match(adapter,/حدد سبب الغياب لكل معلم قبل الانتقال/);
 assert.match(adapter,/screens\.smart\.insertBefore\(generateButton,plan\|\|null\)/);
});

test('scope selector presents two distinct glass choices and a dedicated multi-select checklist',()=>{
 for(const token of ['subxOwnDepartmentCard','التوزيع لمعلمي القسم','subxOtherDepartmentToggle','الاستعانة بالأقسام الأخرى','subxDepartmentChecklist','subxDepartmentApply','subxScopeStartSmart'])assert.ok(adapter.includes(token),token);
 assert.match(style,/subx-scope-card/);assert.match(style,/backdrop-filter:blur/);assert.match(style,/subx-department-option input:checked/);
});
test('absence flow opens scope selection and own-department choice clears all external departments',()=>{
 assert.match(adapter,/التالي: تحديد نطاق التوزيع/);assert.match(adapter,/go\('scope'\)/);
 assert.match(adapter,/subxOwnDepartmentCard[^\n]*applyScopeDepartments\(\[\]\);go\('smart'\)/);
});
test('scope checklist excludes the coordinator department and commits only approved department IDs',()=>{
 assert.match(adapter,/function scopeAvailableDepartments\(\)[\s\S]*?String\(d\.id\)!==ownId/);
 assert.match(adapter,/function applyScopeDepartments\(ids\)[\s\S]*?valid=\[\.\.\.new Set/);
 assert.match(adapter,/substitutionSelectedOtherDepartmentIds=valid\.slice\(\)/);
 assert.match(adapter,/اضغط «موافق» أولاً لاعتماد الأقسام التي اخترتها/);
});
test('scope selector keeps absent teachers in their original department flow and gates cross-department access',()=>{
 assert.match(adapter,/canManageReserveWorkspace\(activeUser\)/);
 assert.match(adapter,/subxOtherDepartmentCard\.classList\.toggle\('hidden',!allowed\)/);
 assert.match(adapter,/substitutionLoadAbsentees/);
});
test('scope screen does not replace the existing smart distribution engine',()=>{
 assert.match(adapter,/substitutionGeneratePlan/);
 assert.match(adapter,/substitutionOtherDepartmentIds\(\)/);
 assert.match(adapter,/screens\.smart\.append\(plan\)/);
});

test('department options response identifies the coordinator even when no active timetable exists',()=>{
 const action=backend.slice(backend.indexOf('if (action === "timetable_substitution_departments")'),backend.indexOf('if (action === "timetable_reserve_stats_access_list")'));
 assert.ok(action.indexOf('const actor = directory.find')<action.indexOf('if(!activeVersionId)'));
 assert.match(action,/departments:\[\],actorDepartmentName,actorDepartmentId/);
 assert.match(action,/principal\.type !== "admin" && actor\?\.canManageSubstitutions !== true/);
});
