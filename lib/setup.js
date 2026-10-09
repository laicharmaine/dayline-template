'use strict';
// First-time setup: create every Notion database Dayline needs under ONE parent page you picked,
// with the right properties, and return the env values to paste into Vercel.
// Safe to re-run: databases it already made under that page (matched by title) are reused, not duplicated.
const { NOTION_VERSION, normalizeId, STATUSES, AREAS, PRIORITIES } = require('./notion');
const { JPROPS, TRACKS, LOCATIONS, JOB_PRIORITIES, SOURCES, INTERVIEW_ROUNDS } = require('./jobs');
const { STORE_PROPS } = require('./store');
const CLASS_CONFIG = require('../config/classes');

const TITLES = {
  todo: 'Dayline · To Do',
  jobs: 'Dayline · Recruiting pipeline',
  brainstorm: 'Dayline · Brainstorm',
  people: 'Dayline · People',
  touchpoints: 'Dayline · Touch points',
  store: 'Dayline · App data',
};
const ENV = { todo: 'NOTION_DATA_SOURCE_ID', jobs: 'JOBS_DATA_SOURCE_ID', brainstorm: 'BRAINSTORM_DATA_SOURCE_ID', people: 'PEOPLE_DATA_SOURCE_ID', touchpoints: 'TOUCHPOINTS_DATA_SOURCE_ID', store: 'DAYLINE_STORE_DATA_SOURCE_ID' };
const COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'yellow', 'red', 'brown', 'gray'];
const opts = (names, colors = {}) => names.map((name, i) => ({ name, color: colors[name] || COLORS[i % COLORS.length] }));
const sel = (names, colors) => ({ select: { options: opts(names, colors) } });
const ADDED_BY = sel(['Me', 'Bot'], { Me: 'blue', Bot: 'gray' });
const classOptions = () => [...(CLASS_CONFIG.classes || []), ...(CLASS_CONFIG.activities || [])].map((c) => ({ name: c.option, color: c.color || 'default' }));
const brainstormGroups = () => ['General', ...(CLASS_CONFIG.activities || []).map((a) => a.option), ...(CLASS_CONFIG.classes || []).map((c) => c.option)];

/** Property schemas (ids of related data sources are filled in at creation time). */
function schemas(ids = {}) {
  return {
    todo: {
      'Task name': { title: {} },
      Status: { status: {} }, // Notion's default status options are exactly Not started / In progress / Done
      Area: sel(AREAS, { School: 'blue', Personal: 'green', Recruiting: 'purple', Other: 'gray' }),
      Priority: sel(PRIORITIES, { High: 'red', Medium: 'yellow', Low: 'gray' }),
      'Due date': { date: {} },
      Notes: { rich_text: {} },
      Link: { url: {} },
      'Added by': ADDED_BY,
      'Class / Activity': { multi_select: { options: classOptions() } },
    },
    jobs: {
      [JPROPS.role]: { title: {} },
      [JPROPS.company]: { rich_text: {} },
      [JPROPS.stage]: sel(['Researching', 'Interested', 'Applied', 'Interview', 'Offer', 'Closed'], { Researching: 'gray', Interested: 'blue', Applied: 'yellow', Interview: 'purple', Offer: 'green', Closed: 'red' }),
      [JPROPS.track]: sel(TRACKS),
      [JPROPS.location]: sel(LOCATIONS),
      [JPROPS.priority]: sel(JOB_PRIORITIES, { High: 'red', Medium: 'yellow', Low: 'gray' }),
      [JPROPS.source]: sel(SOURCES),
      [JPROPS.fit]: { number: { format: 'number' } },
      [JPROPS.url]: { url: {} },
      [JPROPS.deadline]: { date: {} },
      [JPROPS.interview]: { date: {} },
      [JPROPS.round]: sel(INTERVIEW_ROUNDS),
      [JPROPS.nextAction]: { rich_text: {} },
      [JPROPS.notes]: { rich_text: {} },
      [JPROPS.applied]: { date: {} },
      [JPROPS.nextDate]: { date: {} },
      [JPROPS.addedBy]: ADDED_BY,
    },
    brainstorm: {
      Note: { title: {} },
      Group: sel(brainstormGroups()),
      Color: sel(['yellow', 'pink', 'blue', 'green', 'purple', 'orange'], { yellow: 'yellow', pink: 'pink', blue: 'blue', green: 'green', purple: 'purple', orange: 'orange' }),
      Pinned: { checkbox: {} },
    },
    people: {
      Name: { title: {} },
      Company: { rich_text: {} },
      Role: { rich_text: {} },
      'School / affiliation': { rich_text: {} },
      'How we met': { rich_text: {} },
      LinkedIn: { url: {} },
      Email: { email: {} },
      Strength: sel(['Cold', 'Warm', 'Strong'], { Cold: 'blue', Warm: 'orange', Strong: 'green' }),
      Tags: { multi_select: { options: opts(['PM', 'PMM', 'Alum', 'Recruiter', 'Hiring manager', 'Referral']) } },
      'Next follow-up': { date: {} },
      Notes: { rich_text: {} },
      ...(ids.jobs ? { 'Pipeline jobs': { relation: { data_source_id: ids.jobs, type: 'single_property', single_property: {} } } } : {}),
      'Added by': ADDED_BY,
    },
    touchpoints: {
      'Touch point': { title: {} },
      ...(ids.people ? { Person: { relation: { data_source_id: ids.people, type: 'dual_property', dual_property: {} } } } : {}),
      Date: { date: {} },
      Type: sel(['Coffee chat', 'Call', 'LinkedIn message', 'Email', 'Info session/event', 'Referral ask', 'Thank-you note', 'Interview']),
      Notes: { rich_text: {} },
      'Follow-up action': { rich_text: {} },
      'Follow-up date': { date: {} },
      ...(ids.jobs ? { 'Related job': { relation: { data_source_id: ids.jobs, type: 'single_property', single_property: {} } } } : {}),
      'Added by': ADDED_BY,
    },
    store: {
      [STORE_PROPS.key]: { title: {} },
      [STORE_PROPS.kind]: sel(['Meal plan', 'Thank-you'], { 'Meal plan': 'orange', 'Thank-you': 'green' }),
      [STORE_PROPS.date]: { date: {} },
      [STORE_PROPS.data]: { rich_text: {} },
    },
  };
}

/** Accepts a page id or any Notion page URL ("https://www.notion.so/My-Page-0123abcd..."). */
function parsePageRef(ref) {
  const s = String(ref || '').trim();
  const m = s.match(/([0-9a-f]{32})(?:[?#].*)?$/i) || s.replace(/-/g, '').match(/([0-9a-f]{32})/i);
  return m ? normalizeId(m[1]) : null;
}

function createSetupClient({ token, fetchImpl = globalThis.fetch, baseUrl = 'https://api.notion.com' }) {
  if (!token) throw Object.assign(new Error('Paste your Notion integration token (it starts with "ntn_" or "secret_").'), { status: 400 });
  async function nq(method, p, body) {
    const res = await fetchImpl(baseUrl + p, { method, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 401 ? ' (the token is wrong or was revoked)' : res.status === 404 ? ' (share that page with your integration: ••• menu > Connections)' : '';
      throw Object.assign(new Error(`Notion said ${res.status}: ${data.message || data.code || 'error'}${hint}`), { status: res.status === 401 || res.status === 404 ? 400 : 502, code: data.code });
    }
    return data;
  }
  async function searchAll(filterValue, query = '') {
    const out = []; let cursor;
    do {
      const d = await nq('POST', '/v1/search', { query, filter: { property: 'object', value: filterValue }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      out.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : null;
    } while (cursor && out.length < 500);
    return out;
  }
  const titleOf = (o) => (o.title || Object.values(o.properties || {}).find((p) => p.type === 'title')?.title || []).map((t) => t.plain_text || t.text?.content || '').join('');

  return {
    /** Pages the integration can see (to pick a parent). */
    async listPages() {
      return (await searchAll('page')).filter((p) => !p.in_trash && !p.archived && p.parent?.type !== 'data_source_id' && p.parent?.type !== 'database_id')
        .map((p) => ({ id: p.id, title: titleOf(p) || 'Untitled', url: p.url })).slice(0, 100);
    },
    /** Dayline data sources already present (optionally only under one parent page). */
    async findExisting(parentId = null) {
      const found = {};
      for (const ds of await searchAll('data_source', 'Dayline')) {
        if (ds.in_trash || ds.archived) continue;
        const key = Object.keys(TITLES).find((k) => titleOf(ds) === TITLES[k]);
        if (!key || found[key]) continue;
        if (parentId) {
          const dbParent = ds.database_parent?.page_id || null;
          if (dbParent && normalizeId(dbParent) !== normalizeId(parentId)) continue;
        }
        found[key] = ds.id;
      }
      return found;
    },
    async createAll(parentRef, { log = () => {} } = {}) {
      const parent = parsePageRef(parentRef);
      if (!parent) throw Object.assign(new Error('Pick a page, or paste a Notion page link.'), { status: 400 });
      await nq('GET', `/v1/pages/${parent}`); // clear error if the page is not shared with the integration
      const ids = await this.findExisting(parent);
      const created = []; const reused = Object.keys(ids);
      for (const key of ['todo', 'jobs', 'brainstorm', 'people', 'touchpoints', 'store']) {
        if (ids[key]) { log(`${TITLES[key]}: already there, reusing`); continue; }
        let properties = schemas(ids)[key];
        let db;
        try {
          db = await nq('POST', '/v1/databases', { parent: { type: 'page_id', page_id: parent }, title: [{ type: 'text', text: { content: TITLES[key] } }], is_inline: false, initial_data_source: { properties } });
        } catch (e) {
          if (key !== 'todo' || e.code !== 'validation_error') throw e;
          // Older API behaviour: "status" cannot be created; a select with the same options works the same in Dayline.
          properties = { ...properties, Status: sel(STATUSES, { 'Not started': 'default', 'In progress': 'blue', Done: 'green' }) };
          db = await nq('POST', '/v1/databases', { parent: { type: 'page_id', page_id: parent }, title: [{ type: 'text', text: { content: TITLES[key] } }], is_inline: false, initial_data_source: { properties } });
        }
        ids[key] = db.data_sources?.[0]?.id;
        if (!ids[key]) throw new Error(`Notion did not return a data source for ${TITLES[key]}`);
        created.push(key); log(`${TITLES[key]}: created`);
      }
      // People -> "Introduced by" is a relation to itself, so it can only be added once People exists.
      const people = await nq('GET', `/v1/data_sources/${ids.people}`);
      if (!people.properties?.['Introduced by']) {
        await nq('PATCH', `/v1/data_sources/${ids.people}`, { properties: { 'Introduced by': { relation: { data_source_id: ids.people, type: 'single_property', single_property: {} } } } });
      }
      return { parent, ids, created, reused, env: envFor(ids) };
    },
  };
}

function envFor(ids) {
  return Object.keys(ENV).filter((k) => ids[k]).map((k) => `${ENV[k]}=${ids[k]}`).join('\n');
}

module.exports = { TITLES, ENV, schemas, parsePageRef, createSetupClient, envFor };
