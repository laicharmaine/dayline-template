'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseIcs, expandFeed, dedupeEvents, foldCanvasSessions, cleanTitle, normalizeTitle, sortEvents } = require('../lib/calendar');

const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n${body.trim().split('\n').map((l) => l.trim()).join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const personal = { label: 'Personal', group: 'personal', kind: 'calendar', rank: 1 };
const canvas = { label: 'Canvas', group: 'school', kind: 'canvas', rank: 4 };
const expand = (ics, feed = personal, from = '2026-10-01', to = '2026-11-30') => expandFeed(parseIcs(wrap(ics)), feed, from, to);

test('cleanTitle strips Canvas tags, registrar codes, Partiful suffix and Canceled prefix', () => {
  assert.deepEqual(cleanTitle('Assignment #3 [2026FA_ABC_101-0_SEC1]'), { title: 'Assignment #3', course: 'ABC 101', canceled: false });
  assert.deepEqual(cleanTitle('Session 5: Monday, October 5 (2026FA_MGMT_420-0_SEC36 Business Strategy) [2026FA_MGMT_420-0_SEC36]'), { title: 'Session 5', course: 'MGMT 420', canceled: false });
  assert.deepEqual(cleanTitle('MGMT-420-0 (36) Business Strategy'), { title: 'Business Strategy', course: 'MGMT 420', canceled: false });
  assert.equal(cleanTitle('Harvest Party | Partiful').title, 'Harvest Party');
  assert.deepEqual(cleanTitle('Canceled: Virtual Experiential Learning Information Session'), { title: 'Virtual Experiential Learning Information Session', course: null, canceled: true });
  assert.equal(normalizeTitle('Harvest Party 🍺 | Partiful'), normalizeTitle('harvest party'));
});

test('timed event in another zone (LA) lands on the right Chicago day and instant', () => {
  const [ev] = expand(`BEGIN:VEVENT
UID:ms-1
DTSTART;TZID=America/Los_Angeles:20261007T100000
DTEND;TZID=America/Los_Angeles:20261007T110000
SUMMARY:Phone interview
END:VEVENT`);
  assert.equal(ev.start, '2026-10-07T17:00:00.000Z'); // 10am PDT = noon Chicago
  assert.equal(ev.startKey, '2026-10-07');
  assert.equal(ev.allDay, false);
});

test('UTC event late in the evening belongs to the previous day in Chicago', () => {
  const [ev] = expand(`BEGIN:VEVENT
UID:utc-1
DTSTART:20261006T033000Z
DTEND:20261006T043000Z
SUMMARY:Late call
END:VEVENT`);
  assert.equal(ev.startKey, '2026-10-05');
});

test('all-day and multi-day events keep their calendar dates in every server timezone', () => {
  const script = `
    const { parseIcs, expandFeed } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'calendar.js'))});
    const ics = ${JSON.stringify(wrap(`BEGIN:VEVENT
UID:ad-1
DTSTART;VALUE=DATE:20261006
DTEND;VALUE=DATE:20261007
SUMMARY:QRS-303 Biovail case due
END:VEVENT
BEGIN:VEVENT
UID:ad-2
DTSTART;VALUE=DATE:20261010
DTEND;VALUE=DATE:20261013
SUMMARY:Trip
END:VEVENT`))};
    const out = expandFeed(parseIcs(ics), { label: 'P', group: 'personal', kind: 'calendar', rank: 1 }, '2026-10-01', '2026-10-31')
      .map((e) => [e.title, e.startKey, e.endKey, e.allDay, e.deadline]).sort();
    console.log(JSON.stringify(out));`;
  const results = ['UTC', 'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland'].map((TZ) =>
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ } }).toString().trim());
  for (const r of results) assert.equal(r, results[0]);
  assert.deepEqual(JSON.parse(results[0]), [['QRS-303 Biovail case', '2026-10-06', '2026-10-06', true, true], ['Trip', '2026-10-10', '2026-10-12', true, false]]);
});

test('weekly recurrence keeps 10:30am wall time across the Nov 1 DST change', () => {
  const evs = expand(`BEGIN:VEVENT
UID:sample1
DTSTART;TZID=America/Chicago:20261026T103000
DTEND;TZID=America/Chicago:20261026T120000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:MGMT-420-0 (36) Business Strategy
END:VEVENT`);
  assert.deepEqual(evs.map((e) => e.start), ['2026-10-26T15:30:00.000Z', '2026-11-02T16:30:00.000Z', '2026-11-09T16:30:00.000Z']);
  assert.ok(evs.every((e) => e.title === 'Business Strategy' && e.course === 'MGMT 420' && e.recurring));
});

test('EXDATE removes an instance and RECURRENCE-ID moves one', () => {
  const evs = expand(`BEGIN:VEVENT
UID:ipg
DTSTART;TZID=America/Chicago:20261007T110000
DTEND;TZID=America/Chicago:20261007T120000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=America/Chicago:20261014T110000
SUMMARY:PMM IPG Group
END:VEVENT
BEGIN:VEVENT
UID:ipg
RECURRENCE-ID;TZID=America/Chicago:20261021T110000
DTSTART;TZID=America/Chicago:20261022T140000
DTEND;TZID=America/Chicago:20261022T150000
SUMMARY:PMM IPG Group (moved)
END:VEVENT`).sort((a, b) => a.start.localeCompare(b.start));
  assert.deepEqual(evs.map((e) => [e.startKey, e.title]), [['2026-10-07', 'PMM IPG Group'], ['2026-10-22', 'PMM IPG Group (moved)'], ['2026-10-28', 'PMM IPG Group']]);
  assert.equal(evs[1].start, '2026-10-22T19:00:00.000Z');
});

test('monthly recurrence and cancelled events', () => {
  const evs = expand(`BEGIN:VEVENT
UID:rent
DTSTART;VALUE=DATE:20260915
DTEND;VALUE=DATE:20260916
RRULE:FREQ=MONTHLY;BYMONTHDAY=15
SUMMARY:Rent
END:VEVENT
BEGIN:VEVENT
UID:gone
STATUS:CANCELLED
DTSTART:20261008T150000Z
DTEND:20261008T160000Z
SUMMARY:Cancelled thing
END:VEVENT`);
  assert.deepEqual(evs.map((e) => e.startKey), ['2026-10-15', '2026-11-15']);
});

test('Canvas: assignments and zero-length items are deadlines; "Deadline:" all-day titles are cleaned', () => {
  const c = expand(`BEGIN:VEVENT
UID:event-assignment-123
DTSTART:20261009T170000Z
DTEND:20261009T170000Z
SUMMARY:Assignment #3 [2026FA_ABC_101-0_SEC1]
END:VEVENT`, canvas);
  assert.equal(c[0].deadline, true);
  assert.equal(c[0].course, 'ABC 101');
  const p = expand(`BEGIN:VEVENT
UID:dl
DTSTART;VALUE=DATE:20261002
DTEND;VALUE=DATE:20261003
SUMMARY:Deadline: Club B app
END:VEVENT`);
  assert.equal(p[0].deadline, true);
  assert.equal(p[0].title, 'Club B app');
});

// ---------- dedupe ----------
let n = 0;
function mk(o) {
  const start = o.start || '2026-10-10T01:00:00.000Z';
  return { uid: o.uid ?? `u${n++}`, rawTitle: o.title, title: cleanTitle(o.title).title, course: cleanTitle(o.title).course, allDay: false, start, end: o.end || '2026-10-10T04:00:00.000Z', startKey: '2026-10-09', endKey: '2026-10-09', location: o.location || '', description: o.description || '', feed: o.feed, group: o.group || 'personal', rank: o.rank, deadline: !!o.deadline, alsoOn: [], url: null };
}

test('dedupe rule 1: same UID + start on two calendars keeps the more specific calendar', () => {
  const out = dedupeEvents([mk({ uid: 'X1', title: 'Open Mic', feed: 'Personal', rank: 1 }), mk({ uid: 'X1', title: 'Open Mic | Wellness Week', feed: 'Classes & events', rank: 2 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].feed, 'Classes & events');
  assert.deepEqual(out[0].alsoOn, ['Personal']);
});

test('dedupe rule 2: same normalized title + start (Partiful copy wins over Gmail copy)', () => {
  const out = dedupeEvents([mk({ title: 'Harvest Party', feed: 'Personal', rank: 1 }), mk({ title: 'Harvest Party | Partiful', feed: 'Partiful', rank: 4, description: 'RSVP link' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].feed, 'Partiful');
  assert.deepEqual(out[0].alsoOn, ['Personal']);
});

test('dedupe rule 3: "Concert Night" + "Concert Night - The World Tour" at the same time and place merge', () => {
  const out = dedupeEvents([
    mk({ title: 'Concert Night', feed: 'Personal', rank: 1, location: 'United Center' }),
    mk({ title: 'Concert Night - The World Tour', feed: 'Personal', rank: 1, location: 'United Center' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Concert Night - The World Tour');
});

test('dedupe leaves different times, places and short prefixes alone', () => {
  assert.equal(dedupeEvents([mk({ title: 'Concert Night', feed: 'P', rank: 1, location: 'United Center' }), mk({ title: 'Concert Night', feed: 'P', rank: 1, location: 'United Center', start: '2026-10-11T01:00:00.000Z', end: '2026-10-11T04:00:00.000Z' })]).length, 2);
  assert.equal(dedupeEvents([mk({ title: 'Concert Night', feed: 'P', rank: 1, location: 'United Center' }), mk({ title: 'Concert Night tribute', feed: 'P', rank: 1, location: 'Metro' })]).length, 2);
  assert.equal(dedupeEvents([mk({ title: 'AMA', feed: 'P', rank: 1, location: 'Hub' }), mk({ title: 'AMA Presents', feed: 'P', rank: 1, location: 'Hub' })]).length, 2);
});

test('Canvas "Session N" items fold into the matching class meeting', () => {
  const meeting = mk({ title: 'MGMT-420-0 (36) Business Strategy', feed: 'Classes & events', rank: 2, start: '2026-10-05T15:30:00.000Z', end: '2026-10-05T17:00:00.000Z' });
  const note = { ...mk({ title: 'Session 5: Monday, October 5 [2026FA_MGMT_420-0_SEC36]', feed: 'Canvas', rank: 4, start: '2026-10-05T15:30:00.000Z', end: '2026-10-05T15:30:00.000Z' }), deadline: true };
  const out = foldCanvasSessions([meeting, note]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].prep, { title: 'Session 5', description: '', feed: 'Canvas' });
});

test('sortEvents: all-day first, then by time, deadlines before meetings at the same minute', () => {
  const a = { ...mk({ title: 'Class', feed: 'P', rank: 1, start: '2026-10-09T15:30:00.000Z' }), startKey: '2026-10-09' };
  const b = { ...mk({ title: 'Quiz', feed: 'P', rank: 1, start: '2026-10-09T15:30:00.000Z' }), startKey: '2026-10-09', deadline: true };
  const c = { ...mk({ title: 'Trip', feed: 'P', rank: 1 }), allDay: true, startKey: '2026-10-09', start: '2026-10-09' };
  assert.deepEqual(sortEvents([a, b, c]).map((e) => e.title), ['Trip', 'Quiz', 'Class']);
});
