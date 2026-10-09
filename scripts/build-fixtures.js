'use strict';
// Builds FAKE demo data for fixture mode (DATA_MODE=fixture) and the tests. Every task, job, event and
// company here is made up (fictional companies such as Contoso / Fabrikam / Northwind, example.com links).
// Output (gitignored, under data/fixtures/):
//   notion-pages.json  - To Do rows shaped like Notion API pages (+ data source schema)
//   notion-jobs.json   - Recruiting pipeline rows (+ schema)
//   calendars/*.ics    - four iCal calendars (personal, school, Canvas-style assignments, social)
//   feeds.json         - calendar labels / groups for fixture mode
// Dates are relative to today (or --today=YYYY-MM-DD / FIXTURE_TODAY). --reset drops local demo edits.
// `npm test` rebuilds them for a fixed day (2026-10-07) so the tests never depend on the calendar.
const fs = require('fs');
const path = require('path');
const { dateKey, addDays, zonedTime } = require('../lib/time');
const { FIXTURE_IDS } = require('../lib/config');
const { schemas } = require('../lib/setup');
const { createClassMatcher } = require('../lib/classes');
const { SAMPLE_JOB_IDS } = require('../lib/network-sample');

const OUT = path.join(__dirname, '..', 'data', 'fixtures');
const TZ = process.env.APP_TIMEZONE || 'America/Chicago';
const classMatcher = createClassMatcher();
let seq = 0;
const fakeId = (prefix) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const rt = (s) => (s ? [{ type: 'text', text: { content: s, link: null }, plain_text: s, annotations: {} }] : []);
const dt = (d) => (d ? { start: d, end: null, time_zone: null } : null);

/** setup.js request schema -> the response shape Notion returns (name, type, options with colors). */
function responseSchema(props, extra = {}) {
  const out = {};
  for (const [name, def] of Object.entries({ ...props, ...extra })) {
    const type = Object.keys(def)[0];
    out[name] = { id: type === 'title' ? 'title' : name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8) || 'p', name, type, [type]: def[type] };
  }
  return out;
}
function page(ds, id, props, created) {
  return { object: 'page', id, created_time: created, last_edited_time: created, in_trash: false, url: `https://www.notion.so/${id.replace(/-/g, '')}`, parent: { type: 'data_source_id', data_source_id: ds }, properties: props };
}
const selOf = (name, schema, prop) => {
  if (!name) return { type: 'select', select: null };
  const o = (schema[prop].select?.options || schema[prop].status?.options || []).find((x) => x.name === name) || {};
  return { type: 'select', select: { name, color: o.color || 'default' } };
};

function buildTodo(today) {
  const ds = FIXTURE_IDS.todo;
  const s = schemas().todo;
  const schema = responseSchema({ ...s, Status: { status: { options: [{ name: 'Not started', color: 'default' }, { name: 'In progress', color: 'blue' }, { name: 'Done', color: 'green' }] } } }, { Assignee: { people: {} } });
  const d = (n) => (n == null ? null : addDays(today, n));
  // [name, status, area, priority, due offset, notes]
  const rows = [
    ['Renew library books', 'Not started', 'Personal', 'Low', -6, ''],
    ['Submit expense report (sample)', 'Not started', 'Other', 'Medium', -3, ''],
    ['ABC 101 case write-up', 'In progress', 'School', 'High', -1, 'Outline in the shared doc. Portal: https://portal.example.edu/abc101'],
    ['Club B newsletter draft', 'Not started', 'School', 'Medium', 0, ''],
    ['XYZ 202 problem set 4', 'Not started', 'School', 'High', 0, ''],
    ['Call the bank about card', 'Not started', 'Personal', 'Medium', 0, ''],
    ['Apply to Contoso PM internship', 'Not started', 'Recruiting', 'High', 1, 'Referral from the sample network'],
    ['Prep for Fabrikam recruiter screen', 'Not started', 'Recruiting', 'High', 2, ''],
    ['Book dentist appointment', 'Not started', 'Personal', 'Low', 3, ''],
    ['XYZ 202 midterm review session', 'Not started', 'School', 'Medium', 4, ''],
    ['Club B event budget', 'Not started', 'School', 'Medium', 5, ''],
    ['Coffee chat follow-ups', 'Not started', 'Recruiting', 'Medium', 6, ''],
    ['ABC 101 group meeting notes', 'Not started', 'School', 'Low', 8, ''],
    ['Plan weekend trip (sample)', 'Not started', 'Personal', 'Low', 12, ''],
    ['Update resume bullets', 'Not started', 'Recruiting', 'Medium', null, ''],
    ['Read Northwind product blog', 'Not started', 'Recruiting', 'Low', null, ''],
    ['Pick up dry cleaning', 'Done', 'Personal', 'Low', -2, ''],
    ['ABC 101 reading quiz', 'Done', 'School', 'Medium', -4, ''],
    ['Send thank-you to sample mentor', 'Done', 'Recruiting', 'Medium', -5, ''],
  ];
  const pages = rows.map(([name, status, area, priority, due, notes], i) => page(ds, fakeId('aaaaaaaa'), {
    'Task name': { id: 'title', type: 'title', title: rt(name) },
    Status: { id: 'status', type: 'status', status: { name: status, color: status === 'Done' ? 'green' : status === 'In progress' ? 'blue' : 'default' } },
    Area: { id: 'area', ...selOf(area, schema, 'Area') },
    Priority: { id: 'priority', ...selOf(priority, schema, 'Priority') },
    'Due date': { id: 'due', type: 'date', date: dt(d(due)) },
    Notes: { id: 'notes', type: 'rich_text', rich_text: rt(notes) },
    Link: { id: 'link', type: 'url', url: null },
    'Added by': { id: 'addedby', ...selOf('Me', schema, 'Added by') },
    'Class / Activity': { id: 'classes', type: 'multi_select', multi_select: classMatcher.matchTitle(name).map((n) => ({ name: n })) },
  }, `${addDays(today, -20 + i)}T15:00:00.000Z`));
  fs.writeFileSync(path.join(OUT, 'notion-pages.json'), JSON.stringify({ snapshot: `${today}T12:00:00.000Z`, dataSource: { object: 'data_source', id: ds, title: [{ plain_text: 'Dayline · To Do (demo)' }], properties: schema }, pages }, null, 1));
  return pages.length;
}

function buildJobs(today) {
  const ds = FIXTURE_IDS.jobs;
  const schema = responseSchema(schemas().jobs);
  const d = (n) => (n == null ? null : addDays(today, n));
  // [id, role, company, stage, track, location, priority, source, fit, deadline, interview, round, next, notes, applied]
  const rows = [
    [SAMPLE_JOB_IDS.contoso, 'Marketing MBA Internship', 'Contoso', 'Interview', 'PMM', 'Remote/Hybrid', 'High', 'Referral', 9, null, null, 'First round', 'Send thank-you notes', 'Sample role. Had the first round interview; waiting to hear back.', -21],
    [SAMPLE_JOB_IDS.fabrikam, 'Product Manager Intern, Data Platform', 'Fabrikam', 'Applied', 'PM', 'South Bay', 'High', 'Company site', 8, null, null, null, 'Prep recruiter screen', 'Sample role.', -21],
    [SAMPLE_JOB_IDS.northwind, 'Product Marketing Intern', 'Northwind', 'Interested', 'PMM', 'SF', 'Medium', 'LinkedIn', 7, d(14), null, null, 'Ask sample contact for a referral', 'Sample role. Launch-driven team.', null],
    [fakeId('bbbbbbbb'), 'Associate PM Intern', 'Tailspin Toys', 'Applied', 'PM', 'Peninsula', 'Medium', 'School', 7, null, null, null, '', 'Sample role.', -9],
    [fakeId('bbbbbbbb'), 'Growth PM Intern', 'Litware', 'Offer', 'PM', 'SF', 'High', 'Referral', 9, d(10), null, null, 'Decide by the deadline', 'Sample offer.', -40],
    [fakeId('bbbbbbbb'), 'Strategy Intern', 'Adventure Works', 'Closed', 'Other', 'Other', 'Low', 'LinkedIn', 5, null, null, null, '', 'Sample role. Position filled.', -30],
    [fakeId('bbbbbbbb'), 'PM Intern, Payments', 'Woodgrove Bank', 'Researching', 'PM', 'SF', 'High', 'LinkedIn', 8, d(9), null, null, 'Read the job post', 'Sample opportunity. Requirements: SQL, customer interviews, roadmap prioritization.', null],
    [fakeId('bbbbbbbb'), 'Product Marketing Intern, AI', 'Proseware', 'Researching', 'PMM', 'Remote/Hybrid', 'Medium', 'Company site', 7, d(20), null, null, '', 'Sample opportunity. Go-to-market for an AI assistant.', null],
    [fakeId('bbbbbbbb'), 'MBA PM Intern', 'Wide World Importers', 'Researching', 'PM', 'East Bay', 'Low', 'School', 6, null, null, null, '', 'Sample opportunity.', null],
  ];
  const pages = rows.map(([id, role, company, stage, track, loc, pri, src, fit, deadline, interview, round, next, notes, applied], i) => page(ds, id, {
    Name: { id: 'title', type: 'title', title: rt(role) },
    Company: { type: 'rich_text', rich_text: rt(company) },
    Stage: selOf(stage, schema, 'Stage'), Track: selOf(track, schema, 'Track'), Location: selOf(loc, schema, 'Location'),
    Priority: selOf(pri, schema, 'Priority'), Source: selOf(src, schema, 'Source'),
    Fit: { type: 'number', number: fit },
    'Job URL': { type: 'url', url: `https://jobs.example.com/${company.toLowerCase().replace(/\W+/g, '-')}/${i + 1}` },
    Deadline: { type: 'date', date: dt(deadline) },
    Interview: { type: 'date', date: dt(interview) },
    'Interview round': selOf(round, schema, 'Interview round'),
    'Next Action': { type: 'rich_text', rich_text: rt(next) },
    Notes: { type: 'rich_text', rich_text: rt(notes) },
    'Date applied': { type: 'date', date: dt(applied == null ? null : d(applied)) },
    'Next step date': { type: 'date', date: null },
    'Added by': selOf('Me', schema, 'Added by'),
  }, `${addDays(today, -45 + i)}T15:00:00.000Z`));
  fs.writeFileSync(path.join(OUT, 'notion-jobs.json'), JSON.stringify({ snapshot: `${today}T12:00:00.000Z`, dataSource: { object: 'data_source', id: ds, title: [{ plain_text: 'Dayline · Recruiting pipeline (demo)' }], properties: schema }, pages }, null, 1));
  return pages.length;
}

// ---------------- iCal ----------------
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = (k) => k.replace(/-/g, '');
let uidN = 0;
function vevent({ date, start, end, allDay, summary, location, rrule }) {
  const lines = ['BEGIN:VEVENT'];
  if (allDay) lines.push(`DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(addDays(date, 1))}`);
  else lines.push(`DTSTART:${utc(zonedTime(date, start[0], start[1], TZ))}`, `DTEND:${utc(zonedTime(date, end[0], end[1], TZ))}`);
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push(`DTSTAMP:${utc(new Date())}`, `UID:dayline-demo-${++uidN}@example.com`, `SUMMARY:${esc(summary)}`);
  if (location) lines.push(`LOCATION:${esc(location)}`);
  lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  return lines;
}
function ics(name, events) {
  return ['BEGIN:VCALENDAR', 'PRODID:-//Dayline//Demo data//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${TZ}`, ...events.flatMap(vevent), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
function buildCalendars(today) {
  const d = (n) => addDays(today, n);
  const weekday = (n) => { const k = d(n); return new Date(k + 'T12:00:00Z').getUTCDay(); };
  // first Monday / Tuesday on or before today, for weekly class series
  const back = (dow) => { for (let i = 0; i < 7; i++) if (weekday(-i) === dow) return d(-i); return today; };
  const until = utc(new Date(Date.parse(d(60) + 'T00:00:00Z')));
  const cals = {
    'personal.ics': ics('Personal (demo)', [
      { date: back(1), start: [7, 0], end: [8, 0], summary: 'Gym', rrule: `FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=${until}` },
      { date: d(1), start: [12, 0], end: [12, 45], summary: 'Lunch with a sample friend', location: 'Example Cafe' },
      { date: d(3), start: [9, 30], end: [10, 30], summary: 'Dentist (sample)' },
      { date: d(5), allDay: true, summary: 'Sample friend’s birthday' },
    ]),
    'school.ics': ics('Classes (demo)', [
      { date: back(1), start: [9, 0], end: [10, 30], summary: 'ABC 101 Strategy (sample)', location: 'Room 101', rrule: `FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=${until}` },
      { date: back(2), start: [13, 30], end: [15, 0], summary: 'XYZ 202 Statistics (sample)', location: 'Room 202', rrule: `FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=${until}` },
      { date: d(2), start: [18, 0], end: [19, 0], summary: 'Club B weekly meeting', location: 'Student center' },
      { date: d(18), start: [9, 0], end: [11, 0], summary: 'XYZ 202 Midterm Exam' },
    ]),
    'canvas.ics': ics('Canvas (demo)', [
      { date: d(1), allDay: true, summary: 'ABC 101: Case write-up 2 [ABC_101]' },
      { date: d(4), allDay: true, summary: 'XYZ 202: Problem set 5 [XYZ_202]' },
      { date: d(9), allDay: true, summary: 'ABC 101: Reading reflection [ABC_101]' },
    ]),
    'social.ics': ics('Social (demo)', [
      { date: d(0), start: [20, 0], end: [22, 0], summary: 'Game night (sample)', location: '123 Example St' },
      { date: d(2), start: [19, 0], end: [21, 0], summary: 'Sample dinner party', location: 'Sample Hall' },
      { date: d(6), start: [13, 0], end: [16, 0], summary: 'Fall festival (sample)', location: 'Example Park' },
    ]),
  };
  fs.mkdirSync(path.join(OUT, 'calendars'), { recursive: true });
  for (const [f, body] of Object.entries(cals)) fs.writeFileSync(path.join(OUT, 'calendars', f), body);
  const feeds = [
    { file: 'calendars/personal.ics', label: 'Personal', group: 'personal', rank: 1 },
    { file: 'calendars/school.ics', label: 'Classes', group: 'school', rank: 2 },
    { file: 'calendars/canvas.ics', label: 'Canvas', group: 'school', kind: 'canvas', rank: 4 },
    { file: 'calendars/social.ics', label: 'Social', group: 'social', rank: 4 },
  ];
  fs.writeFileSync(path.join(OUT, 'feeds.json'), JSON.stringify(feeds, null, 2));
  return feeds.length;
}

function build({ today = process.env.FIXTURE_TODAY || dateKey(process.env.NOW ? new Date(process.env.NOW) : new Date(), TZ), reset = false, quiet = false } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  seq = 0; uidN = 0;
  const t = buildTodo(today);
  const j = buildJobs(today);
  const c = buildCalendars(today);
  if (reset) for (const f of ['notion-pages.local.json', 'notion-jobs.local.json', 'network.json', 'dayline-store.json', 'brainstorm.json']) if (fs.existsSync(path.join(OUT, f))) fs.unlinkSync(path.join(OUT, f));
  if (!quiet) console.log(`Demo data (all fake) for ${today}: ${t} tasks, ${j} jobs, ${c} calendars -> data/fixtures/`);
}

if (require.main === module) {
  const day = (process.argv.find((a) => a.startsWith('--today=')) || '').slice(8);
  build({ reset: process.argv.includes('--reset'), quiet: process.argv.includes('--quiet'), ...(day ? { today: day } : {}) });
}
module.exports = { build };
