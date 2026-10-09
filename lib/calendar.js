'use strict';
// Calendar feeds: fetch each private iCal (ICS) URL, expand recurring events in America/Chicago,
// clean up titles, flag Canvas deadlines, and merge duplicates that show up on several calendars.
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const ical = require('node-ical');
const { dateKey, hostLocalDateKey, addDays, startOfDay, DEFAULT_TZ } = require('./time');

const MAX_FEED_BYTES = 8 * 1024 * 1024;

// ---------- titles ----------

/** "ABC_101" / "ABC-101-0 (1)" style codes -> "ABC 101". */
function courseFrom(text) {
  const m = String(text || '').match(/(?:^|[^A-Za-z])([A-Z]{3,5})[_-](\d{3})(?!\d)/);
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * Display title + course chip.
 *  "Assignment #3 [2026FA_ABC_101-0_SEC1]"                         -> "Assignment #3", ABC 101
 *  "Session 5: Monday, October 5 (2026FA_MGMT_420-0_SEC36 ...) [..]" -> "Session 5", MGMT 420
 *  "MGMT-420-0 (36) Business Strategy"                               -> "Business Strategy", MGMT 420
 *  "Harvest Party | Partiful"                                   -> "Harvest Party"
 *  "Canceled: Info Session"                                           -> "Info Session" (canceled)
 */
function cleanTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  let course = null;
  let canceled = false;
  const cm = t.match(/^(cancell?ed|canceled event)\s*:\s*/i);
  if (cm) { canceled = true; t = t.slice(cm[0].length); }
  t = t.replace(/\s*\|\s*Partiful\s*$/i, '');
  // Canvas: trailing [TERM_DEPT_NUM-0_SEC] tags and "(TERM_DEPT_NUM... Course name)" parentheticals
  const tags = t.match(/\[[^\]]*\]/g) || [];
  for (const tag of tags) course = course || courseFrom(tag);
  t = t.replace(/\s*\[[^\]]*\d{4}[A-Z]{2}_[^\]]*\]/g, '');
  t = t.replace(/\s*\((\d{4}[A-Z]{2}_[^)]*)\)/g, (_, inner) => { course = course || courseFrom(inner); return ''; });
  // Registrar style: "MGMT-420-0 (36) Business Strategy"
  const rm = t.match(/^([A-Z]{3,5})-(\d{3})-\d+\s*\(\d+\)\s*/);
  if (rm) { course = course || `${rm[1]} ${rm[2]}`; t = t.slice(rm[0].length) || `${rm[1]} ${rm[2]}`; }
  // "Session 5: Monday, October 5" -> "Session 5"
  t = t.replace(/^((?:Session|Class)\s+\d+):\s*(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+[A-Za-z]+\s+\d{1,2}$/i, '$1');
  return { title: t.trim() || String(raw || '').trim() || '(no title)', course, canceled };
}

/** Key used to spot the same event on two calendars: lowercase words only, emoji/punctuation dropped. */
function normalizeTitle(raw) {
  const { title, course } = cleanTitle(raw);
  const words = title.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return (course ? course.toLowerCase() + ' ' : '') + words;
}

// ---------- parsing / expansion ----------

function parseIcs(text) {
  return Object.values(ical.sync.parseICS(text)).filter((c) => c && c.type === 'VEVENT');
}

const shortText = (s, n = 400) => (typeof s === 'string' ? s : s?.val || '').replace(/\r/g, '').trim().slice(0, n);
const urlIn = (s) => (String(s || '').match(/https?:\/\/[^\s<>")\]]+/) || [null])[0];

function isDeadlineEvent({ feed, uid, title, allDay, start, end }) {
  if (feed.kind === 'canvas') {
    if (/^event-assignment/.test(uid)) return true;
    if (!allDay && end.getTime() === start.getTime()) return true; // Canvas due dates have no duration
  }
  return allDay && /^(deadline|due)\b|\bdue\s*$/i.test(title);
}

/** Expand one parsed feed to concrete event instances overlapping [fromKey, toKey] (Chicago days). */
function expandFeed(vevents, feed, fromKey, toKey, tz = DEFAULT_TZ) {
  const from = new Date(startOfDay(fromKey, tz).getTime() - 2 * 86400000);
  const to = new Date(startOfDay(addDays(toKey, 1), tz).getTime() + 2 * 86400000);
  const out = [];
  for (const ve of vevents) {
    if (String(ve.status || '').toUpperCase() === 'CANCELLED') continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ve, { from, to, expandOngoing: true });
    } catch (e) {
      continue; // one malformed event shouldn't hide the whole calendar
    }
    for (const inst of instances) {
      const src = inst.event || ve;
      if (String(src.status || '').toUpperCase() === 'CANCELLED') continue;
      const birthday = feed.kind === 'birthdays';
      const allDay = !!inst.isFullDay || birthday; // the Birthdays calendar is always shown as all-day
      const start = inst.start;
      let end = inst.end || (allDay ? new Date(start.getTime() + 86400000) : start);
      if (end < start) end = start;
      let startKey, endKey;
      if (birthday && !inst.isFullDay) {
        startKey = dateKey(start, tz); endKey = startKey; // a timed entry lands on its local (Chicago) day
      } else if (allDay) {
        startKey = hostLocalDateKey(start);
        const endExcl = hostLocalDateKey(end);
        endKey = endExcl > startKey ? addDays(endExcl, -1) : startKey;
      } else {
        startKey = dateKey(start, tz);
        endKey = end > start ? dateKey(new Date(end.getTime() - 1), tz) : startKey;
      }
      if (endKey < fromKey || startKey > toKey) continue;
      const rawTitle = shortText(inst.summary || src.summary, 300);
      const { title, course, canceled } = feed.kind === 'birthdays' ? { title: rawTitle || '(birthday)', course: null, canceled: false } : cleanTitle(rawTitle);
      const uid = String(ve.uid || '');
      const description = shortText(src.description);
      const location = shortText(src.location, 200);
      const ev = {
        uid,
        title,
        rawTitle,
        course,
        canceled,
        allDay,
        start: allDay ? startKey : start.toISOString(),
        end: allDay ? addDays(endKey, 1) : end.toISOString(),
        startKey,
        endKey,
        feed: feed.label,
        group: feed.group,
        rank: feed.rank,
        location: location && location !== '-' ? location.replace(/,\s*$/, '') : '',
        description,
        url: (typeof src.url === 'string' ? src.url : src.url?.val) || urlIn(description) || null,
        recurring: !!inst.isRecurring,
        alsoOn: [],
      };
      if (birthday) ev.birthday = true;
      ev.deadline = isDeadlineEvent({ feed, uid, title, allDay, start, end });
      if (ev.deadline && allDay) ev.title = title.replace(/^(deadline|due)\s*:\s*/i, '').replace(/\s+due\s*$/i, '') || title;
      ev.id = crypto.createHash('sha1').update(`${feed.label}|${uid}|${ev.start}`).digest('hex').slice(0, 16);
      out.push(ev);
    }
  }
  return out;
}

// ---------- duplicates ----------

const instantOf = (e) => (e.allDay ? e.startKey : e.start);

function mergeInto(keep, other) {
  for (const label of [other.feed, ...other.alsoOn]) if (label !== keep.feed && !keep.alsoOn.includes(label)) keep.alsoOn.push(label);
  keep.deadline = keep.deadline || other.deadline;
  if (!keep.location && other.location) keep.location = other.location;
  if (!keep.description && other.description) keep.description = other.description;
  if (!keep.url && other.url) keep.url = other.url;
  if (!keep.course && other.course) keep.course = other.course;
  return keep;
}

function better(a, b) { // which copy to show: more specific calendar wins, then the richer copy
  if (a.rank !== b.rank) return a.rank > b.rank ? a : b;
  if (a.title.length !== b.title.length) return a.title.length > b.title.length ? a : b;
  return (a.description || '').length >= (b.description || '').length ? a : b;
}

function collapse(events, keyFn) {
  const groups = new Map();
  const order = [];
  for (const e of events) {
    const k = keyFn(e);
    if (k === null) { order.push(e); continue; }
    if (!groups.has(k)) { groups.set(k, e); order.push(k); continue; }
    const cur = groups.get(k);
    const win = better(cur, e);
    groups.set(k, mergeInto(win, win === cur ? e : cur));
  }
  return order.map((k) => (typeof k === 'string' ? groups.get(k) : k));
}

/**
 * Merge copies of the same event:
 *  1. same UID + same start (Google keeps the source UID when a feed is imported into two calendars)
 *  2. same normalized title + same start (and same course, if any)
 *  3. same start, end and location where one title is a word-prefix of the other
 *     (e.g. Gmail's "Concert Night" and "Concert Night - The World Tour")
 * The copy from the more specific calendar (higher rank) is kept; the others are listed in `alsoOn`.
 */
function dedupeEvents(events) {
  let list = collapse(events, (e) => (e.uid ? `uid|${e.uid}|${instantOf(e)}` : null));
  list = collapse(list, (e) => `t|${normalizeTitle(e.rawTitle)}|${instantOf(e)}`);
  // rule 3 (pairwise, small lists)
  const out = [];
  for (const e of list) {
    const nt = normalizeTitle(e.rawTitle);
    const loc = normLoc(e.location);
    const twin = !e.allDay && loc && out.find((o) => !o.allDay && o.start === e.start && o.end === e.end && sameLoc(normLoc(o.location), loc) && (() => {
      const ot = normalizeTitle(o.rawTitle);
      const [s, l] = ot.length <= nt.length ? [ot, nt] : [nt, ot];
      return s.length >= 4 && (l === s || l.startsWith(s + ' '));
    })());
    if (!twin) { out.push(e); continue; }
    const keepLonger = twin.title.length >= e.title.length ? twin : e;
    const merged = mergeInto(keepLonger, keepLonger === twin ? e : twin);
    out[out.indexOf(twin)] = merged;
  }
  return foldDeadlineReminders(out);
}

const normLoc = (l) => String(l || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** "Lakeside Arena, Springfield" and "Lakeside Arena, Springfield, CA" are the same place. */
const sameLoc = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && (a.startsWith(b + ' ') || b.startsWith(a + ' ')));

/** Words of a deadline title without the course code and filler, e.g. "Deadline: ABC-101 Assignment 3" -> {assignment, 3}. */
function deadlineWords(e) {
  const course = (e.course || courseFrom(e.rawTitle) || '').toLowerCase();
  const drop = new Set(['deadline', 'due', 'the', 'a', 'an', ...course.split(' ')]);
  return normalizeTitle(e.rawTitle).split(' ').filter((w) => w && !drop.has(w));
}

/**
 * Rule 4: an all-day "Deadline: ABC-101 Assignment 3" reminder on a personal calendar and Canvas's timed
 * "Assignment #3" (ABC 101) due the same day are the same thing. Keep the Canvas copy (it has the due time).
 */
function foldDeadlineReminders(events) {
  const removed = new Set();
  for (const r of events) {
    if (!r.allDay || !r.deadline) continue;
    const course = r.course || courseFrom(r.rawTitle);
    if (!course) continue;
    const words = deadlineWords(r);
    if (!words.length) continue;
    const match = events.find((c) => c !== r && !removed.has(c) && !c.allDay && c.deadline && c.course === course && c.startKey === r.startKey && (() => {
      const cw = deadlineWords(c);
      const [small, big] = words.length <= cw.length ? [words, cw] : [cw, words];
      return small.length > 0 && small.every((w) => big.includes(w));
    })());
    if (match) { mergeInto(match, r); removed.add(r); }
  }
  return removed.size ? events.filter((e) => !removed.has(e)) : events;
}

/**
 * Canvas posts a zero-length "Class 5: …" / "Session 5" item at the start of each class. When the
 * actual class meeting (same course, same start) is on another calendar, attach the Canvas item to
 * it as `prep` instead of showing two rows.
 */
function foldCanvasSessions(events) {
  const removed = new Set();
  for (const note of events) {
    if (!note.deadline || !note.course || note.allDay || !/^(class|session)\s*\d+/i.test(note.title)) continue;
    const t = Date.parse(note.start);
    const near = (m) => m !== note && !m.allDay && !m.deadline && Math.abs(Date.parse(m.start) - t) <= 5 * 60000 && Date.parse(m.end) > Date.parse(m.start);
    // Same course code; failing that, a school-calendar meeting with no code at the same time (e.g. "Leadership in Organizations").
    const meeting = events.find((m) => near(m) && m.course === note.course)
      || events.find((m) => near(m) && !m.course && m.group === 'school' && m.feed !== note.feed);
    if (meeting && !meeting.prep) {
      meeting.prep = { title: note.title, description: note.description, feed: note.feed };
      removed.add(note);
    }
  }
  return events.filter((e) => !removed.has(e));
}

function sortEvents(events) {
  return events.sort((a, b) => {
    if (a.startKey !== b.startKey) return a.startKey < b.startKey ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const sa = a.allDay ? a.startKey : a.start, sb = b.allDay ? b.startKey : b.start;
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (a.deadline !== b.deadline) return a.deadline ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

// ---------- feed loading with cache ----------

async function readFeed(feed, { fetchImpl, allowFiles, timeoutMs = 12000 }) {
  if (feed.url.startsWith('file:')) {
    if (!allowFiles) throw new Error('file: feeds are only allowed in fixture mode');
    return fs.readFileSync(fileURLToPath(feed.url), 'utf8');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed.url, { signal: ctrl.signal, headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'Dayline/0.1 (personal calendar reader)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new Error('feed too large');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not an iCal feed (check the URL ends in .ics / basic.ics)');
    return text;
  } finally { clearTimeout(timer); }
}

function createCalendarService({ feeds, tz = DEFAULT_TZ, cacheSeconds = 300, fetchImpl = globalThis.fetch, allowFiles = false, now = () => Date.now() }) {
  const state = new Map(); // label -> { vevents, fetchedAt, error, inflight }

  async function refresh(feed) {
    const s = state.get(feed.label) || {};
    if (s.inflight) return s.inflight;
    s.inflight = (async () => {
      try {
        const text = await readFeed(feed, { fetchImpl, allowFiles });
        s.vevents = parseIcs(text);
        s.fetchedAt = now();
        s.error = null;
      } catch (e) {
        s.error = e.name === 'AbortError' ? 'timed out' : e.message;
        s.failedAt = now();
      } finally { s.inflight = null; }
    })();
    state.set(feed.label, s);
    return s.inflight;
  }

  async function ensureFresh() {
    await Promise.all(feeds.map((f) => {
      const s = state.get(f.label);
      const fresh = s && s.fetchedAt && now() - s.fetchedAt < cacheSeconds * 1000;
      const recentlyFailed = s && s.error && s.failedAt && now() - s.failedAt < 60000;
      return fresh || recentlyFailed ? null : refresh(f);
    }));
  }

  async function getEvents(fromKey, toKey) {
    await ensureFresh();
    let all = [];
    for (const f of feeds) {
      const s = state.get(f.label);
      if (s?.vevents) all = all.concat(expandFeed(s.vevents, f, fromKey, toKey, tz));
    }
    return sortEvents(foldCanvasSessions(dedupeEvents(all)));
  }

  function status() {
    return feeds.map((f) => {
      const s = state.get(f.label) || {};
      return { label: f.label, group: f.group, ok: !!s.vevents && !s.error, stale: !!s.vevents && !!s.error, error: s.error || null, fetchedAt: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null, events: s.vevents ? s.vevents.length : 0 };
    });
  }

  return { getEvents, status, refreshAll: () => Promise.all(feeds.map(refresh)) };
}

module.exports = { cleanTitle, normalizeTitle, courseFrom, parseIcs, expandFeed, dedupeEvents, foldCanvasSessions, sortEvents, createCalendarService, isDeadlineEvent };
