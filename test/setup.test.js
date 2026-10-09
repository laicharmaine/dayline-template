'use strict';
// First-time setup against a MOCKED Notion API (no network, no real workspace).
const test = require('node:test');
const assert = require('node:assert/strict');
const { TITLES, ENV, schemas, parsePageRef, createSetupClient, envFor } = require('../lib/setup');
const { createApp } = require('../lib/app');

const PARENT = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const PARENT_URL = 'https://www.notion.so/My-Dayline-abcdefabcdef4abc8defabcdefabcdef';

/** Tiny in-memory Notion: pages, databases/data sources, search. Records every call. */
function fakeNotion({ statusUnsupported = false, shared = true } = {}) {
  const calls = [];
  const dataSources = new Map();
  let n = 0;
  const id = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  async function fetchImpl(url, opts = {}) {
    const p = url.replace('https://api.notion.com', '');
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method: opts.method, path: p, body, auth: opts.headers.Authorization, version: opts.headers['Notion-Version'] });
    if (opts.headers.Authorization !== 'Bearer ntn_fake') return json(401, { code: 'unauthorized', message: 'API token is invalid.' });
    if (opts.method === 'GET' && p === `/v1/pages/${PARENT}`) return shared ? json(200, { object: 'page', id: PARENT }) : json(404, { code: 'object_not_found', message: 'Could not find page' });
    if (opts.method === 'POST' && p === '/v1/search') {
      if (body.filter.value === 'page') return json(200, { results: [{ object: 'page', id: PARENT, url: PARENT_URL, parent: { type: 'workspace' }, properties: { title: { type: 'title', title: [{ plain_text: 'My Dayline' }] } } }], has_more: false });
      return json(200, { results: [...dataSources.values()].map((d) => ({ object: 'data_source', id: d.id, title: [{ plain_text: d.title }], database_parent: { type: 'page_id', page_id: d.parent } })), has_more: false });
    }
    if (opts.method === 'POST' && p === '/v1/databases') {
      const props = body.initial_data_source.properties;
      if (statusUnsupported && Object.values(props).some((x) => x.status)) return json(400, { code: 'validation_error', message: 'status is not supported' });
      for (const [name, def] of Object.entries(props)) {
        if (def.relation && !dataSources.has(def.relation.data_source_id)) return json(400, { code: 'validation_error', message: `bad relation ${name}` });
      }
      const ds = { id: id(), title: body.title[0].text.content, parent: body.parent.page_id, properties: props };
      dataSources.set(ds.id, ds);
      return json(200, { object: 'database', id: id(), data_sources: [{ id: ds.id, name: ds.title }] });
    }
    const m = p.match(/^\/v1\/data_sources\/([\w-]+)$/);
    if (m && dataSources.has(m[1])) {
      const ds = dataSources.get(m[1]);
      if (opts.method === 'PATCH') Object.assign(ds.properties, body.properties);
      return json(200, { object: 'data_source', id: ds.id, properties: ds.properties });
    }
    return json(404, { code: 'object_not_found', message: `no route ${opts.method} ${p}` });
  }
  return { fetchImpl, calls, dataSources };
}

test('parsePageRef: ids, dashed ids and page links; junk is refused', () => {
  assert.equal(parsePageRef(PARENT), PARENT);
  assert.equal(parsePageRef(PARENT.replace(/-/g, '')), PARENT);
  assert.equal(parsePageRef(PARENT_URL), PARENT);
  assert.equal(parsePageRef(PARENT_URL + '?pvs=4'), PARENT);
  assert.equal(parsePageRef('not a page'), null);
  assert.equal(parsePageRef(''), null);
});

test('schemas: every database has exactly one title; relations point at the right data sources', () => {
  const s = schemas({ jobs: 'J', people: 'P' });
  assert.deepEqual(Object.keys(s).sort(), Object.keys(TITLES).sort());
  for (const [k, props] of Object.entries(s)) assert.equal(Object.values(props).filter((p) => p.title).length, 1, k);
  assert.deepEqual(s.todo.Status, { status: {} });
  assert.deepEqual(s.people['Pipeline jobs'].relation, { data_source_id: 'J', type: 'single_property', single_property: {} });
  assert.deepEqual(s.touchpoints.Person.relation, { data_source_id: 'P', type: 'dual_property', dual_property: {} });
  assert.equal(s.touchpoints['Related job'].relation.data_source_id, 'J');
  assert.ok(s.todo['Added by'].select.options.some((o) => o.name === 'Me'));
  assert.equal(schemas().people['Pipeline jobs'], undefined, 'no relation without the target id');
});

test('createAll makes all six databases under the chosen page, wires relations, and returns env lines', async () => {
  const fake = fakeNotion();
  const setup = createSetupClient({ token: 'ntn_fake', fetchImpl: fake.fetchImpl });
  const out = await setup.createAll(PARENT_URL);
  assert.equal(out.parent, PARENT);
  assert.deepEqual(out.created, ['todo', 'jobs', 'brainstorm', 'people', 'touchpoints', 'store']);
  assert.equal(fake.dataSources.size, 6);
  for (const ds of fake.dataSources.values()) assert.equal(ds.parent, PARENT);
  assert.deepEqual([...fake.dataSources.values()].map((d) => d.title).sort(), Object.values(TITLES).sort());
  const people = fake.dataSources.get(out.ids.people);
  assert.equal(people.properties['Introduced by'].relation.data_source_id, out.ids.people, 'self relation added after creation');
  assert.equal(people.properties['Pipeline jobs'].relation.data_source_id, out.ids.jobs);
  assert.equal(fake.dataSources.get(out.ids.touchpoints).properties.Person.relation.data_source_id, out.ids.people);
  const lines = out.env.split('\n');
  assert.equal(lines.length, 6);
  for (const [k, name] of Object.entries(ENV)) assert.ok(lines.includes(`${name}=${out.ids[k]}`), name);
  assert.ok(fake.calls.every((c) => c.version && c.auth === 'Bearer ntn_fake'));
  assert.ok(!fake.calls.some((c) => c.method === 'DELETE' || /\/v1\/pages$/.test(c.path)), 'never creates or deletes pages');
});

test('createAll is safe to re-run: existing Dayline databases under that page are reused, not duplicated', async () => {
  const fake = fakeNotion();
  const setup = createSetupClient({ token: 'ntn_fake', fetchImpl: fake.fetchImpl });
  const first = await setup.createAll(PARENT);
  const again = await setup.createAll(PARENT);
  assert.equal(fake.dataSources.size, 6);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.ids, first.ids);
  assert.equal(again.env, first.env);
  assert.deepEqual(await setup.findExisting(), first.ids);
});

test('if Notion refuses a status property, To Do falls back to a select with the same options', async () => {
  const fake = fakeNotion({ statusUnsupported: true });
  const out = await createSetupClient({ token: 'ntn_fake', fetchImpl: fake.fetchImpl }).createAll(PARENT);
  const status = fake.dataSources.get(out.ids.todo).properties.Status;
  assert.deepEqual(status.select.options.map((o) => o.name), ['Not started', 'In progress', 'Done']);
});

test('friendly errors: missing token, bad token, page not shared, bad link', async () => {
  assert.throws(() => createSetupClient({ token: '' }), /Paste your Notion integration token/);
  await assert.rejects(createSetupClient({ token: 'ntn_wrong', fetchImpl: fakeNotion().fetchImpl }).createAll(PARENT), (e) => e.status === 400 && /token is wrong/.test(e.message));
  await assert.rejects(createSetupClient({ token: 'ntn_fake', fetchImpl: fakeNotion({ shared: false }).fetchImpl }).createAll(PARENT), (e) => e.status === 400 && /Connections/.test(e.message));
  await assert.rejects(createSetupClient({ token: 'ntn_fake', fetchImpl: fakeNotion().fetchImpl }).createAll('hello'), (e) => e.status === 400);
  assert.equal(envFor({ todo: 'a', store: 'b' }), 'NOTION_DATA_SOURCE_ID=a\nDAYLINE_STORE_DATA_SOURCE_ID=b');
});

async function serve(opts) {
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'live', production: false, geminiKey: '', notionToken: '', ...opts.config },
    notion: null, calendar: { getEvents: async () => [], status: () => [] }, setupMode: opts.setupMode, setupFetch: opts.setupFetch,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, location: res.headers.get('location'), body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  };
  return { server, base, call, close: () => new Promise((r) => server.close(r)) };
}

test('setup mode: pages redirect to /setup, other APIs wait, /setup is behind the password and creates the databases', async () => {
  const fake = fakeNotion();
  const s = await serve({ setupMode: true, setupFetch: fake.fetchImpl });
  try {
    assert.equal((await fetch(s.base + '/setup', { redirect: 'manual' })).status, 302, 'signed-out visitors go to login');
    assert.equal((await fetch(s.base + '/api/setup/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const home = await s.call('/');
    assert.equal(home.status, 302);
    assert.equal(home.location, '/setup');
    assert.match((await s.call('/setup')).body, /setup/i);
    assert.equal((await s.call('/api/tasks')).status, 409);
    const st = await s.call('/api/setup/status');
    assert.equal(st.body.setupMode, true);
    assert.equal(st.body.hasToken, false);
    const pages = await s.call('/api/setup/pages', { method: 'POST', body: { token: 'ntn_fake' } });
    assert.deepEqual(pages.body.pages.map((p) => p.title), ['My Dayline']);
    const made = await s.call('/api/setup/create', { method: 'POST', body: { token: 'ntn_fake', parent: PARENT_URL } });
    assert.equal(made.status, 201);
    assert.equal(made.body.env.split('\n').length, 6);
    assert.ok(!JSON.stringify(made.body).includes('ntn_fake'), 'the token is never echoed back');
    const bad = await s.call('/api/setup/create', { method: 'POST', body: { token: 'ntn_wrong', parent: PARENT } });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('setup is refused in demo (fixture) mode', async () => {
  const s = await serve({ setupMode: false, config: { mode: 'fixture' }, setupFetch: async () => { throw new Error('must not call Notion'); } });
  try {
    assert.equal((await s.call('/api/setup/create', { method: 'POST', body: { token: 'ntn_fake', parent: PARENT } })).status, 409);
  } finally { await s.close(); }
});
