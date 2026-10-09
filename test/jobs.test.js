'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobsClient, validateJobInput, jobPropertiesFor, buildJobsQueryRequest, parseJobPage, capsFromSchema, richText, JOBS_DEFAULT_DATA_SOURCE_ID } = require('../lib/jobs');
const { normalizeId } = require('../lib/notion');
const { res, mockFetch } = require('./helpers');

const DS = JOBS_DEFAULT_DATA_SOURCE_ID;
const PAGE = 'bbbbbbbb-0000-4000-8000-000000000999';
const opts = (...names) => ({ select: { options: names.map((name) => ({ name })) } });
const REAL_SCHEMA = { properties: { Name: { type: 'title' }, Stage: { type: 'select', ...opts('Researching', 'Applied', 'Interview', 'Offer', 'Closed') }, Deadline: { type: 'date' } } };
const FULL_SCHEMA = { properties: { ...REAL_SCHEMA.properties, Stage: { type: 'select', ...opts('Researching', 'Interested', 'Applied', 'Interview', 'Offer', 'Closed') }, 'Date applied': { type: 'date' }, 'Next step date': { type: 'date' } } };
const page = (props = {}) => ({ id: PAGE, url: 'https://notion.so/p', created_time: '2026-09-04T04:32:01.000Z', properties: {
  Name: { title: [{ plain_text: 'AI Product Manager - MBA Intern (Summer 2027)' }] }, Company: { rich_text: [{ plain_text: 'Proseware' }] }, Stage: { select: { name: 'Researching' } },
  Track: { select: { name: 'PM' } }, Location: { select: { name: 'Peninsula' } }, Fit: { number: 5 }, 'Job URL': { url: 'https://job-boards.greenhouse.io/c3ascend/jobs/8860562002' }, ...props } });

function client(schema) {
  const fetchImpl = mockFetch([[(u, i) => (i.method || 'GET') === 'GET', res(200, schema)], [() => true, res(200, page())]]);
  return { fetchImpl, c: createJobsClient({ token: 'ntn_test', fetchImpl }) };
}

test('validateJobInput checks every field', () => {
  assert.equal(validateJobInput({}).error, 'Role is required');
  assert.match(validateJobInput({ role: 'PM', status: 'Rejected' }).error, /Status must be one of/);
  assert.match(validateJobInput({ role: 'PM', url: 'javascript:alert(1)' }).error, /http/);
  assert.match(validateJobInput({ role: 'PM', fit: 11 }).error, /0 to 10/);
  assert.match(validateJobInput({ role: 'PM', applied: '9/16' }).error, /YYYY-MM-DD/);
  assert.deepEqual(validateJobInput({ role: ' PMM  Intern ', company: 'Adobe', fit: '9', location: '', applied: '' }).value, { role: 'PMM Intern', company: 'Adobe', location: null, fit: 9, applied: null });
  assert.equal(validateJobInput({ notes: 'x' }, { partial: true }).value.notes, 'x');
});

test('create sends Stage "Interested" by default with exact Pipeline property shapes', async () => {
  const { fetchImpl, c } = client(FULL_SCHEMA);
  await c.create({ role: '2027 MBA Intern – Product Marketing Manager', company: 'Adobe', track: 'PMM', location: 'South Bay', source: 'Company site', url: 'https://adobe.wd5.myworkdayjobs.com/x', deadline: '2026-10-31', notes: 'Pay: $37–$50/hr' });
  const post = fetchImpl.calls.at(-1);
  assert.equal(post.url, 'https://api.notion.com/v1/pages');
  assert.equal(post.headers['Notion-Version'], '2026-03-11');
  assert.deepEqual(post.body, {
    parent: { type: 'data_source_id', data_source_id: DS },
    properties: {
      Name: { title: [{ type: 'text', text: { content: '2027 MBA Intern – Product Marketing Manager' } }] },
      Company: { rich_text: [{ type: 'text', text: { content: 'Adobe' } }] },
      Stage: { select: { name: 'Interested' } },
      Track: { select: { name: 'PMM' } }, Location: { select: { name: 'South Bay' } }, Source: { select: { name: 'Company site' } },
      'Job URL': { url: 'https://adobe.wd5.myworkdayjobs.com/x' },
      Deadline: { date: { start: '2026-10-31' } },
      Notes: { rich_text: [{ type: 'text', text: { content: 'Pay: $37–$50/hr' } }] },
    },
  });
});

test('"Move to tracker" is a single Stage change on the existing row', async () => {
  const { fetchImpl, c } = client(FULL_SCHEMA);
  await c.update(PAGE, { status: 'Interested' });
  const patch = fetchImpl.calls.at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url, `https://api.notion.com/v1/pages/${PAGE}`);
  assert.deepEqual(patch.body, { properties: { Stage: { select: { name: 'Interested' } } } });
});

test('marking applied writes Stage + Date applied + next step when those columns exist', async () => {
  const { fetchImpl, c } = client(FULL_SCHEMA);
  await c.update(PAGE, { status: 'Applied', applied: '2026-10-05', nextAction: 'Follow up with recruiter', nextDate: '2026-10-12' });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { properties: {
    Stage: { select: { name: 'Applied' } }, 'Next Action': { rich_text: [{ type: 'text', text: { content: 'Follow up with recruiter' } }] },
    'Date applied': { date: { start: '2026-10-05' } }, 'Next step date': { date: { start: '2026-10-12' } },
  } });
});

test('older schema (before Oct 5 2026): optional date columns are skipped, and "Interested" gives a clear 409 without writing', async () => {
  const { fetchImpl, c } = client(REAL_SCHEMA);
  await c.update(PAGE, { status: 'Applied', applied: '2026-10-05', nextDate: '2026-10-12' });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { properties: { Stage: { select: { name: 'Applied' } } } });
  const before = fetchImpl.calls.length;
  await assert.rejects(c.update(PAGE, { status: 'Interested' }), (e) => e.status === 409 && e.code === 'missing_option' && /Interested/.test(e.message));
  await assert.rejects(c.create({ role: 'x' }), (e) => e.status === 409);
  assert.equal(fetchImpl.calls.length, before, 'no PATCH/POST sent');
  assert.deepEqual(capsFromSchema(REAL_SCHEMA), { applied: false, nextDate: false, interested: false, addedBy: false, round: false, stageOptions: ['Researching', 'Applied', 'Interview', 'Offer', 'Closed'] });
});

test('clearing values and long notes', () => {
  const p = jobPropertiesFor({ url: '', fit: null, deadline: null, company: '', notes: 'a'.repeat(4500) });
  assert.deepEqual(p['Job URL'], { url: null });
  assert.deepEqual(p.Fit, { number: null });
  assert.deepEqual(p.Deadline, { date: null });
  assert.deepEqual(p.Company, { rich_text: [] });
  assert.deepEqual(p.Notes.rich_text.map((t) => t.text.content.length), [2000, 2000, 500]);
  assert.equal(richText('').length, 0);
});

test('query and page parsing: Researching rows are Opportunities, Interview maps to Interviewing', () => {
  assert.deepEqual(buildJobsQueryRequest(DS), { method: 'POST', path: `/v1/data_sources/${normalizeId(DS)}/query`, body: { sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 } });
  const opp = parseJobPage(page());
  assert.equal(opp.status, 'Opportunity');
  assert.equal(opp.company, 'Proseware');
  assert.equal(opp.fit, 5);
  assert.equal(opp.applied, null);
  const iv = parseJobPage(page({ Stage: { select: { name: 'Interview' } }, Interview: { date: { start: '2026-10-08T10:00:00.000-07:00' } }, 'Date applied': { date: { start: '2026-09-16' } } }));
  assert.equal(iv.status, 'Interviewing');
  assert.equal(iv.interview, '2026-10-08');
  assert.equal(iv.applied, '2026-09-16');
  assert.equal(parseJobPage(page({ Stage: { select: { name: 'Phone screen' } } })).status, 'Interested'); // unknown custom stage still shows in the tracker
});

const ADDED_BY_SCHEMA = { properties: { ...FULL_SCHEMA.properties, 'Added by': { type: 'select', ...opts('Me', 'Bot') } } };
test('her schema since Oct 5 2026: new jobs get Added by = Me; updates never touch it; Interested works', async () => {
  const { fetchImpl, c } = client(ADDED_BY_SCHEMA);
  assert.deepEqual(capsFromSchema(ADDED_BY_SCHEMA), { applied: true, nextDate: true, interested: true, addedBy: true, round: false, stageOptions: ['Researching', 'Interested', 'Applied', 'Interview', 'Offer', 'Closed'] });
  await c.create({ role: 'PMM Intern', company: 'Adobe', applied: '2026-10-05', nextDate: '2026-10-12' });
  const post = fetchImpl.calls.at(-1).body.properties;
  assert.deepEqual(post['Added by'], { select: { name: 'Me' } });
  assert.deepEqual(post.Stage, { select: { name: 'Interested' } });
  assert.deepEqual(post['Date applied'], { date: { start: '2026-10-05' } });
  assert.deepEqual(post['Next step date'], { date: { start: '2026-10-12' } });
  await c.update(PAGE, { status: 'Interested' }); // "Move to tracker"
  assert.deepEqual(fetchImpl.calls.at(-1).body, { properties: { Stage: { select: { name: 'Interested' } } } });
  // a client can't claim to be a bot or rewrite who added a row
  assert.equal('addedBy' in (validateJobInput({ role: 'x', addedBy: 'Bot' }).value), false);
  assert.equal(parseJobPage(page({ 'Added by': { select: { name: 'Bot' } } })).addedBy, 'Bot');
  assert.equal(parseJobPage(page()).addedBy, null);
});
test('without the Added by column, creates still work and send no Added by', async () => {
  const { fetchImpl, c } = client(FULL_SCHEMA);
  await c.create({ role: 'x' });
  assert.equal('Added by' in fetchImpl.calls.at(-1).body.properties, false);
});
