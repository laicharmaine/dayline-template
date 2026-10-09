'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotionClient, buildQueryRequest, buildCreateRequest, buildUpdateRequest, validateTaskInput, normalizeId, NOTION_VERSION } = require('../lib/notion');
const { res, mockFetch } = require('./helpers');

const DS = '11111111-1111-4111-8111-111111111111';
const PAGE = 'abcdef01234541238123456789abcdef';
const pageBody = (props = {}) => ({ object: 'page', id: normalizeId(PAGE), url: 'https://notion.so/x', properties: { 'Task name': { title: [{ plain_text: 'Club B app' }] }, Status: { status: { name: 'Done' } }, ...props } });
const schema = (type = 'status') => res(200, { object: 'data_source', properties: { Status: { type } } });

function client(statusType = 'status', extra = {}) {
  const fetchImpl = mockFetch([
    [(u, i) => (i.method || 'GET') === 'GET', schema(statusType)],
    [(u) => u.endsWith('/query'), res(200, { results: [pageBody({ Status: { status: { name: 'Not started' } } })], has_more: false })],
    [() => true, res(200, pageBody())],
  ]);
  return { fetchImpl, c: createNotionClient({ token: 'ntn_test', dataSourceId: DS, fetchImpl, ...extra }) };
}

test('ids: accepts raw hex, dashed UUIDs and Notion URLs', () => {
  assert.equal(normalizeId('https://www.notion.so/Todo-11111111111141118111111111111111?v=1'), DS);
  assert.equal(normalizeId('collection://11111111-1111-4111-8111-111111111111'), DS);
  assert.equal(normalizeId('nope'), '');
});

test('check-off sends exactly one PATCH with the status property and the right headers', async () => {
  const { fetchImpl, c } = client();
  await c.update(PAGE, { status: 'Done' });
  const [get, patch] = fetchImpl.calls;
  assert.equal(get.url, `https://api.notion.com/v1/data_sources/${DS}`);
  assert.equal(get.method, 'GET');
  assert.equal(patch.url, `https://api.notion.com/v1/pages/${normalizeId(PAGE)}`);
  assert.equal(patch.method, 'PATCH');
  assert.deepEqual(patch.headers, { Authorization: 'Bearer ntn_test', 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' });
  assert.equal(NOTION_VERSION, '2026-03-11');
  assert.deepEqual(patch.body, { properties: { Status: { status: { name: 'Done' } } } });
});

test('create posts to /v1/pages with a data_source_id parent and all fields', async () => {
  const { fetchImpl, c } = client('status', { assigneeId: '99999999-9999-4999-8999-999999999999' });
  await c.create({ name: 'Email recruiter', area: 'Recruiting', priority: 'High', due: '2026-10-07' });
  const post = fetchImpl.calls.at(-1);
  assert.equal(post.url, 'https://api.notion.com/v1/pages');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, {
    parent: { type: 'data_source_id', data_source_id: DS },
    properties: {
      'Task name': { title: [{ type: 'text', text: { content: 'Email recruiter' } }] },
      Status: { status: { name: 'Not started' } },
      Area: { select: { name: 'Recruiting' } },
      Priority: { select: { name: 'High' } },
      'Due date': { date: { start: '2026-10-07' } },
      Assignee: { people: [{ object: 'user', id: '99999999-9999-4999-8999-999999999999' }] },
    },
  });
});

test('edit and clear: renames, clears the due date and the area', async () => {
  const { fetchImpl, c } = client();
  await c.update(PAGE, { name: 'Club B app (final)', due: null, area: null, priority: 'Low' });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { properties: {
    'Task name': { title: [{ type: 'text', text: { content: 'Club B app (final)' } }] },
    Area: { select: null }, Priority: { select: { name: 'Low' } }, 'Due date': { date: null },
  } });
});

test('list query filters out Done and sorts by due date', async () => {
  const { fetchImpl, c } = client();
  const tasks = await c.listOpen();
  const q = fetchImpl.calls.find((x) => x.url.endsWith('/query'));
  assert.deepEqual(q.body, { filter: { property: 'Status', status: { does_not_equal: 'Done' } }, sorts: [{ property: 'Due date', direction: 'ascending' }], page_size: 100 });
  assert.equal(tasks[0].name, 'Club B app');
  assert.equal(tasks[0].done, false);
});

test('falls back to select-typed Status when the schema says so', async () => {
  const { fetchImpl, c } = client('select');
  await c.update(PAGE, { status: 'Done' });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { properties: { Status: { select: { name: 'Done' } } } });
  assert.deepEqual(buildQueryRequest(DS, { statusType: 'select' }).body.filter, { property: 'Status', select: { does_not_equal: 'Done' } });
});

test('friendly errors for a bad token or an unshared database', async () => {
  const bad = createNotionClient({ token: 'x', dataSourceId: DS, statusType: 'status', fetchImpl: mockFetch([[() => true, res(401, { code: 'unauthorized', message: 'API token is invalid.' })]]) });
  await assert.rejects(bad.listOpen(), /NOTION_TOKEN/);
  const missing = createNotionClient({ token: 'x', dataSourceId: DS, statusType: 'status', fetchImpl: mockFetch([[() => true, res(404, { code: 'object_not_found', message: 'nope' })]]) });
  await assert.rejects(missing.listOpen(), (e) => e.status === 404 && /integration connected/.test(e.message));
});

test('retries once after a 429', async () => {
  let n = 0;
  const fetchImpl = mockFetch([[() => true, () => (n++ === 0 ? res(429, { code: 'rate_limited' }, { 'retry-after': '0' }) : res(200, { results: [], has_more: false }))]]);
  const c = createNotionClient({ token: 'x', dataSourceId: DS, statusType: 'status', fetchImpl });
  assert.deepEqual(await c.listOpen(), []);
  assert.equal(fetchImpl.calls.length, 2);
});

test('validation: names required, options checked, dates must be YYYY-MM-DD', () => {
  assert.equal(validateTaskInput({}).error, 'Task name is required');
  assert.match(validateTaskInput({ name: 'x', area: 'Work' }).error, /Area must be one of/);
  assert.match(validateTaskInput({ name: 'x', due: '10/5' }).error, /YYYY-MM-DD/);
  assert.deepEqual(validateTaskInput({ name: '  a   b ', due: '', area: '' }).value, { name: 'a b', due: null, area: null });
  assert.equal(validateTaskInput({}, { partial: true }).error, 'Nothing to update');
  assert.deepEqual(buildUpdateRequest(PAGE, { status: 'In progress' }).body, { properties: { Status: { status: { name: 'In progress' } } } });
  assert.equal(buildCreateRequest(DS, { name: 'x' }).body.properties.Status.status.name, 'Not started');
});

test('tasks: create sets Added by = Me when the column exists; updates and parsing', async () => {
  const fetchImpl = mockFetch([
    [(u, i) => (i.method || 'GET') === 'GET', res(200, { object: 'data_source', properties: { Status: { type: 'status' }, 'Added by': { type: 'select', select: { options: [{ name: 'Me' }, { name: 'Bot' }] } } } })],
    [() => true, res(200, pageBody({ 'Added by': { select: { name: 'Me' } } }))],
  ]);
  const c = createNotionClient({ token: 'ntn_test', dataSourceId: DS, fetchImpl });
  const t = await c.create({ name: 'Email recruiter' });
  assert.deepEqual(fetchImpl.calls.at(-1).body.properties['Added by'], { select: { name: 'Me' } });
  assert.equal(t.addedBy, 'Me');
  await c.update(PAGE, { status: 'Done' });
  assert.equal('Added by' in fetchImpl.calls.at(-1).body.properties, false);
  assert.equal(fetchImpl.calls.filter((x) => x.method === 'GET').length, 1, 'schema read once');
  assert.equal('addedBy' in validateTaskInput({ name: 'x', addedBy: 'Bot' }).value, false);
});
test('tasks: no Added by column (or schema unreadable) means no Added by on create', async () => {
  const { fetchImpl, c } = client();
  await c.create({ name: 'x' });
  assert.equal('Added by' in fetchImpl.calls.at(-1).body.properties, false);
});

test('notes and link: long notes go to Notion in segments of at most 2,000 characters; links are checked', async () => {
  const { richText, checkLink, parsePage: parse } = require('../lib/notion');
  const fetchImpl = mockFetch([
    [(u, i) => (i.method || 'GET') === 'GET', res(200, { object: 'data_source', properties: { Status: { type: 'status' }, Notes: { type: 'rich_text' }, Link: { type: 'url' } } })],
    [() => true, res(200, pageBody())],
  ]);
  const c = createNotionClient({ token: 'ntn_test', dataSourceId: DS, fetchImpl });
  const long = 'x'.repeat(4500) + ' https://example.com/app';
  await c.update(PAGE, validateTaskInput({ notes: long, link: 'notion.so/my-app' }, { partial: true }).value); // as the API route does
  const props = fetchImpl.calls.at(-1).body.properties;
  assert.deepEqual(props.Notes.rich_text.map((r) => r.text.content.length), [2000, 2000, 524]);
  assert.equal(props.Notes.rich_text.map((r) => r.text.content).join(''), long);
  assert.deepEqual(props.Link, { url: 'https://notion.so/my-app' });
  await c.update(PAGE, { notes: '', link: '' });
  assert.deepEqual(fetchImpl.calls.at(-1).body.properties, { Notes: { rich_text: [] }, Link: { url: null } });
  await c.create({ name: 'With extras', notes: 'see https://a.example', link: 'https://b.example/x' });
  const created = fetchImpl.calls.at(-1).body.properties;
  assert.equal(created.Notes.rich_text[0].text.content, 'see https://a.example');
  assert.deepEqual(created.Link, { url: 'https://b.example/x' });
  await c.create({ name: 'Plain' });
  const plainProps = fetchImpl.calls.at(-1).body.properties;
  assert.equal('Notes' in plainProps || 'Link' in plainProps, false);

  assert.equal(richText('a'.repeat(250000)).length, 100);
  assert.match(validateTaskInput({ name: 'x', link: 'javascript:alert(1)' }).error, /web address/);
  assert.match(validateTaskInput({ name: 'x', link: 'ftp://files.example' }).error, /web address/);
  assert.equal(checkLink('https://ok.example/a?b=1').value, 'https://ok.example/a?b=1');
  assert.match(validateTaskInput({ name: 'x', notes: 'n'.repeat(20001) }).error, /too long/);
  assert.equal(validateTaskInput({ name: 'x', notes: 'a\r\nb' }).value.notes, 'a\nb');

  const p = parse(pageBody({ Notes: { rich_text: [{ type: 'text', plain_text: 'plain ', text: { content: 'plain ' }, annotations: { bold: false, color: 'default' } }, { type: 'text', plain_text: 'bold', text: { content: 'bold' }, annotations: { bold: true, color: 'default' } }] }, Link: { url: 'https://x.example' } }));
  assert.equal(p.notes, 'plain bold');
  assert.equal(p.notesRich, true);
  assert.equal(p.link, 'https://x.example');
  assert.equal(parse(pageBody({ Notes: { rich_text: [{ type: 'text', plain_text: 'hi', text: { content: 'hi' }, annotations: { bold: false, color: 'default' } }] } })).notesRich, false);
  assert.equal(parse(pageBody({ Notes: { rich_text: [{ type: 'text', plain_text: 'y'.repeat(3000), text: { content: 'y'.repeat(3000) } }] } })).notes.length, 3000);
});

test('notes and link: a database without a Link column never gets one sent', async () => {
  const fetchImpl = mockFetch([[(u, i) => (i.method || 'GET') === 'GET', res(200, { object: 'data_source', properties: { Status: { type: 'status' }, Notes: { type: 'rich_text' } } })], [() => true, res(200, pageBody())]]);
  const c = createNotionClient({ token: 'ntn_test', dataSourceId: DS, fetchImpl });
  await c.update(PAGE, { link: 'https://x.example', notes: 'n' });
  assert.deepEqual(fetchImpl.calls.at(-1).body.properties, { Notes: { rich_text: [{ type: 'text', text: { content: 'n' } }] } });
});
