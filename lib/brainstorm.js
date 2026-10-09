'use strict';
// Sticky-note brainstorm board for Classes & activities.
// Live: Notion data source "Brainstorm" (created by First-time setup). Groups come from config/classes.js.
// Fixture: JSON file (no Notion writes).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeId, createSender, plain, richText, NotionError } = require('./notion');

const CLASS_CONFIG = require('../config/classes');
const GROUPS = ['General', ...(CLASS_CONFIG.activities || []).map((a) => a.option), ...(CLASS_CONFIG.classes || []).map((c) => c.option)];
const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];
const PROPS = { note: 'Note', group: 'Group', color: 'Color', pinned: 'Pinned' };
const NOTE_MAX = 2000;
const DEFAULT_DATA_SOURCE_ID = '33333333-3333-4333-8333-333333333333'; // FAKE: fixture/tests only. Live: BRAINSTORM_DATA_SOURCE_ID

function validateNoteInput(body, { partial = false } = {}) {
  const v = {};
  if (!partial || 'text' in (body || {})) {
    const t = String(body?.text ?? '').trim().replace(/\s+/g, ' ');
    if (!t) return { error: 'Write something on the sticky note.' };
    if (t.length > NOTE_MAX) return { error: `Keep notes under ${NOTE_MAX} characters.` };
    v.text = t;
  }
  if (!partial || 'group' in (body || {})) {
    const g = body?.group == null || body.group === '' ? 'General' : String(body.group);
    if (!GROUPS.includes(g)) return { error: `Group must be one of: ${GROUPS.join(', ')}` };
    v.group = g;
  }
  if (!partial || 'color' in (body || {})) {
    const c = body?.color == null || body.color === '' ? 'yellow' : String(body.color);
    if (!COLORS.includes(c)) return { error: `Color must be one of: ${COLORS.join(', ')}` };
    v.color = c;
  }
  if (!partial || 'pinned' in (body || {})) {
    v.pinned = !!body?.pinned;
  }
  return { value: v };
}

function parseNote(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    text: plain(p[PROPS.note]?.title) || '',
    group: p[PROPS.group]?.select?.name || 'General',
    color: p[PROPS.color]?.select?.name || 'yellow',
    pinned: !!p[PROPS.pinned]?.checkbox,
    url: page.url || null,
    edited: page.last_edited_time || null,
    created: page.created_time || null,
  };
}

function propertiesFor(fields) {
  const out = {};
  if ('text' in fields) out[PROPS.note] = { title: richText(fields.text) };
  if ('group' in fields) out[PROPS.group] = { select: { name: fields.group } };
  if ('color' in fields) out[PROPS.color] = { select: { name: fields.color } };
  if ('pinned' in fields) out[PROPS.pinned] = { checkbox: !!fields.pinned };
  return out;
}

function sortNotes(list) {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || String(b.edited || b.created || '').localeCompare(String(a.edited || a.created || ''))
    || a.text.localeCompare(b.text));
}

function createNotionBrainstorm({ token, dataSourceId = DEFAULT_DATA_SOURCE_ID, fetchImpl = globalThis.fetch }) {
  const ds = normalizeId(dataSourceId);
  const send = createSender({ token, fetchImpl, what: 'the Dayline Brainstorm database' });
  return {
    backend: 'notion',
    dataSourceId: ds,
    groups: GROUPS,
    colors: COLORS,
    async list() {
      const pages = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const body = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] };
        if (cursor) body.start_cursor = cursor;
        const data = await send({ method: 'POST', path: `/v1/data_sources/${ds}/query`, body });
        pages.push(...(data.results || []).filter((p) => !p.in_trash && !p.archived));
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      return sortNotes(pages.map(parseNote));
    },
    async create(fields) {
      const { value, error } = validateNoteInput(fields);
      if (error) throw Object.assign(new Error(error), { status: 400, code: 'validation_error' });
      const page = await send({
        method: 'POST', path: '/v1/pages',
        body: { parent: { type: 'data_source_id', data_source_id: ds }, properties: propertiesFor(value) },
      });
      return parseNote(page);
    },
    async update(id, fields) {
      const { value, error } = validateNoteInput(fields, { partial: true });
      if (error) throw Object.assign(new Error(error), { status: 400, code: 'validation_error' });
      if (!Object.keys(value).length) throw Object.assign(new Error('Nothing to update'), { status: 400 });
      const page = await send({
        method: 'PATCH', path: `/v1/pages/${normalizeId(id)}`,
        body: { properties: propertiesFor(value) },
      });
      return parseNote(page);
    },
    async remove(id) {
      await send({ method: 'PATCH', path: `/v1/pages/${normalizeId(id)}`, body: { in_trash: true } }); // API 2026-03-11 renamed archived -> in_trash
      return { id, archived: true };
    },
  };
}

function createFileBrainstorm({ file }) {
  const ensure = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ notes: [] }, null, 2));
  };
  const load = () => { ensure(); return JSON.parse(fs.readFileSync(file, 'utf8')); };
  const save = (db) => { ensure(); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, file); };
  return {
    backend: 'file',
    dataSourceId: null,
    groups: GROUPS,
    colors: COLORS,
    async list() { return sortNotes(load().notes || []); },
    async create(fields) {
      const { value, error } = validateNoteInput(fields);
      if (error) throw Object.assign(new Error(error), { status: 400, code: 'validation_error' });
      const db = load();
      const now = new Date().toISOString();
      const note = { id: normalizeId(crypto.randomBytes(16).toString('hex')), ...value, url: null, created: now, edited: now };
      db.notes.unshift(note);
      save(db);
      return note;
    },
    async update(id, fields) {
      const { value, error } = validateNoteInput(fields, { partial: true });
      if (error) throw Object.assign(new Error(error), { status: 400, code: 'validation_error' });
      const db = load();
      const note = db.notes.find((n) => n.id === id);
      if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });
      Object.assign(note, value, { edited: new Date().toISOString() });
      save(db);
      return note;
    },
    async remove(id) {
      const db = load();
      const before = db.notes.length;
      db.notes = db.notes.filter((n) => n.id !== id);
      if (db.notes.length === before) throw Object.assign(new Error('Note not found'), { status: 404 });
      save(db);
      return { id, archived: true };
    },
  };
}

module.exports = {
  GROUPS, COLORS, PROPS, NOTE_MAX, DEFAULT_DATA_SOURCE_ID,
  validateNoteInput, parseNote, propertiesFor, sortNotes,
  createNotionBrainstorm, createFileBrainstorm,
};
