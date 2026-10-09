'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createFileMealPlans, validatePlan, notesFor, parseNotes, PLAN_STATUSES, DEFAULT_PLAN_STATUS,
} = require('../lib/mealplans');
const { classifyExamTitle, examsForClass, countdownLabel } = require('../lib/exams');
const { createClassMatcher } = require('../lib/classes');
const { createApp } = require('../lib/app');

test('PLAN_STATUSES includes Reached out and Confirmed', () => {
  assert.deepEqual(PLAN_STATUSES, ['Planned', 'Reached out', 'Confirmed', 'Declined', 'Cancelled']);
  assert.equal(DEFAULT_PLAN_STATUS, 'Planned');
});

test('validatePlan accepts planStatus and rejects unknown', () => {
  const ok = validatePlan({ date: '2026-10-06', meal: 'lunch', with: 'Sam', planStatus: 'Reached out' });
  assert.equal(ok.value.planStatus, 'Reached out');
  assert.ok(validatePlan({ date: '2026-10-06', meal: 'lunch', with: 'Sam', planStatus: 'Nope' }).error);
  assert.equal(validatePlan({ date: '2026-10-06', meal: 'dinner', with: 'Sam' }).value.planStatus, 'Planned');
});

test('notes encode and parse status', () => {
  const n = notesFor({ meal: 'lunch', date: '2026-10-06', with: 'Sam Sample', planStatus: 'Confirmed' });
  assert.match(n, /status:Confirmed/);
  assert.equal(parseNotes(n).planStatus, 'Confirmed');
  assert.equal(parseNotes(n).with, 'Sam Sample');
});

test('file meal plans persist planStatus and keep it on name-only update', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-st-')), 'm.json');
  const mp = createFileMealPlans({ file });
  const a = await mp.upsert({ date: '2026-10-06', meal: 'lunch', with: 'Alex', planStatus: 'Reached out' });
  assert.equal(a.planStatus, 'Reached out');
  const b = await mp.upsert({ date: '2026-10-06', meal: 'lunch', with: 'Alexandra' });
  assert.equal(b.with, 'Alexandra');
  assert.equal(b.planStatus, 'Reached out');
  const c = await mp.upsert({ date: '2026-10-06', meal: 'lunch', with: 'Alexandra', planStatus: 'Confirmed' });
  assert.equal(c.planStatus, 'Confirmed');
  assert.equal((await mp.list())[0].planStatus, 'Confirmed');
});

test('/api/socializing returns planStatus; PUT updates it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-api-st-')), 'm.json');
  const mealplans = createFileMealPlans({ file });
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' },
    notion: { listOpen: async () => [], listDone: async () => [] },
    calendar: { getEvents: async () => [], status: () => [] },
    mealplans,
    now: () => new Date('2026-10-06T12:00:00-05:00'),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await fetch(base + '/api/socializing/plans', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-10-06', meal: 'dinner', with: 'Jordan', planStatus: 'Reached out' }) });
    const body = await (await fetch(base + '/api/socializing', { headers: { cookie } })).json();
    assert.ok(body.planStatuses.includes('Confirmed'));
    const dinner = body.plan[0].meals.find((m) => m.id === 'dinner');
    assert.equal(dinner.plan.with, 'Jordan');
    assert.equal(dinner.plan.planStatus, 'Reached out');
  } finally { await new Promise((r) => server.close(r)); }
});

test('classifyExamTitle distinguishes midterm/final from final project', () => {
  assert.equal(classifyExamTitle('XYZ-202 Midterm exam'), 'midterm');
  assert.equal(classifyExamTitle('Mid-term Exam'), 'midterm');
  assert.equal(classifyExamTitle('ABC-101 Final exam'), 'final');
  assert.equal(classifyExamTitle('QRS-303 final exam (tentative)'), 'final');
  assert.equal(classifyExamTitle('SECA final project'), null);
});

test('examsForClass merges config, tasks, and calendar; prefers upcoming', () => {
  const item = { option: 'XYZ-202', midterm: '2026-10-27', final: '2026-12-04' };
  const exams = examsForClass(item, {
    today: '2026-10-06',
    tasks: [{ name: 'XYZ-202 Midterm exam', due: { key: '2026-10-27' }, classes: ['XYZ-202'] }],
    events: [{ title: 'Mid-term Exam', startKey: '2026-10-27', cls: 'XYZ-202', deadline: true }],
  });
  assert.equal(exams.midterm.key, '2026-10-27');
  assert.equal(exams.final.key, '2026-12-04');
  assert.equal(countdownLabel('2026-10-27', '2026-10-06').days, 21);
});

