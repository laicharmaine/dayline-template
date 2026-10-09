'use strict';
// All configuration comes from environment variables (see .env.example).
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'data', 'fixtures');
// Fake ids used ONLY in fixture/demo mode (data/fixtures). Live mode takes every id from env vars
// (First-time setup creates the databases and shows the values to paste).
const FIXTURE_IDS = {
  todo: '11111111-1111-4111-8111-111111111111',
  jobs: '22222222-2222-4222-8222-222222222222',
  brainstorm: '33333333-3333-4333-8333-333333333333',
  people: '44444444-4444-4444-8444-444444444444',
  touchpoints: '55555555-5555-4555-8555-555555555555',
};
const DEFAULT_DATA_SOURCE_ID = FIXTURE_IDS.todo; // fixture/tests only

function parseFeeds(raw) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (e) { throw new Error('CAL_FEEDS is not valid JSON: ' + e.message); }
  if (!Array.isArray(list)) throw new Error('CAL_FEEDS must be a JSON array of {label, group, url}');
  return list.map((f, i) => {
    if (!f || !f.url || !f.label) throw new Error(`CAL_FEEDS[${i}] needs at least "label" and "url"`);
    const group = ['personal', 'school', 'social'].includes(f.group) ? f.group : 'personal';
    const kind = ['canvas', 'birthdays', 'calendar'].includes(f.kind) ? f.kind
      : /canvas/i.test(f.label) || /instructure|canvas/i.test(f.url) ? 'canvas'
        : /birthday/i.test(f.label) ? 'birthdays' : 'calendar';
    const rank = Number.isFinite(f.rank) ? f.rank : ({ personal: 1, school: 2, social: 3 })[group] + (kind === 'canvas' ? 2 : 0);
    return { label: String(f.label), group, kind, rank, url: String(f.url).replace(/^webcal:\/\//i, 'https://') };
  });
}

/**
 * Calendars: any number, all optional. Easiest in Vercel is one numbered set per calendar:
 *   CAL_1_URL=https://...ics   CAL_1_LABEL=Personal   CAL_1_GROUP=personal|school|social   (CAL_1_KIND=canvas|birthdays)
 *   CAL_2_URL=...              CAL_2_LABEL=Canvas     CAL_2_GROUP=school
 * Also accepted: DAYLINE_CAL_<NAME>=url (label from NAME, group guessed). Rank decides which copy wins when an
 * event is on several calendars (higher = more specific): personal 1 < school 2 < canvas / social 4.
 */
const ENV_FEEDS = []; // kept for compatibility: no fixed calendar names any more
const guessGroup = (label) => (/partiful|social|party|friends/i.test(label) ? 'social' : /canvas|school|class|course|outlook|university|college/i.test(label) ? 'school' : 'personal');
const titleCase = (s) => s.toLowerCase().split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
function feedsFromEnv(env) {
  const list = [];
  const nums = Object.keys(env).map((k) => (k.match(/^CAL_(\d+)_URL$/) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    const url = String(env[`CAL_${n}_URL`] || '').trim();
    if (!url) continue;
    const label = String(env[`CAL_${n}_LABEL`] || '').trim() || `Calendar ${n}`;
    const group = String(env[`CAL_${n}_GROUP`] || '').trim().toLowerCase() || guessGroup(label);
    const kind = String(env[`CAL_${n}_KIND`] || '').trim().toLowerCase() || undefined;
    list.push({ label, group, kind, url });
  }
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^DAYLINE_CAL_([A-Z0-9_]+)$/);
    if (!m || !String(v || '').trim()) continue;
    const label = titleCase(m[1]);
    list.push({ label, group: guessGroup(label), kind: /birthday/i.test(label) ? 'birthdays' : undefined, url: String(v).trim() });
  }
  return list.map((f) => ({ ...f, rank: f.kind === 'canvas' || /canvas/i.test(f.label) ? 4 : ({ personal: 1, school: 2, social: 4 })[f.group] || 1 }));
}
/** CAL_FEEDS (JSON) wins if set; otherwise the per-calendar variables are used. */
function resolveFeeds(env) {
  if (env.CAL_FEEDS && env.CAL_FEEDS.trim()) return parseFeeds(env.CAL_FEEDS);
  const list = feedsFromEnv(env);
  return list.length ? parseFeeds(JSON.stringify(list)) : [];
}

function loadConfig(env = process.env) {
  const mode = (env.DATA_MODE || 'live').toLowerCase() === 'fixture' ? 'fixture' : 'live';
  const cfg = {
    port: Number(env.PORT || 4320),
    mode,
    tz: env.APP_TIMEZONE || 'America/Chicago',
    appPassword: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    production: env.NODE_ENV === 'production',
    allowShortPassword: /^(1|true|yes)$/i.test(env.ALLOW_SHORT_PASSWORD || ''), // owner's explicit opt-in to a 6-9 character password
    notionToken: env.NOTION_TOKEN || env.DAYLINE_NOTION_TOKEN || '',
    notionReadOnly: /^(1|true|yes)$/i.test(env.NOTION_READ_ONLY || ''),
    notionDataSourceId: env.NOTION_DATA_SOURCE_ID || (mode === 'fixture' ? FIXTURE_IDS.todo : ''),
    notionAssigneeId: env.NOTION_ASSIGNEE_ID || '',
    jobsDataSourceId: env.JOBS_DATA_SOURCE_ID || (mode === 'fixture' ? FIXTURE_IDS.jobs : ''),
    brainstormDataSourceId: env.BRAINSTORM_DATA_SOURCE_ID || (mode === 'fixture' ? FIXTURE_IDS.brainstorm : ''),
    brainstormEnabled: (env.BRAINSTORM_ENABLED || 'true').toLowerCase() !== 'false',
    jobsEnabled: (env.JOBS_ENABLED || 'true').toLowerCase() !== 'false',
    peopleDataSourceId: env.PEOPLE_DATA_SOURCE_ID || (mode === 'fixture' ? FIXTURE_IDS.people : ''),
    touchpointsDataSourceId: env.TOUCHPOINTS_DATA_SOURCE_ID || (mode === 'fixture' ? FIXTURE_IDS.touchpoints : ''),
    networkEnabled: (env.NETWORK_ENABLED || 'true').toLowerCase() !== 'false',
    // Dayline's own store (meal plans, thank-you reminders): Turso if set, else a separate small Notion database.
    tursoUrl: env.TURSO_DATABASE_URL || '',
    tursoToken: env.TURSO_AUTH_TOKEN || '',
    storeDataSourceId: env.DAYLINE_STORE_DATA_SOURCE_ID || '',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModels: (env.GEMINI_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean),
    calCacheSeconds: Number(env.CAL_CACHE_SECONDS || 300),
    feeds: resolveFeeds(env),
    // A frozen clock for demos/screenshots. Only honoured in fixture mode.
    now: mode === 'fixture' && env.NOW ? new Date(env.NOW) : null,
    fixture: {
      notionSeed: path.join(FIXTURE_DIR, 'notion-pages.json'),
      notionLocal: path.join(FIXTURE_DIR, 'notion-pages.local.json'),
      feedsFile: path.join(FIXTURE_DIR, 'feeds.json'),
      jobsSeed: path.join(FIXTURE_DIR, 'notion-jobs.json'),
      jobsLocal: path.join(FIXTURE_DIR, 'notion-jobs.local.json'),
      brainstormFile: path.join(FIXTURE_DIR, 'brainstorm.json'),
      mealplansFile: path.join(FIXTURE_DIR, 'mealplans.json'),
      storeFile: path.join(FIXTURE_DIR, 'dayline-store.json'), // meal plans + thank-you reminders (fixture)
      networkFile: path.join(FIXTURE_DIR, 'network.json'), // seeded with FAKE sample people (lib/network-sample.js)
    },
  };
  return cfg;
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg.appPassword) problems.push('APP_PASSWORD is not set (every page and API route is behind it).');
  else if (cfg.production && cfg.appPassword.length < (cfg.allowShortPassword ? 6 : 10)) {
    problems.push(cfg.allowShortPassword ? 'APP_PASSWORD must be at least 6 characters.' : 'APP_PASSWORD should be at least 10 characters in production (or set ALLOW_SHORT_PASSWORD=true to accept 6+).');
  }
  if (cfg.mode === 'live' && !cfg.notionToken) problems.push('DAYLINE_NOTION_TOKEN (or NOTION_TOKEN) is not set (or use DATA_MODE=fixture for local demo data).');
  if (cfg.mode === 'live' && cfg.feeds.length === 0) problems.push('CAL_FEEDS is empty: no CAL_1_URL (or DAYLINE_CAL_*) variables are set, so no calendars will show (allowed, but probably not what you want).');
  return problems;
}

module.exports = { loadConfig, validateConfig, parseFeeds, feedsFromEnv, resolveFeeds, ENV_FEEDS, ROOT, FIXTURE_DIR, DEFAULT_DATA_SOURCE_ID, FIXTURE_IDS };
