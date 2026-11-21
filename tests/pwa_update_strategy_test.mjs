import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('installed PWA checks for a fresh service worker on startup', () => {
  assert.match(html, /register\("\.\/sw\.js",\s*\{\s*updateViaCache:\s*"none"\s*\}\)/);
  assert.match(html, /registration\.update\(\)/);
});

test('PWA navigation bypasses the browser HTTP cache and rotates app caches', () => {
  assert.match(sw, /fetch\(request,\s*\{\s*cache:\s*'no-store'\s*\}\)/);
  assert.match(sw, /abudujana-app-v40/);
  assert.match(sw, /abudujana-static-v47/);
});
