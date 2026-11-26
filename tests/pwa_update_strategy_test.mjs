import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('installed PWA checks for a fresh service worker immediately on startup', () => {
  const appBuildVersion = html.match(/<meta name="app-build" content="([^"]+)"/)?.[1];
  assert.ok(appBuildVersion, "index.html must declare an app build marker");
  const workerRegistration = html.match(/navigator\.serviceWorker\.register\("([^"]+)",\s*\{\s*updateViaCache:\s*"none"\s*\}\)/);
  assert.ok(workerRegistration, "service worker must register without browser cache");
  const appBuildVersionForWorker = appBuildVersion.replace(/^(\d{4})-(\d{2})-(\d{2})-/, "$1$2$3-");
  assert.equal(new URL(workerRegistration[1], "https://school.example/").searchParams.get("v"), appBuildVersionForWorker);
  assert.match(html, /registration\.update\(\)/);
  assert.doesNotMatch(html, /window\.addEventListener\("load",\s*\(\)\s*=>\s*\{\s*navigator\.serviceWorker\.register/);
});

test('service worker updates rotate both application caches', () => {
  assert.match(sw, /abudujana-app-v55/);
  assert.match(sw, /abudujana-static-v62/);
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

// The message layout is exercised in detail by reserve_archive_refresh_test.ts.
test('reserve WhatsApp distribution uses the shared Arabic school report template', () => {
  const reserve = readFileSync(new URL('../reserve-workflow.js', import.meta.url), 'utf8');
  const shareStart = reserve.indexOf('window.timetableDailyShareWhatsApp = async function ()');
  const shareEnd = reserve.indexOf('function applyTeacherTimetablePresentation', shareStart);
  const share = reserve.slice(shareStart, shareEnd);
  const formatterStart = reserve.indexOf('function buildReserveWhatsAppMessage(');
  const formatterEnd = reserve.indexOf('function applyTeacherTimetablePresentation', formatterStart);
  const formatter = reserve.slice(formatterStart, formatterEnd);
  assert.ok(shareStart >= 0 && shareEnd > shareStart);
  assert.ok(share.includes('const subject=await reservePrintActorSubject();'));
  assert.ok(share.includes('const message=buildReserveWhatsAppMessage(groups,date,weekday,subject);'));
  assert.ok(formatter.includes('مدرسة أبو دجانة الأنصاري'));
  assert.ok(formatter.includes('📚 *المادة:*'));
  assert.ok(formatter.includes('🗓️ *التاريخ:*'));
  assert.ok(formatter.includes('. المعلم الغائب:*'));
  assert.ok(formatter.includes('*الاحتياط:*'));
  assert.ok(formatter.includes('━━━━━━━━━━━━━━━━━━'));
  assert.ok(formatter.includes('شكرًا لتعاونكم وحرصكم الدائم'));
});

test('supporting department teacher cards recover when the source renderer populates asynchronously', () => {
  const reserve = readFileSync(new URL('../reserve-workflow.js', import.meta.url), 'utf8');
  assert.ok(reserve.includes('canonicalTeacherSourceHost.dataset.canonicalTeacherObserverBound'));
  assert.ok(reserve.includes('canonicalTeacherObserver.observe(canonicalTeacherSourceHost,{childList:true,subtree:true})'));
  assert.ok(reserve.includes('enhanceCanonicalTeacherCards();'));
  assert.match(reserve, /if\(typeof window\.renderSubstitutionOtherTeacherChoices==="function"\)\s*\{\s*window\.renderSubstitutionOtherTeacherChoices\(\);\s*\}/);
});
