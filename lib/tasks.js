'use strict';
// Pure task logic: what is overdue, what is due today, and how lists are sorted.
// "Today" is always the calendar day in America/Chicago (APP_TIMEZONE), not the server's zone.

const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const prank = (t) => (t.priority in PRIORITY_RANK ? PRIORITY_RANK[t.priority] : 3);
const dkey = (t) => t.due?.key || null;

/** 'done' | 'overdue' | 'today' | 'upcoming' | 'nodate' */
function bucketOf(task, todayKey) {
  if (task.done) return 'done';
  const k = dkey(task);
  if (!k) return 'nodate';
  if (k < todayKey) return 'overdue';
  if (k === todayKey) return 'today';
  return 'upcoming';
}

function byDue(a, b) {
  const ka = dkey(a), kb = dkey(b);
  if (ka !== kb) { if (!ka) return 1; if (!kb) return -1; return ka < kb ? -1 : 1; }
  const ta = a.due?.time || '', tb = b.due?.time || '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return prank(a) - prank(b) || a.name.localeCompare(b.name);
}
function byPriority(a, b) { return prank(a) - prank(b) || byDue(a, b); }

function sortTasks(tasks, by = 'due') { return [...tasks].sort(by === 'priority' ? byPriority : byDue); }

function todayTasks(tasks, todayKey) {
  const open = tasks.filter((t) => !t.done);
  return {
    overdue: open.filter((t) => bucketOf(t, todayKey) === 'overdue').sort(byDue),
    dueToday: open.filter((t) => bucketOf(t, todayKey) === 'today').sort(byPriority),
    noDateCount: open.filter((t) => !dkey(t)).length,
  };
}

function tasksByDay(tasks, fromKey, toKey) {
  const map = {};
  for (const t of tasks) {
    const k = dkey(t);
    if (!t.done && k && k >= fromKey && k <= toKey) (map[k] = map[k] || []).push(t);
  }
  for (const k of Object.keys(map)) map[k].sort(byPriority);
  return map;
}

/**
 * The "Next up" card: the event happening now or next today; otherwise the next timed deadline today;
 * otherwise the most important overdue/due-today task.
 */
function nextUp({ events, overdue, dueToday, now, todayKey }) {
  const t = now.getTime();
  const timed = events.filter((e) => !e.allDay && !e.canceled && e.startKey === todayKey);
  const meeting = timed.filter((e) => !e.deadline && Date.parse(e.end) > t).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (meeting) return { kind: 'event', state: Date.parse(meeting.start) <= t ? 'now' : 'next', minutes: Math.round((Date.parse(meeting.start) - t) / 60000), event: meeting };
  const deadline = timed.filter((e) => e.deadline && Date.parse(e.start) > t).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (deadline) return { kind: 'deadline', state: 'next', minutes: Math.round((Date.parse(deadline.start) - t) / 60000), event: deadline };
  const task = [...dueToday, ...overdue].sort(byPriority)[0];
  if (task) return { kind: 'task', state: dkey(task) < todayKey ? 'overdue' : 'today', task };
  return null;
}

module.exports = { bucketOf, sortTasks, todayTasks, tasksByDay, nextUp, PRIORITY_RANK };
