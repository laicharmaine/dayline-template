'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKey, zonedTime, weekStart, addDays, diffDays, isDateKey } = require('../lib/time');
const { bucketOf, todayTasks, sortTasks, tasksByDay, nextUp } = require('../lib/tasks');
const { parsePage } = require('../lib/notion');

const task = (name, due, extra = {}) => ({ id: name, name, done: false, priority: 'Medium', due: due ? { key: due, time: null } : null, ...extra });

test('"today" is the Chicago day, even when UTC has already rolled over', () => {
  assert.equal(dateKey(new Date('2026-10-05T23:59:00-05:00')), '2026-10-05'); // 04:59Z on Oct 6
  assert.equal(dateKey(new Date('2026-10-06T00:01:00-05:00')), '2026-10-06');
  assert.equal(dateKey(new Date('2026-10-06T04:30:00Z'), 'America/Los_Angeles'), '2026-10-05');
});

test('a task due Oct 5 is "today" at 11:59pm and "overdue" one minute after midnight', () => {
  const t = task('Club B app', '2026-10-05');
  assert.equal(bucketOf(t, dateKey(new Date('2026-10-05T23:59:00-05:00'))), 'today');
  assert.equal(bucketOf(t, dateKey(new Date('2026-10-06T00:01:00-05:00'))), 'overdue');
  assert.equal(bucketOf({ ...t, done: true }, '2026-10-06'), 'done');
  assert.equal(bucketOf(task('x', null), '2026-10-06'), 'nodate');
});

test('Notion due dates with a time are bucketed by their Chicago day', () => {
  const page = { id: 'p', url: 'u', properties: { 'Task name': { title: [{ plain_text: 'Late' }] }, Status: { status: { name: 'Not started' } }, 'Due date': { date: { start: '2026-10-06T03:00:00.000+00:00' } } } };
  assert.deepEqual(parsePage(page).due, { key: '2026-10-05', time: '2026-10-06T03:00:00.000Z', range: false });
  const range = { ...page, properties: { ...page.properties, 'Due date': { date: { start: '2026-10-05', end: '2026-10-08' } } } };
  assert.equal(parsePage(range).due.key, '2026-10-08');
});

test('zonedTime handles both DST transitions', () => {
  assert.equal(zonedTime('2026-11-01', 0, 0).toISOString(), '2026-11-01T05:00:00.000Z'); // still CDT at midnight
  assert.equal(zonedTime('2026-11-02', 0, 0).toISOString(), '2026-11-02T06:00:00.000Z');
  assert.equal(zonedTime('2027-03-14', 12, 0).toISOString(), '2027-03-14T17:00:00.000Z');
  assert.equal(weekStart('2026-10-11'), '2026-10-05'); // Sunday belongs to the week starting Monday
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(diffDays('2026-10-05', '2026-10-12'), 7);
  assert.ok(isDateKey('2026-10-05') && !isDateKey('2026-13-40') && !isDateKey('Oct 5'));
});

test('due-date sort: overdue, then soonest, then no date; ties by priority', () => {
  const list = [task('nodate', null), task('later', '2026-10-09'), task('high today', '2026-10-05', { priority: 'High' }), task('low today', '2026-10-05', { priority: 'Low' }), task('old', '2026-09-09')];
  assert.deepEqual(sortTasks(list).map((t) => t.name), ['old', 'high today', 'low today', 'later', 'nodate']);
  assert.deepEqual(sortTasks(list, 'priority').map((t) => t.name), ['high today', 'old', 'later', 'nodate', 'low today']);
  const t = todayTasks(list, '2026-10-05');
  assert.deepEqual(t.overdue.map((x) => x.name), ['old']);
  assert.deepEqual(t.dueToday.map((x) => x.name), ['high today', 'low today']);
  assert.equal(t.noDateCount, 1);
  assert.deepEqual(Object.keys(tasksByDay(list, '2026-10-05', '2026-10-11')).sort(), ['2026-10-05', '2026-10-09']);
});

test('nextUp prefers the meeting happening now, then the next one, then tasks', () => {
  const now = new Date('2026-10-05T10:56:00-05:00');
  const ev = (title, s, e, extra = {}) => ({ title, start: new Date(s).toISOString(), end: new Date(e).toISOString(), startKey: '2026-10-05', allDay: false, deadline: false, canceled: false, ...extra });
  const events = [ev('Business Strategy', '2026-10-05T10:30:00-05:00', '2026-10-05T12:00:00-05:00'), ev('Data Analytics', '2026-10-05T18:30:00-05:00', '2026-10-05T21:30:00-05:00')];
  assert.equal(nextUp({ events, overdue: [], dueToday: [], now, todayKey: '2026-10-05' }).state, 'now');
  const later = nextUp({ events: events.slice(1), overdue: [], dueToday: [], now, todayKey: '2026-10-05' });
  assert.equal(later.state, 'next');
  assert.equal(later.minutes, 454);
  assert.equal(nextUp({ events: [], overdue: [task('IBM', '2026-09-27', { priority: 'High' })], dueToday: [], now, todayKey: '2026-10-05' }).state, 'overdue');
});
