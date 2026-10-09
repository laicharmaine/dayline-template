'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { feedsFromEnv, resolveFeeds, loadConfig } = require('../lib/config');
const { readOnlyFetch, ReadOnlyError } = require('../lib/readonly');
const { parseIcs, expandFeed, dedupeEvents, foldCanvasSessions } = require('../lib/calendar');

const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n${body.trim().split('\n').map((l) => l.trim()).join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const expand = (ics, feed, from = '2026-10-01', to = '2026-11-30') => expandFeed(parseIcs(wrap(ics)), feed, from, to);
const personal = { label: 'Personal', group: 'personal', kind: 'calendar', rank: 1 };
const birthdays = { label: 'Birthdays', group: 'personal', kind: 'birthdays', rank: 1 };
const outlook = { label: 'Outlook', group: 'school', kind: 'calendar', rank: 2 };
const canvas = { label: 'Canvas', group: 'school', kind: 'canvas', rank: 4 };

test('DAYLINE_CAL_* vars become feeds with fixed groups; webcal:// becomes https://', () => {
  const feeds = resolveFeeds({ DAYLINE_CAL_PERSONAL: 'https://g.example/p.ics', DAYLINE_CAL_PARTIFUL: 'webcal://partiful.example/x.ics', DAYLINE_CAL_BIRTHDAYS: 'https://g.example/b.ics', DAYLINE_CAL_OUTLOOK: 'https://outlook.example/o.ics' });
  const by = Object.fromEntries(feeds.map((f) => [f.label, f]));
  assert.deepEqual(Object.keys(by).sort(), ['Birthdays', 'Outlook', 'Partiful', 'Personal']);
  assert.equal(resolveFeeds({ DAYLINE_CAL_CANVAS: 'https://c.example/c.ics' })[0].kind, 'canvas');
  assert.equal(by.Partiful.url, 'https://partiful.example/x.ics');
  assert.equal(by.Partiful.group, 'social');
  assert.equal(by.Birthdays.kind, 'birthdays');
  assert.equal(by.Outlook.group, 'school');
});

test('numbered CAL_n_URL / CAL_n_LABEL / CAL_n_GROUP calendars: any number, friendly labels, in order', () => {
  const feeds = resolveFeeds({
    CAL_2_URL: 'webcal://school.example/s.ics', CAL_2_LABEL: 'My classes', CAL_2_GROUP: 'school',
    CAL_1_URL: 'https://g.example/p.ics', CAL_1_LABEL: 'Personal',
    CAL_3_URL: 'https://canvas.example/feed.ics', CAL_3_LABEL: 'Canvas',
    CAL_10_URL: 'https://p.example/x.ics', CAL_10_LABEL: 'Partiful',
    CAL_4_URL: '  ', CAL_4_LABEL: 'Empty is skipped',
  });
  assert.deepEqual(feeds.map((f) => f.label), ['Personal', 'My classes', 'Canvas', 'Partiful']);
  assert.equal(feeds[0].group, 'personal');
  assert.equal(feeds[1].group, 'school');
  assert.equal(feeds[1].url, 'https://school.example/s.ics');
  assert.equal(feeds[2].kind, 'canvas');
  assert.equal(feeds[3].group, 'social');
  assert.ok(feeds[2].rank > feeds[1].rank && feeds[1].rank > feeds[0].rank);
  assert.deepEqual(resolveFeeds({}), []);
});

test('CAL_FEEDS JSON wins over DAYLINE_CAL_*; DAYLINE_NOTION_TOKEN is a fallback for NOTION_TOKEN', () => {
  const feeds = resolveFeeds({ CAL_FEEDS: '[{"label":"Only","group":"school","url":"https://x.example/a.ics"}]', DAYLINE_CAL_PERSONAL: 'https://g.example/p.ics' });
  assert.deepEqual(feeds.map((f) => f.label), ['Only']);
  assert.equal(loadConfig({ DAYLINE_NOTION_TOKEN: 'ntn_test' }).notionToken, 'ntn_test');
  assert.equal(loadConfig({ NOTION_TOKEN: 'ntn_a', DAYLINE_NOTION_TOKEN: 'ntn_b' }).notionToken, 'ntn_a');
  assert.equal(loadConfig({ NOTION_READ_ONLY: 'true' }).notionReadOnly, true);
});

test('read-only guard lets reads and queries through and refuses writes', async () => {
  const calls = [];
  const f = readOnlyFetch(async (url, opts) => { calls.push(opts.method || 'GET'); return { ok: true }; });
  await f('https://api.notion.com/v1/data_sources/abc/query', { method: 'POST' });
  await f('https://api.notion.com/v1/data_sources/abc');
  await f('https://api.notion.com/v1/search', { method: 'POST' });
  await assert.rejects(f('https://api.notion.com/v1/pages', { method: 'POST' }), (e) => e instanceof ReadOnlyError && e.status === 409);
  await assert.rejects(f('https://api.notion.com/v1/pages/abc', { method: 'PATCH' }), ReadOnlyError);
  assert.deepEqual(calls, ['POST', 'GET', 'POST']);
});

test('Outlook Windows timezone names ("Central Standard Time") are understood', () => {
  const [ev] = expand(`BEGIN:VTIMEZONE
TZID:Central Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:o-1
DTSTART;TZID=Central Standard Time:20261006T151500
DTEND;TZID=Central Standard Time:20261006T164500
SUMMARY:MGMT-420-0 (36) Business Strategy
END:VEVENT`, outlook);
  assert.equal(ev.start, '2026-10-06T20:15:00.000Z'); // 3:15pm CDT
  assert.equal(ev.course, 'MGMT 420');
});

test('Birthdays feed is always all-day, even a timed entry, on its Chicago date', () => {
  const evs = expand(`BEGIN:VEVENT
UID:b-1
DTSTART;VALUE=DATE:20261008
DTEND;VALUE=DATE:20261009
SUMMARY:Sam's bday
END:VEVENT
BEGIN:VEVENT
UID:b-2
DTSTART:20261010T020000Z
DTEND:20261010T040000Z
SUMMARY:Ana's birthday party
END:VEVENT`, birthdays);
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.allDay && e.birthday));
  assert.equal(evs.find((e) => e.uid === 'b-2').startKey, '2026-10-09'); // 9pm CDT Oct 9
});

test('dedupe: same event, location written with and without state, is shown once', () => {
  const evs = [
    ...expand(`BEGIN:VEVENT
UID:g-1
DTSTART:20261004T020000Z
DTEND:20261004T050000Z
SUMMARY:Concert Night
LOCATION:Soldier Field, Chicago
END:VEVENT
BEGIN:VEVENT
UID:g-2
DTSTART:20261004T020000Z
DTEND:20261004T050000Z
SUMMARY:Concert Night - The World Tour
LOCATION:Soldier Field, Chicago, IL
END:VEVENT`, personal),
  ];
  assert.equal(dedupeEvents(evs).length, 1);
});

test('dedupe: all-day personal "Deadline: ABC-101 Assignment 3" folds into the timed Canvas due item', () => {
  const evs = [
    ...expand(`BEGIN:VEVENT
UID:p-dl
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
SUMMARY:Deadline: ABC-101 Assignment 3
END:VEVENT`, personal),
    ...expand(`BEGIN:VEVENT
UID:event-assignment-1
DTSTART:20261010T045900Z
DTEND:20261010T045900Z
SUMMARY:Assignment #3 [2026FA_ABC_101-0_SEC1]
END:VEVENT`, canvas),
  ];
  const out = dedupeEvents(evs);
  assert.equal(out.length, 1);
  assert.equal(out[0].feed, 'Canvas');
  assert.equal(out[0].allDay, false);
});

test('Canvas session note folds into a school meeting with no course code at the same time', () => {
  const evs = [
    ...expand(`BEGIN:VEVENT
UID:o-2
DTSTART:20261007T140000Z
DTEND:20261007T153000Z
SUMMARY:Leadership in Organizations
END:VEVENT`, outlook),
    ...expand(`BEGIN:VEVENT
UID:c-2
DTSTART:20261007T140000Z
DTEND:20261007T140000Z
SUMMARY:Class 4: Teams [2026FA_LDRS_430-0_SEC1]
END:VEVENT`, canvas),
  ];
  const out = foldCanvasSessions(dedupeEvents(evs));
  assert.equal(out.length, 1);
  assert.equal(out[0].prep.title, 'Class 4: Teams');
  assert.equal(out[0].feed, 'Outlook');
});

test('production password floor: 10 characters, or 6 with ALLOW_SHORT_PASSWORD=true', () => {
  const { validateConfig } = require('../lib/config');
  const base = { NODE_ENV: 'production', NOTION_TOKEN: 'ntn_x', DAYLINE_CAL_PERSONAL: 'https://g.example/p.ics' };
  const pw = (p) => validateConfig(loadConfig(p)).filter((m) => /APP_PASSWORD/.test(m));
  assert.equal(pw({ ...base, APP_PASSWORD: 'abcdef' }).length, 1);
  assert.equal(pw({ ...base, APP_PASSWORD: 'abcdef', ALLOW_SHORT_PASSWORD: 'true' }).length, 0);
  assert.equal(pw({ ...base, APP_PASSWORD: 'abcde', ALLOW_SHORT_PASSWORD: 'true' }).length, 1);
  assert.equal(pw({ ...base, APP_PASSWORD: 'abcdefghij' }).length, 0);
});
