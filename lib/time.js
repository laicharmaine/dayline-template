'use strict';
// Date helpers that work in a named IANA zone (default America/Chicago) no matter
// what timezone the server runs in (Render/Vercel run in UTC; the box runs in Chicago).
// "Date keys" are plain 'YYYY-MM-DD' strings for a calendar day in that zone.

const DEFAULT_TZ = 'America/Chicago';
const fmtCache = new Map();

function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of an instant in a zone. */
function zonedParts(date, tz = DEFAULT_TZ) {
  const o = {};
  for (const p of fmt(tz).formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second, weekday: o.weekday };
}

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** Calendar day (in tz) that an instant falls on. */
function dateKey(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  return keyOf(p.y, p.m, p.d);
}

/** Day of a "date-only" value that a parser materialised as local midnight of the host. */
function hostLocalDateKey(date) {
  return keyOf(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function addDays(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) { // b - a in whole days
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** Monday of the week containing key. */
function weekStart(key) {
  const dow = new Date(key + 'T00:00:00Z').getUTCDay(); // 0=Sun
  return addDays(key, dow === 0 ? -6 : 1 - dow);
}

/** Offset (minutes, east positive) of tz at an instant. */
function offsetMinutes(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** The instant of wall-clock time (key, hh:mm) in tz. Handles DST by re-checking the offset. */
function zonedTime(key, hh = 0, mm = 0, tz = DEFAULT_TZ) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  t = guess - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

const startOfDay = (key, tz = DEFAULT_TZ) => zonedTime(key, 0, 0, tz);

module.exports = { DEFAULT_TZ, zonedParts, dateKey, hostLocalDateKey, addDays, diffDays, weekStart, offsetMinutes, zonedTime, startOfDay, isDateKey };
