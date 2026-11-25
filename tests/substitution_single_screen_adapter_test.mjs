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
test('absence screen presents the dynamic home department and optional supporting department cards before smart generation',()=>{
 assert.match(adapter,/id='subxHomeDepartmentCard'/);
 assert.match(adapter,/التوزيع لمعلمي القسم/);
 assert.match(adapter,/substitutionActorDepartmentName/);
 assert.match(adapter,/screens\.absentees\.append\(deptWrap\)/);
 assert.match(adapter,/screens\.absentees\.append\(generateButton\)/);
 assert.doesNotMatch(adapter,/id='subxAbsenteesNext'/, 'the old intermediate smart-step button must not return');
 assert.match(html,/subx-department-choice-grid/);
 assert.match(html,/سيُدرج جميع المعلمين تلقائيًا/);
});
test('checking a supporting department automatically includes every eligible teacher and opens smart suggestions on the next screen',()=>{
 assert.match(html,/function getSubstitutionSelectedOtherTeacherNames\(\)[\s\S]*?departments\.filter\(item=>ids\.has\(String\(item\.id\)\)\)[\s\S]*?flatMap/);
 assert.match(adapter,/if\(n==='absentees'\)loadReserveDepartmentCards\(\)/);
 assert.match(adapter,/if\(plan&&!plan\.classList\.contains\('hidden'\)\)go\('smart'\)/);
});
