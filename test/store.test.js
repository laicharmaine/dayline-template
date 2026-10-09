'use strict';
// Dayline store backends (meal plans + thank-you reminders). No network: Turso and Notion are mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileStore, createTursoStore, createNotionStore, storeFromConfig } = require('../lib/store');
const { createStoreMealPlans } = require('../lib/mealplans');

async function contract(store) {
  assert.deepEqual(await store.list('meal'), []);
  await store.put('meal', '2026-10-14:dinner', { with: 'Sam Sample', planStatus: 'Planned' }, { date: '2026-10-14' });
  await store.put('meal', '2026-10-14:dinner', { with: 'Sam Sample', planStatus: 'Confirmed' }, { date: '2026-10-14' });
  await store.put('thanks', 'chat:abc', { kind: 'chat', state: 'open' });
  const meals = await store.list('meal');
  assert.equal(meals.length, 1);
  assert.equal(meals[0].data.planStatus, 'Confirmed');
  assert.equal(meals[0].date, '2026-10-14');
  assert.equal((await store.get('thanks', 'chat:abc')).data.kind, 'chat');
  assert.equal(await store.remove('meal', '2026-10-14:dinner'), true);
  assert.equal(await store.remove('meal', '2026-10-14:dinner'), false);
  assert.deepEqual(await store.list('meal'), []);
  await assert.rejects(store.put('tasks', 'x', {}), /Unknown store kind/);
}

test('file store: contract + meal plans on top', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-store-'));
  try {
    await contract(createFileStore({ file: path.join(dir, 's.json') }));
    const mp = createStoreMealPlans({ store: createFileStore({ file: path.join(dir, 'm.json') }) });
    const p = await mp.upsert({ date: '2026-10-15', meal: 'lunch', with: 'Jordan Example', planStatus: 'Reached out' });
    const p2 = await mp.upsert({ date: '2026-10-15', meal: 'lunch', with: 'Jordan Example J' }); // keeps status on name-only edit
    assert.equal(p2.id, p.id);
    assert.equal(p2.planStatus, 'Reached out');
    assert.equal((await mp.list({ from: '2026-10-15', to: '2026-10-15' })).length, 1);
    assert.equal((await mp.list({ from: '2026-10-16' })).length, 0);
    assert.deepEqual(await mp.clear({ date: '2026-10-15', meal: 'lunch' }), { cleared: true, id: p.id });
    await assert.rejects(mp.upsert({ date: '2026-10-15', meal: 'brunch', with: 'X' }), /lunch or dinner/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A tiny fake of the Turso HTTP pipeline that understands the statements lib/store.js sends. */
function fakeTurso() {
  const rows = new Map(); const calls = [];
  const val = (a) => (a.type === 'null' ? null : a.value);
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    const { requests } = JSON.parse(opts.body);
    assert.equal(requests.at(-1).type, 'close');
    const results = requests.filter((r) => r.type === 'execute').map(({ stmt }) => {
      const a = (stmt.args || []).map(val); let out = []; let affected = 0;
      if (/^CREATE TABLE/.test(stmt.sql)) { /* ok */ } else if (/^SELECT .* WHERE kind = \? AND key = \?/.test(stmt.sql)) {
        const r = rows.get(`${a[0]}|${a[1]}`); out = r ? [r] : [];
      } else if (/^SELECT/.test(stmt.sql)) out = [...rows.values()].filter((r) => r.kind === a[0]);
      else if (/^INSERT INTO records/.test(stmt.sql)) { rows.set(`${a[0]}|${a[1]}`, { kind: a[0], key: a[1], date: a[2], data: a[3], updated: a[4] }); affected = 1; } else if (/^DELETE/.test(stmt.sql)) affected = rows.delete(`${a[0]}|${a[1]}`) ? 1 : 0;
      else return { type: 'error', error: { message: 'unexpected sql' } };
      const cols = ['kind', 'key', 'date', 'data', 'updated'];
      return { type: 'ok', response: { type: 'execute', result: { cols: cols.map((name) => ({ name })), rows: out.map((r) => cols.map((c) => (r[c] == null ? { type: 'null' } : { type: 'text', value: r[c] }))), affected_row_count: affected } } };
    });
    return { ok: true, status: 200, json: async () => ({ results: [...results, { type: 'ok', response: { type: 'close' } }] }) };
  };
  return { fetchImpl, calls };
}

test('turso store: libsql:// URL -> https pipeline, bearer token, contract', async () => {
  const f = fakeTurso();
  const store = createTursoStore({ url: 'libsql://dayline-example.turso.io', authToken: 'tok', fetchImpl: f.fetchImpl });
  await contract(store);
  assert.ok(f.calls.every((c) => c.url === 'https://dayline-example.turso.io/v2/pipeline' && c.auth === 'Bearer tok'));
  assert.throws(() => createTursoStore({ url: 'ftp://x', authToken: 't' }), /libsql/);
  const bad = createTursoStore({ url: 'https://x.turso.io', authToken: 't', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(bad.list('meal'), /Turso\) error 401/);
});

test('notion store: separate data source only, Kind filter, trash on remove', async () => {
  const DS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const pages = new Map(); let n = 0; const seen = [];
  const fetchImpl = async (url, opts) => {
    const p = new URL(url).pathname; const body = opts.body ? JSON.parse(opts.body) : null; seen.push(`${opts.method} ${p}`);
    const json = (x) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => x, text: async () => JSON.stringify(x) });
    if (opts.method === 'POST' && p === `/v1/data_sources/${DS}/query`) {
      const kind = body.filter.select.equals;
      return json({ results: [...pages.values()].filter((x) => !x.in_trash && x.properties.Kind.select.name === kind), has_more: false });
    }
    if (opts.method === 'POST' && p === '/v1/pages') {
      assert.equal(body.parent.data_source_id, DS);
      const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
      const props = JSON.parse(JSON.stringify(body.properties));
      for (const k of ['Key']) props[k].title.forEach((t) => { t.plain_text = t.text.content; });
      props.Data.rich_text.forEach((t) => { t.plain_text = t.text.content; });
      pages.set(id, { id, properties: props, last_edited_time: '2026-10-09T00:00:00Z' });
      return json(pages.get(id));
    }
    const m = p.match(/^\/v1\/pages\/(.+)$/);
    if (opts.method === 'PATCH' && m) {
      const pg = [...pages.values()].find((x) => x.id.replace(/-/g, '') === m[1].replace(/-/g, ''));
      if (body.in_trash) pg.in_trash = true;
      if (body.properties) { const props = JSON.parse(JSON.stringify(body.properties)); props.Key.title.forEach((t) => { t.plain_text = t.text.content; }); props.Data.rich_text.forEach((t) => { t.plain_text = t.text.content; }); pg.properties = props; }
      return json(pg);
    }
    throw new Error(`unexpected ${opts.method} ${p}`);
  };
  await contract(createNotionStore({ token: 't', dataSourceId: DS, fetchImpl }));
  assert.ok(seen.every((s) => s.includes(DS.replace(/-/g, '')) || s.includes(DS) || s.startsWith('POST /v1/pages') || s.startsWith('PATCH /v1/pages/')));
  // long JSON is chunked under Notion's 2000-char rich_text limit
  const store = createNotionStore({ token: 't', dataSourceId: DS, fetchImpl });
  await store.put('thanks', 'interview:x:First round', { notes: 'n'.repeat(5000) });
  assert.equal((await store.get('thanks', 'interview:x:First round')).data.notes.length, 5000);
});

test('storeFromConfig picks fixture file > Turso > Notion store > none', () => {
  const fixture = { mode: 'fixture', fixture: { storeFile: path.join(os.tmpdir(), 'x.json') } };
  assert.equal(storeFromConfig(fixture).backend, 'file');
  assert.equal(storeFromConfig({ mode: 'live', tursoUrl: 'libsql://a.turso.io', tursoToken: 't', storeDataSourceId: 'x', notionToken: 'n' }).backend, 'turso');
  assert.equal(storeFromConfig({ mode: 'live', storeDataSourceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', notionToken: 'n' }).backend, 'notion-store');
  assert.equal(storeFromConfig({ mode: 'live', notionToken: 'n' }), null);
});
