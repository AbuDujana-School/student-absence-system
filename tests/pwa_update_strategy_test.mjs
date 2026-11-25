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
