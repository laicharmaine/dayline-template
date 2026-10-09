'use strict';
// Dayline server entry. Loads .env (if present), wires Notion + calendars for the chosen DATA_MODE.
require('express'); // (lets Vercel's zero-config detector recognise this as an Express app)
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { loadConfig, validateConfig, parseFeeds } = require('./lib/config');
const { createNotionClient } = require('./lib/notion');
const { createFixtureNotionFetch } = require('./lib/fixture-notion');
const { createCalendarService } = require('./lib/calendar');
const { createJobsClient } = require('./lib/jobs');
const { createNotionBrainstorm, createFileBrainstorm } = require('./lib/brainstorm');
const { createStoreMealPlans } = require('./lib/mealplans');
const { storeFromConfig } = require('./lib/store');
const { createNotionNetwork, createFileNetwork } = require('./lib/network');
const { sampleNetwork } = require('./lib/network-sample');
const { dateKey } = require('./lib/time');
const { createApp } = require('./lib/app');
const { readOnlyFetch } = require('./lib/readonly');

const ON_VERCEL = !!process.env.VERCEL; // Vercel runs this file as one serverless function: export the app, don't listen
const config = loadConfig();
const problems = validateConfig(config);
const fatal = problems.filter((p) => !p.startsWith('CAL_FEEDS is empty'));
for (const p of problems) console.warn('Config:', p);
if (fatal.length) {
  console.error('Dayline cannot start until the settings above are fixed. See SETUP.md.');
  if (!ON_VERCEL) process.exit(1);
  // On Vercel, answer every request with the problem instead of crashing the function in a loop.
  const express = require('express');
  const broken = express();
  broken.use((req, res) => res.status(500).type('text').send(`Dayline is not set up yet:\n- ${fatal.join('\n- ')}\n\nAdd the missing Environment Variables in Vercel (Settings > Environment Variables), then redeploy. See SETUP.md.`));
  module.exports = broken;
  return;
}

let notion;
let jobs = null;
let brainstorm = null;
let mealplans = null;
let network = null;
let setupMode = false;
let store = null; // Dayline's own store: meal plans + thank-you reminders (never your To Do list)
let feeds = config.feeds;
if (config.mode === 'fixture') {
  if (!fs.existsSync(config.fixture.notionSeed)) require('./scripts/build-fixtures').build(); // fake demo data, generated on first run
  const sources = [{ dataSourceId: config.notionDataSourceId, seedFile: config.fixture.notionSeed, localFile: config.fixture.notionLocal }];
  if (fs.existsSync(config.fixture.jobsSeed)) sources.push({ dataSourceId: config.jobsDataSourceId, seedFile: config.fixture.jobsSeed, localFile: config.fixture.jobsLocal });
  const fixtureFetch = createFixtureNotionFetch({ sources }); // never touches the network
  notion = createNotionClient({ token: 'fixture', dataSourceId: config.notionDataSourceId, tz: config.tz, fetchImpl: fixtureFetch });
  if (config.jobsEnabled && sources.length > 1) jobs = createJobsClient({ token: 'fixture', dataSourceId: config.jobsDataSourceId, fetchImpl: fixtureFetch });
  if (config.brainstormEnabled) brainstorm = createFileBrainstorm({ file: config.fixture.brainstormFile });
  store = storeFromConfig(config);
  if (config.networkEnabled) network = createFileNetwork({ file: config.fixture.networkFile, seed: () => sampleNetwork(dateKey(config.now || new Date(), config.tz)) });
  if (!feeds.length && fs.existsSync(config.fixture.feedsFile)) {
    const list = JSON.parse(fs.readFileSync(config.fixture.feedsFile, 'utf8'))
      .map((f) => ({ ...f, url: pathToFileURL(path.join(path.dirname(config.fixture.feedsFile), f.file)).href }));
    feeds = parseFeeds(JSON.stringify(list));
  }
} else if (!config.notionDataSourceId) {
  setupMode = true; // no databases yet: only sign-in + /setup work until the env values are added
  console.warn('NOTION_DATA_SOURCE_ID is not set: starting in first-time setup mode. Sign in and open /setup.');
} else {
  const fetchImpl = config.notionReadOnly ? readOnlyFetch(globalThis.fetch) : globalThis.fetch; // NOTION_READ_ONLY=true: reads only
  notion = createNotionClient({ token: config.notionToken, dataSourceId: config.notionDataSourceId, tz: config.tz, assigneeId: config.notionAssigneeId || undefined, fetchImpl });
  if (config.jobsEnabled && config.jobsDataSourceId) jobs = createJobsClient({ token: config.notionToken, dataSourceId: config.jobsDataSourceId, fetchImpl });
  if (config.brainstormEnabled && config.brainstormDataSourceId) brainstorm = createNotionBrainstorm({ token: config.notionToken, dataSourceId: config.brainstormDataSourceId, fetchImpl });
  store = storeFromConfig(config, { fetchImpl });
  if (config.networkEnabled && config.peopleDataSourceId && config.touchpointsDataSourceId) network = createNotionNetwork({ token: config.notionToken, peopleDataSourceId: config.peopleDataSourceId, touchDataSourceId: config.touchpointsDataSourceId, fetchImpl });
}

if (store) mealplans = createStoreMealPlans({ store });
else if (!setupMode) console.warn('No Dayline store configured (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or DAYLINE_STORE_DATA_SOURCE_ID): Socializing plans and thank-you reminders are off.');

const calendar = createCalendarService({ feeds, tz: config.tz, cacheSeconds: config.calCacheSeconds, allowFiles: config.mode === 'fixture' });
const now = config.now ? (() => { const offset = config.now.getTime() - Date.now(); return () => new Date(Date.now() + offset); })() : () => new Date();
const app = createApp({ config, notion, calendar, jobs, brainstorm, mealplans, network, store, now, setupMode });

if (!ON_VERCEL) app.listen(config.port, '0.0.0.0', () => {
  console.log(`Dayline running on http://localhost:${config.port} (${setupMode ? 'FIRST-TIME SETUP, open /setup' : `${config.mode} mode`}, ${feeds.length} calendar feeds, jobs ${jobs ? 'on' : 'off'}, brainstorm ${brainstorm ? brainstorm.backend : 'off'}, coffee chats ${network ? network.backend : 'off'}, store ${store ? store.backend : 'off'}, Gemini ${config.geminiKey ? 'on' : 'off'}, tz ${config.tz})`);
  if (config.mode === 'fixture') console.log('Fixture mode: tasks and calendars come from data/fixtures; edits go to data/fixtures/*.local.json only.');
});

module.exports = app;
