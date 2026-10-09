'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClassMatcher, CONFIG } = require('../lib/classes');
const { validateTaskInput, buildCreateRequest, buildUpdateRequest, createNotionClient } = require('../lib/notion');
const { createFixtureNotionFetch } = require('../lib/fixture-notion');
const { createApp } = require('../lib/app');
const { FIXTURE_IDS } = require('../lib/config');

const m = createClassMatcher();

test('config/classes.js: every class has an option and codes; every activity has keywords', () => {
  for (const c of CONFIG.classes) { assert.ok(c.option, 'option'); assert.ok((c.codes || []).length > 0, c.option); }
  for (const a of CONFIG.activities) assert.ok(a.keywords.length > 0, a.option);
  assert.equal(new Set(m.options).size, m.options.length, 'options are unique');
});

// Matching logic is tested against a fixed config so editing config/classes.js never breaks these tests.
const TEST_CONFIG = {
  classes: [
    { option: 'ABC-101', codes: ['ABC 101'] },
    { option: 'XYZ-202', codes: ['XYZ 202'] },
    { option: 'QRS-303', codes: ['QRS 303'] },
  ],
  activities: [
    { option: 'Club B', keywords: ['Club B', 'Bake Sale Committee'] },
    { option: 'Robotics Team', keywords: ['Robotics'] },
  ],
};
const tm = createClassMatcher(TEST_CONFIG);

test('task titles match only on a full course code or a whole-word activity keyword', () => {
  const cases = [
    ['ABC-101 prep — Class 5', ['ABC-101']],
    ['abc 101 notes', ['ABC-101']],
    ['XYZ202 HW', ['XYZ-202']],
    ['QRS-303 and ABC-101 combo', ['ABC-101', 'QRS-303']],
    ['Club B flyer', ['Club B']],
    ['Bake Sale Committee tickets', ['Club B']],
    ['Robotics newsletter', ['Robotics Team']],
    // not confident enough: left blank
    ["Read today's ABC assignment", []],
    ['XYZ 2020 thing', []],
    ['Clubhouse meeting', []],
    ['Roboticsish slide', []],
  ];
  for (const [title, want] of cases) assert.deepEqual(tm.matchTitle(title), want, title);
});

test('calendar events map by Canvas course first, then by title', () => {
  assert.equal(tm.matchEvent({ course: 'QRS 303', title: 'Review Session' }), 'QRS-303');
  assert.equal(tm.matchEvent({ title: 'ABC 101 Session 5' }), 'ABC-101');
  assert.equal(tm.matchEvent({ title: 'Club B committee meeting' }), 'Club B');
  assert.equal(tm.matchEvent({ title: 'Dinner with a friend' }), null);
});

test('class matcher exposes midterm/final from config', () => {
  const x = createClassMatcher({ classes: [{ option: 'XYZ-202', codes: ['XYZ 202'], midterm: '2026-10-27', final: '2026-12-04' }] });
  assert.equal(x.items[0].midterm, '2026-10-27');
  assert.equal(x.items[0].final, '2026-12-04');
});

test('validateTaskInput accepts a list of classes and rejects bad shapes', () => {
  assert.deepEqual(validateTaskInput({ name: 'x', classes: [' ABC-101 ', 'ABC-101', 'Club B'] }).value.classes, ['ABC-101', 'Club B']);
  assert.deepEqual(validateTaskInput({ name: 'x', classes: null }).value.classes, []);
  assert.ok(validateTaskInput({ name: 'x', classes: 'ABC-101' }).error);
  assert.ok(validateTaskInput({ name: 'x', classes: Array.from({ length: 11 }, (_, i) => `C${i}`) }).error);
});

test('create/update payloads write Class / Activity as multi_select only when the column exists', () => {
  const caps = { notes: true, link: true, classes: true };
  const create = buildCreateRequest('ds', { name: 'x', classes: ['Class A'] }, { caps });
  assert.deepEqual(create.body.properties['Class / Activity'], { multi_select: [{ name: 'Class A' }] });
  assert.equal(buildCreateRequest('ds', { name: 'x', classes: [] }, { caps }).body.properties['Class / Activity'], undefined);
  assert.deepEqual(buildUpdateRequest('p', { classes: [] }, { caps }).body.properties['Class / Activity'], { multi_select: [] });
  assert.equal(buildUpdateRequest('p', { classes: ['Class A'] }, { caps: { ...caps, classes: false } }).body.properties['Class / Activity'], undefined);
});

const real = path.join(__dirname, '..', 'data', 'fixtures', 'notion-pages.json');
test('fixture copy: classes round-trip and unknown options are refused (never Notion)', { skip: !fs.existsSync(real) && 'no fixtures' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-cls-'));
  const seed = path.join(dir, 'tasks.json');
  fs.copyFileSync(real, seed);
  const ds = FIXTURE_IDS.todo;
  const fx = createFixtureNotionFetch({ sources: [{ dataSourceId: ds, seedFile: seed, localFile: path.join(dir, 'tasks.local.json') }] });
  const notion = createNotionClient({ token: 'fixture', dataSourceId: ds, fetchImpl: fx });
  const caps = await notion.getCaps();
  assert.equal(caps.classes, true);
  assert.ok(caps.classOptions.includes('Club B'));
  const open = await notion.listOpen();
  assert.ok(open.some((t) => t.classes.includes('Class A')), 'fixture rows carry classes');
  const t = await notion.create({ name: 'Fixture Club B task', classes: ['Club B'] });
  assert.deepEqual(t.classes, ['Club B']);
  assert.deepEqual((await notion.update(t.id, { classes: ['Club B', 'Class A'] })).classes, ['Club B', 'Class A']);
  assert.deepEqual((await notion.update(t.id, { classes: [] })).classes, []);
  await assert.rejects(notion.update(t.id, { classes: ['Underwater Basket Weaving'] }), (e) => e.status === 400 && e.code === 'unknown_option');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/api/classes maps calendar events to classes within the session/deadline windows', async () => {
  const NOW = new Date('2026-10-05T10:56:00-05:00');
  const ev = (id, title, startKey, extra = {}) => ({ id, title, start: `${startKey}T19:00:00.000Z`, end: `${startKey}T20:30:00.000Z`, startKey, endKey: startKey, allDay: false, deadline: false, ...extra });
  const events = [
    ev('s1', 'Strategy ABC 101', '2026-10-06'),
    ev('s2', 'Review Session', '2026-10-08', { course: 'XYZ-202' }),
    ev('s3', 'ABC-101 far session', '2026-11-02'), // beyond 3 weeks: dropped
    ev('d1', 'Assignment #3', '2026-11-06', { course: 'XYZ 202', deadline: true }), // deadline within 6 weeks: kept
    ev('c1', 'Canceled: ABC 101', '2026-10-07', { canceled: true }),
    ev('p1', 'ABC 101 earlier', '2026-10-01'), // past
    ev('x1', 'Club B committee', '2026-10-10'),
    ev('n1', 'Dinner', '2026-10-06'),
  ];
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' },
    notion: { listOpen: async () => [], listDone: async () => [], getCaps: async () => ({ notes: true, link: true, classes: true, classOptions: m.options }) },
    calendar: { getEvents: async () => events, status: () => [] },
    jobs: { list: async () => [], getCaps: async () => ({}) },
    now: () => NOW,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/classes')).status, 401);
    const body = await (await fetch(base + '/api/classes', { headers: { cookie } })).json();
    assert.deepEqual(body.events.map((e) => [e.id, e.cls]), [['s1', 'Class A'], ['s2', 'Class B'], ['d1', 'Class B'], ['x1', 'Club B']]);
    assert.equal(body.items.length, m.items.length);
    assert.ok(body.items.every((i) => i.key && !('test' in i)));
    assert.deepEqual(body.notionOptions, m.options);
    const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    assert.equal(me.classes.find((c) => c.option === 'Class A').key, 'class-a');
    const tasks = await (await fetch(base + '/api/tasks', { headers: { cookie } })).json();
    assert.equal(tasks.caps.classes, true);
  } finally { await new Promise((r) => server.close(r)); }
});
