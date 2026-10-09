'use strict';
// Dayline's own small record store (meal plans, thank-you reminders). It never touches your To Do list.
// Backends (same interface: list(kind), get(kind,key), put(kind,key,data,{date}), remove(kind,key)):
//   file   - JSON file (fixture mode, tests)
//   turso  - Turso / libSQL over the HTTP pipeline API (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN); no SDK needed
//   notion - one separate small Notion database ("Dayline data") used only as storage (DAYLINE_STORE_DATA_SOURCE_ID)
const fs = require('fs');
const path = require('path');
const { normalizeId, createSender } = require('./notion');

const KINDS = ['meal', 'thanks'];
const KIND_LABEL = { meal: 'Meal plan', thanks: 'Thank-you' };
const kindOf = (label) => Object.keys(KIND_LABEL).find((k) => KIND_LABEL[k] === label) || null;
const isoNow = () => new Date().toISOString();
function check(kind, key) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown store kind: ${kind}`);
  if (!key || String(key).length > 200) throw new Error('Bad store key');
}

function createFileStore({ file }) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { records: {} }; } };
  const save = (db) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, file); };
  const id = (kind, key) => `${kind}|${key}`;
  return {
    backend: 'file',
    async list(kind) { return Object.values(load().records || {}).filter((r) => r.kind === kind); },
    async get(kind, key) { return load().records?.[id(kind, key)] || null; },
    async put(kind, key, data, { date = null } = {}) {
      check(kind, key);
      const db = load(); db.records = db.records || {};
      const rec = { kind, key, date, data, updated: isoNow() };
      db.records[id(kind, key)] = rec; save(db); return rec;
    },
    async remove(kind, key) {
      const db = load(); const had = !!db.records?.[id(kind, key)];
      if (had) { delete db.records[id(kind, key)]; save(db); }
      return had;
    },
  };
}

/** Turso/libSQL HTTP pipeline: POST {url}/v2/pipeline with a Bearer token. */
function createTursoStore({ url, authToken, fetchImpl = globalThis.fetch }) {
  const base = String(url || '').trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('TURSO_DATABASE_URL must be a libsql:// or https:// URL');
  const arg = (v) => (v == null ? { type: 'null' } : { type: 'text', value: String(v) });
  async function run(stmts) {
    const res = await fetchImpl(`${base}/v2/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [...stmts.map(([sql, args = []]) => ({ type: 'execute', stmt: { sql, args: args.map(arg) } })), { type: 'close' }] }),
    });
    if (!res.ok) throw Object.assign(new Error(`Dayline store (Turso) error ${res.status}`), { status: 502 });
    const body = await res.json();
    return (body.results || []).slice(0, stmts.length).map((r) => {
      if (r.type !== 'ok') throw Object.assign(new Error(`Dayline store (Turso): ${r.error?.message || 'query failed'}`), { status: 502 });
      const result = r.response?.result || {};
      const cols = (result.cols || []).map((c) => c.name);
      return { rows: (result.rows || []).map((row) => Object.fromEntries(row.map((cell, i) => [cols[i], cell?.type === 'null' ? null : cell?.value ?? null]))), affected: result.affected_row_count || 0 };
    });
  }
  const DDL = 'CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, key TEXT NOT NULL, date TEXT, data TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (kind, key))';
  let ready = null;
  const ensure = () => (ready ||= run([[DDL]]).catch((e) => { ready = null; throw e; }));
  const toRec = (row) => ({ kind: row.kind, key: row.key, date: row.date, data: JSON.parse(row.data || '{}'), updated: row.updated });
  return {
    backend: 'turso',
    async list(kind) { await ensure(); const [r] = await run([['SELECT kind, key, date, data, updated FROM records WHERE kind = ?', [kind]]]); return r.rows.map(toRec); },
    async get(kind, key) { await ensure(); const [r] = await run([['SELECT kind, key, date, data, updated FROM records WHERE kind = ? AND key = ?', [kind, key]]]); return r.rows[0] ? toRec(r.rows[0]) : null; },
    async put(kind, key, data, { date = null } = {}) {
      check(kind, key); await ensure();
      const rec = { kind, key, date, data, updated: isoNow() };
      await run([['INSERT INTO records (kind, key, date, data, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET date = excluded.date, data = excluded.data, updated = excluded.updated', [kind, key, date, JSON.stringify(data), rec.updated]]]);
      return rec;
    },
    async remove(kind, key) { await ensure(); const [r] = await run([['DELETE FROM records WHERE kind = ? AND key = ?', [kind, key]]]); return r.affected > 0; },
  };
}

/** Fallback: a separate small Notion database used only as Dayline's storage (Key / Kind / Date / Data). */
const STORE_PROPS = { key: 'Key', kind: 'Kind', date: 'Date', data: 'Data' };
const chunk = (s) => { const out = []; for (let i = 0; i < s.length && out.length < 100; i += 1900) out.push({ type: 'text', text: { content: s.slice(i, i + 1900) } }); return out.length ? out : [{ type: 'text', text: { content: '{}' } }]; };
const plainOf = (rt) => (rt || []).map((x) => x.plain_text ?? x.text?.content ?? '').join('');
function createNotionStore({ token, dataSourceId, fetchImpl = globalThis.fetch, ttlMs = 15000 }) {
  const ds = normalizeId(dataSourceId);
  const send = createSender({ token, fetchImpl, what: 'the Dayline data database' });
  const cache = new Map(); // kind -> { at, rows: [{pageId, rec}] }
  async function rows(kind, fresh = false) {
    const c = cache.get(kind);
    if (!fresh && c && Date.now() - c.at < ttlMs) return c.rows;
    const out = []; let cursor;
    do {
      const data = await send({ method: 'POST', path: `/v1/data_sources/${ds}/query`, body: { filter: { property: STORE_PROPS.kind, select: { equals: KIND_LABEL[kind] } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
      for (const p of data.results || []) {
        if (p.in_trash || p.archived) continue;
        const pr = p.properties || {};
        let parsed = {}; try { parsed = JSON.parse(plainOf(pr[STORE_PROPS.data]?.rich_text) || '{}'); } catch { parsed = {}; }
        out.push({ pageId: p.id, rec: { kind: kindOf(pr[STORE_PROPS.kind]?.select?.name) || kind, key: plainOf(pr[STORE_PROPS.key]?.title), date: pr[STORE_PROPS.date]?.date?.start || null, data: parsed, updated: p.last_edited_time } });
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    cache.set(kind, { at: Date.now(), rows: out });
    return out;
  }
  const props = (kind, key, data, date) => ({
    [STORE_PROPS.key]: { title: [{ type: 'text', text: { content: key } }] },
    [STORE_PROPS.kind]: { select: { name: KIND_LABEL[kind] } },
    [STORE_PROPS.date]: { date: date ? { start: date } : null },
    [STORE_PROPS.data]: { rich_text: chunk(JSON.stringify(data)) },
  });
  return {
    backend: 'notion-store',
    async list(kind) { return (await rows(kind)).map((r) => r.rec); },
    async get(kind, key) { return (await rows(kind)).find((r) => r.rec.key === key)?.rec || null; },
    async put(kind, key, data, { date = null } = {}) {
      check(kind, key);
      const hit = (await rows(kind, true)).find((r) => r.rec.key === key);
      if (hit) await send({ method: 'PATCH', path: `/v1/pages/${normalizeId(hit.pageId)}`, body: { properties: props(kind, key, data, date) } });
      else await send({ method: 'POST', path: '/v1/pages', body: { parent: { type: 'data_source_id', data_source_id: ds }, properties: props(kind, key, data, date) } });
      cache.delete(kind);
      return { kind, key, date, data, updated: isoNow() };
    },
    async remove(kind, key) {
      const hit = (await rows(kind, true)).find((r) => r.rec.key === key);
      if (!hit) return false;
      await send({ method: 'PATCH', path: `/v1/pages/${normalizeId(hit.pageId)}`, body: { in_trash: true } });
      cache.delete(kind);
      return true;
    },
  };
}

/** Pick the backend from config: Turso if configured, else the separate Notion store, else null. */
// fetchImpl is the (possibly NOTION_READ_ONLY-guarded) Notion fetch; Turso is not Notion, so it uses tursoFetch.
function storeFromConfig(config, { fetchImpl, tursoFetch = globalThis.fetch } = {}) {
  if (config.mode === 'fixture') return createFileStore({ file: config.fixture.storeFile });
  if (config.tursoUrl && config.tursoToken) return createTursoStore({ url: config.tursoUrl, authToken: config.tursoToken, fetchImpl: tursoFetch });
  if (config.storeDataSourceId && config.notionToken) return createNotionStore({ token: config.notionToken, dataSourceId: config.storeDataSourceId, fetchImpl });
  return null;
}

module.exports = { KINDS, KIND_LABEL, STORE_PROPS, createFileStore, createTursoStore, createNotionStore, storeFromConfig };
