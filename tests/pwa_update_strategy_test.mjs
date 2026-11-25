import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('installed PWA checks for a fresh service worker immediately on startup', () => {
  assert.match(html, /register\("\.\/sw\.js\?v=20261125-reserve-live-release-1",\s*\{\s*updateViaCache:\s*"none"\s*\}\)/);
  assert.match(html, /registration\.update\(\)/);
  assert.doesNotMatch(html, /window\.addEventListener\("load",\s*\(\)\s*=>\s*\{\s*navigator\.serviceWorker\.register/);
});

test('service worker updates rotate both application caches', () => {
  assert.match(sw, /abudujana-app-v52/);
  assert.match(sw, /abudujana-static-v59/);
  assert.match(sw, /fetch\(request,\s*\{\s*cache:\s*'no-store'/);
});

test('installed pages refresh after a new worker controls the login page', () => {
  assert.match(html, /hadControllerAtStartup = Boolean\(navigator\.serviceWorker\.controller\)/);
  assert.match(html, /navigator\.serviceWorker\.addEventListener\("controllerchange"/);
  assert.ok(html.includes("if (loginIsVisible)"));
  assert.ok(html.includes("window.location.reload()"));
  assert.match(html, /pwaUpdateNotice/);
  assert.match(html, /تحديث الآن/);
});

test('reserve scope and supporting departments use clear glass selection controls', () => {
  const reserve = readFileSync(new URL('../reserve-workflow.js', import.meta.url), 'utf8');
  assert.ok(reserve.includes('data-reserve-scope="local"'));
  assert.ok(reserve.includes('data-reserve-scope="external"'));
  assert.ok(reserve.includes('.subx-department-choice-card[data-reserve-scope=local].is-active{background:linear-gradient'));
  assert.ok(reserve.includes('data-canonical-department-id'));
  assert.ok(reserve.includes('subx-canonical-department-card input{position:static;display:block;width:27px;height:27px'));
  assert.ok(reserve.includes('data-department-bulk="all"'));
  assert.ok(reserve.includes('data-teacher-group-action="all"'));
  assert.ok(reserve.includes('expanded.hidden=!ids.includes(id)'));
  assert.ok(reserve.includes('subx-canonical-teacher-checkbox{width:27px!important;height:27px!important'));
});

test('reserve WhatsApp distribution uses the requested department and spaced WhatsApp formatting', () => {
  const reserve = readFileSync(new URL('../reserve-workflow.js', import.meta.url), 'utf8');
  const share = reserve.slice(reserve.indexOf('window.timetableDailyShareWhatsApp = async function ()'), reserve.indexOf('function applyTeacherTimetablePresentation'));
  assert.ok(share.includes('const department=await reservePrintActorSubject();'));
  assert.ok(share.includes('`"+department+"`'));
  assert.ok(share.includes('*المعلم الغائب* : `'));
  assert.ok(share.includes('*الاحتياط* : `'));
  assert.ok(share.includes('message+="\\n\\n";'));
});

test('supporting department teacher cards recover when the source renderer populates asynchronously', () => {
  const reserve = readFileSync(new URL('../reserve-workflow.js', import.meta.url), 'utf8');
  assert.ok(reserve.includes('canonicalTeacherSourceHost.dataset.canonicalTeacherObserverBound'));
  assert.ok(reserve.includes('canonicalTeacherObserver.observe(canonicalTeacherSourceHost,{childList:true,subtree:true})'));
  assert.ok(reserve.includes('enhanceCanonicalTeacherCards();'));
  assert.match(reserve, /if\(typeof window\.renderSubstitutionOtherTeacherChoices==="function"\)\s*\{\s*window\.renderSubstitutionOtherTeacherChoices\(\);\s*\}/);
});
test('reserve edit lifecycle ends at midnight Muscat on the assignment date and includes future dates', () => {
  const reserve = readFileSync(new URL('../reserve-workflow.js', import.meta.url), 'utf8');
  const endpoint = readFileSync(new URL('../supabase/functions/timetable-management/index.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261125120000_reserve_edit_until_assignment_day_end.sql', import.meta.url), 'utf8');
  assert.match(endpoint, /date >= todayInMuscat && now < deadline/);
  assert.match(migration, /p_assignment_date >= \(now\(\) AT TIME ZONE 'Asia\/Muscat'\)::date/);
  assert.match(migration, /p_assignment_date \+ 1/);
  assert.ok(reserve.includes('end.setUTCDate(end.getUTCDate()+365)'));
});
