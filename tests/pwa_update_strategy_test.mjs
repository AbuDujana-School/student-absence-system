import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
const logo = readFileSync(new URL('../logo.png', import.meta.url));

test('installed PWA checks for a fresh service worker immediately on startup', () => {
  const appBuildVersion = html.match(/<meta name="app-build" content="([^"]+)"/)?.[1];
  assert.ok(appBuildVersion, "index.html must declare an app build marker");
  const workerRegistration = html.match(/workerContainer\.register\("([^"]+)",\s*\{\s*updateViaCache:\s*"none"\s*\}\)/);
  assert.ok(workerRegistration, "service worker must register without browser cache");
  const appBuildVersionForWorker = appBuildVersion.replace(/^(\d{4})-(\d{2})-(\d{2})-/, "$1$2$3-");
  assert.equal(new URL(workerRegistration[1], "https://school.example/").searchParams.get("v"), appBuildVersionForWorker);
  assert.match(html, /registration\.update\(\)/);
  assert.doesNotMatch(html, /window\.addEventListener\("load",\s*\(\)\s*=>\s*\{\s*navigator\.serviceWorker\.register/);
});

test('service worker updates rotate both application caches', () => {
  assert.match(sw, /abudujana-app-v65/);
  assert.match(sw, /abudujana-static-v72/);
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


test('app entry is a direct display-only PIN gate with both school-logo positions', () => {
 const start=html.indexOf('<div id="loginView"'),end=html.indexOf('<section id="uiReviewLauncher"',start);
 assert.ok(start>=0&&end>start);const login=html.slice(start,end);
 assert.doesNotMatch(html,/id="schoolSplash"|dismissSchoolSplash|function closeSplash/);
 assert.doesNotMatch(login,/<(?:input|textarea)\b|contenteditable/i);
 assert.equal((login.match(/src="\.\/logo\.png"/g)||[]).length,2);
 assert.match(login,/id="schoolLoginPad"/);assert.match(login,/type="submit"[^>]*id="loginSubmitBtn"/);
 assert.match(html,/SCHOOL_LOGIN_PIN_MIN_LENGTH=4/);assert.match(html,/SCHOOL_LOGIN_PIN_MAX_LENGTH=20/);
 assert.match(html,/event\.key==="Backspace"/);assert.match(html,/event\.key==="Enter"/);assert.match(html,/Numpad\[0-9\]/);
 assert.ok(html.includes('document.body.classList.add("login-mode")'));
 assert.equal(manifest.start_url,"./index.html");assert.match(sw,/'\.\/logo\.png'/);
 assert.deepEqual([...logo.subarray(0,8)],[137,80,78,71,13,10,26,10],"school logo must be a valid PNG file");
});

test('PIN gate responsive layout removes helper text, shows only filled dots, and uses desktop landscape columns', () => {
  const loginStart = html.indexOf('<div id="loginView"');
  const loginEnd = html.indexOf('<section id="uiReviewLauncher"', loginStart);
  const login = html.slice(loginStart, loginEnd);
  const rendererStart = html.indexOf('function renderSchoolLoginPin()');
  const rendererEnd = html.indexOf('function setSchoolLoginPin(', rendererStart);
  const renderer = html.slice(rendererStart, rendererEnd);
  assert.ok(login.includes('<span>الرقم السري</span>'));
  assert.ok(!login.includes('schoolLoginShow'));
  assert.ok(!login.includes('schoolLoginHint'));
  assert.ok(!login.includes('أدخل الرمز ثم اضغط موافق'));
  assert.ok(!login.includes('تظهر أربع خانات'));
  assert.ok(renderer.includes('const count=schoolLoginPinCode.length'));
  assert.ok(renderer.includes('for(let i=0;i<count;i++)'));
  assert.ok(!renderer.includes('data-digit'));
  assert.ok(!renderer.includes('revealed'));
  assert.ok(html.includes('@media(max-width:759px)'));
  assert.ok(html.includes('@media(min-width:760px)'));
  assert.ok(html.includes('grid-template-columns:minmax(0,1fr) minmax(340px,440px)'));
  assert.ok(html.includes('min-height:100dvh'));
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(!head.includes('<script src='));
  const libs = html.indexOf('<script src="https://cdn.tailwindcss.com">');
  const core = html.indexOf('/* ============ Supabase & Crypto config ============ */');
  assert.ok(libs > 0 && core > libs);
  assert.equal(manifest.background_color, '#04121f');
  assert.equal(manifest.theme_color, '#04121f');
});

test('PIN gate structure, responsive layout, and masked-dot display remain valid', () => {
 const head=html.slice(0,html.indexOf('</head>'));
 assert.equal((head.match(/<style/g)||[]).length,head.split('</style>').length-1,'all head style tags must close before </head>');
 const bodyStart=html.indexOf('<body');
 const loginStart=html.indexOf('<div id="loginView"');
 assert.ok(bodyStart>0&&loginStart>bodyStart);
 assert.ok(loginStart<html.indexOf('</main>',loginStart));
 const login=html.slice(loginStart,html.indexOf('<section id="uiReviewLauncher"',loginStart));
 const renderer=html.slice(html.indexOf('function renderSchoolLoginPin()'),html.indexOf('function setSchoolLoginPin('));
 assert.ok(login.includes('<span>الرقم السري</span>'));
 assert.ok(!login.includes('schoolLoginShow'));
 assert.ok(!login.includes('schoolLoginHint'));
 assert.ok(!login.includes('أدخل الرمز ثم اضغط موافق'));
 assert.ok(!login.includes('تظهر أربع خانات'));
 assert.ok(renderer.includes('const count=schoolLoginPinCode.length'));
 assert.ok(renderer.includes('for(let i=0;i<count;i++)'));
 assert.ok(!renderer.includes('data-digit'));
 assert.ok(!renderer.includes('revealed'));
 assert.ok(html.includes('@media(max-width:759px)'));
 assert.ok(html.includes('@media(min-width:760px)'));
 assert.ok(html.includes('grid-template-columns:minmax(0,1fr) minmax(340px,440px)'));
 assert.ok(html.includes('min-height:100dvh'));
 assert.ok(!head.includes('<script src='));
 assert.equal(manifest.background_color,'#04121f');
 assert.equal(manifest.theme_color,'#04121f');
 assert.equal(manifest.orientation,'any');
});


test('PIN gate uses the full available phone viewport without shrinking touch controls or locking vertical scroll', () => {
  const firstPaintStart = html.indexOf('<style id="login-first-paint">');
  const firstPaintEnd = html.indexOf('</style>', firstPaintStart) + 8;
  const responsiveStart = html.indexOf('<style id="premium-pin-responsive-layout">');
  const responsiveEnd = html.indexOf('</style>', responsiveStart) + 8;
  const firstPaint = html.slice(firstPaintStart, firstPaintEnd);
  const responsive = html.slice(responsiveStart, responsiveEnd);
  assert.ok(firstPaint.includes('overflow-y:auto'));
  assert.ok(!firstPaint.includes('overflow:hidden'));
  assert.ok(responsive.includes('@media(max-width:759px)'));
  assert.ok(responsive.includes('flex-direction:column'));
  assert.ok(responsive.includes('width:100%;max-width:560px'));
  assert.ok(responsive.includes('min-height:100svh'));
  assert.ok(responsive.includes('overflow-y:auto!important'));
  assert.ok(responsive.includes('height:clamp(54px,7dvh,66px)'));
  assert.ok(responsive.includes('font-size:clamp(18px,4.7vw,24px)'));
  assert.ok(responsive.includes('@media(min-width:760px)'));
  assert.ok(responsive.includes('grid-template-columns:minmax(0,1fr) minmax(340px,440px)'));
  assert.doesNotMatch(responsive, /max-height:620px|\\.sl-key\\{height:36px|\\.sl-key\\{font-size:9px/);
  assert.ok(html.includes('2026-11-27-direct-pin-login-5'));
  assert.ok(html.includes('sw.js?v=20261127-direct-pin-login-5'));
});
