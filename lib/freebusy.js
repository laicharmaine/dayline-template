'use strict';
// Lunch / dinner free-busy against your calendars (APP_TIMEZONE).
// Pure helpers so Socializing can pick a contiguous free hour in each meal window.
const { zonedTime, zonedParts, addDays, dateKey } = require('./time');

const LUNCH = { id: 'lunch', label: 'Lunch', startMin: 11 * 60 + 30, endMin: 13 * 60 + 30, preferMin: 60 };
const DINNER = { id: 'dinner', label: 'Dinner', startMin: 18 * 60, endMin: 20 * 60, preferMin: 60 };
const MEALS = [LUNCH, DINNER];

function minutesOf(date, tz) {
  const p = zonedParts(date, tz);
  return p.hh * 60 + p.mm;
}

/** Timed, non-canceled, non-deadline events that occupy the day. All-day / birthdays ignored for meal slots. */
function blocksBusy(ev) {
  if (!ev || ev.canceled || ev.allDay || ev.deadline || ev.birthday) return false;
  if (!ev.start || !ev.end) return false;
  return true;
}

function busyIntervalsForDay(events, dayKey, tz) {
  const dayStart = zonedTime(dayKey, 0, 0, tz).getTime();
  const dayEnd = zonedTime(addDays(dayKey, 1), 0, 0, tz).getTime();
  const out = [];
  for (const ev of events) {
    if (!blocksBusy(ev)) continue;
    const s = Date.parse(ev.start);
    const e = Date.parse(ev.end);
    if (!(e > dayStart && s < dayEnd)) continue;
    const startMin = Math.max(0, Math.floor((Math.max(s, dayStart) - dayStart) / 60000));
    const endMin = Math.min(24 * 60, Math.ceil((Math.min(e, dayEnd) - dayStart) / 60000));
    if (endMin > startMin) out.push({ startMin, endMin, title: ev.title, feed: ev.feed });
  }
  out.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return mergeIntervals(out);
}

function mergeIntervals(list) {
  if (!list.length) return [];
  const out = [{ ...list[0], blockers: [list[0]] }];
  for (let i = 1; i < list.length; i++) {
    const cur = list[i];
    const last = out[out.length - 1];
    if (cur.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, cur.endMin);
      last.blockers.push(cur);
    } else out.push({ ...cur, blockers: [cur] });
  }
  return out;
}

function freeGaps(busy, windowStart, windowEnd) {
  const gaps = [];
  let cursor = windowStart;
  for (const b of busy) {
    if (b.endMin <= windowStart || b.startMin >= windowEnd) continue;
    const bs = Math.max(b.startMin, windowStart);
    const be = Math.min(b.endMin, windowEnd);
    if (bs > cursor) gaps.push({ startMin: cursor, endMin: bs });
    cursor = Math.max(cursor, be);
  }
  if (cursor < windowEnd) gaps.push({ startMin: cursor, endMin: windowEnd });
  return gaps;
}

function fmtClock(min) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const am = hh < 12;
  const h12 = hh % 12 || 12;
  return mm ? `${h12}:${String(mm).padStart(2, '0')}${am ? 'am' : 'pm'}` : `${h12}${am ? 'am' : 'pm'}`;
}

/**
 * Show the longest continuous free stretch inside the meal window (not truncated to 1h).
 * Status: free (>= preferMin), partial (>=30m), tight (<30m), or busy.
 */
function pickSlot(busy, meal) {
  const gaps = freeGaps(busy, meal.startMin, meal.endMin);
  if (gaps.length) {
    // Longest gap wins; ties prefer the earlier start (eat sooner).
    const best = [...gaps].sort((a, b) => (b.endMin - b.startMin) - (a.endMin - a.startMin) || a.startMin - b.startMin)[0];
    const mins = best.endMin - best.startMin;
    const status = mins >= meal.preferMin ? 'free' : mins >= 30 ? 'partial' : 'tight';
    return {
      status,
      startMin: best.startMin,
      endMin: best.endMin,
      minutes: mins,
      slotLabel: `${fmtClock(best.startMin)} – ${fmtClock(best.endMin)}`,
      windowLabel: `${fmtClock(meal.startMin)} – ${fmtClock(meal.endMin)}`,
      gaps,
    };
  }
  const blockers = busy.filter((b) => b.endMin > meal.startMin && b.startMin < meal.endMin)
    .flatMap((b) => b.blockers || [b]);
  return {
    status: 'busy',
    startMin: null,
    endMin: null,
    label: 'No free time',
    windowLabel: `${fmtClock(meal.startMin)} – ${fmtClock(meal.endMin)}`,
    gaps: [],
    blockers: blockers.map((b) => ({ title: b.title, feed: b.feed, when: `${fmtClock(b.startMin)} – ${fmtClock(b.endMin)}` })),
  };
}

function mealPlanForDay(events, dayKey, tz = 'America/Chicago') {
  const busy = busyIntervalsForDay(events, dayKey, tz);
  return {
    date: dayKey,
    meals: MEALS.map((meal) => ({ id: meal.id, label: meal.label, ...pickSlot(busy, meal) })),
  };
}

function buildSocializing({ events, today, days = 8, tz = 'America/Chicago', partifulDays = 45 }) {
  const endKey = addDays(today, days - 1);
  const partifulEnd = addDays(today, partifulDays);
  const partiful = events
    .filter((e) => !e.canceled && (e.feed === 'Partiful' || e.group === 'social'))
    .filter((e) => e.endKey >= today && e.startKey <= partifulEnd)
    .sort((a, b) => (a.start || a.startKey).localeCompare(b.start || b.startKey));
  const plan = [];
  for (let i = 0; i < days; i++) {
    const key = addDays(today, i);
    plan.push(mealPlanForDay(events, key, tz));
  }
  return { today, end: endKey, partiful, plan, meals: MEALS.map(({ id, label, startMin, endMin, preferMin }) => ({ id, label, startMin, endMin, preferMin })) };
}

module.exports = {
  LUNCH, DINNER, MEALS, blocksBusy, busyIntervalsForDay, freeGaps, pickSlot, mealPlanForDay, buildSocializing, fmtClock, minutesOf,
};
