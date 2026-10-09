'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freeGaps, pickSlot, mealPlanForDay, buildSocializing, LUNCH, DINNER, busyIntervalsForDay } = require('../lib/freebusy');
const { createApp } = require('../lib/app');

const TZ = 'America/Chicago';
const DAY = '2026-10-05';

test('freeGaps finds holes around busy blocks inside a window', () => {
  const gaps = freeGaps([{ startMin: 12 * 60, endMin: 13 * 60 }], LUNCH.startMin, LUNCH.endMin);
  assert.deepEqual(gaps, [{ startMin: 11 * 60 + 30, endMin: 12 * 60 }, { startMin: 13 * 60, endMin: 13 * 60 + 30 }]);
});

test('pickSlot shows the full continuous free window (not a forced 1h slice)', () => {
  const free = pickSlot([], DINNER);
  assert.equal(free.status, 'free');
  assert.equal(free.startMin, DINNER.startMin);
  assert.equal(free.endMin, DINNER.endMin); // whole 6–8pm window
  assert.equal(free.slotLabel, '6pm – 8pm');
  const partial = pickSlot([{ startMin: 11 * 60 + 30, endMin: 13 * 60 }], LUNCH);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.startMin, 13 * 60);
  assert.equal(partial.endMin, 13 * 60 + 30);
  assert.equal(partial.slotLabel, '1pm – 1:30pm');
  const busy = pickSlot([{ startMin: 18 * 60, endMin: 20 * 60, title: 'Seminar', feed: 'Outlook', blockers: [{ title: 'Seminar', feed: 'Outlook', startMin: 18 * 60, endMin: 20 * 60 }] }], DINNER);
  assert.equal(busy.status, 'busy');
});

test('all-day, deadlines and canceled events do not block meals', () => {
  const events = [
    { title: 'Birthday', allDay: true, birthday: true, start: DAY, end: '2026-10-06', startKey: DAY, endKey: DAY },
    { title: 'Assignment due', deadline: true, start: '2026-10-05T18:00:00.000Z', end: '2026-10-05T18:00:00.000Z', startKey: DAY, endKey: DAY },
    { title: 'Canceled lunch', canceled: true, start: '2026-10-05T16:30:00.000Z', end: '2026-10-05T17:30:00.000Z', startKey: DAY, endKey: DAY },
  ];
  assert.equal(busyIntervalsForDay(events, DAY, TZ).length, 0);
  assert.equal(mealPlanForDay(events, DAY, TZ).meals.every((m) => m.status === 'free'), true);
});

test('buildSocializing lists Partiful and plans lunch/dinner for each day', () => {
  const events = [
    { title: 'Mixer | Partiful', feed: 'Partiful', group: 'social', start: '2026-10-06T23:00:00.000Z', end: '2026-10-07T01:00:00.000Z', startKey: '2026-10-06', endKey: '2026-10-06', allDay: false },
    { title: 'Class', feed: 'Outlook', start: '2026-10-05T16:30:00.000Z', end: '2026-10-05T18:00:00.000Z', startKey: DAY, endKey: DAY, allDay: false },
  ];
  const body = buildSocializing({ events, today: DAY, days: 3, tz: TZ });
  assert.equal(body.partiful.length, 1);
  assert.equal(body.plan.length, 3);
  assert.equal(body.plan[0].meals.find((m) => m.id === 'lunch').status, 'partial');
  assert.equal(body.plan[0].meals.find((m) => m.id === 'dinner').status, 'free');
});

test('GET /api/socializing is behind the password and returns plan + partiful', async () => {
  const NOW = new Date('2026-10-05T10:56:00-05:00');
  const events = [
    { title: 'Oktoberfest | Partiful', feed: 'Partiful', group: 'social', start: '2026-10-10T18:00:00.000Z', end: '2026-10-10T20:00:00.000Z', startKey: '2026-10-10', endKey: '2026-10-10', allDay: false, location: 'Fulton Market' },
  ];
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: TZ, mode: 'fixture', production: false, geminiKey: '' },
    notion: { listOpen: async () => [], listDone: async () => [] },
    calendar: { getEvents: async () => events, status: () => [] },
    jobs: null,
    now: () => NOW,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/socializing')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const body = await (await fetch(base + '/api/socializing', { headers: { cookie } })).json();
    assert.equal(body.today, DAY);
    assert.equal(body.partiful.length, 1);
    assert.equal(body.plan.length, 8);
    assert.ok(body.plan[0].meals.some((m) => m.id === 'lunch' && m.slotLabel));
  } finally { await new Promise((r) => server.close(r)); }
});
