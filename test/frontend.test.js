// Front-end sanity checks: the app parses, wires up its elements, keeps desktop at >=1024px and has the phone layout + manifest below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'views', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('app.js compiles', () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'app.js' }));
});

test('index.html has the sidebar nav, quick actions and shared elements app.js uses', () => {
  for (const id of ['searchBtn', 'quickTask', 'quickJob', 'menuBtn', 'helpBtn', 'sheet', 'backdrop', 'toast', 'modePill']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  for (const view of ['today', 'week', 'tasks', 'jobs', 'opps']) assert.match(html, new RegExp(`data-view="${view}"`));
});

test('responsive: desktop layout kept at >=1024px, phone layout below, installable, no service worker', () => {
  for (const fn of ['viewToday', 'viewWeek', 'viewTasks', 'viewJobs', 'viewOpps', 'viewClasses', 'viewSocial', 'openSearch', 'openShortcuts', 'openMoreSheet']) {
    assert.match(js, new RegExp(`function ${fn}\\(`), `missing ${fn}()`);
  }
  // one breakpoint, shared by CSS and JS
  assert.match(js, /matchMedia\('\(max-width: 1023px\)'\)/);
  assert.match(css, /@media \(max-width: 1023px\)/);
  // desktop rules untouched: sidebar + min-width still apply at >=1024px
  assert.match(css, /body \{ min-width: var\(--min-w\); \}/);
  assert.match(css, /--min-w: 1100px/);
  assert.match(css, /\.mbar, \.tabbar \{ display: none; \}/);
  // phone chrome + installability
  for (const id of ['mSearch', 'mAdd', 'mMore']) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  for (const tab of ['today', 'tasks', 'jobs', 'classes', 'chats', 'more']) assert.match(html, new RegExp(`data-tab="${tab}"`));
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(html, /name="theme-color"/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) assert.ok(fs.existsSync(path.join(root, 'public', icon.src)), `missing ${icon.src}`);
  assert.ok(fs.existsSync(path.join(root, 'public', 'apple-touch-icon.png')));
  // no offline service worker (not needed; keeps the stale-asset reload simple)
  assert.doesNotMatch(js, /serviceWorker/);
  for (const f of ['sw.js', 'service-worker.js']) assert.equal(fs.existsSync(path.join(root, 'public', f)), false, `public/${f} should not exist`);
  // stale-asset auto-reload still wired
  assert.match(js, /X-Dayline-Asset/);
});

test('keyboard shortcuts cover new task, new job, search and view switching', () => {
  for (const key of ["'n'", "'j'", "'/'", "'?'"]) assert.ok(js.includes(key), `no handler for ${key}`);
});
