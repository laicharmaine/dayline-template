'use strict';
// Notion To Do database access through the official REST API.
// API version 2026-03-11 (latest as of Oct 2026). Since 2025-09-03, rows live in a *data source*
// inside a database: query with POST /v1/data_sources/{id}/query, create rows with
// parent {type:'data_source_id'}, update rows with PATCH /v1/pages/{id}.
// The request builders below are pure functions so tests can check the exact payloads.
const { dateKey, isDateKey, DEFAULT_TZ } = require('./time');

const NOTION_API = 'https://api.notion.com';
const NOTION_VERSION = '2026-03-11';

const PROPS = { title: 'Task name', status: 'Status', area: 'Area', priority: 'Priority', due: 'Due date', notes: 'Notes', link: 'Link', assignee: 'Assignee', addedBy: 'Added by', classes: 'Class / Activity' };
// "Added by" (select: Me | Bot) records who created a row. Dayline sets "Me" on rows it creates
// (you are the one clicking); other assistants that add rows should set "Bot".
const ADDED_BY_ME = 'Me';
const NOTES_MAX = 20000; // characters; Notion allows 100 rich-text segments of 2,000 characters each
const RICH_TEXT_CHUNK = 2000; // Notion's per-segment limit
/** Plain string -> Notion rich_text array, split into segments of at most 2,000 characters. */
function richText(s) {
  const out = [];
  const str = String(s || '');
  for (let i = 0; i < str.length && out.length < 100; i += RICH_TEXT_CHUNK) out.push({ type: 'text', text: { content: str.slice(i, i + RICH_TEXT_CHUNK) } });
  return out;
}
/** Accepts '', null or an http(s) URL; returns { value } or { error }. */
function checkLink(raw) {
  const u = raw == null ? '' : String(raw).trim();
  if (!u) return { value: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`; // "notion.so/x" -> https://notion.so/x
  if (!/^https?:\/\//i.test(withScheme) || withScheme.length > 2000) return { error: 'Link must be a web address (http:// or https://)' };
  try { new URL(withScheme); } catch { return { error: 'Link is not a valid web address' }; }
  return { value: withScheme };
}
const addedByValue = (props) => props?.[PROPS.addedBy]?.select?.name ?? null;
const STATUSES = ['Not started', 'In progress', 'Done'];
const AREAS = ['School', 'Personal', 'Recruiting', 'Other'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const DONE = 'Done';
const NOT_STARTED = 'Not started';

/** Accepts a raw 32-hex id, a dashed UUID, a collection:// URL or a Notion URL and returns a dashed UUID. */
function normalizeId(raw) {
  if (!raw) return '';
  const m = String(raw).replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!m) return '';
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The Status property is a Notion "status" property in your database (checked against the
// real schema), but older templates use "select". Both shapes are supported.
const statusValue = (name, statusType = 'status') => (statusType === 'select' ? { select: { name } } : { status: { name } });
const statusFilter = (op, name, statusType = 'status') => ({ property: PROPS.status, [statusType === 'select' ? 'select' : 'status']: { [op]: name } });

function buildQueryRequest(dataSourceId, { done = false, cursor, statusType = 'status', pageSize } = {}) {
  const body = done
    ? { filter: statusFilter('equals', DONE, statusType), sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }], page_size: pageSize || 50 }
    : { filter: statusFilter('does_not_equal', DONE, statusType), sorts: [{ property: PROPS.due, direction: 'ascending' }], page_size: pageSize || 100 };
  if (cursor) body.start_cursor = cursor;
  return { method: 'POST', path: `/v1/data_sources/${normalizeId(dataSourceId)}/query`, body };
}

function buildSchemaRequest(dataSourceId) {
  return { method: 'GET', path: `/v1/data_sources/${normalizeId(dataSourceId)}` };
}

function dueProperty(due) {
  if (due === null || due === '') return { date: null };
  return { date: { start: due } };
}

/** Notion property payload for the fields present in `fields` (already validated). */
function propertiesFor(fields, { statusType = 'status', caps = { notes: true, link: true, classes: true } } = {}) {
  const p = {};
  if ('name' in fields) p[PROPS.title] = { title: [{ type: 'text', text: { content: fields.name } }] };
  if ('status' in fields) p[PROPS.status] = statusValue(fields.status, statusType);
  if ('area' in fields) p[PROPS.area] = { select: fields.area ? { name: fields.area } : null };
  if ('priority' in fields) p[PROPS.priority] = { select: fields.priority ? { name: fields.priority } : null };
  if ('due' in fields) p[PROPS.due] = dueProperty(fields.due);
  if ('notes' in fields && caps.notes) p[PROPS.notes] = { rich_text: richText(fields.notes) };
  if ('link' in fields && caps.link) p[PROPS.link] = { url: fields.link || null };
  if ('classes' in fields && caps.classes) p[PROPS.classes] = { multi_select: fields.classes.map((name) => ({ name })) };
  return p;
}

function buildCreateRequest(dataSourceId, fields, { statusType = 'status', assigneeId, addedBy, caps } = {}) {
  const properties = propertiesFor({ status: NOT_STARTED, ...fields }, { statusType, caps });
  if (properties[PROPS.notes] && !properties[PROPS.notes].rich_text.length) delete properties[PROPS.notes];
  if (properties[PROPS.link] && !properties[PROPS.link].url) delete properties[PROPS.link];
  if (properties[PROPS.classes] && !properties[PROPS.classes].multi_select.length) delete properties[PROPS.classes];
  if (assigneeId) properties[PROPS.assignee] = { people: [{ object: 'user', id: assigneeId }] };
  if (addedBy) properties[PROPS.addedBy] = { select: { name: addedBy } };
  return { method: 'POST', path: '/v1/pages', body: { parent: { type: 'data_source_id', data_source_id: normalizeId(dataSourceId) }, properties } };
}

function buildUpdateRequest(pageId, fields, { statusType = 'status', caps } = {}) {
  return { method: 'PATCH', path: `/v1/pages/${normalizeId(pageId)}`, body: { properties: propertiesFor(fields, { statusType, caps }) } };
}

/** Validates user input for create (all fields) or update (partial). Returns { value } or { error }. */
function validateTaskInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const v = {};
  if ('name' in input || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { error: 'Task name is required' };
    if (name.length > 300) return { error: 'Task name is too long (300 characters max)' };
    v.name = name;
  }
  if ('status' in input) {
    if (!STATUSES.includes(input.status)) return { error: `Status must be one of: ${STATUSES.join(', ')}` };
    v.status = input.status;
  }
  for (const [key, options] of [['area', AREAS], ['priority', PRIORITIES]]) {
    if (key in input) {
      const val = input[key] === '' ? null : input[key];
      if (val !== null && !options.includes(val)) return { error: `${key[0].toUpperCase() + key.slice(1)} must be one of: ${options.join(', ')}` };
      v[key] = val;
    }
  }
  if ('due' in input) {
    const due = input.due === '' ? null : input.due;
    if (due !== null && !isDateKey(due)) return { error: 'Due date must be YYYY-MM-DD' };
    v.due = due;
  }
  if ('notes' in input) {
    const notes = input.notes == null ? '' : String(input.notes).replace(/\r\n?/g, '\n');
    if (notes.length > NOTES_MAX) return { error: `Notes are too long (${NOTES_MAX.toLocaleString('en-US')} characters max)` };
    v.notes = notes.trim() ? notes : '';
  }
  if ('link' in input) {
    const { value, error } = checkLink(input.link);
    if (error) return { error };
    v.link = value;
  }
  if ('classes' in input) {
    const list = input.classes == null ? [] : input.classes;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x.trim() || x.length > 100) || list.length > 10) return { error: 'Class / Activity must be a list of up to 10 names' };
    v.classes = [...new Set(list.map((x) => x.trim()))];
  }
  if (partial && Object.keys(v).length === 0) return { error: 'Nothing to update' };
  return { value: v };
}

const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r.plain_text ?? r.text?.content ?? '').join('') : '');

/** Notion page object -> the small task shape the UI uses. */
function parsePage(page, { tz = DEFAULT_TZ } = {}) {
  const props = page.properties || {};
  const st = props[PROPS.status];
  const status = st?.status?.name ?? st?.select?.name ?? NOT_STARTED;
  const dueRaw = props[PROPS.due]?.date || null;
  let due = null;
  if (dueRaw?.start) {
    // A date range counts as due on its end date.
    const value = dueRaw.end || dueRaw.start;
    const hasTime = value.length > 10;
    due = { key: hasTime ? dateKey(new Date(value), tz) : value.slice(0, 10), time: hasTime ? new Date(value).toISOString() : null, range: !!dueRaw.end };
  }
  return {
    id: page.id,
    name: plain(props[PROPS.title]?.title) || 'Untitled',
    status,
    done: status === DONE,
    area: props[PROPS.area]?.select?.name ?? null,
    priority: props[PROPS.priority]?.select?.name ?? null,
    due,
    notes: plain(props[PROPS.notes]?.rich_text).slice(0, NOTES_MAX),
    // true when the Notion notes have formatting, links or mentions that a plain-text edit would drop
    notesRich: (props[PROPS.notes]?.rich_text || []).some((r) => r.type !== 'text' || r.href || r.text?.link || Object.entries(r.annotations || {}).some(([k, val]) => (k === 'color' ? val !== 'default' : val))),
    link: props[PROPS.link]?.url || null,
    classes: (props[PROPS.classes]?.multi_select || []).map((o) => o.name),
    addedBy: addedByValue(props),
    url: page.url,
    edited: page.last_edited_time,
  };
}

class NotionError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/**
 * Shared Notion HTTP sender: auth + version headers, 429 retry, friendly errors.
 * `what` names the database in "not found" messages.
 */
function createSender({ token, fetchImpl = globalThis.fetch, baseUrl = NOTION_API, maxRetries = 2, what = 'the database' }) {
  return async function send(req, attempt = 0) {
    const res = await fetchImpl(baseUrl + req.path, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    if (res.status === 429 && attempt < maxRetries) { // rate limited: Notion allows ~3 requests/second
      const wait = Math.min(5, Number(res.headers?.get?.('retry-after')) || 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return send(req, attempt + 1);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const code = data?.code || 'notion_error';
      let msg = data?.message || `Notion request failed (${res.status})`;
      if (res.status === 404 || code === 'object_not_found') msg = `Notion could not find ${what}. Is the integration connected to it? (see SETUP.md step 1)`;
      if (res.status === 401) msg = 'Notion rejected the token. Check NOTION_TOKEN.';
      throw new NotionError(msg, res.status, code);
    }
    return data;
  };
}

/**
 * Minimal Notion client. `fetchImpl` is injectable: tests pass a mock, fixture mode passes the
 * local-file fake from lib/fixture-notion.js, production uses global fetch.
 */
function createNotionClient({ token, dataSourceId, fetchImpl = globalThis.fetch, tz = DEFAULT_TZ, assigneeId, statusType, baseUrl = NOTION_API, maxRetries = 2 }) {
  if (!dataSourceId) throw new Error('NOTION_DATA_SOURCE_ID is not set');
  let resolvedStatusType = statusType || null;

  const send = createSender({ token, fetchImpl, baseUrl, maxRetries, what: 'the To Do database' });

  // Whether the "Added by" column exists; re-checked every 10 minutes so adding it in Notion just works.
  // Optional columns ("Added by", "Notes", "Link"): re-checked every 10 minutes so adding one in Notion just works.
  let caps = null;
  let schemaAt = 0;
  const noteSchema = (ds) => {
    const p = ds?.properties || {};
    caps = {
      addedBy: p[PROPS.addedBy]?.type === 'select', notes: p[PROPS.notes]?.type === 'rich_text', link: p[PROPS.link]?.type === 'url',
      classes: p[PROPS.classes]?.type === 'multi_select', classOptions: (p[PROPS.classes]?.multi_select?.options || []).map((o) => o.name),
    };
    schemaAt = Date.now();
  };
  async function getCaps() {
    if (caps && Date.now() - schemaAt < 10 * 60000) return caps;
    try { noteSchema(await send(buildSchemaRequest(dataSourceId))); } catch { return caps || { addedBy: false, notes: false, link: false, classes: false, classOptions: [] }; }
    return caps;
  }
  const getAddedBy = async () => (await getCaps()).addedBy;
  // Only existing options: Notion would otherwise silently create a new option for a typo.
  function checkClasses(fields, c) {
    if (!('classes' in fields) || !c.classes) return;
    const unknown = fields.classes.filter((x) => !c.classOptions.includes(x));
    if (unknown.length) throw new NotionError(`Unknown class / activity: ${unknown.join(', ')}. Add it in config/classes.js and Notion first.`, 400, 'unknown_option');
  }

  async function getStatusType() {
    if (resolvedStatusType) return resolvedStatusType;
    try {
      const ds = await send(buildSchemaRequest(dataSourceId));
      noteSchema(ds);
      resolvedStatusType = ds?.properties?.[PROPS.status]?.type === 'select' ? 'select' : 'status';
    } catch (e) {
      if (e.status === 401 || e.status === 404) throw e;
      return 'status'; // transient error: assume the real schema's type, try again next time
    }
    return resolvedStatusType;
  }

  return {
    async listOpen() {
      const statusType = await getStatusType();
      const pages = [];
      let cursor;
      for (let i = 0; i < 20; i++) { // up to 2,000 open tasks
        const data = await send(buildQueryRequest(dataSourceId, { cursor, statusType }));
        pages.push(...(data.results || []));
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      return pages.map((p) => parsePage(p, { tz }));
    },
    async listDone() {
      const statusType = await getStatusType();
      const data = await send(buildQueryRequest(dataSourceId, { done: true, statusType }));
      return (data.results || []).map((p) => parsePage(p, { tz }));
    },
    /** opts.addedBy: 'Bot' for rows Dayline creates on its own (e.g. thank-you reminders); default Me. */
    async create(fields, opts = {}) {
      const statusType = await getStatusType();
      const c = await getCaps();
      checkClasses(fields, c);
      return parsePage(await send(buildCreateRequest(dataSourceId, fields, { statusType, assigneeId, addedBy: c.addedBy ? (opts.addedBy || ADDED_BY_ME) : undefined, caps: c })), { tz });
    },
    /** Rows whose Notes contain `text` (any status). Used for Dayline's thank-you reminder markers. */
    async findByNotes(text) {
      const pages = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const body = { filter: { property: PROPS.notes, rich_text: { contains: text } }, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await send({ method: 'POST', path: `/v1/data_sources/${normalizeId(dataSourceId)}/query`, body });
        pages.push(...(data.results || []).filter((p) => !p.in_trash));
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      return pages.map((p) => parsePage(p, { tz }));
    },
    async update(pageId, fields) {
      const statusType = await getStatusType();
      const c = ('notes' in fields || 'link' in fields || 'classes' in fields) ? await getCaps() : undefined;
      if (c) checkClasses(fields, c);
      return parsePage(await send(buildUpdateRequest(pageId, fields, { statusType, caps: c })), { tz });
    },
    getStatusType,
    getAddedBy,
    getCaps,
  };
}

module.exports = {
  NOTION_API, NOTION_VERSION, PROPS, ADDED_BY_ME, STATUSES, AREAS, PRIORITIES, DONE, NOT_STARTED,
  normalizeId, buildQueryRequest, buildSchemaRequest, buildCreateRequest, buildUpdateRequest, propertiesFor,
  validateTaskInput, parsePage, createNotionClient, createSender, NotionError, plain, richText, checkLink, NOTES_MAX, RICH_TEXT_CHUNK,
};
