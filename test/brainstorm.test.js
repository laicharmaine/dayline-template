'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileBrainstorm, validateNoteInput, GROUPS } = require('../lib/brainstorm');
const { createFileMealPlans, validatePlan, parseTitle, titleFor } = require('../lib/mealplans');
const { createApp } = require('../lib/app');
const { pickSlot, LUNCH, DINNER } = require('../lib/freebusy');

test('validateNoteInput requires text and known group/color', () => {
  assert.ok(validateNoteInput({}).error);
  assert.equal(validateNoteInput({ text: 'Hello', group: 'Club B', color: 'pink' }).value.group, 'Club B');
  assert.ok(validateNoteInput({ text: 'x', group: 'Nope' }).error);
});

test('file brainstorm create/update/remove round-trip', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bn-')), 'b.json');
  const bn = createFileBrainstorm({ file });
  const n = await bn.create({ text: 'Party playlist', group: 'Club B', color: 'pink', pinned: true });
  assert.equal((await bn.list())[0].pinned, true);
  await bn.update(n.id, { text: 'Party playlist v2', pinned: false });
  assert.equal((await bn.list())[0].text, 'Party playlist v2');
  await bn.remove(n.id);
  assert.equal((await bn.list()).length, 0);
});

test('/api/brainstorm CRUD behind password', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bn-api-')), 'b.json');
  const brainstorm = createFileBrainstorm({ file });
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' },
    notion: { listOpen: async () => [], listDone: async () => [] },
    calendar: { getEvents: async () => [], status: () => [] },
    brainstorm,
    now: () => new Date('2026-10-05T10:56:00-05:00'),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/brainstorm')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const created = await (await fetch(base + '/api/brainstorm', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Club B flyer', group: 'Club B', color: 'yellow' }) })).json();
    assert.equal(created.group, 'Club B');
    assert.equal((await (await fetch(base + '/api/brainstorm', { headers: { cookie } })).json()).notes.length, 1);
    assert.equal((await fetch(base + `/api/brainstorm/${created.id}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});

test('meal plan upsert/clear and title parsing', async () => {
  assert.deepEqual(parseTitle(titleFor({ date: '2026-10-06', meal: 'lunch', with: 'Sam' })), { meal: 'lunch', date: '2026-10-06', with: 'Sam' });
  assert.ok(validatePlan({ date: '2026-10-06', meal: 'lunch' }).error);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-')), 'm.json');
  const mp = createFileMealPlans({ file });
  const p = await mp.upsert({ date: '2026-10-06', meal: 'lunch', with: 'Sam Sample' });
  assert.equal(p.with, 'Sam Sample');
  assert.equal((await mp.list({ from: '2026-10-06', to: '2026-10-06' })).length, 1);
  await mp.clear({ date: '2026-10-06', meal: 'lunch' });
  assert.equal((await mp.list()).length, 0);
});

test('pickSlot exposes the full continuous free stretch', () => {
  const free = pickSlot([], DINNER);
  assert.equal(free.endMin - free.startMin, 120);
  assert.equal(free.slotLabel, '6pm – 8pm');
  const gap = pickSlot([{ startMin: 11 * 60 + 30, endMin: 11 * 60 + 45 }], LUNCH);
  assert.equal(gap.slotLabel, '11:45am – 1:30pm');
  assert.equal(gap.status, 'free');
});

test('/api/socializing includes plans; PUT/DELETE meal plans', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-api-')), 'm.json');
  const mealplans = createFileMealPlans({ file });
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' },
    notion: { listOpen: async () => [], listDone: async () => [] },
    calendar: { getEvents: async () => [], status: () => [] },
    mealplans,
    now: () => new Date('2026-10-05T10:56:00-05:00'),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await fetch(base + '/api/socializing/plans', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-10-05', meal: 'lunch', with: 'Alex' }) });
    const body = await (await fetch(base + '/api/socializing', { headers: { cookie } })).json();
    const lunch = body.plan[0].meals.find((m) => m.id === 'lunch');
    assert.equal(lunch.plan.with, 'Alex');
    assert.equal(lunch.slotLabel.includes('–') || lunch.slotLabel.includes('-'), true);
    await fetch(base + '/api/socializing/plans', { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-10-05', meal: 'lunch' }) });
  } finally { await new Promise((r) => server.close(r)); }
});
