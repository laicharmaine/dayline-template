'use strict';
// Fixture mode: a stand-in for `fetch` that answers the handful of Notion API calls Dayline makes,
// using local JSON copies of the To Do and Pipeline databases. Writes only touch the *.local.json copies.
// It never talks to the network, so fixture mode cannot change the real Notion workspace.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROPS, normalizeId } = require('./notion');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => body };
}

/**
 * createFixtureNotionFetch({ sources: [{ dataSourceId, seedFile, localFile }] })
 * (or the single-source shorthand { seedFile, localFile, dataSourceId }).
 */
function createFixtureNotionFetch(opts) {
  const sources = (opts.sources || [opts]).map((s) => ({ ...s, id: normalizeId(s.dataSourceId) }));
  const load = (src) => JSON.parse(fs.readFileSync(fs.existsSync(src.localFile) ? src.localFile : src.seedFile, 'utf8'));
  const save = (src, db) => { fs.mkdirSync(path.dirname(src.localFile), { recursive: true }); fs.writeFileSync(src.localFile, JSON.stringify(db, null, 1)); };
  const sourceById = (id) => sources.find((s) => s.id === normalizeId(id));
  const notFound = (what) => jsonResponse(404, { object: 'error', code: 'object_not_found', message: `Could not find ${what}` });

  const statusOf = (p) => p.properties[PROPS.status]?.status?.name ?? p.properties[PROPS.status]?.select?.name;
  function matches(page, filter) {
    if (!filter) return true;
    if (filter.and) return filter.and.every((f) => matches(page, f));
    if (filter.or) return filter.or.some((f) => matches(page, f));
    if (filter.property === PROPS.status) {
      const cond = filter.status || filter.select;
      if ('equals' in cond) return statusOf(page) === cond.equals;
      if ('does_not_equal' in cond) return statusOf(page) !== cond.does_not_equal;
    }
    if (filter.rich_text && 'contains' in filter.rich_text) {
      const text = (page.properties[filter.property]?.rich_text || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');
      return text.includes(filter.rich_text.contains);
    }
    throw new Error('fixture: unsupported filter ' + JSON.stringify(filter));
  }
  function sortPages(pages, sorts = []) {
    const s = sorts[0];
    if (!s) return pages;
    const dir = s.direction === 'descending' ? -1 : 1;
    const val = (p) => (s.timestamp ? p[s.timestamp] : p.properties[s.property]?.date?.start) || null;
    return pages.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va === vb) return 0;
      if (va === null) return 1; // Notion puts empty values last
      if (vb === null) return -1;
      return va < vb ? -dir : dir;
    });
  }
  function applyProperties(page, props) {
    for (const [name, value] of Object.entries(props)) {
      const cur = page.properties[name] || {};
      if (value.title) page.properties[name] = { id: 'title', type: 'title', title: value.title.map((t) => ({ type: 'text', text: { content: t.text.content, link: null }, plain_text: t.text.content })) };
      else if ('status' in value) page.properties[name] = { ...cur, type: 'status', status: { name: value.status.name } };
      else if ('select' in value) page.properties[name] = { ...cur, type: 'select', select: value.select ? { name: value.select.name } : null };
      else if ('date' in value) page.properties[name] = { ...cur, type: 'date', date: value.date ? { start: value.date.start, end: value.date.end || null, time_zone: null } : null };
      else if ('people' in value) page.properties[name] = { ...cur, type: 'people', people: value.people };
      else if ('rich_text' in value) page.properties[name] = { ...cur, type: 'rich_text', rich_text: value.rich_text.map((t) => ({ type: 'text', text: { content: t.text.content, link: null }, plain_text: t.text.content })) };
      else if ('url' in value) page.properties[name] = { ...cur, type: 'url', url: value.url };
      else if ('multi_select' in value) page.properties[name] = { ...cur, type: 'multi_select', multi_select: (value.multi_select || []).map((o) => ({ name: o.name, color: (cur.multi_select || []).find((x) => x.name === o.name)?.color || 'default' })) };
      else if ('number' in value) page.properties[name] = { ...cur, type: 'number', number: value.number };
      else throw new Error('fixture: unsupported property value for ' + name);
    }
  }

  // Behave like Notion: unknown properties and unknown select options are rejected.
  function checkProps(ds, props) {
    for (const [name, value] of Object.entries(props)) {
      const def = ds?.properties?.[name];
      if (!def) throw Object.assign(new Error(`${name} is not a property that exists.`), { fixtureStatus: 400 });
      if (value && value.select && def.select?.options && !def.select.options.some((o) => o.name === value.select.name)) {
        throw Object.assign(new Error(`Invalid select option "${value.select.name}" for ${name}.`), { fixtureStatus: 400 });
      }
    }
  }

  return async function fixtureFetch(url, init = {}) {
    try { return await handle(url, init); } catch (e) {
      if (e.fixtureStatus) return jsonResponse(e.fixtureStatus, { object: 'error', code: 'validation_error', message: e.message });
      throw e;
    }
  };
  async function handle(url, init) {
    const { pathname } = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    let m;
    if (method === 'GET' && (m = pathname.match(/^\/v1\/data_sources\/([^/]+)$/))) {
      const src = sourceById(m[1]);
      return src ? jsonResponse(200, load(src).dataSource) : notFound('data source');
    }
    if (method === 'POST' && (m = pathname.match(/^\/v1\/data_sources\/([^/]+)\/query$/))) {
      const src = sourceById(m[1]);
      if (!src) return notFound('data source');
      const db = load(src);
      const all = sortPages(db.pages.filter((p) => !p.in_trash && matches(p, body.filter)), body.sorts);
      const start = body.start_cursor ? Number(body.start_cursor) : 0;
      const size = Math.min(body.page_size || 100, 100);
      const results = all.slice(start, start + size);
      const more = start + size < all.length;
      return jsonResponse(200, { object: 'list', results, has_more: more, next_cursor: more ? String(start + size) : null });
    }
    if (method === 'PATCH' && (m = pathname.match(/^\/v1\/pages\/([^/]+)$/))) {
      for (const src of sources) {
        const db = load(src);
        const page = db.pages.find((p) => normalizeId(p.id) === normalizeId(m[1]));
        if (!page) continue;
        if (body.in_trash === true || body.archived === true) { page.archived = true; page.in_trash = true; }
        if (body.in_trash === false || body.archived === false) { page.archived = false; page.in_trash = false; }
        if (body.properties) { checkProps(db.dataSource, body.properties); applyProperties(page, body.properties); }
        page.last_edited_time = new Date().toISOString();
        save(src, db);
        return jsonResponse(200, page);
      }
      return notFound('page');
    }
    if (method === 'POST' && pathname === '/v1/pages') {
      const src = sourceById(body.parent?.data_source_id);
      if (!src) return jsonResponse(400, { object: 'error', code: 'validation_error', message: 'bad parent' });
      const db = load(src);
      checkProps(db.dataSource, body.properties || {});
      const id = normalizeId(crypto.randomBytes(16).toString('hex'));
      const now = new Date().toISOString();
      const page = { object: 'page', id, created_time: now, last_edited_time: now, in_trash: false, url: `https://www.notion.so/${id.replace(/-/g, '')}`, parent: body.parent, properties: {} };
      applyProperties(page, body.properties || {});
      db.pages.push(page);
      save(src, db);
      return jsonResponse(200, page);
    }
    return jsonResponse(400, { object: 'error', code: 'invalid_request_url', message: `fixture: unsupported ${method} ${pathname}` });
  }
}

module.exports = { createFixtureNotionFetch };
