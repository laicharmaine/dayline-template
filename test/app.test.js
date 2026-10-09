'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../lib/app');
const { createFixtureNotionFetch } = require('../lib/fixture-notion');
const { createNotionClient } = require('../lib/notion');
const { createJobsClient, JOBS_DEFAULT_DATA_SOURCE_ID } = require('../lib/jobs');
const { res, mockFetch, publicLookup } = require('./helpers');

const NOW = new Date('2026-10-05T10:56:00-05:00');
const config = { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' };
const TASK_DS = '11111111-1111-4111-8111-111111111111';

function fakes() {
  const tasks = [
    { id: 'a', name: 'Double-check tax', done: false, priority: 'Medium', area: 'Personal', due: { key: '2026-09-09', time: null } },
    { id: 'b', name: 'Marketing club apps', done: false, priority: 'High', area: 'School', due: { key: '2026-10-05', time: null } },
    { id: 'c', name: 'Read case', done: false, priority: 'Low', area: 'School', due: { key: '2026-10-08', time: null } },
  ];
  const events = [
    { id: 'e1', title: 'Business Strategy', start: '2026-10-05T15:30:00.000Z', end: '2026-10-05T17:00:00.000Z', startKey: '2026-10-05', endKey: '2026-10-05', allDay: false, deadline: false },
    { id: 'e2', title: 'Assignment #3', start: '2026-10-09T17:00:00.000Z', end: '2026-10-09T17:00:00.000Z', startKey: '2026-10-09', endKey: '2026-10-09', allDay: false, deadline: true },
  ];
  const jobsList = [{ id: 'j1', role: 'PM Intern 2027', company: 'Example Labs', status: 'Opportunity', url: 'https://jobs.ashbyhq.com/example-labs/0e0e0e0e-1234-4abc-8def-0123456789ab' }];
  return {
    notion: { listOpen: async () => tasks, listDone: async () => [], create: async (f) => ({ id: 'n', done: false, ...f }), update: async (id, f) => ({ id, done: f.status === 'Done', name: 'x', ...f }) },
    calendar: { getEvents: async () => events, status: () => [] },
    jobs: { list: async () => jobsList, getCaps: async () => ({ applied: true, nextDate: true, interested: true }), create: async (f) => ({ id: 'new', ...f }), update: async (id, f) => ({ id, ...f }) },
  };
}

async function start(extra = {}) {
  const f = fakes();
  const app = createApp({ config, ...f, now: () => NOW, ...extra });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base + p, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const login = async () => { const r = await call('/api/login', { method: 'POST', body: { password: config.appPassword } }); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; };
  return { server, call, login, close: () => new Promise((r) => server.close(r)) };
}

test('every API route and page is behind the password', async () => {
  const s = await start();
  try {
    const routes = [['GET', '/api/me'], ['GET', '/api/today'], ['GET', '/api/agenda'], ['GET', '/api/tasks'], ['GET', '/api/month'], ['GET', '/api/status'], ['GET', '/api/socializing'], ['PUT', '/api/socializing/plans'], ['DELETE', '/api/socializing/plans'], ['GET', '/api/brainstorm'], ['POST', '/api/brainstorm'], ['PATCH', '/api/brainstorm/abcdef01234541238123456789abcdef'], ['DELETE', '/api/brainstorm/abcdef01234541238123456789abcdef'], ['GET', '/api/jobs'],
      ['POST', '/api/tasks'], ['PATCH', '/api/tasks/abcdef01234541238123456789abcdef'], ['POST', '/api/jobs'], ['PATCH', '/api/jobs/abcdef01234541238123456789abcdef'], ['DELETE', '/api/jobs/abcdef01234541238123456789abcdef'], ['POST', '/api/jobs/abcdef01234541238123456789abcdef/resume-tips'], ['POST', '/api/jobs/parse'], ['GET', '/api/nope']];
    for (const [method, p] of routes) {
      const r = await s.call(p, { method, body: method === 'GET' ? undefined : { name: 'x', url: 'https://example.com' } });
      assert.equal(r.status, 401, `${method} ${p}`);
    }
    for (const p of ['/', '/today', '/tasks', '/jobs', '/opportunities']) {
      const r = await s.call(p);
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.get('location'), '/login');
    }
    const forged = await s.call('/api/me', { cookie: 'dl_session=eyJ2IjoxLCJleHAiOjk5OTk5OTk5OTl9.AAAA' });
    assert.equal(forged.status, 401);
  } finally { await s.close(); }
});

test('login sets an httpOnly cookie; wrong passwords are rate limited', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 8; i++) assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
    assert.equal((await s.call('/api/login', { method: 'POST', body: { password: config.appPassword } })).status, 429);
  } finally { await s.close(); }
  const s2 = await start();
  try {
    const r = await s2.call('/api/login', { method: 'POST', body: { password: config.appPassword } });
    assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const me = await (await s2.call('/api/me', { cookie })).json();
    assert.equal(me.today, '2026-10-05');
    assert.equal((await s2.call('/today', { cookie })).status, 200);
  } finally { await s2.close(); }
});

test('cross-origin writes are refused', async () => {
  const s = await start();
  try {
    const cookie = await s.login();
    const r = await s.call('/api/tasks', { method: 'POST', cookie, body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});

test('today, tasks and month endpoints', async () => {
  const s = await start();
  try {
    const cookie = await s.login();
    const today = await (await s.call('/api/today', { cookie })).json();
    assert.deepEqual(today.overdue.map((t) => t.name), ['Double-check tax']);
    assert.deepEqual(today.dueToday.map((t) => t.name), ['Marketing club apps']);
    assert.equal(today.nextUp.state, 'now');
    const month = await (await s.call('/api/month?month=2026-10', { cookie })).json();
    assert.equal(month.gridStart, '2026-09-28');
    assert.equal(month.gridEnd, '2026-11-08');
    assert.deepEqual(month.days['2026-10-05'], { tasks: 1, events: 1, deadlines: 0, overdue: 0 });
    assert.deepEqual(month.days['2026-10-09'], { tasks: 0, events: 0, deadlines: 1, overdue: 0 });
    assert.equal(month.days['2026-09-09'], undefined); // outside the 6-week grid
    const bad = await s.call('/api/tasks', { method: 'POST', cookie, body: { name: '' } });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('jobs endpoints split tracker/opportunities and parse never saves', async () => {
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'PM Intern 2027', hiringOrganization: { name: 'Example Labs' }, jobLocation: { address: { addressLocality: 'San Francisco' } }, description: 'x' })}</script>`;
  const parser = { fetchImpl: mockFetch([[() => true, res(200, `<html><head>${ld}</head></html>`)]]), lookup: publicLookup };
  let saved = 0;
  const f = fakes();
  f.jobs.create = async (x) => { saved++; return { id: 'new', ...x }; };
  const s = await start({ parser, jobs: f.jobs });
  try {
    const cookie = await s.login();
    const list = await (await s.call('/api/jobs', { cookie })).json();
    assert.equal(list.opportunities.length, 1);
    assert.equal(list.tracker.length, 0);
    const parsed = await (await s.call('/api/jobs/parse', { method: 'POST', cookie, body: { url: 'https://jobs.ashbyhq.com/example-labs/0e0e0e0e-1234-4abc-8def-0123456789ab?utm=x' } })).json();
    assert.equal(parsed.fields.company, 'Example Labs');
    assert.equal(parsed.fields.location, 'SF');
    assert.deepEqual(parsed.duplicate, { id: 'j1', role: 'PM Intern 2027', company: 'Example Labs', status: 'Opportunity' });
    assert.equal(saved, 0);
    const priv = await s.call('/api/jobs/parse', { method: 'POST', cookie, body: { url: 'http://127.0.0.1:4320/api/tasks' } });
    assert.equal(priv.status, 400);
    assert.equal((await priv.json()).canPaste, false);
    const created = await s.call('/api/jobs', { method: 'POST', cookie, body: { role: 'PM Intern 2027', company: 'Example Labs', status: 'Interested' } });
    assert.equal(created.status, 201);
    assert.equal(saved, 1);
    assert.equal((await s.call('/api/jobs', { method: 'POST', cookie, body: { role: 'x', status: 'Rejected' } })).status, 400);
  } finally { await s.close(); }
});

test('fixture mode writes only to *.local.json and rejects unknown options like Notion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-'));
  const real = path.join(__dirname, '..', 'data', 'fixtures');
  const seedT = path.join(dir, 'tasks.json'), seedJ = path.join(dir, 'jobs.json');
  const hasReal = fs.existsSync(path.join(real, 'notion-pages.json')) && fs.existsSync(path.join(real, 'notion-jobs.json'));
  if (hasReal) { fs.copyFileSync(path.join(real, 'notion-pages.json'), seedT); fs.copyFileSync(path.join(real, 'notion-jobs.json'), seedJ); } else {
    const page = (id, props) => ({ object: 'page', id, created_time: '2026-09-01T00:00:00.000Z', last_edited_time: '2026-09-01T00:00:00.000Z', in_trash: false, url: 'u', properties: props });
    fs.writeFileSync(seedT, JSON.stringify({ dataSource: { properties: { 'Task name': { type: 'title' }, Status: { type: 'status' }, Area: { type: 'select', select: { options: [{ name: 'School' }] } }, Priority: { type: 'select', select: { options: [{ name: 'High' }] } }, 'Due date': { type: 'date' } } },
      pages: [page('aaaaaaaa-0000-4000-8000-000000000001', { 'Task name': { title: [{ plain_text: 'Club B app' }] }, Status: { status: { name: 'Not started' } } })] }));
    fs.writeFileSync(seedJ, JSON.stringify({ dataSource: { properties: { Name: { type: 'title' }, Stage: { type: 'select', select: { options: [{ name: 'Researching' }, { name: 'Interested' }] } } } },
      pages: [page('aaaaaaaa-0000-4000-8000-000000000002', { Name: { title: [{ plain_text: 'PM Intern' }] }, Stage: { select: { name: 'Researching' } } })] }));
  }
  const hash = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  const before = [hash(seedT), hash(seedJ)];
  const fx = createFixtureNotionFetch({ sources: [
    { dataSourceId: TASK_DS, seedFile: seedT, localFile: path.join(dir, 'tasks.local.json') },
    { dataSourceId: JOBS_DEFAULT_DATA_SOURCE_ID, seedFile: seedJ, localFile: path.join(dir, 'jobs.local.json') },
  ] });
  const notion = createNotionClient({ token: 'fixture', dataSourceId: TASK_DS, fetchImpl: fx });
  const jobs = createJobsClient({ token: 'fixture', fetchImpl: fx });
  const [task] = await notion.listOpen();
  const done = await notion.update(task.id, { status: 'Done' });
  assert.equal(done.done, true);
  const opp = (await jobs.list()).find((j) => j.status === 'Opportunity');
  assert.equal((await jobs.update(opp.id, { status: 'Interested' })).status, 'Interested');
  if (hasReal) { // the real-schema snapshot has "Added by": rows made in Dayline are marked as hers
    assert.equal((await notion.create({ name: 'Fixture-only task' })).addedBy, 'Me');
    assert.equal((await jobs.create({ role: 'Fixture-only job' })).addedBy, 'Me');
  }
  if (hasReal) { // notes + link round-trip through the fixture copy (never Notion)
    const t = await notion.create({ name: 'Fixture notes task', notes: 'Portal: https://portal.example/app\nsecond line', link: 'https://apps.example/x' });
    assert.equal(t.link, 'https://apps.example/x');
    assert.match(t.notes, /second line/);
    const long = 'z'.repeat(4100);
    const u = await notion.update(t.id, { notes: long, link: null });
    assert.equal(u.notes, long);
    assert.equal(u.link, null);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.local.json'), 'utf8')).pages.find((pg) => pg.id === t.id);
    assert.deepEqual(raw.properties.Notes.rich_text.map((r) => r.text.content.length), [2000, 2000, 100]);
  }
  await assert.rejects(notion.update(task.id, { area: 'Work' }), (e) => e.status === 400 && e.code === 'validation_error');
  assert.deepEqual([hash(seedT), hash(seedJ)], before, 'seed files untouched');
  assert.ok(fs.existsSync(path.join(dir, 'tasks.local.json')) && fs.existsSync(path.join(dir, 'jobs.local.json')));
  const otherCalls = await fx('https://api.notion.com/v1/blocks/x', { method: 'GET' });
  assert.equal(otherCalls.status, 400); // anything else is refused, and nothing goes to the network
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DELETE /api/jobs archives; resume tips are on-demand for Interested+', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-jdel-'));
  const real = path.join(__dirname, '..', 'data', 'fixtures');
  assert.ok(fs.existsSync(path.join(real, 'notion-jobs.json')));
  const seedJ = path.join(dir, 'jobs.json');
  fs.copyFileSync(path.join(real, 'notion-jobs.json'), seedJ);
  const fx = createFixtureNotionFetch({ sources: [
    { dataSourceId: '11111111-1111-4111-8111-111111111111', seedFile: path.join(real, 'notion-pages.json'), localFile: path.join(dir, 'tasks.local.json') },
    { dataSourceId: JOBS_DEFAULT_DATA_SOURCE_ID, seedFile: seedJ, localFile: path.join(dir, 'jobs.local.json') },
  ] });
  const notion = createNotionClient({ token: 'fixture', dataSourceId: '11111111-1111-4111-8111-111111111111', fetchImpl: fx });
  const jobs = createJobsClient({ token: 'fixture', fetchImpl: fx });
  const list = await jobs.list();
  const interested = list.find((j) => j.status === 'Interested') || list.find((j) => j.status === 'Applied') || list.find((j) => j.status !== 'Opportunity');
  assert.ok(interested, 'fixture needs a tracker job');
  const s = await start({ notion, jobs });
  try {
    const cookie = await s.login();
    const bad = await s.call(`/api/jobs/${interested.id}`, { method: 'DELETE', cookie, body: {} });
    assert.equal(bad.status, 400);
    const tips = await s.call(`/api/jobs/${interested.id}/resume-tips`, { method: 'POST', cookie, body: {} });
    assert.equal(tips.status, 200);
    const body = await tips.json();
    assert.ok(body.suggestions.length >= 3);
    const archived = await s.call(`/api/jobs/${interested.id}?mode=archive`, { method: 'DELETE', cookie, body: {} });
    assert.equal(archived.status, 200);
    assert.equal((await archived.json()).archived, true);
    const after = await (await s.call('/api/jobs', { cookie })).json();
    assert.ok(!after.tracker.some((j) => j.id === interested.id));
    assert.ok(!after.opportunities.some((j) => j.id === interested.id));
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
