'use strict';
// Coffee chats (People + Touch points), Offer "thank your network", interview rounds and 24h thank-you reminders.
// Route tests run against local fixture copies + a temp JSON network file: nothing here can reach Notion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('../lib/network');
const thanks = require('../lib/thanks');
const { sampleNetwork, SAMPLE_JOB_IDS, samplePersonId } = require('../lib/network-sample');
const { createApp } = require('../lib/app');
const { createNotionClient } = require('../lib/notion');
const { createJobsClient, JOBS_DEFAULT_DATA_SOURCE_ID, INTERVIEW_ROUNDS, validateJobInput } = require('../lib/jobs');
const { createFixtureNotionFetch } = require('../lib/fixture-notion');
const { createFileStore } = require('../lib/store');

const TODAY = '2026-10-07';
const TASK_DS = '11111111-1111-4111-8111-111111111111';
const P = samplePersonId;

test('validatePerson / validateTouch', () => {
  assert.ok(net.validatePerson({}).error);
  assert.ok(net.validatePerson({ name: 'A', strength: 'Hot' }).error);
  assert.deepEqual(net.validatePerson({ name: ' Ann ', company: 'Litware', strength: 'Warm' }).value, { name: 'Ann', company: 'Litware', strength: 'Warm' });
  assert.ok(net.validatePerson({ name: 'A', linkedin: 'javascript:alert(1)' }).error, 'only http(s) links');
  assert.ok(net.validateTouch({ type: 'Coffee chat', date: TODAY }).error, 'needs a person');
  assert.ok(net.validateTouch({ personId: P(1), type: 'Lunch', date: TODAY }).error, 'type must be known');
  const ok = net.validateTouch({ personId: P(1), type: 'Coffee chat', date: TODAY, notes: 'Hi' });
  assert.equal(ok.error, undefined);
  assert.ok(net.TOUCH_TYPES.includes('Thank-you note') && net.TOUCH_TYPES.includes('Interview'));
});

test('companyKey, followUpState, summarize and the graph', () => {
  assert.equal(net.companyKey('Contoso Corporation'), net.companyKey('contoso'));
  assert.deepEqual(['2026-10-01', TODAY, '2026-10-10', '2026-11-10'].map((d) => net.followUpState(d, TODAY)), ['overdue', 'today', 'soon', 'later']);
  const { people, touches } = sampleNetwork(TODAY);
  const jobs = [{ id: SAMPLE_JOB_IDS.contoso, company: 'Contoso', role: 'Marketing MBA Intern', status: 'Interviewing' }];
  const s = net.summarize({ people, touches, today: TODAY, jobs });
  const avery = s.people.find((p) => p.id === P(1));
  assert.equal(avery.touchCount, 2);
  assert.equal(avery.lastTouch.type, 'Referral ask');
  assert.deepEqual(avery.matchedJobIds, [SAMPLE_JOB_IDS.contoso]);
  assert.equal(s.people.find((p) => p.id === P(7)).followUpState, 'overdue');
  assert.equal(s.stats.people, 8);
  assert.equal(s.stats.touches, 9);
  assert.ok(s.stats.followUpsDue >= 2, 'Taylor (late) + Jordan (today)');
  assert.ok(s.stats.chatsThisWeek >= 1);
  const g = net.buildGraph(s.people);
  assert.ok(g.edges.some((e) => e.from === P(1) && e.to === P(2) && e.kind === 'intro'), 'Avery introduced Jordan');
  assert.ok(g.edges.some((e) => e.from === 'me' && e.to === P(1)));
});

test('Offer: thank-your-network candidates and template drafts', async () => {
  const { people, touches } = sampleNetwork(TODAY);
  const job = { id: SAMPLE_JOB_IDS.contoso, company: 'Contoso', role: 'Marketing MBA Internship Opportunities, United States', status: 'Offer' };
  const cands = net.thankCandidates({ job, people, touches });
  const ids = cands.map((c) => c.id);
  assert.ok(ids.includes(P(1)) && ids.includes(P(2)), 'Contoso contacts');
  assert.ok(!ids.includes(P(6)), 'Tailspin Toys contact is not suggested');
  const drafts = await net.draftThankYous({ job, people: people.filter((p) => p.id === P(1)), touches, accepted: false, why: {}, geminiKey: '' });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source, 'template');
  assert.match(drafts[0].message, /^Hi Avery,/);
  assert.match(drafts[0].message, /offer/i);
  assert.match(drafts[0].message, /referr/i, 'mentions the referral touch');
});

test('thank-you reminder records: notes marker round-trip, To Do fields, past interviews', () => {
  const rec = { kind: 'interview', jobId: SAMPLE_JOB_IDS.contoso, round: 'First round', date: '2026-10-08', interviewers: [{ name: 'Pat Example', email: 'pat@example.com' }], notes: 'Talked about Assistant.', company: 'Contoso', state: 'open' };
  const notes = thanks.notesFor(rec);
  assert.ok(notes.includes(thanks.MARK));
  const back = thanks.parseNotes(notes);
  assert.equal(back.kind, 'interview');
  assert.equal(back.round, 'First round');
  assert.equal(back.interviewers[0].email, 'pat@example.com');
  assert.match(back.notes, /Assistant/);
  const f = thanks.taskFields(rec);
  assert.equal(f.area, 'Recruiting');
  assert.equal(f.due, '2026-10-09', 'due the day after');
  assert.match(f.name, /^Send thank-you to Pat Example \(Contoso · First round\)/);
  assert.equal(thanks.taskFields({ ...rec, state: 'skipped' }).status, 'Done');
  const jobs = [
    { id: 'a', company: 'Contoso', role: 'PMM', status: 'Interviewing', round: 'First round', interview: null, notes: '' },
    { id: 'b', company: 'Acme', role: 'PM', status: 'Applied', notes: 'Completed phone screen with recruiter on 9/30' },
    { id: 'c', company: 'Beta', role: 'PM', status: 'Interviewing', round: 'Second round', interview: '2026-10-07' },
    { id: 'd', company: 'Gamma', role: 'PM', status: 'Applied', notes: 'Interview scheduled for next week' },
  ];
  const check = thanks.pastInterviews({ jobs, records: [], today: TODAY });
  assert.deepEqual(check.map((c) => c.jobId).sort(), ['a', 'b'], 'undated Interviewing + "completed" notes; not future/after-launch');
  const handled = thanks.pastInterviews({ jobs, records: [{ kind: 'interview', jobId: 'a', round: 'First round', done: true }], today: TODAY });
  assert.ok(!handled.some((c) => c.jobId === 'a'));
  assert.deepEqual(thanks.sweepDue({ jobs, records: [], today: TODAY }).map((j) => j.id), ['c'], 'only interviews on/after launch day that have passed');
});

test('thank-you templates: 3 versions for chats and interviews', () => {
  const chat = thanks.templateVersions({ kind: 'chat', recipient: { name: 'Avery Sample' }, person: { name: 'Avery Sample', company: 'Contoso', role: 'Senior PMM, Cloud' }, date: '2026-10-06', today: TODAY, notes: 'Walked through how Cloud PMMs partner with sales on launches.' });
  assert.equal(chat.length, 3);
  assert.deepEqual(chat.map((v) => v.label), ['Short & warm', 'With a specific takeaway', 'Takeaway + light ask']);
  assert.ok(chat.every((v) => v.body.startsWith('Hi Avery,') && v.subject));
  assert.match(chat[0].body, /yesterday/);
  assert.match(chat[1].body, /how Cloud PMMs partner with sales/i);
  const iv = thanks.templateVersions({ kind: 'interview', recipient: { name: 'Pat Example' }, job: { company: 'Contoso', role: 'Marketing MBA Internship Opportunities, United States' }, round: 'First round', date: TODAY, today: TODAY, notes: 'Discussed a launch I led.' });
  assert.equal(iv.length, 3);
  assert.ok(iv.every((v) => /Contoso/.test(v.subject + v.body)));
  assert.match(iv[0].body, /first round/i);
});

test('interview rounds: validated on job input', () => {
  assert.deepEqual(INTERVIEW_ROUNDS, ['Recruiter screen', 'First round', 'Second round', 'Final round']);
  assert.ok(validateJobInput({ round: 'Fourth round' }, { partial: true }).error);
  assert.equal(validateJobInput({ round: 'Final round' }, { partial: true }).value.round, 'Final round');
});

// ---------- routes ----------
async function startApp() {
  const real = path.join(__dirname, '..', 'data', 'fixtures');
  assert.ok(fs.existsSync(path.join(real, 'notion-jobs.json')) && fs.existsSync(path.join(real, 'notion-pages.json')), 'run npm run fixtures first');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-net-'));
  const fx = createFixtureNotionFetch({ sources: [
    { dataSourceId: TASK_DS, seedFile: path.join(real, 'notion-pages.json'), localFile: path.join(dir, 'tasks.local.json') },
    { dataSourceId: JOBS_DEFAULT_DATA_SOURCE_ID, seedFile: path.join(real, 'notion-jobs.json'), localFile: path.join(dir, 'jobs.local.json') },
  ] });
  // Count every Notion write (anything but GET and .../query) the app makes through the fixture fetch.
  const writes = [];
  const counted = async (url, opts = {}) => {
    const m = String(opts.method || 'GET').toUpperCase(); const p = new URL(String(url)).pathname;
    if (m !== 'GET' && !/\/query$/.test(p)) writes.push(`${m} ${p}`);
    return fx(url, opts);
  };
  const notion = createNotionClient({ token: 'fixture', dataSourceId: TASK_DS, fetchImpl: counted });
  const jobs = createJobsClient({ token: 'fixture', fetchImpl: counted });
  const network = net.createFileNetwork({ file: path.join(dir, 'network.json'), seed: () => sampleNetwork(TODAY) });
  const store = createFileStore({ file: path.join(dir, 'store.json') });
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' },
    notion, jobs, network, store, calendar: { getEvents: async () => [], status: () => [] },
    now: () => new Date(`${TODAY}T12:00:00-05:00`),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, notion, store, writes, jobs, dir, base, close: () => new Promise((r) => { server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }) };
}

test('/api/network: list, stats, CRUD, quick log + 24h thank-you reminder (Dayline store, no To Do row)', async () => {
  const s = await startApp();
  try {
    const unauth = await fetch(s.base + '/api/network');
    assert.equal(unauth.status, 401);
    const g = await s.call('/api/network');
    assert.equal(g.status, 200);
    assert.equal(g.body.backend, 'file');
    assert.equal(g.body.people.length, 8);
    assert.equal(g.body.graph.nodes.length, 8);
    assert.ok(g.body.options.types.includes('Coffee chat'));
    assert.ok(g.body.jobs.some((j) => j.id === SAMPLE_JOB_IDS.contoso));

    // quick log with a brand-new person: the reminder goes to the Dayline store, not her To Do list
    const openBefore = (await s.notion.listOpen()).length;
    const log = await s.call('/api/network/log', { method: 'POST', body: { person: { name: 'Drew Fakename', company: 'Litware', role: 'PM' }, touch: { type: 'Coffee chat', date: TODAY, notes: 'Litware product org structure; tips on the case interview.' } } });
    assert.equal(log.status, 201);
    assert.equal(log.body.createdPerson, true);
    assert.equal(log.body.reminder.kind, 'chat');
    assert.equal(log.body.reminder.due, '2026-10-08');
    assert.equal(log.body.reminder.taskId, undefined);
    assert.equal((await s.notion.listOpen()).length, openBefore, 'no To Do row');
    assert.deepEqual(s.writes, [], 'no Notion writes at all (network is the file backend here)');
    assert.equal((await s.store.list('thanks')).length, 1);
    // logging again for the same name+company reuses the person; remind:false skips the reminder
    const again = await s.call('/api/network/log', { method: 'POST', body: { person: { name: 'drew fakename', company: 'Litware' }, touch: { type: 'Coffee chat', date: TODAY }, remind: false } });
    assert.equal(again.body.createdPerson, false);
    assert.equal(again.body.person.id, log.body.person.id);
    assert.equal(again.body.reminder, undefined);
    // a non-chat touch never creates a reminder; a follow-up date becomes Next follow-up
    const li = await s.call('/api/network/touches', { method: 'POST', body: { personId: P(6), type: 'LinkedIn message', date: TODAY, followUp: '2026-10-14' } });
    assert.equal(li.status, 201);
    assert.equal(li.body.reminder, undefined);
    const after = await s.call('/api/network');
    assert.equal(after.body.people.find((p) => p.id === P(6)).nextFollowUp, '2026-10-14');
    assert.equal(after.body.people.find((p) => p.id === log.body.person.id).touchCount, 2);

    // reminder shows on /api/thanks; drafts give 3 versions with subject + body; nothing is sent
    const th = await s.call('/api/thanks');
    assert.equal(th.body.store, 'file');
    const rem = th.body.reminders.find((r) => r.id === log.body.reminder.id);
    assert.ok(rem && !rem.overdue);
    assert.equal(rem.person.name, 'Drew Fakename');
    const dr = await s.call('/api/thanks/drafts', { method: 'POST', body: { id: rem.id } });
    assert.equal(dr.status, 200);
    assert.equal(dr.body.drafts[0].versions.length, 3);
    assert.match(dr.body.drafts[0].versions[1].body, /Litware product org structure/i);
    // "Add to my to-dos" (her tap) is the only thing that makes a To Do row; tapping twice does not duplicate
    const todo = await s.call('/api/thanks/todo', { method: 'POST', body: { id: rem.id } });
    assert.equal(todo.status, 201);
    const task = (await s.notion.listOpen()).find((t) => t.id === todo.body.task.id);
    assert.ok(task, 'To Do created on request');
    assert.equal(task.addedBy, 'Me');
    assert.match(task.name, /^Send thank-you to Drew Fakename \(Litware\)/);
    const todo2 = await s.call('/api/thanks/todo', { method: 'POST', body: { id: rem.id } });
    assert.equal(todo2.body.existed, true);
    assert.equal((await s.notion.listOpen()).length, openBefore + 1);
    // mark sent: completes the To Do she added + logs a Thank-you note touch point
    const res = await s.call('/api/thanks/resolve', { method: 'POST', body: { id: rem.id, action: 'sent', message: 'Hi Drew, thanks!' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.logged, 1);
    assert.ok(!(await s.notion.listOpen()).some((t) => t.id === todo.body.task.id), 'To Do completed');
    const net2 = await s.call('/api/network?fresh=1');
    assert.ok(net2.body.touches.some((t) => t.personId === log.body.person.id && t.type === 'Thank-you note'));
    assert.ok(!(await s.call('/api/thanks')).body.reminders.some((r) => r.id === rem.id));

    // edit + delete (delete trashes their touch points too)
    const upd = await s.call(`/api/network/people/${log.body.person.id}`, { method: 'PATCH', body: { strength: 'Strong', tags: ['PM', 'Referral'] } });
    assert.equal(upd.body.strength, 'Strong');
    const bad = await s.call(`/api/network/people/${log.body.person.id}`, { method: 'PATCH', body: { strength: 'Best' } });
    assert.equal(bad.status, 400);
    const del = await s.call(`/api/network/people/${log.body.person.id}`, { method: 'DELETE', body: {} });
    assert.equal(del.status, 200);
    const net3 = await s.call('/api/network?fresh=1');
    assert.ok(!net3.body.people.some((p) => p.id === log.body.person.id));
    assert.ok(!net3.body.touches.some((t) => t.personId === log.body.person.id));
  } finally { await s.close(); }
});

test('/api/network/thanks: Offer panel candidates + drafts (template without a Gemini key)', async () => {
  const s = await startApp();
  try {
    const c = await s.call(`/api/network/thanks?jobId=${SAMPLE_JOB_IDS.contoso}`);
    assert.equal(c.status, 200);
    assert.ok(c.body.candidates.some((x) => x.id === P(1)) && c.body.candidates.some((x) => x.id === P(2)));
    const none = await s.call('/api/network/thanks/drafts', { method: 'POST', body: { jobId: SAMPLE_JOB_IDS.contoso, personIds: [] } });
    assert.equal(none.status, 400);
    const d = await s.call('/api/network/thanks/drafts', { method: 'POST', body: { jobId: SAMPLE_JOB_IDS.contoso, personIds: [P(1), P(2)], accepted: true } });
    assert.equal(d.status, 200);
    assert.equal(d.body.drafts.length, 2);
    assert.ok(d.body.drafts.every((x) => x.source === 'template' && x.subject && x.message.length > 60));
  } finally { await s.close(); }
});

test('/api/thanks: past interviews -> "to check"; passed interviews -> derived reminders; no background Notion writes', async () => {
  const s = await startApp();
  try {
    const th = await s.call('/api/thanks');
    assert.equal(th.status, 200);
    const ms = th.body.toCheck.find((c) => c.jobId === SAMPLE_JOB_IDS.contoso);
    assert.ok(ms, 'Contoso (Interviewing, date TBD) is listed to check');
    assert.equal(ms.round, 'First round');
    assert.equal(th.body.reminders.length, 0);
    // An interview dated today (since launch) shows as a reminder, but nothing is written anywhere for it
    await s.jobs.update(SAMPLE_JOB_IDS.fabrikam, { status: 'Interviewing', interview: TODAY });
    s.writes.length = 0;
    const th2 = await s.call('/api/thanks?fresh=1');
    const nv = th2.body.reminders.find((r) => r.jobId === SAMPLE_JOB_IDS.fabrikam);
    assert.ok(nv && nv.virtual, 'derived reminder for the passed interview');
    assert.equal(nv.due, '2026-10-08');
    await s.call('/api/thanks'); await s.call('/api/thanks?fresh=1');
    assert.deepEqual(s.writes, [], 'GET /api/thanks never writes to Notion');
    assert.equal((await s.store.list('thanks')).length, 0, 'and not to the store either');
    // Skip "to check": recorded in the Dayline store (not Notion), and it stops showing
    const skip = await s.call('/api/thanks/resolve', { method: 'POST', body: { jobId: SAMPLE_JOB_IDS.contoso, round: 'First round', action: 'skip' } });
    assert.equal(skip.status, 200);
    assert.equal(skip.body.reminder.state, 'skipped');
    assert.deepEqual(s.writes, [], 'skip writes only to the Dayline store');
    assert.ok(!(await s.call('/api/thanks')).body.toCheck.some((c) => c.jobId === SAMPLE_JOB_IDS.contoso));
    // Resolving a derived reminder stores the decision
    const nvSkip = await s.call('/api/thanks/resolve', { method: 'POST', body: { id: nv.id, action: 'skip' } });
    assert.equal(nvSkip.status, 200);
    assert.ok(!(await s.call('/api/thanks')).body.reminders.some((r) => r.jobId === SAMPLE_JOB_IDS.fabrikam));
    // Log the second round with an interviewer added to People (her Save): job round/date update, reminder in the store
    const openBefore = (await s.notion.listOpen()).length;
    const iv = await s.call('/api/thanks/interview', { method: 'POST', body: { jobId: SAMPLE_JOB_IDS.contoso, round: 'Second round', date: TODAY, interviewers: [{ name: 'Pat Interviewer', email: 'pat@example.com', addToNetwork: true }], notes: 'Case on Assistant pricing.' } });
    assert.equal(iv.status, 201);
    assert.equal(iv.body.reminder.due, '2026-10-08');
    assert.equal(iv.body.peopleIds.length, 1);
    assert.equal((await s.notion.listOpen()).length, openBefore, 'no To Do row for the reminder');
    const job = (await s.call('/api/jobs')).body.tracker.find((j) => j.id === SAMPLE_JOB_IDS.contoso);
    assert.equal(job.round, 'Second round');
    assert.equal(job.interview, TODAY);
    const dr = await s.call('/api/thanks/drafts', { method: 'POST', body: { id: iv.body.reminder.id } });
    assert.equal(dr.body.drafts[0].recipient.email, 'pat@example.com');
    assert.equal(dr.body.drafts[0].versions.length, 3);
    assert.match(dr.body.drafts[0].versions.map((v) => v.body).join(' '), /second round/i);
    // Logging the same round again updates the reminder instead of adding another
    await s.call('/api/thanks/interview', { method: 'POST', body: { jobId: SAMPLE_JOB_IDS.contoso, round: 'Second round', date: TODAY, interviewers: [{ name: 'Pat Interviewer', email: 'pat@example.com' }], notes: 'More notes' } });
    assert.equal((await s.call('/api/thanks')).body.reminders.filter((r) => r.jobId === SAMPLE_JOB_IDS.contoso).length, 1);
    // A To Do on request; ticking it off in Notion closes the reminder in Dayline
    const todo = await s.call('/api/thanks/todo', { method: 'POST', body: { id: iv.body.reminder.id } });
    const task = (await s.notion.listOpen()).find((t) => t.id === todo.body.task.id);
    assert.match(task.name, /Pat Interviewer \(Contoso · Second round\)/);
    await s.notion.update(task.id, { status: 'Done' });
    await new Promise((r) => setTimeout(r, 5)); // let the app's task cache be bypassed by fresh=1
    assert.ok(!(await s.call('/api/thanks?fresh=1')).body.reminders.some((r) => r.id === iv.body.reminder.id));
    const bad = await s.call('/api/thanks/interview', { method: 'POST', body: { jobId: SAMPLE_JOB_IDS.contoso, round: 'Fifth round', date: TODAY } });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('without a Dayline store, thank-you writes are refused instead of falling back to To Do rows', async () => {
  const real = path.join(__dirname, '..', 'data', 'fixtures');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-nostore-'));
  const fx = createFixtureNotionFetch({ sources: [{ dataSourceId: TASK_DS, seedFile: path.join(real, 'notion-pages.json'), localFile: path.join(dir, 'tasks.local.json') }] });
  const notion = createNotionClient({ token: 'fixture', dataSourceId: TASK_DS, fetchImpl: fx });
  const app = createApp({ config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false }, notion, calendar: { getEvents: async () => [], status: () => [] }, now: () => new Date(`${TODAY}T12:00:00-05:00`) });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) })).headers.get('set-cookie').split(';')[0];
    const r = await fetch(base + '/api/thanks/resolve', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'x', action: 'skip' }) });
    assert.equal(r.status, 503);
    const g = await fetch(base + '/api/thanks', { headers: { cookie } });
    assert.equal(g.status, 200);
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
