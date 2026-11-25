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
test('the restored illustrated absence-reason picker is the single modal used by all reserve flows',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/function openAbsenceReasonPicker\(absentName,onConfirm,initialValue\)/);
 assert.match(workflow,/window\.openSubstitutionAbsenceReasonPicker = function\(absentName,currentValue,onConfirm\)/);
 assert.match(workflow,/timetableDailyAbsenceReasonModal/);
 assert.doesNotMatch(workflow,/Object\.defineProperty\(window, "openSubstitutionAbsenceReasonPicker"/);
 assert.doesNotMatch(html,/subxReasonPopup/);
 assert.doesNotMatch(html,/window\.openSubstitutionAbsenceReasonPicker=function/);
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

test('the restored absence modal retains its selected-state and accessible choice styling',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/#timetableDailyAbsenceReasonModal \.tt-absence-reason-option:has\(input:checked\)/);
 assert.match(workflow,/ttAbsenceReasonChoice/);
 assert.match(workflow,/fa-hospital/);
 assert.match(workflow,/fa-kit-medical/);
 assert.doesNotMatch(html,/#substitutionView #subxReasonPopup/);
});
test('absence screen has a validated next step and smart distribution owns the generate action',()=>{
 assert.match(adapter,/id='subxAbsenteesNext'/);
 assert.match(adapter,/حدد معلماً غائباً واحداً على الأقل/);
 assert.match(adapter,/حدد سبب الغياب لكل معلم قبل الانتقال/);
 assert.match(adapter,/screens\.smart\.insertBefore\(generateButton,plan\|\|null\)/);
});

test('canonical single-screen adapter is the only active reserve navigation layer',()=>{
 assert.doesNotMatch(html,/<script id="substitution-cinematic-interactions">/);
 assert.match(adapter,/id='subxScreen_hub'/);
 assert.ok(adapter.includes("'edit'"));
});
test('edit and archive use separate Muscat-local default date ranges',()=>{
 assert.match(html,/const dateFrom=isEditMount\?today:from\.value/);
 assert.match(html,/const dateTo=isEditMount\?shiftDate\(today,365\):to\.value/);
 assert.match(html,/if\(!from\.value\)from\.value=shiftDate\(today,-365\)/);
 assert.match(html,/if\(!to\.value\)to\.value=today/);
});
test('the canonical picker selection is reused by the absentee checkbox handler instead of opening a second modal',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/picker\(absentName,"",value=>/);
 assert.match(workflow,/window\.openSubstitutionAbsenceReasonPicker\(absentName,"",resolve\)/);
 assert.match(html,/const sharedReason=window\.__mainReserveAbsenceReasons\?\.\[reasonKey\]/);
});

test('canonical distribution date never permits a past date and quick navigation exposes only today and tomorrow',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/distributionDate\.min=today/);
 assert.match(workflow,/distributionDate\.addEventListener\("input",enforceNoPastDistributionDate\)/);
 assert.match(workflow,/data-date-offset="0"[\s\S]*data-date-offset="1"/);
 assert.doesNotMatch(workflow,/data-date-offset="-1"/);
});
test('period indicator is deliberately enlarged and future active assignments remain in the default edit range',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.ok(workflow.includes(':is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator{display:flex;flex-direction:column'));
 assert.ok(workflow.includes('<span>الحصة الحالية</span>'));
 assert.ok(workflow.includes('font-size:2.65rem'));
 assert.ok(workflow.includes('min-height:6.2rem'));
 assert.ok(workflow.includes('end.setUTCDate(end.getUTCDate()+365)'));
});
test('saved group edit actions use the saved assignment date, not the currently selected date',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/savedRows\[0\]\?\.assignmentDate\|\|timetableSubstitutionGetDate\(\)\.date/);
});

test('active reserve records are reclassified at Muscat midnight and the visible single-screen list refreshes',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/nextMidnightUtc=Date\.UTC\(today\[0\],today\[1\]-1,today\[2\]\+1,0\)-4\*60\*60\*1000/);
 assert.match(workflow,/new CustomEvent\("reserve:muscat-day-changed"/);
 assert.match(workflow,/if\(reserveIsDailyArchivePanelVisible\(\)\)await window\.timetableDailyLoadArchive/);
 assert.match(html,/addEventListener\('reserve:muscat-day-changed',[\s\S]*current==='edit'[\s\S]*current==='archive'/);
});

test('midnight refresh avoids background archive requests when the legacy archive panel is closed',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/function reserveIsDailyArchivePanelVisible\(\)/);
 assert.match(workflow,/panel&&!panel\.classList\.contains\("hidden"\)/);
 assert.match(workflow,/if\(reserveIsDailyArchivePanelVisible\(\)\)await window\.timetableDailyLoadArchive/);
});

test('the single canonical date navigation is Oman-local and the adapter does not add duplicate shortcuts',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/data-date-offset="0"[\s\S]*data-date-offset="1"/);
 assert.ok(workflow.includes('timeZone:"Asia/Muscat"'));
 assert.match(workflow,/distributionDate\.min=today/);
 assert.doesNotMatch(workflow,/data-date-offset="-1"/);
 assert.doesNotMatch(adapter,/data-day="0"|data-day="1"/);
 assert.doesNotMatch(html,/data-day="0"|data-day="1"/);
});

test('edit and archive screens partition saved assignments at the Oman-local date boundary',()=>{
 assert.match(html,/isEditMount=hostId==='subxEditMountArea'/);
 assert.match(html,/isEditMount\s*\?allRows\.filter\(r=>String\(r\.assignmentDate\|\|''\)>=today&&r\.canEdit===true/);
 assert.match(html,/allRows\.filter\(r=>String\(r\.assignmentDate\|\|''\)<today&&r\.status!=='cancelled'/);
 assert.match(html,/timeZone:'Asia\/Muscat'/);
 assert.match(html,/current==='edit'[\s\S]*loadArchive\('subxEditMountArea'\)[\s\S]*current==='archive'[\s\S]*loadArchive\('subxArchiveMountArea'\)/);
});

test('reserve edit/archive state refreshes immediately when the tab returns after Muscat midnight',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/function reserveRefreshOmanDayIfChanged\(\)/);
 assert.match(workflow,/addEventListener\("focus",reserveRefreshOmanDayIfChanged\)/);
 assert.match(workflow,/addEventListener\("visibilitychange",\(\)=>\{if\(!document\.hidden\)reserveRefreshOmanDayIfChanged\(\);\}\)/);
 assert.match(workflow,/window\.dispatchEvent\(new CustomEvent\("reserve:muscat-day-changed"/);
});

test('the final substitute approval step presents a large, readable current-lesson indicator',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 assert.match(workflow,/\.tt-period-indicator\{display:flex;flex-direction:column/);
 assert.match(workflow,/min-width:10\.5rem;min-height:6\.2rem/);
 assert.match(workflow,/font-size:2\.65rem/);
 assert.match(workflow,/<span>الحصة الحالية<\/span>/);
 assert.match(workflow,/<em>'\+esc\(item\.className\|\|"الشعبة غير محددة"\)\+'<\/em>/);
});

test('the main reserve save handler independently rejects dates before the Oman-local day',()=>{
 const save=html.slice(html.indexOf('window.substitutionSavePlan=async function'),html.indexOf('function buildShareMessage'));
 assert.match(save,/selectedAssignmentDate<omanToday/);
 assert.match(save,/timeZone:"Asia\/Muscat"/);
 assert.match(save,/لا يمكن اعتماد توزيع بتاريخ سابق/);
});

test('canonical reserve panel keeps legacy edit/archive panels hidden behind the single active edit path',()=>{
 const workflow=fs.readFileSync(new URL('../reserve-workflow.js',import.meta.url),'utf8');
 const start=workflow.indexOf('function mountCanonicalPanel()');
 const end=workflow.indexOf('function restoreCanonicalPanel()',start);
 assert.ok(start>=0&&end>start);
 const mount=workflow.slice(start,end);
 assert.match(mount,/const archiveHost=\$\("subxArchiveMountArea"\)/);
 assert.match(mount,/!\$\("subxEditMountArea"\)/);
 assert.match(mount,/\$\("timetableDailyActivePanel"\)\?\.classList\.add\("hidden"\)/);
 assert.match(mount,/\$\("timetableDailyArchivePanel"\)\?\.classList\.add\("hidden"\)/);
 assert.match(mount,/ttAdminReserveTools/);
 assert.match(adapter,/id=\"subxEditMountArea\"/);
 assert.match(adapter,/id=\"subxArchiveMountArea\"/);
 assert.doesNotMatch(mount,/subxEditContent|subxArchiveContent/);
});

test('reserve save guard accepts YYYY-MM-DD and rejects only earlier dates',()=>{
 const save=html.slice(html.indexOf('window.substitutionSavePlan=async function'),html.indexOf('function buildShareMessage'));
 assert.match(save,/!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/.test\(selectedAssignmentDate\)/);
 assert.doesNotMatch(save,/!\/\^\\\\d/);
 assert.ok(/^\d{4}-\d{2}-\d{2}$/.test('2026-11-25'));
 assert.ok('2026-11-25'>='2026-11-25');
 assert.ok(!('2026-11-24'>='2026-11-25'));
});
