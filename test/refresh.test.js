'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../lib/app');

test('?fresh=1 busts server caches once per refresh burst and re-pulls the calendar feeds', async () => {
  let refreshes = 0, listOpen = 0;
  const app = createApp({
    config: { appPassword: 'correct horse battery', sessionSecret: 's'.repeat(64), tz: 'America/Chicago', mode: 'fixture', production: false, geminiKey: '' },
    notion: { listOpen: async () => { listOpen += 1; return []; }, listDone: async () => [] },
    calendar: { getEvents: async () => [], status: () => [], refreshAll: async () => { refreshes += 1; } },
    now: () => new Date('2026-10-07T12:00:00-05:00'),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/tasks?fresh=1')).status, 401);
    assert.equal(refreshes, 0, 'signed-out requests cannot trigger feed fetches');
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = (p) => fetch(base + p, { headers: { cookie } });
    await get('/api/tasks');
    await get('/api/tasks');
    assert.equal(listOpen, 1, 'second call is served from the cache');
    assert.equal(refreshes, 0);
    const res = await Promise.all([get('/api/tasks?fresh=1'), get('/api/today?fresh=1'), get('/api/me?fresh=1')]);
    assert.ok(res.every((r) => r.status === 200));
    assert.ok(res[2].headers.get('x-dayline-asset'), 'asset version header for the client reload check');
    assert.equal(refreshes, 1, 'one feed refresh shared by the burst');
    assert.equal(listOpen, 2, 'task cache was dropped');
  } finally { await new Promise((r) => server.close(r)); }
});
