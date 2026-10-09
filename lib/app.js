'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createAuth, parseCookies, cookieHeader, createLimiter, COOKIE } = require('./auth');
const { validateTaskInput, normalizeId, AREAS, PRIORITIES, STATUSES } = require('./notion');
const { todayTasks, tasksByDay, nextUp, sortTasks } = require('./tasks');
const { dateKey, addDays, weekStart, isDateKey } = require('./time');
const net = require('./network');
const thanks = require('./thanks');
const { validateJobInput, INTERVIEW_ROUNDS, TRACKER_STATUSES, JOB_STATUSES, TRACKS, LOCATIONS, BAY_AREA, JOB_PRIORITIES, SOURCES } = require('./jobs');
const jobparse = require('./jobparse');
const resumeTips = require('./resume-tips');
const { buildSocializing } = require('./freebusy');
const { createClassMatcher } = require('./classes');
const classMatcher = createClassMatcher(); // rules live in config/classes.js

// Read once at startup with literal paths so serverless bundlers (Vercel) include the files.
const PUBLIC = path.join(__dirname, '..', 'public');
const crypto = require('crypto');
function assetVersion(...names) {
  const h = crypto.createHash('sha1');
  for (const n of names) h.update(fs.readFileSync(path.join(PUBLIC, n)));
  return h.digest('hex').slice(0, 10);
}
const ASSET_V = assetVersion('app.js', 'style.css');
const LOGIN_ASSET_V = assetVersion('login.js', 'style.css');
function withAssetV(html, v) {
  return html
    .replaceAll('href="/style.css"', `href="/style.css?v=${v}"`)
    .replaceAll('src="/app.js"', `src="/app.js?v=${v}"`)
    .replaceAll('src="/login.js"', `src="/login.js?v=${v}"`);
}
const LOGIN_HTML = withAssetV(fs.readFileSync(path.join(__dirname, '..', 'views', 'login.html'), 'utf8'), LOGIN_ASSET_V);
const INDEX_HTML = withAssetV(fs.readFileSync(path.join(__dirname, '..', 'views', 'index.html'), 'utf8'), ASSET_V);
const SETUP_HTML = fs.readFileSync(path.join(__dirname, '..', 'views', 'setup.html'), 'utf8').replaceAll('src="/setup.js"', `src="/setup.js?v=${assetVersion('setup.js', 'style.css')}"`).replaceAll('href="/style.css"', `href="/style.css?v=${ASSET_V}"`);
const setupLib = require('./setup');

/**
 * @param {object} deps
 *  config   - from lib/config.js
 *  notion   - { listOpen, listDone, create, update }
 *  calendar - { getEvents(fromKey, toKey), status() }
 *  now      - () => Date (injectable clock)
 */
function createApp({ config, notion, calendar, jobs = null, brainstorm = null, mealplans = null, network = null, store = null, now = () => new Date(), parser = {}, setupMode = false, setupFetch = globalThis.fetch }) {
  const app = express();
  const auth = createAuth({ appPassword: config.appPassword, sessionSecret: config.sessionSecret, now: () => now().getTime() });
  const limiter = createLimiter();
  const parseHits = new Map(); // simple hourly cap on "Add from URL" (each one fetches a page and may call Gemini)
  function parseAllowed(key) {
    const t = Date.now();
    const h = parseHits.get(key) || { start: t, n: 0 };
    if (t - h.start > 3600000) { h.start = t; h.n = 0; }
    h.n += 1; parseHits.set(key, h);
    return h.n <= 60;
  }
  const tz = config.tz;

  app.set('trust proxy', 1); // Render/Vercel terminate TLS in front of us
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  const isAuthed = (req) => auth.verify(parseCookies(req.headers.cookie)[COOKIE]);
  const secureCookie = (req) => req.secure || config.production;

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------- pages ----------
  app.get('/login', (req, res) => (isAuthed(req) ? res.redirect('/') : res.type('html').send(LOGIN_HTML)));
  app.get(['/', '/today', '/week', '/tasks', '/jobs', '/opportunities', '/classes', '/social', '/chats'], (req, res) => (!isAuthed(req) ? res.redirect('/login') : setupMode ? res.redirect('/setup') : res.set('Cache-Control', 'no-store').type('html').send(INDEX_HTML)));
  app.get('/setup', (req, res) => (isAuthed(req) ? res.set('Cache-Control', 'no-store').type('html').send(SETUP_HTML) : res.redirect('/login')));
  app.use((req, res, next) => {
    res.set('X-Dayline-Asset', ASSET_V);
    if (/\.(?:js|css)$/.test(req.path)) res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    next();
  });
  app.use(express.static(PUBLIC, { index: false, maxAge: config.production ? '1h' : 0, etag: true, lastModified: true }));

  // ---------- auth API ----------
  app.use('/api', express.json({ limit: '20kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      // CSRF guard on top of SameSite=Lax: writes must be same-origin JSON.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    }
    next();
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!auth.checkPassword(req.body?.password)) { limiter.fail(ip); return res.status(401).json({ error: 'Wrong password' }); }
    limiter.clear(ip);
    res.set('Set-Cookie', cookieHeader(auth.issue(), { secure: secureCookie(req) }));
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', cookieHeader('', { secure: secureCookie(req), maxAge: 0 }));
    res.json({ ok: true });
  });

  // Every other /api route needs a valid session.
  app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Not signed in' })));

  // ---------- First-time setup (creates the Notion databases; shows env values to paste into Vercel) ----------
  // Uses NOTION_TOKEN from the server env, or a token pasted on the page (used for that request only, never stored).
  const setupClient = (req) => setupLib.createSetupClient({ token: String(req.body?.token || '').trim() || config.notionToken, fetchImpl: setupFetch });
  const setupHits = { start: 0, n: 0 };
  const setupLimit = (req, res, next) => {
    if (Date.now() - setupHits.start > 3600000) { setupHits.start = Date.now(); setupHits.n = 0; }
    setupHits.n += 1;
    return setupHits.n > 40 ? res.status(429).json({ error: 'Too many setup attempts this hour.' }) : next();
  };
  app.get('/api/setup/status', (req, res) => res.json({
    setupMode, mode: config.mode, hasToken: !!config.notionToken,
    configured: { todo: !!config.notionDataSourceId, jobs: !!config.jobsDataSourceId, brainstorm: !!config.brainstormDataSourceId, people: !!config.peopleDataSourceId, touchpoints: !!config.touchpointsDataSourceId, store: !!store },
    calendars: (calendar?.status?.() || []).map((f) => f.label), titles: setupLib.TITLES,
  }));
  const setupGuard = (req, res, next) => (config.mode === 'fixture' ? res.status(409).json({ error: 'Setup is off in demo (fixture) mode. Deploy with DATA_MODE unset to use your own Notion.' }) : next());
  app.post('/api/setup/pages', setupGuard, setupLimit, asyncSetup(async (req, res) => res.json({ pages: await setupClient(req).listPages() })));
  app.post('/api/setup/find', setupGuard, setupLimit, asyncSetup(async (req, res) => { const ids = await setupClient(req).findExisting(); res.json({ ids, env: setupLib.envFor(ids) }); }));
  app.post('/api/setup/create', setupGuard, setupLimit, asyncSetup(async (req, res) => { const out = await setupClient(req).createAll(req.body?.parent); res.status(201).json(out); }));
  function asyncSetup(fn) { return (req, res) => fn(req, res).catch((e) => res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message })); }
  if (setupMode) app.use('/api', (req, res, next) => (/^\/(logout|setup)/.test(req.path) ? next() : res.status(409).json({ error: 'Finish first-time setup at /setup first.', setup: true })));
  // Refresh button: GETs with ?fresh=1 drop this instance's caches (tasks, jobs, network, thank-yous) and re-pull the
  // calendar ICS feeds once; parallel requests from the same refresh share that one bust instead of each refetching.
  const bust = { at: 0, p: null };
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' || req.query.fresh !== '1') return next();
    if (!bust.p || Date.now() - bust.at > 4000) {
      bust.at = Date.now();
      cache.openAt = 0; cache.doneAt = 0; jobsCache.at = 0; netCache.at = 0; thankCache.at = 0;
      bust.p = Promise.resolve(calendar.refreshAll ? calendar.refreshAll() : null).catch(() => null);
    }
    bust.p.then(() => next(), () => next());
  });

  // ---------- data ----------
  const cache = { open: null, openAt: 0, done: null, doneAt: 0 };
  const TASK_TTL = 20000;
  async function openTasks() {
    if (cache.open && Date.now() - cache.openAt < TASK_TTL) return cache.open;
    cache.open = await notion.listOpen();
    cache.openAt = Date.now();
    return cache.open;
  }
  async function doneTasks() {
    if (cache.done && Date.now() - cache.doneAt < TASK_TTL) return cache.done;
    cache.done = await notion.listDone();
    cache.doneAt = Date.now();
    return cache.done;
  }
  function remember(task) { // keep caches in step with a write so the UI doesn't flicker back
    if (cache.open) { cache.open = cache.open.filter((t) => t.id !== task.id); if (!task.done) cache.open.push(task); }
    if (cache.done) { cache.done = cache.done.filter((t) => t.id !== task.id); if (task.done) cache.done.unshift(task); }
  }

  async function safeEvents(fromKey, toKey) {
    try { return { events: await calendar.getEvents(fromKey, toKey), error: null }; } catch (e) { return { events: [], error: e.message }; }
  }
  const asyncRoute = (fn) => (req, res) => fn(req, res).catch((e) => {
    const status = e.status && e.status >= 400 && e.status < 600 ? (e.status === 401 || e.status === 403 ? 502 : e.status) : 500;
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, e.message);
    res.status(status).json({ error: e.message || 'Something went wrong' });
  });

  app.get('/api/me', (req, res) => {
    const n = now();
    res.json({ ok: true, mode: config.mode, readOnly: !!config.notionReadOnly, tz, today: dateKey(n, tz), now: n.toISOString(), assetV: ASSET_V, options: { areas: AREAS, priorities: PRIORITIES, statuses: STATUSES }, classes: classMatcher.items.map(({ key, option, name, kind, color }) => ({ key, option, name, kind, color })) });
  });

  app.get('/api/today', asyncRoute(async (req, res) => {
    const n = now();
    const todayKey = dateKey(n, tz);
    const [tasks, { events, error }] = await Promise.all([openTasks(), safeEvents(todayKey, todayKey)]);
    const t = todayTasks(tasks, todayKey);
    res.json({
      today: todayKey, now: n.toISOString(),
      overdue: t.overdue, dueToday: t.dueToday, noDateCount: t.noDateCount,
      events, nextUp: nextUp({ events, overdue: t.overdue, dueToday: t.dueToday, now: n, todayKey }),
      calendarError: error, feeds: calendar.status(),
    });
  }));

  app.get('/api/agenda', asyncRoute(async (req, res) => {
    const todayKey = dateKey(now(), tz);
    const start = isDateKey(req.query.start) ? req.query.start : weekStart(todayKey);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 31);
    const end = addDays(start, days - 1);
    const [tasks, { events, error }] = await Promise.all([openTasks(), safeEvents(start, end)]);
    const byDay = tasksByDay(tasks, start, end);
    const out = [];
    for (let i = 0; i < days; i++) {
      const key = addDays(start, i);
      out.push({ date: key, events: events.filter((e) => e.startKey <= key && e.endKey >= key), tasks: byDay[key] || [] });
    }
    res.json({ today: todayKey, start, end, days: out, calendarError: error, feeds: calendar.status() });
  }));

  app.get('/api/tasks', asyncRoute(async (req, res) => {
    const by = req.query.sort === 'priority' ? 'priority' : 'due';
    const open = sortTasks(await openTasks(), by);
    const caps = notion.getCaps ? await notion.getCaps().catch(() => null) : null;
    const body = { today: dateKey(now(), tz), open, caps: caps ? { notes: caps.notes, link: caps.link, classes: caps.classes, classOptions: caps.classOptions || null } : { notes: true, link: false, classes: false, classOptions: null } };
    if (req.query.done === '1') body.done = await doneTasks();
    res.json(body);
  }));

  app.post('/api/tasks', asyncRoute(async (req, res) => {
    const { value, error } = validateTaskInput(req.body);
    if (error) return res.status(400).json({ error });
    const task = await notion.create(value);
    remember(task);
    res.status(201).json(task);
  }));

  app.patch('/api/tasks/:id', asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad task id' });
    const { value, error } = validateTaskInput(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    const task = await notion.update(id, value);
    remember(task);
    res.json(task);
  }));

  // Classes & activities: config/classes.js items, plus calendar events mapped to them (next 3 weeks of
  // sessions/events, 6 weeks of deadlines). Tasks come from /api/tasks (their "Class / Activity" column).
  app.get('/api/classes', asyncRoute(async (req, res) => {
    const todayKey = dateKey(now(), tz);
    const deadlinesEnd = addDays(todayKey, 120); // far enough for midterms + finals
    const { events, error } = await safeEvents(todayKey, deadlinesEnd);
    const sessionsEnd = addDays(todayKey, 20);
    const nowMs = now().getTime();
    const { classifyExamTitle } = require('./exams');
    const mapped = [];
    for (const e of events) {
      if (e.canceled) continue;
      const cls = classMatcher.matchEvent(e);
      if (!cls) continue;
      const upcoming = e.allDay ? e.endKey >= todayKey : Date.parse(e.end || e.start) >= nowMs;
      if (!upcoming) continue;
      const isExam = !!classifyExamTitle(`${e.title || ''} ${e.rawTitle || ''}`);
      if (!e.deadline && !isExam && e.startKey > sessionsEnd) continue; // sessions: next 3 weeks; exams keep longer window
      if ((e.deadline || isExam) && e.startKey > deadlinesEnd) continue;
      mapped.push({ ...e, cls, exam: isExam ? classifyExamTitle(`${e.title || ''} ${e.rawTitle || ''}`) : null });
    }
    const caps = notion.getCaps ? await notion.getCaps().catch(() => null) : null;
    res.json({ today: todayKey, items: classMatcher.items, notionOptions: caps?.classOptions || null, events: mapped, sessionsEnd, deadlinesEnd, calendarError: error });
  }));

  // Dots for the mini month calendar: per day, how many open tasks are due and how many events there are.
  app.get('/api/month', asyncRoute(async (req, res) => {
    const todayKey = dateKey(now(), tz);
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayKey.slice(0, 7);
    const start = `${month}-01`;
    const gridStart = weekStart(start);
    const gridEnd = addDays(gridStart, 41); // 6 weeks, Monday first
    const [tasks, { events, error }] = await Promise.all([openTasks(), safeEvents(gridStart, gridEnd)]);
    const days = {};
    const bump = (k, field) => { if (k >= gridStart && k <= gridEnd) { days[k] = days[k] || { tasks: 0, events: 0, deadlines: 0, overdue: 0 }; days[k][field] += 1; } };
    for (const t of tasks) if (t.due?.key) { bump(t.due.key, 'tasks'); if (t.due.key < todayKey) bump(t.due.key, 'overdue'); }
    for (const e of events) {
      if (e.canceled) continue;
      for (let k = e.startKey; k <= e.endKey && k <= gridEnd; k = addDays(k, 1)) bump(k, e.deadline ? 'deadlines' : 'events');
    }
    res.json({ today: todayKey, month, gridStart, gridEnd, days, calendarError: error });
  }));

  // ---------- jobs (Notion "Pipeline" database) ----------
  const jobsCache = { list: null, at: 0 };
  async function allJobs() {
    if (jobsCache.list && Date.now() - jobsCache.at < TASK_TTL) return jobsCache.list;
    jobsCache.list = await jobs.list();
    jobsCache.at = Date.now();
    return jobsCache.list;
  }
  function rememberJob(job) { if (jobsCache.list) jobsCache.list = [job, ...jobsCache.list.filter((j) => j.id !== job.id)]; }
  const needJobs = (req, res, next) => (jobs ? next() : res.status(404).json({ error: 'The jobs tracker is not set up (JOBS_ENABLED=false).' }));

  app.get('/api/jobs', needJobs, asyncRoute(async (req, res) => {
    const [list, caps] = await Promise.all([allJobs(), jobs.getCaps()]);
    res.json({
      today: dateKey(now(), tz),
      tracker: list.filter((j) => j.status !== 'Opportunity'),
      opportunities: list.filter((j) => j.status === 'Opportunity'),
      caps: { applied: caps.applied, nextDate: caps.nextDate, interested: caps.interested, addedBy: caps.addedBy, round: !!caps.round },
      options: { rounds: INTERVIEW_ROUNDS, statuses: TRACKER_STATUSES, allStatuses: JOB_STATUSES, tracks: TRACKS, locations: LOCATIONS, bayArea: BAY_AREA, priorities: JOB_PRIORITIES, sources: SOURCES },
      gemini: !!config.geminiKey,
    });
  }));
  app.post('/api/jobs', needJobs, asyncRoute(async (req, res) => {
    const { value, error } = validateJobInput(req.body);
    if (error) return res.status(400).json({ error });
    const job = await jobs.create(value);
    rememberJob(job);
    res.status(201).json(job);
  }));
  app.patch('/api/jobs/:id', needJobs, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad job id' });
    const { value, error } = validateJobInput(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    const job = await jobs.update(id, value);
    rememberJob(job);
    res.json(job);
  }));
  // Soft-remove is PATCH status=Closed. This archives the Notion page (extra confirm on the client).
  app.delete('/api/jobs/:id', needJobs, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad job id' });
    if (req.query.mode !== 'archive') return res.status(400).json({ error: 'Pass ?mode=archive to permanently archive this Notion page. Prefer marking it Closed to remove it from the board.' });
    if (!jobs.archive) return res.status(501).json({ error: 'Archive is not available.' });
    const out = await jobs.archive(id);
    if (jobsCache.list) jobsCache.list = jobsCache.list.filter((j) => j.id !== id);
    res.json(out);
  }));
  // On-demand resume bullet suggestions for Interested / Applied / Interviewing. Cached per job fingerprint.
  const tipHits = new Map();
  function tipAllowed(key) {
    const t = Date.now();
    const h = tipHits.get(key) || { start: t, n: 0 };
    if (t - h.start > 3600000) { h.start = t; h.n = 0; }
    h.n += 1; tipHits.set(key, h);
    return h.n <= 40;
  }
  app.post('/api/jobs/:id/resume-tips', needJobs, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad job id' });
    if (!tipAllowed('me')) return res.status(429).json({ error: 'Resume tip limit for this hour. Try again later.' });
    const list = await allJobs();
    const job = list.find((j) => j.id === id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const allowed = ['Interested', 'Applied', 'Interviewing'];
    if (!allowed.includes(job.status)) return res.status(400).json({ error: 'Resume tips are for Interested, Applied or Interviewing roles.' });
    try {
      const result = await resumeTips.suggestResumeTips(job, {
        refresh: !!req.body?.refresh,
        geminiKey: config.geminiKey,
        geminiModels: config.geminiModels?.length ? config.geminiModels : undefined,
        fetchImpl: parser.geminiFetch || parser.fetchImpl,
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
  }));
  // Read a posting (URL or pasted text) into suggested fields. Never saves anything.
  app.post('/api/jobs/parse', needJobs, asyncRoute(async (req, res) => {
    if (!parseAllowed('me')) return res.status(429).json({ error: 'That is a lot of postings for one hour. Try again later.' });
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 60000) : '';
    const opts = { geminiKey: config.geminiKey, geminiModels: config.geminiModels?.length ? config.geminiModels : undefined, fetchImpl: parser.fetchImpl, lookup: parser.lookup, geminiFetch: parser.geminiFetch };
    try {
      const result = text ? await jobparse.parseJobFromText(text, { ...opts, url }) : url ? await jobparse.parseJobFromUrl(url, opts) : null;
      if (!result) return res.status(400).json({ error: 'Paste a link or the job description.' });
      result.notes = jobparse.notesFromParsed(result.fields);
      const list = await allJobs().catch(() => []);
      const norm = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
      const dup = list.find((j) => (result.fields.url && norm(j.url) === norm(result.fields.url)) ||
        (j.company && result.fields.company && j.company.toLowerCase() === result.fields.company.toLowerCase() && j.role.toLowerCase() === result.fields.role.toLowerCase()));
      result.duplicate = dup ? { id: dup.id, role: dup.role, company: dup.company, status: dup.status } : null;
      res.json(result);
    } catch (e) {
      if (e instanceof jobparse.ParseError) return res.status(e.status).json({ error: e.message, code: e.code, canPaste: e.canPaste });
      throw e;
    }
  }));


  // ---------- Coffee chats (Notion People + Touch points) ----------
  const needNetwork = (req, res, next) => (network ? next() : res.status(404).json({ error: 'Coffee chats are not set up (NETWORK_ENABLED=false).' }));
  const netCache = { people: null, touches: null, at: 0 };
  async function netData(fresh = false) {
    if (!fresh && netCache.people && Date.now() - netCache.at < TASK_TTL) return netCache;
    const [people, touches] = await Promise.all([network.listPeople(), network.listTouches()]);
    Object.assign(netCache, { people, touches, at: Date.now() });
    return netCache;
  }
  const netDirty = () => { netCache.at = 0; };
  const badRequest = (res, error) => res.status(400).json({ error });
  async function findPerson(id) { const { people } = await netData(); return people.find((p) => p.id === id) || null; }
  /** After a touch point: a follow-up date becomes the person's next follow-up; a touch on/after the old one clears it. */
  async function syncFollowUp(person, touch) {
    if (!person) return person;
    if (touch.followUp && touch.followUp !== person.nextFollowUp) return network.updatePerson(person.id, { nextFollowUp: touch.followUp });
    if (!touch.followUp && person.nextFollowUp && touch.date && person.nextFollowUp <= touch.date) return network.updatePerson(person.id, { nextFollowUp: null });
    return person;
  }

  app.get('/api/network', needNetwork, asyncRoute(async (req, res) => {
    const today = dateKey(now(), tz);
    const [{ people, touches }, jobList, tags] = await Promise.all([netData(req.query.fresh === '1'), jobs ? allJobs().catch(() => []) : [], network.tagOptions()]);
    const { people: enriched, stats } = net.summarize({ people, touches, today, jobs: jobList });
    res.json({
      backend: network.backend, today, people: enriched, touches, stats, graph: net.buildGraph(enriched),
      options: { strengths: net.STRENGTHS, types: net.TOUCH_TYPES, tags },
      jobs: jobList.filter((j) => j.status !== 'Opportunity' || j.company).map((j) => ({ id: j.id, company: j.company, role: j.role, status: j.status })),
      gemini: !!config.geminiKey,
    });
  }));
  app.post('/api/network/people', needNetwork, asyncRoute(async (req, res) => {
    const { value, error } = net.validatePerson(req.body);
    if (error) return badRequest(res, error);
    const person = await network.createPerson(value);
    netDirty();
    res.status(201).json(person);
  }));
  app.patch('/api/network/people/:id', needNetwork, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return badRequest(res, 'Bad person id');
    const { value, error } = net.validatePerson(req.body, { partial: true });
    if (error) return badRequest(res, error);
    if ((value.introducedBy || []).includes(id)) return badRequest(res, 'Someone cannot introduce themselves');
    const person = await network.updatePerson(id, value);
    netDirty();
    res.json(person);
  }));
  // Delete = move the person and their touch points to Notion trash (restorable from Notion).
  app.delete('/api/network/people/:id', needNetwork, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return badRequest(res, 'Bad person id');
    const { touches } = await netData(true);
    const theirs = touches.filter((t) => t.personId === id);
    for (const t of theirs) await network.trash(t.id);
    await network.trash(id);
    netDirty();
    res.json({ id, trashed: true, touches: theirs.length });
  }));
  app.post('/api/network/touches', needNetwork, asyncRoute(async (req, res) => {
    const { value, error } = net.validateTouch(req.body);
    if (error) return badRequest(res, error);
    const person = await findPerson(value.personId);
    if (!person) return res.status(404).json({ error: 'That person is not in your network list' });
    const touch = await network.createTouch(value, { personName: person.name });
    const updated = await syncFollowUp(person, touch);
    const reminder = await maybeChatReminder(req.body?.remind, person, touch);
    netDirty();
    res.status(201).json({ touch, person: updated, ...reminder });
  }));
  app.patch('/api/network/touches/:id', needNetwork, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return badRequest(res, 'Bad touch point id');
    const { value, error } = net.validateTouch(req.body, { partial: true });
    if (error) return badRequest(res, error);
    const { touches } = await netData();
    const cur = touches.find((t) => t.id === id);
    const person = await findPerson(value.personId || cur?.personId);
    const merged = { type: cur?.type || 'Coffee chat', date: cur?.date, ...value };
    const touch = await network.updateTouch(id, ('type' in value || 'date' in value) ? { ...value, type: merged.type, date: merged.date } : value, { personName: person?.name });
    netDirty();
    res.json({ touch });
  }));
  app.delete('/api/network/touches/:id', needNetwork, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return badRequest(res, 'Bad touch point id');
    await network.trash(id);
    netDirty();
    res.json({ id, trashed: true });
  }));
  // Quick "Log coffee chat": existing person by id, or a new person (reuses a same-name + same-company match).
  app.post('/api/network/log', needNetwork, asyncRoute(async (req, res) => {
    const body = req.body || {};
    let person = body.personId ? await findPerson(normalizeId(body.personId)) : null;
    let created = false;
    if (body.personId && !person) return res.status(404).json({ error: 'That person is not in your network list' });
    if (!person) {
      const { value, error } = net.validatePerson(body.person || {});
      if (error) return badRequest(res, error);
      const { people } = await netData(true);
      person = people.find((p) => p.name.toLowerCase() === value.name.toLowerCase() && net.companyKey(p.company) === net.companyKey(value.company)) || null;
      if (!person) { person = await network.createPerson(value); created = true; }
    }
    const { value: tv, error: te } = net.validateTouch({ type: 'Coffee chat', date: dateKey(now(), tz), ...(body.touch || {}), personId: person.id });
    if (te) return badRequest(res, te);
    const touch = await network.createTouch(tv, { personName: person.name });
    person = await syncFollowUp(person, touch);
    const reminder = await maybeChatReminder(body.remind, person, touch);
    netDirty();
    res.status(201).json({ person, touch, createdPerson: created, ...reminder });
  }));
  // "Thank your network" for an offer: who to thank, then drafts. Nothing is ever sent from here.
  app.get('/api/network/thanks', needNetwork, needJobs, asyncRoute(async (req, res) => {
    const jobId = normalizeId(req.query.jobId);
    const job = (await allJobs()).find((j) => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { people, touches } = await netData();
    res.json({ job: { id: job.id, company: job.company, role: job.role, status: job.status }, candidates: net.thankCandidates({ job, people, touches }), gemini: !!config.geminiKey });
  }));
  const thankHits = { start: 0, n: 0 };
  app.post('/api/network/thanks/drafts', needNetwork, needJobs, asyncRoute(async (req, res) => {
    const jobId = normalizeId(req.body?.jobId);
    const ids = Array.isArray(req.body?.personIds) ? [...new Set(req.body.personIds.map(normalizeId).filter(Boolean))] : [];
    if (!ids.length) return badRequest(res, 'Pick at least one person to thank');
    if (ids.length > 25) return badRequest(res, 'Up to 25 people at a time');
    if (Date.now() - thankHits.start > 3600000) { thankHits.start = Date.now(); thankHits.n = 0; }
    thankHits.n += 1;
    const job = (await allJobs()).find((j) => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { people, touches } = await netData();
    const chosen = ids.map((id) => people.find((p) => p.id === id)).filter(Boolean);
    const why = Object.fromEntries(net.thankCandidates({ job, people, touches }).map((c) => [c.id, c.why]));
    const drafts = await net.draftThankYous({
      job, people: chosen, touches, accepted: !!req.body?.accepted, why, today: dateKey(now(), tz),
      geminiKey: thankHits.n <= 30 ? config.geminiKey : '', geminiModels: config.geminiModels, fetchImpl: parser.geminiFetch || parser.fetchImpl,
    });
    res.json({ job: { id: job.id, company: job.company, role: job.role }, drafts });
  }));

  // ---------- Thank-you reminders (coffee chats + interviews) ----------
  // Kept in Dayline's own store (lib/store.js), never auto-written to Notion. Interviews whose date has passed are
  // shown as derived reminders (nothing is written until the user acts). A To Do row is created only when the user taps
  // "Add to my to-dos".
  const thankCache = { list: null, at: 0 };
  const needStore = (req, res, next) => (store ? next() : res.status(503).json({ error: 'Thank-you reminders need the Dayline store (not configured).' }));
  async function thankRecords(fresh = false) {
    if (!store) return [];
    if (!fresh && thankCache.list && Date.now() - thankCache.at < TASK_TTL) return thankCache.list;
    thankCache.list = (await store.list('thanks')).map((r) => ({ ...r.data, id: r.key }));
    thankCache.at = Date.now();
    return thankCache.list;
  }
  const withDue = (r) => ({ ...r, due: r.date ? addDays(r.date, 1) : null }); // "24 hours after": day-level dates
  async function saveThanks(id, rec) {
    const data = { ...rec }; delete data.id; delete data.virtual; delete data.due; delete data.done;
    await store.put('thanks', id, data, { date: rec.date || null });
    thankCache.at = 0;
    return withDue({ ...data, id });
  }
  /** Stored records + derived reminders for passed interviews (not written anywhere until the user acts). */
  async function thankList({ fresh = false, jobList = [], today }) {
    const records = await thankRecords(fresh);
    const derived = thanks.sweepDue({ jobs: jobList, records, today })
      .map((j) => ({ id: thanks.interviewKey(j.id, j.round), kind: 'interview', jobId: j.id, round: j.round || null, date: j.interview, company: j.company, link: j.notionUrl || null, state: 'open', virtual: true }));
    return { records, all: [...records, ...derived].map(withDue) };
  }
  /** A To Do the user added for a reminder: if the user ticked it off in Notion, the reminder is done too. */
  async function todoOpen(taskId) {
    if (!taskId) return false;
    const open = await openTasks().catch(() => null);
    return open ? open.some((t) => t.id === taskId) : true;
  }
  /** After a Coffee chat: "Send thank-you to <Name>" due the next day (unless the user unticked it). Dayline store only. */
  async function maybeChatReminder(flag, person, touch) {
    if (touch.type !== 'Coffee chat' || flag === false || !store) return {};
    try {
      const reminder = await saveThanks(`chat:${touch.id}`, { kind: 'chat', personId: person.id, touchId: touch.id, jobId: touch.jobId || null, date: touch.date, personName: person.name, company: person.company || null, link: person.url || person.linkedin || null, state: 'open', created: new Date().toISOString() });
      return { reminder };
    } catch (e) { return { reminderError: `The chat was saved, but the thank-you reminder was not: ${e.message}` }; }
  }
  app.get('/api/thanks', asyncRoute(async (req, res) => {
    const today = dateKey(now(), tz);
    const jobList = jobs ? await allJobs().catch(() => []) : [];
    const { records, all } = await thankList({ fresh: req.query.fresh === '1', jobList, today });
    const { people } = network ? await netData() : { people: [] };
    const pById = new Map(people.map((p) => [p.id, p]));
    const jById = new Map(jobList.map((j) => [j.id, j]));
    const slimP = (p) => (p ? { id: p.id, name: p.name, email: p.email, linkedin: p.linkedin, company: p.company, role: p.role } : null);
    const slimJ = (j) => (j ? { id: j.id, company: j.company, role: j.role, status: j.status, round: j.round || null } : null);
    const open = [];
    for (const r of all) {
      if (r.state && r.state !== 'open') continue;
      if (r.taskId && !(await todoOpen(r.taskId))) continue; // ticked off in the user's To Do list
      open.push({ ...r, person: slimP(pById.get(r.personId)), job: slimJ(jById.get(r.jobId)), overdue: !!(r.due && r.due < today) });
    }
    open.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
    res.json({ today, store: store ? store.backend : null, reminders: open, toCheck: thanks.pastInterviews({ jobs: jobList, records, today }), rounds: thanks.ROUNDS, gemini: !!config.geminiKey });
  }));
  async function findThanks(id, today) {
    if (!id) return null;
    const jobList = jobs ? await allJobs().catch(() => []) : [];
    return (await thankList({ fresh: true, jobList, today })).all.find((r) => r.id === id) || null;
  }
  const thanksId = (b) => (typeof b.id === 'string' && b.id.length <= 200 ? b.id : null);
  const draftHits = { start: 0, n: 0 };
  app.post('/api/thanks/drafts', asyncRoute(async (req, res) => {
    const b = req.body || {};
    const today = dateKey(now(), tz);
    if (Date.now() - draftHits.start > 3600000) { draftHits.start = Date.now(); draftHits.n = 0; }
    draftHits.n += 1;
    const ai = { geminiKey: draftHits.n <= 60 ? config.geminiKey : '', geminiModels: config.geminiModels, fetchImpl: parser.geminiFetch || parser.fetchImpl };
    const rec = await findThanks(thanksId(b), today);
    const kind = rec?.kind || b.kind;
    if (!thanks.KINDS.includes(kind)) return badRequest(res, 'kind must be chat or interview');
    const jobList = jobs ? await allJobs().catch(() => []) : [];
    const job = jobList.find((j) => j.id === normalizeId(b.jobId || rec?.jobId)) || null;
    if (kind === 'chat') {
      if (!network) return res.status(404).json({ error: 'Coffee chats are not set up.' });
      const { people, touches } = await netData();
      const person = people.find((p) => p.id === normalizeId(b.personId || rec?.personId));
      if (!person) return res.status(404).json({ error: 'Person not found' });
      const touch = touches.find((t) => t.id === normalizeId(b.touchId || rec?.touchId)) || touches.filter((t) => t.personId === person.id && t.type !== 'Thank-you note').sort((x, y) => String(y.date).localeCompare(String(x.date)))[0] || null;
      const cjob = job || jobList.find((j) => j.id === touch?.jobId) || null;
      const out = await thanks.draftVersions({ kind, recipient: person, person, job: cjob, date: touch?.date || rec?.date, today, notes: touch?.notes || '', action: touch?.action || '' }, ai);
      return res.json({ kind, drafts: [{ recipient: { name: person.name, email: person.email, linkedin: person.linkedin, personId: person.id }, ...out }], job: cjob ? { id: cjob.id, company: cjob.company, role: cjob.role } : null });
    }
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const interviewers = thanks.parseInterviewers(b.interviewers ?? rec?.interviewers ?? []);
    const round = thanks.ROUNDS.includes(b.round) ? b.round : rec?.round || job.round || null;
    const notes = typeof b.notes === 'string' ? b.notes.slice(0, 4000) : rec?.notes || '';
    const date = isDateKey(b.date) ? b.date : rec?.date || job.interview || null;
    const recipients = interviewers.length ? interviewers.slice(0, 4) : [{ name: '', email: '' }];
    const drafts = [];
    for (const r of recipients) drafts.push({ recipient: r, ...(await thanks.draftVersions({ kind, recipient: r.name ? r : { name: 'there' }, job, round, date, today, notes }, ai)) });
    res.json({ kind, drafts, job: { id: job.id, company: job.company, role: job.role }, round, date, interviewers, notes });
  }));
  // Log an interview round (the user's Save): interviewer names/emails (People only for the ones the user ticks), notes,
  // the job's round/date, and the 24h reminder in the Dayline store.
  app.post('/api/thanks/interview', needJobs, needStore, asyncRoute(async (req, res) => {
    const b = req.body || {};
    const job = (await allJobs()).find((j) => j.id === normalizeId(b.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!thanks.ROUNDS.includes(b.round)) return badRequest(res, `Round must be one of: ${thanks.ROUNDS.join(', ')}`);
    if (!isDateKey(b.date)) return badRequest(res, 'Interview date must be YYYY-MM-DD');
    const raw = Array.isArray(b.interviewers) ? b.interviewers.slice(0, 6) : [];
    const interviewers = thanks.parseInterviewers(raw);
    const notes = String(b.notes || '').slice(0, 4000);
    const peopleIds = [];
    if (network) {
      for (let i = 0; i < interviewers.length; i++) {
        const want = raw[i] || {};
        let pid = normalizeId(want.personId) || null;
        if (!pid && want.addToNetwork && interviewers[i].name) {
          const { people } = await netData(true);
          const hit = people.find((p) => p.name.toLowerCase() === interviewers[i].name.toLowerCase() && net.companyKey(p.company) === net.companyKey(job.company));
          pid = hit ? hit.id : (await network.createPerson({ name: interviewers[i].name, email: interviewers[i].email || null, company: job.company, role: 'Interviewer', howMet: `${b.round} interview`, jobIds: [job.id], tags: [] })).id;
        }
        if (pid) {
          interviewers[i].personId = pid; peopleIds.push(pid);
          await network.createTouch({ personId: pid, date: b.date, type: 'Interview', notes, jobId: job.id }, { personName: interviewers[i].name });
        }
      }
      netDirty();
    }
    const patch = {};
    if (job.status !== 'Offer' && job.status !== 'Interviewing') patch.status = 'Interviewing';
    if (job.round !== b.round) patch.round = b.round;
    if (job.interview !== b.date) patch.interview = b.date;
    if (Object.keys(patch).length) { const caps = await jobs.getCaps(); if (!caps.round) delete patch.round; if (Object.keys(patch).length) rememberJob(await jobs.update(job.id, patch)); }
    const id = thanks.interviewKey(job.id, b.round);
    const existing = (await thankRecords(true)).find((r) => r.id === id);
    const reminder = await saveThanks(id, { ...(existing || {}), kind: 'interview', jobId: job.id, round: b.round, date: b.date, interviewers, peopleIds, notes, company: job.company, link: job.notionUrl || null, state: 'open', created: existing?.created || new Date().toISOString() });
    res.status(201).json({ reminder, peopleIds });
  }));
  // "Add to my to-dos": the only way a thank-you reminder becomes a Notion To Do row (the user's tap).
  app.post('/api/thanks/todo', needStore, asyncRoute(async (req, res) => {
    const today = dateKey(now(), tz);
    const rec = await findThanks(thanksId(req.body || {}), today);
    if (!rec) return res.status(404).json({ error: 'Reminder not found' });
    if (rec.taskId && (await todoOpen(rec.taskId))) return res.json({ reminder: rec, task: { id: rec.taskId, url: rec.taskUrl || null }, existed: true });
    let personName = rec.personName;
    if (rec.kind === 'chat' && !personName && network) personName = (await netData()).people.find((p) => p.id === rec.personId)?.name;
    const task = await notion.create(thanks.taskFields({ ...rec, personName, state: 'open' }));
    remember(task);
    const reminder = await saveThanks(rec.id, { ...rec, taskId: task.id, taskUrl: task.url || null });
    res.status(201).json({ reminder, task: { id: task.id, url: task.url || null } });
  }));
  // Mark a thank-you as sent (the user sent it themselves) or skipped. Logs "Thank-you note" touch points for linked people.
  app.post('/api/thanks/resolve', needStore, asyncRoute(async (req, res) => {
    const b = req.body || {};
    const action = b.action === 'skip' ? 'skipped' : b.action === 'sent' ? 'sent' : null;
    if (!action) return badRequest(res, 'action must be sent or skip');
    const today = dateKey(now(), tz);
    let rec = thanksId(b) ? await findThanks(thanksId(b), today) : null;
    if (thanksId(b) && !rec) return res.status(404).json({ error: 'Reminder not found' });
    if (!rec) { // "Thank-yous to check" (past interview): remember the decision so it is not asked again
      const job = jobs ? (await allJobs()).find((j) => j.id === normalizeId(b.jobId)) : null;
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const round = thanks.ROUNDS.includes(b.round) ? b.round : job.round || null;
      rec = { id: thanks.interviewKey(job.id, round), kind: 'interview', jobId: job.id, round, date: isDateKey(b.date) ? b.date : job.interview || null, interviewers: thanks.parseInterviewers(b.interviewers || []), notes: String(b.notes || '').slice(0, 4000), company: job.company, link: job.notionUrl || null };
    }
    if (rec.taskId && (await todoOpen(rec.taskId))) { remember(await notion.update(rec.taskId, { status: 'Done' })); } // the To Do the user added for it
    rec = await saveThanks(rec.id, { ...rec, state: action, resolved: today });
    let logged = 0;
    if (action === 'sent' && network) {
      const ids = rec.kind === 'chat' ? [rec.personId] : rec.peopleIds || [];
      const { people } = await netData();
      for (const id of ids.filter(Boolean)) {
        const p = people.find((x) => x.id === id);
        if (!p) continue;
        const note = `Thank-you ${rec.kind === 'interview' ? `after ${rec.round || 'interview'}` : 'after coffee chat'}${b.message ? `:\n${String(b.message).slice(0, 3000)}` : ' (marked sent in Dayline)'}`;
        await network.createTouch({ personId: id, date: today, type: 'Thank-you note', notes: note, jobId: rec.jobId || null }, { personName: p.name });
        logged += 1;
      }
      netDirty();
    }
    res.json({ reminder: rec, logged });
  }));

  const needBrainstorm = (req, res, next) => (brainstorm ? next() : res.status(404).json({ error: 'Brainstorm is not set up.' }));
  app.get('/api/brainstorm', needBrainstorm, asyncRoute(async (req, res) => {
    const notes = await brainstorm.list();
    const group = typeof req.query.group === 'string' ? req.query.group : '';
    res.json({
      backend: brainstorm.backend,
      groups: brainstorm.groups,
      colors: brainstorm.colors,
      notes: group && group !== 'all' ? notes.filter((n) => n.group === group) : notes,
    });
  }));
  app.post('/api/brainstorm', needBrainstorm, asyncRoute(async (req, res) => {
    try {
      const note = await brainstorm.create(req.body || {});
      res.status(201).json(note);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message, code: e.code });
      throw e;
    }
  }));
  app.patch('/api/brainstorm/:id', needBrainstorm, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad note id' });
    try {
      res.json(await brainstorm.update(id, req.body || {}));
    } catch (e) {
      if (e.status === 400 || e.status === 404) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
  }));
  app.delete('/api/brainstorm/:id', needBrainstorm, asyncRoute(async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad note id' });
    try {
      res.json(await brainstorm.remove(id));
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
  }));

  // Partiful list + lunch/dinner free-busy for the next week (read-only; no calendar writes).
  app.get('/api/socializing', asyncRoute(async (req, res) => {
    const todayKey = dateKey(now(), tz);
    const days = Math.min(14, Math.max(1, Number(req.query.days) || 8));
    const { events, error } = await safeEvents(todayKey, addDays(todayKey, Math.max(days, 45)));
    const body = buildSocializing({ events, today: todayKey, days, tz });
    body.calendarError = error;
    body.planStatuses = mealplans?.statuses || ['Planned', 'Reached out', 'Confirmed', 'Declined', 'Cancelled'];
    if (mealplans) {
      try {
        const plans = await mealplans.list({ from: todayKey, to: addDays(todayKey, days - 1) });
        const byKey = Object.fromEntries(plans.map((p) => [`${p.date}:${p.meal}`, p]));
        for (const day of body.plan) {
          for (const meal of day.meals) {
            const plan = byKey[`${day.date}:${meal.id}`];
            meal.plan = plan ? { id: plan.id, with: plan.with, planStatus: plan.planStatus || 'Planned', edited: plan.edited || null } : null;
          }
        }
        body.plans = plans;
      } catch (e) {
        body.plansError = e.message;
      }
    }
    res.json(body);
  }));
  app.put('/api/socializing/plans', asyncRoute(async (req, res) => {
    if (!mealplans) return res.status(404).json({ error: 'Meal plans are not set up.' });
    try {
      const plan = await mealplans.upsert(req.body || {});
      res.json(plan);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  }));
  app.delete('/api/socializing/plans', asyncRoute(async (req, res) => {
    if (!mealplans) return res.status(404).json({ error: 'Meal plans are not set up.' });
    const date = req.body?.date || req.query.date;
    const meal = req.body?.meal || req.query.meal;
    if (!date || !meal) return res.status(400).json({ error: 'Need date and meal.' });
    res.json(await mealplans.clear({ date, meal }));
  }));

  app.get('/api/status', (req, res) => res.json({ mode: config.mode, feeds: calendar.status(), jobs: !!jobs, network: network ? network.backend : null, gemini: !!config.geminiKey }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

module.exports = { createApp };
