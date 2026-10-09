'use strict';
// Recruiting tracker backed by a Notion "Pipeline" database (created by First-time setup).
//
// Schema: Name (title = role), Company (text), Stage (select: Researching / Interested / Applied /
// Interview / Offer / Closed), Track (PM / PMM / Other), Location, Priority, Source, Fit (number),
// Job URL (url), Deadline (date), Interview (date), Interview round (select), Next Action (text),
// Notes (text), Date applied (date), Next step date (date), Added by (select: Me | Bot).
//
// Dayline treats Stage "Researching" rows as *Opportunities* (roles not applied to yet) and every other
// stage as the *Tracker*. The app reads the schema and degrades gracefully when optional columns are missing.
// To change tracks or locations, edit TRACKS / LOCATIONS below and the matching Notion select options.
const { normalizeId, createSender, plain, NotionError, ADDED_BY_ME, richText } = require('./notion');
const { isDateKey } = require('./time');

const JOBS_DEFAULT_DATA_SOURCE_ID = '22222222-2222-4222-8222-222222222222'; // FAKE: fixture/tests only. Live: JOBS_DATA_SOURCE_ID

const JPROPS = {
  role: 'Name', company: 'Company', stage: 'Stage', track: 'Track', location: 'Location', priority: 'Priority',
  source: 'Source', fit: 'Fit', url: 'Job URL', deadline: 'Deadline', interview: 'Interview', nextAction: 'Next Action',
  notes: 'Notes', applied: 'Date applied', nextDate: 'Next step date', addedBy: 'Added by', round: 'Interview round',
};
// Interviewing is split into rounds with a separate "Interview round" select so the Stage values stay simple. The "Interview" date is the date of
// the current round.
const INTERVIEW_ROUNDS = ['Recruiter screen', 'First round', 'Second round', 'Final round'];
// App status -> Notion Stage option.
const STATUS_TO_STAGE = { Opportunity: 'Researching', Interested: 'Interested', Applied: 'Applied', Interviewing: 'Interview', Offer: 'Offer', Closed: 'Closed' };
const STAGE_TO_STATUS = Object.fromEntries(Object.entries(STATUS_TO_STAGE).map(([k, v]) => [v, k]));
const TRACKER_STATUSES = ['Interested', 'Applied', 'Interviewing', 'Offer', 'Closed'];
const JOB_STATUSES = ['Opportunity', ...TRACKER_STATUSES];
const TRACKS = ['PM', 'PMM', 'Other'];
const LOCATIONS = ['SF', 'Peninsula', 'South Bay', 'East Bay', 'Remote/Hybrid', 'Other'];
const BAY_AREA = ['SF', 'Peninsula', 'South Bay', 'East Bay'];
const JOB_PRIORITIES = ['High', 'Medium', 'Low'];
const SOURCES = ['LinkedIn', 'Company site', 'School', 'Referral', 'Other'];
function validateJobInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const v = {};
  const str = (k, max, label) => {
    if (!(k in input)) return null;
    const val = input[k] == null ? '' : String(input[k]).trim();
    if (val.length > max) return `${label} is too long (${max} characters max)`;
    v[k] = val;
    return null;
  };
  if ('role' in input || !partial) {
    const role = typeof input.role === 'string' ? input.role.trim().replace(/\s+/g, ' ') : '';
    if (!role) return { error: 'Role is required' };
    if (role.length > 300) return { error: 'Role is too long (300 characters max)' };
    v.role = role;
  }
  for (const [k, max, label] of [['company', 200, 'Company'], ['nextAction', 500, 'Next step'], ['notes', 6000, 'Notes']]) {
    const err = str(k, max, label);
    if (err) return { error: err };
  }
  if ('url' in input) {
    const u = input.url == null ? '' : String(input.url).trim();
    if (u && (!/^https?:\/\//i.test(u) || u.length > 2000)) return { error: 'Link must start with http:// or https://' };
    if (u) { try { new URL(u); } catch { return { error: 'Link is not a valid URL' }; } }
    v.url = u;
  }
  for (const [k, options] of [['status', JOB_STATUSES], ['track', TRACKS], ['location', LOCATIONS], ['priority', JOB_PRIORITIES], ['source', SOURCES], ['round', INTERVIEW_ROUNDS]]) {
    if (k in input) {
      const val = input[k] === '' || input[k] == null ? null : input[k];
      if (k === 'status' && val === null) return { error: 'Status is required' };
      if (val !== null && !options.includes(val)) return { error: `${k[0].toUpperCase() + k.slice(1)} must be one of: ${options.join(', ')}` };
      v[k] = val;
    }
  }
  if ('fit' in input) {
    const f = input.fit === '' || input.fit == null ? null : Number(input.fit);
    if (f !== null && (!Number.isFinite(f) || f < 0 || f > 10)) return { error: 'Fit must be a number from 0 to 10' };
    v.fit = f;
  }
  for (const k of ['deadline', 'interview', 'applied', 'nextDate']) {
    if (k in input) {
      const d = input[k] === '' || input[k] == null ? null : input[k];
      if (d !== null && !isDateKey(d)) return { error: `${k} must be YYYY-MM-DD` };
      v[k] = d;
    }
  }
  if (partial && Object.keys(v).length === 0) return { error: 'Nothing to update' };
  return { value: v };
}

/** Notion property payload. `caps` says which optional columns exist (unknown columns are skipped). */
function jobPropertiesFor(fields, caps = { applied: true, nextDate: true, round: true }) {
  const p = {};
  const sel = (name) => ({ select: name ? { name } : null });
  const date = (d) => ({ date: d ? { start: d } : null });
  if ('role' in fields) p[JPROPS.role] = { title: [{ type: 'text', text: { content: fields.role } }] };
  if ('company' in fields) p[JPROPS.company] = { rich_text: fields.company ? richText(fields.company) : [] };
  if ('status' in fields) p[JPROPS.stage] = sel(STATUS_TO_STAGE[fields.status]);
  if ('track' in fields) p[JPROPS.track] = sel(fields.track);
  if ('location' in fields) p[JPROPS.location] = sel(fields.location);
  if ('priority' in fields) p[JPROPS.priority] = sel(fields.priority);
  if ('source' in fields) p[JPROPS.source] = sel(fields.source);
  if ('fit' in fields) p[JPROPS.fit] = { number: fields.fit };
  if ('url' in fields) p[JPROPS.url] = { url: fields.url || null };
  if ('deadline' in fields) p[JPROPS.deadline] = date(fields.deadline);
  if ('interview' in fields) p[JPROPS.interview] = date(fields.interview);
  if ('nextAction' in fields) p[JPROPS.nextAction] = { rich_text: fields.nextAction ? richText(fields.nextAction) : [] };
  if ('notes' in fields) p[JPROPS.notes] = { rich_text: fields.notes ? richText(fields.notes) : [] };
  if ('applied' in fields && caps.applied) p[JPROPS.applied] = date(fields.applied);
  if ('nextDate' in fields && caps.nextDate) p[JPROPS.nextDate] = date(fields.nextDate);
  if ('round' in fields && caps.round) p[JPROPS.round] = sel(fields.round);
  return p;
}

function buildJobsQueryRequest(dataSourceId, { cursor } = {}) {
  const body = { sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 };
  if (cursor) body.start_cursor = cursor;
  return { method: 'POST', path: `/v1/data_sources/${normalizeId(dataSourceId)}/query`, body };
}
function buildJobCreateRequest(dataSourceId, fields, caps) {
  const properties = jobPropertiesFor({ status: 'Interested', ...fields }, caps);
  if (caps?.addedBy) properties[JPROPS.addedBy] = { select: { name: ADDED_BY_ME } }; // created by you in Dayline
  return { method: 'POST', path: '/v1/pages', body: { parent: { type: 'data_source_id', data_source_id: normalizeId(dataSourceId) }, properties } };
}
function buildJobUpdateRequest(pageId, fields, caps) {
  return { method: 'PATCH', path: `/v1/pages/${normalizeId(pageId)}`, body: { properties: jobPropertiesFor(fields, caps) } };
}

const dateStart = (prop) => (prop?.date?.start ? prop.date.start.slice(0, 10) : null);
function parseJobPage(page) {
  const p = page.properties || {};
  const stage = p[JPROPS.stage]?.select?.name || null;
  return {
    id: page.id,
    role: plain(p[JPROPS.role]?.title) || 'Untitled role',
    company: plain(p[JPROPS.company]?.rich_text),
    stage,
    status: STAGE_TO_STATUS[stage] || (stage ? 'Interested' : 'Opportunity'),
    track: p[JPROPS.track]?.select?.name || null,
    location: p[JPROPS.location]?.select?.name || null,
    priority: p[JPROPS.priority]?.select?.name || null,
    source: p[JPROPS.source]?.select?.name || null,
    fit: typeof p[JPROPS.fit]?.number === 'number' ? p[JPROPS.fit].number : null,
    url: p[JPROPS.url]?.url || null,
    deadline: dateStart(p[JPROPS.deadline]),
    interview: dateStart(p[JPROPS.interview]),
    applied: dateStart(p[JPROPS.applied]),
    nextDate: dateStart(p[JPROPS.nextDate]),
    nextAction: plain(p[JPROPS.nextAction]?.rich_text),
    notes: plain(p[JPROPS.notes]?.rich_text),
    addedBy: p[JPROPS.addedBy]?.select?.name || null,
    round: p[JPROPS.round]?.select?.name || null,
    notionUrl: page.url,
    created: page.created_time,
    edited: page.last_edited_time,
  };
}

function capsFromSchema(ds) {
  const props = ds?.properties || {};
  const stageOptions = (props[JPROPS.stage]?.select?.options || []).map((o) => o.name);
  return {
    applied: props[JPROPS.applied]?.type === 'date',
    nextDate: props[JPROPS.nextDate]?.type === 'date',
    interested: stageOptions.includes('Interested'),
    addedBy: props[JPROPS.addedBy]?.type === 'select',
    round: props[JPROPS.round]?.type === 'select',
    stageOptions,
  };
}

function createJobsClient({ token, dataSourceId = JOBS_DEFAULT_DATA_SOURCE_ID, fetchImpl = globalThis.fetch, baseUrl, maxRetries }) {
  const send = createSender({ token, fetchImpl, baseUrl, maxRetries, what: 'the recruiting Pipeline database' });
  let caps = null;
  let capsAt = 0;
  async function getCaps() {
    if (caps && Date.now() - capsAt < 10 * 60000) return caps; // re-read the schema every 10 minutes
    caps = capsFromSchema(await send({ method: 'GET', path: `/v1/data_sources/${normalizeId(dataSourceId)}` }));
    capsAt = Date.now();
    return caps;
  }
  function checkStatus(fields, c) {
    if (fields.status && STATUS_TO_STAGE[fields.status] && c.stageOptions.length && !c.stageOptions.includes(STATUS_TO_STAGE[fields.status])) {
      throw new NotionError(`Your Pipeline's Stage property has no "${STATUS_TO_STAGE[fields.status]}" option yet. Add it in Notion (SETUP.md step 4), then try again.`, 409, 'missing_option');
    }
  }
  return {
    getCaps,
    async list() {
      const pages = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const data = await send(buildJobsQueryRequest(dataSourceId, { cursor }));
        pages.push(...(data.results || []));
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
      return pages.filter((p) => !p.in_trash).map(parseJobPage);
    },
    async create(fields) {
      const c = await getCaps();
      checkStatus({ status: 'Interested', ...fields }, c);
      return parseJobPage(await send(buildJobCreateRequest(dataSourceId, fields, c)));
    },
    async update(id, fields) {
      const c = await getCaps();
      checkStatus(fields, c);
      return parseJobPage(await send(buildJobUpdateRequest(id, fields, c)));
    },
    /** Archive the Notion page (recoverable from Notion trash). Prefer Closed for soft-remove. */
    async archive(id) {
      await send({ method: 'PATCH', path: `/v1/pages/${normalizeId(id)}`, body: { in_trash: true } }); // API 2026-03-11: "archived" was replaced by "in_trash"
      return { id, archived: true };
    },
  };
}

module.exports = {
  JOBS_DEFAULT_DATA_SOURCE_ID, JPROPS, INTERVIEW_ROUNDS, STATUS_TO_STAGE, STAGE_TO_STATUS, TRACKER_STATUSES, JOB_STATUSES, TRACKS, LOCATIONS, BAY_AREA, JOB_PRIORITIES, SOURCES,
  validateJobInput, jobPropertiesFor, buildJobsQueryRequest, buildJobCreateRequest, buildJobUpdateRequest, parseJobPage, capsFromSchema, createJobsClient, richText,
};
