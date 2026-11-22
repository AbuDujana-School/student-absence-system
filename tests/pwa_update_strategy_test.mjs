import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('installed PWA checks for a fresh service worker on startup', () => {
  assert.match(html, /register\("\.\/sw\.js",\s*\{\s*updateViaCache:\s*"none"\s*\}\)/);
  assert.match(html, /registration\.update\(\)/);
});

test('service worker updates rotate both application caches', () => {
  assert.match(sw, /abudujana-app-v43/);
  assert.match(sw, /abudujana-static-v50/);
  assert.match(sw, /fetch\(request,\s*\{\s*cache:\s*'no-store'\s*\}\)/);
});

test('installed pages refresh after a new worker controls the login page', () => {
  assert.match(html, /hadControllerAtStartup = Boolean\(navigator\.serviceWorker\.controller\)/);
  assert.match(html, /navigator\.serviceWorker\.addEventListener\("controllerchange"/);
  assert.match(html, /if \(loginIsVisible\)\s*\{\s*window\.location\.reload\(\)/);
  assert.match(html, /pwaUpdateNotice/);
  assert.match(html, /تحديث الآن/);
});
