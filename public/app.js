'use strict';
/* Dayline front end: vanilla JS, no build step. All DOM is built with h(); data never goes through innerHTML. */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const main = $('#main');
  const sheet = $('#sheet');
  const backdrop = $('#backdrop');
  const toastEl = $('#toast');
  const CLIENT_ASSET_V = (document.querySelector('script[src*="app.js"]')?.src.match(/[?&]v=([^&]+)/) || [])[1] || '';
  // Desktop (>=1024px): sidebar, dashboard grids, tables, side panels. Phones/tablets (<1024px): top bar, bottom tabs,
  // single-column cards, full-screen sheets. Same views, different renderers where a table or board would not fit.
  const mobileMq = window.matchMedia('(max-width: 1023px)');
  const isMobile = () => mobileMq.matches;
  document.documentElement.classList.toggle('is-mobile', isMobile());

  const AREAS = ['School', 'Personal', 'Recruiting', 'Other'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const STATUSES = ['Not started', 'In progress', 'Done'];
  const GROUP_LABEL = { personal: 'Personal', school: 'School', social: 'Social' };

  let me = { tz: 'America/Chicago', today: null, mode: 'live' };
  let clockOffset = 0; // server clock minus browser clock (lets fixture mode freeze "now")
  const nowMs = () => Date.now() + clockOffset;

  const prefs = Object.assign({ area: 'All', sort: 'due', showDone: false }, safeJson(localStorage.getItem('dayline.prefs')));
  const savePrefs = () => localStorage.setItem('dayline.prefs', JSON.stringify(prefs));
  function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

  // ---------- DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  /** replaceChildren that skips null/false and flattens arrays, like h(). */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    return el;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function icon(d) {
    const s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', d); s.append(p);
    return s;
  }
  const ICON = { check: 'M5 12.5l4.5 4.5L19 7.5', left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7', cal: 'M4 6.5h16v13H4zM4 10.5h16M8.5 4v4M15.5 4v4', link: 'M10 14l9-9M14 5h5v5M19 14v5H5V5h5' };

  // ---------- dates (all in the app's time zone) ----------
  const fmtCache = {};
  function fmt(opts) {
    const key = JSON.stringify(opts);
    return fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat('en-US', { timeZone: me.tz, ...opts }));
  }
  // A YYYY-MM-DD key is a calendar day, so format it at UTC noon to avoid any zone shift.
  const keyDate = (key) => new Date(key + 'T12:00:00Z');
  const fmtKey = (key, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(keyDate(key));
  function addDays(key, n) { const d = keyDate(key); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const diffDays = (a, b) => Math.round((keyDate(b) - keyDate(a)) / 86400000);
  function weekStart(key) { const dow = keyDate(key).getUTCDay(); return addDays(key, -((dow + 6) % 7)); }
  function todayKey() {
    const p = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs())).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const partsOf = (date, opts) => Object.fromEntries(fmt(opts).formatToParts(date).map((x) => [x.type, x.value]));
  function keyOfIso(iso) { const p = partsOf(new Date(iso), { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${p.year}-${p.month}-${p.day}`; }
  function minsOf(iso) { const p = partsOf(new Date(iso), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); return (Number(p.hour) % 24) * 60 + Number(p.minute); }
  const hourLabel = (hr) => (hr % 24 === 0 ? '12 AM' : hr < 12 ? `${hr} AM` : hr === 12 ? '12 PM' : `${hr - 12} PM`);
  function timeLabel(iso) { return fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(':00', '').replace(' AM', 'am').replace(' PM', 'pm'); }
  function duration(ev) {
    const m = Math.round((Date.parse(ev.end) - Date.parse(ev.start)) / 60000);
    if (m <= 0) return '';
    if (m < 60) return `${m} min`;
    const hr = m / 60;
    return `${Number.isInteger(hr) ? hr : hr.toFixed(1)} hr`;
  }
  function dueLabel(task, today) {
    const k = task.due?.key;
    if (!k) return null;
    const d = diffDays(today, k);
    let text, cls = '';
    if (d < 0) { text = d === -1 ? 'Yesterday' : `${-d} days late`; cls = 'late'; }
    else if (d === 0) { text = 'Today'; cls = 'today'; }
    else if (d === 1) text = 'Tomorrow';
    else if (d < 7) text = fmtKey(k, { weekday: 'long' });
    else text = fmtKey(k, { month: 'short', day: 'numeric' });
    if (task.due.time) text += ' ' + timeLabel(task.due.time);
    return { text, cls };
  }

  // ---------- API ----------
  let freshUntil = 0; // set by the Refresh button: GETs bypass server / Notion / ICS caches until it finishes
  async function api(path, opts = {}) {
    if ((opts.method || 'GET') === 'GET' && Date.now() < freshUntil && !/[?&]fresh=1\b/.test(path)) path += (path.includes('?') ? '&' : '?') + 'fresh=1';
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const serverAsset = res.headers.get('X-Dayline-Asset');
    if (CLIENT_ASSET_V && serverAsset && serverAsset !== CLIENT_ASSET_V) {
      location.reload();
      throw new Error('Updating Dayline…');
    }
    if (res.status === 401) { location.replace('/login'); throw new Error('Not signed in'); }
    if (opts.method && opts.method !== 'GET') monthCache.clear(); // task writes change the calendar dots
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- toast ----------
  let toastTimer;
  // Flush pending edits when the tab is hidden/closed (replaces per-keystroke autosave).
  const hideHandlers = new Set();
  function onHide(fn) { hideHandlers.add(fn); }
  const flushEdits = (forget = false) => { for (const fn of hideHandlers) { try { fn(); } catch { /* ignore */ } } if (forget) hideHandlers.clear(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushEdits(); });
  window.addEventListener('pagehide', () => flushEdits());
  function toast(msg, action) {
    clearTimeout(toastTimer);
    fill(toastEl, h('span', null, msg), action ? h('button', { type: 'button', onclick: () => { hideToast(); action.fn(); } }, action.label) : null);
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, action ? 8000 : 3000);
  }
  function hideToast() { toastEl.hidden = true; }

  /** Centered yes/no dialog. Resolves true on confirm, false on cancel/Esc/backdrop. */
  function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, extra = null } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
      openSheet([
        h('h2', { id: 'sheetTitle' }, title || 'Confirm'),
        body ? (typeof body === 'string' ? h('p', { class: 'confirm-body' }, body) : body) : null,
        extra,
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => finish(false) }, 'Cancel'),
          h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, confirmLabel)),
      ], 'modal');
      document.addEventListener('keydown', onKey, { once: true });
    });
  }

  // ---------- shared pieces ----------
  function groupClass(ev) { return 'g-' + (ev.group || 'personal'); }
  const BDAY_RE = /\b(b-?day|birthday)\b/i;
  function calendarName(ev) { return ev.feed + (ev.alsoOn?.length ? ` · also on ${ev.alsoOn.join(', ')}` : ''); }

  function eventRow(ev, { compact = false, today = null } = {}) {
    const past = today && !ev.allDay && Date.parse(ev.end || ev.start) < nowMs();
    const when = ev.allDay ? h('div', { class: 'when' }, 'All day')
      : h('div', { class: 'when' }, timeLabel(ev.start), !compact && !ev.deadline && duration(ev) ? h('small', null, duration(ev)) : null);
    const sub = [ev.location, compact ? null : ev.feed].filter(Boolean).join(' · ');
    return h('li', { class: `ev ${groupClass(ev)}${ev.deadline ? ' deadline' : ''}${ev.canceled ? ' canceled' : ''}${past ? ' past' : ''}`, tabindex: '0', role: 'button',
      onclick: () => openEvent(ev), onkeydown: (e) => { if (e.key === 'Enter') openEvent(ev); } },
      when,
      h('div', { class: 'bar' }),
      h('div', { class: 'what' },
        h('div', { class: 'title' }, ev.course ? h('span', { class: 'course' }, ev.course) : null, ev.title),
        sub ? h('div', { class: 'sub' }, sub) : null,
        ev.prep ? h('div', { class: 'prep' }, ev.prep.title) : null));
  }

  function allDayChips(events) {
    if (!events.length) return null;
    return h('div', { class: 'allday' }, events.map((ev) => h('button', { type: 'button', class: `chip ${groupClass(ev)}${ev.deadline ? ' deadline' : ''}${ev.birthday ? ' birthday' : ''}`, onclick: () => openEvent(ev), title: calendarName(ev) },
      ev.deadline ? h('span', { class: 'flag' }, 'Due') : ev.birthday ? h('span', { class: 'bd-mark', 'aria-hidden': 'true' }, BDAY_RE.test(ev.title) ? '🎂' : '·') : h('span', { class: 'dot' }),
      h('span', { class: 't' }, ev.course ? `${ev.course} · ` : '', ev.title))));
  }

  // "Added by" (Notion select: Me | Bot). Rows you add in Dayline are "Me";
  // rows other assistants add should be "Bot". A subtle tag, plus a filter on Tasks, Jobs and Opportunities.
  const WHO = { Me: 'you', Bot: 'bot' };
  function whoTag(addedBy, { botOnly = false } = {}) {
    const k = WHO[addedBy];
    if (!k || (botOnly && k !== 'bot')) return null;
    return h('span', { class: `who ${k}`, title: k === 'bot' ? 'Added by a bot or assistant' : 'Added by you' }, k === 'bot' ? 'Bot' : 'You');
  }
  const whoOk = (pref) => (x) => !pref || pref === 'all' || WHO[x.addedBy] === pref;
  function whoFilter(list, value, onPick) {
    const n = (k) => (k === 'all' ? list.length : list.filter((x) => WHO[x.addedBy] === k).length);
    const sel = h('select', { class: 'who-filter', 'aria-label': 'Filter by who added it', title: 'Added by (Notion column)', onchange: () => onPick(sel.value) },
      [['all', 'By anyone'], ['you', 'By you'], ['bot', 'By bot']].map(([k, label]) => h('option', { value: k, selected: (value || 'all') === k }, `${label} (${n(k)})`)));
    return sel;
  }

  function taskRow(task, today, { showDue = true } = {}) {
    const li = h('li', { class: `task${task.done ? ' done' : ''}`, dataset: { id: task.id } });
    const check = h('button', { type: 'button', class: `check p-${task.priority || 'none'}`, 'aria-label': task.done ? `Mark "${task.name}" not done` : `Mark "${task.name}" done`, onclick: () => toggleDone(task, li) }, icon(ICON.check));
    li.append(check, h('div', { class: 'tbody', role: 'button', tabindex: '0', onclick: () => openTaskSheet(task), onkeydown: (e) => { if (e.key === 'Enter') openTaskSheet(task); } },
      h('div', { class: 'tname' }, task.name),
      h('div', { class: 'tmeta' },
        showDue ? dateTag(task, today) : null,
        task.area ? h('span', { class: `area a-${task.area}` }, task.area) : null,
        task.status === 'In progress' ? h('span', { class: 'prog' }, 'In progress') : null,
        task.priority ? h('span', { class: `prio ${task.priority}` }, task.priority) : null,
        whoTag(task.addedBy, { botOnly: true }), taskIcons(task))));
    return li;
  }

  /** Small calendar tag: "Overdue · Oct 2", "Today", "Tomorrow", "Tue Oct 6". */
  function dateTag(task, today) {
    const k = task.due?.key;
    if (!k) return null;
    const d = diffDays(today, k);
    const short = fmtKey(k, { month: 'short', day: 'numeric' });
    let text = fmtKey(k, { weekday: 'short' }) + ' ' + short, cls = '';
    if (task.done) text = short;
    else if (d < 0) { text = `Overdue · ${short}`; cls = 'late'; }
    else if (d === 0) { text = 'Today'; cls = 'today'; }
    else if (d === 1) text = 'Tomorrow';
    if (task.due.time) text += ' ' + timeLabel(task.due.time);
    return h('span', { class: `dtag ${cls}` }, icon(ICON.cal), text);
  }

  function banner(error, feeds) {
    const bad = (feeds || []).filter((f) => f.error);
    if (!error && !bad.length) return null;
    return h('div', { class: 'banner', role: 'status' }, bad.length ? `Couldn't refresh ${bad.map((f) => f.label).join(', ')}${bad.some((f) => f.stale) ? ' (showing the last copy)' : ''}.` : `Calendar problem: ${error}`);
  }
  const skeleton = () => [h('div', { class: 'skeleton', style: 'height:30px;width:55%' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'height:160px' })];

  // ---------- views ----------
  let current = { view: null, arg: null };
  let renderSeq = 0;

  async function render() {
    flushEdits(true); // save any open sticky/notes edit before the view is rebuilt
    const [view, arg] = (location.hash.replace(/^#/, '') || 'today').split('/');
    const v = ['today', 'week', 'tasks', 'jobs', 'opps', 'chats', 'classes', 'social'].includes(view) ? view : 'today';
    const changed = v !== current.view || arg !== current.arg;
    current = { view: v, arg };
    document.querySelectorAll('.nav-item[data-view]').forEach((a) => {
      a.classList.toggle('active', a.dataset.view === v);
    });
    document.querySelectorAll('.nav-item[data-view]').forEach((a) => (a.dataset.view === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    const tabFor = ['today', 'tasks', 'jobs', 'classes', 'chats'].includes(v) ? v : 'more';
    document.querySelectorAll('.tab[data-tab]').forEach((a) => { const on = a.dataset.tab === tabFor; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const seq = ++renderSeq;
    if (changed && !main.firstChild?.dataset?.view?.startsWith(v)) fill(main, h('div', { class: 'view' }, skeleton()));
    try {
      const views = { today: viewToday, week: viewWeek, tasks: viewTasks, jobs: viewJobs, opps: viewOpps, chats: viewChats, classes: viewClasses, social: viewSocial };
      const node = await views[v](arg);
      if (seq !== renderSeq) return;
      node.dataset.view = v;
      fill(main, node);
      if (node._afterMount) node._afterMount();
      document.title = `${{ today: 'Today', week: 'Week', tasks: 'Tasks', jobs: 'Jobs', opps: 'Opportunities', chats: 'Coffee chats', classes: 'Classes & activities', social: 'Socializing' }[v]} · Dayline`;
      return true;
    } catch (e) {
      if (seq !== renderSeq) return;
      fill(main, h('div', { class: 'view' }, h('div', { class: 'banner' }, e.message), h('button', { class: 'btn', type: 'button', onclick: render }, 'Try again')));
      return false;
    }
  }

  // ---------- Refresh (desktop page header + mobile top bar) ----------
  let lastUpdated = Date.now(), refreshing = false, refreshCtlEl = null;
  const refreshStamp = h('span', { class: 'refresh-stamp', 'aria-live': 'polite' });
  function paintStamp() {
    const s = Math.round((Date.now() - lastUpdated) / 1000);
    refreshStamp.textContent = refreshing ? 'Refreshing…' : s < 60 ? 'Updated just now' : s < 3600 ? `Updated ${Math.round(s / 60)} min ago` : `Updated ${new Date(lastUpdated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: me.tz })}`;
    refreshStamp.title = `Last refreshed ${new Date(lastUpdated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: me.tz })}`;
  }
  function refreshIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M19.5 12a7.5 7.5 0 0 1-12.9 5.2', 'M4.5 12a7.5 7.5 0 0 1 12.9-5.2', 'M17.6 3.3v3.9h-3.9', 'M6.4 20.7v-3.9h3.9']) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  function refreshCtl() {
    if (!refreshCtlEl) refreshCtlEl = h('div', { class: 'refresh-ctl' }, refreshStamp,
      h('button', { type: 'button', class: 'btn refresh-btn', 'aria-label': 'Refresh', title: 'Re-fetch from Notion and your calendars (R)', onclick: () => doRefresh() }, refreshIcon(), h('span', null, 'Refresh')));
    paintStamp();
    return refreshCtlEl;
  }
  async function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    document.documentElement.classList.add('is-refreshing');
    document.querySelectorAll('.refresh-btn, #mRefresh').forEach((b) => { b.setAttribute('aria-busy', 'true'); b.disabled = true; });
    paintStamp();
    freshUntil = Date.now() + 25000;
    monthCache.clear(); netAt = 0; thanksAt = 0; jobsData = null;
    let ok = false;
    try {
      me = Object.assign(me, await api('/api/me')); // a new deploy (asset version change) reloads the page right here
      ok = await render();
    } catch (e) { if (!/Updating Dayline/.test(e.message)) toast(e.message); }
    finally {
      freshUntil = 0; refreshing = false;
      document.documentElement.classList.remove('is-refreshing');
      document.querySelectorAll('.refresh-btn, #mRefresh').forEach((b) => { b.removeAttribute('aria-busy'); b.disabled = false; });
      if (ok) lastUpdated = Date.now();
      paintStamp();
    }
  }
  setInterval(paintStamp, 30000);

  function nextUpCard(n, today) {
    if (!n) return null;
    if (n.kind === 'task') {
      const t = n.task;
      return h('div', { class: 'next', style: '--g: var(--a-recruiting)', role: 'button', tabindex: '0', onclick: () => openTaskSheet(t) },
        h('div', { class: 'label', style: n.state === 'overdue' ? 'color:var(--danger)' : '' }, n.state === 'overdue' ? 'Overdue · top task' : 'Top task today'),
        h('div', { class: 'title' }, t.name),
        h('div', { class: 'meta' }, [t.area, t.priority && `${t.priority} priority`, dueLabel(t, today)?.text].filter(Boolean).join(' · ')));
    }
    const ev = n.event;
    const mins = n.minutes;
    const rel = n.state === 'now' ? 'Happening now' : mins < 1 ? 'Starting now' : mins < 60 ? `Next up · in ${mins} min` : `Next up · in ${Math.floor(mins / 60)} hr${mins % 60 >= 10 ? ` ${mins % 60} min` : ''}`;
    const timeText = n.kind === 'deadline' ? `Due ${timeLabel(ev.start)}` : `${timeLabel(ev.start)} – ${timeLabel(ev.end)}`;
    return h('div', { class: `next ${groupClass(ev)}`, role: 'button', tabindex: '0', onclick: () => openEvent(ev) },
      h('div', { class: 'label' }, n.state === 'now' ? h('span', { class: 'live' }) : null, n.kind === 'deadline' ? 'Next deadline' : rel),
      h('div', { class: 'title' }, ev.course ? h('span', { class: 'course' }, ev.course) : null, ev.title),
      h('div', { class: 'meta' }, [timeText, ev.location, ev.feed].filter(Boolean).join(' · ')),
      ev.prep ? h('div', { class: 'prep' }, `Canvas: ${ev.prep.title}`) : null);
  }


  // ---- Tasks: mini month calendar + date-grouped list ----
  const monthCache = new Map();
  let calMonth = null;     // 'YYYY-MM' shown in the mini calendar
  let dayFilter = null;    // 'YYYY-MM-DD' when a day is picked

  async function getMonth(month, fresh = false) {
    if (!fresh && monthCache.has(month) && Date.now() - monthCache.get(month).at < 60000) return monthCache.get(month).data;
    const data = await api(`/api/month?month=${month}`);
    monthCache.set(month, { at: Date.now(), data });
    return data;
  }

  function miniCalendar(m, today, { onPick = (key) => { dayFilter = dayFilter === key ? null : key; render(); }, selected = dayFilter } = {}) {
    const [y, mo] = m.month.split('-').map(Number);
    const title = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, mo - 1, 15)));
    const shift = (n) => { const d = new Date(Date.UTC(y, mo - 1 + n, 1)); calMonth = d.toISOString().slice(0, 7); render(); };
    const grid = h('div', { class: 'minical-grid', role: 'grid', 'aria-label': title },
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('div', { class: 'dow', 'aria-hidden': 'true' }, d)));
    for (let i = 0; i < 42; i++) {
      const key = addDays(m.gridStart, i);
      if (i >= 35 && key.slice(0, 7) !== m.month) break; // drop an all-next-month last row
      const c = m.days[key] || {};
      const dots = [];
      if (c.tasks) dots.push(h('i', { class: c.overdue ? 'd-od' : '' }));
      if (c.deadlines) dots.push(h('i', { class: 'd-dl' }));
      if (c.events) dots.push(h('i', { class: 'd-ev' }));
      const label = `${fmtKey(key, { weekday: 'long', month: 'long', day: 'numeric' })}: ${c.tasks || 0} tasks, ${c.events || 0} events${c.deadlines ? `, ${c.deadlines} deadlines` : ''}`;
      grid.append(h('button', {
        type: 'button', class: `mday${key.slice(0, 7) !== m.month ? ' out' : ''}${key === today ? ' is-today' : ''}${key < today ? ' past' : ''}`,
        'data-date': key, 'aria-pressed': String(selected === key), 'aria-label': label,
        onclick: () => onPick(key),
      }, h('span', { class: 'n' }, Number(key.slice(8))), h('span', { class: 'dots', 'aria-hidden': 'true' }, dots)));
    }
    return h('div', { class: 'minical' },
      h('div', { class: 'minical-head' },
        h('span', { class: 'mtitle' }, title),
        m.month !== today.slice(0, 7) ? h('button', { type: 'button', class: 'btn small', onclick: () => { calMonth = today.slice(0, 7); render(); } }, 'Today') : null,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon(ICON.left)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', onclick: () => shift(1) }, icon(ICON.right))),
      grid,
      h('div', { class: 'minical-legend', 'aria-hidden': 'true' }, h('span', null, h('i'), 'Tasks'), h('span', null, h('i', { class: 'd-dl' }), 'Deadlines'), h('span', null, h('i', { class: 'd-ev' }), 'Events')));
  }

  // ---------- writes ----------
  async function toggleDone(task, li) {
    const wasDone = task.done;
    const prevStatus = task.status;
    const next = wasDone ? 'Not started' : 'Done';
    li.classList.toggle('done', !wasDone);
    if (!wasDone && !prefs.showDone) setTimeout(() => li.classList.add('leaving'), 250);
    try {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status: next } });
      if (!wasDone) toast(`Done: ${truncate(task.name, 34)}`, { label: 'Undo', fn: () => updateTask(task.id, { status: prevStatus }, 'Restored') });
      else toast('Marked not done');
      setTimeout(render, wasDone ? 0 : 550);
    } catch (e) {
      li.classList.toggle('done', wasDone); li.classList.remove('leaving');
      toast(e.message);
    }
  }
  async function updateTask(id, patch, msg) {
    try { await api(`/api/tasks/${id}`, { method: 'PATCH', body: patch }); if (msg) toast(msg); render(); } catch (e) { toast(e.message); }
  }
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // ---------- sheets ----------
  let lastFocus = null;
  /** mode: 'modal' (centered dialog), 'panel' (right-hand side panel, optionally 'panel wide') or 'modal palette' (search). */
  function openSheet(children, mode = 'modal') {
    const flush = beforeClose; beforeClose = null; // opening another sheet first saves anything pending in the old one
    if (flush) { try { flush(); } catch { /* ignore */ } }
    lastFocus = sheet.hidden ? document.activeElement : lastFocus;
    sheet.className = 'sheet ' + mode;
    fill(sheet, h('button', { type: 'button', class: 'sheet-close', 'aria-label': 'Close', onclick: closeSheet }, '×'), ...children);
    sheet.hidden = false; backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    const first = sheet.querySelector('input:not([type]), input[type=text], input[type=url], input[type=search], textarea') || sheet.querySelector('button:not(.sheet-close), a') || sheet.querySelector('button');
    setTimeout(() => first && first.focus({ preventScroll: true }), 30);
  }
  let beforeClose = null; // panels with unsaved input flush it here
  function closeSheet() {
    flushEdits(true);
    const flush = beforeClose; beforeClose = null;
    if (flush) { try { flush(); } catch { /* ignore */ } }
    sheet.hidden = true; backdrop.hidden = true; sheet.replaceChildren(); sheet.className = 'sheet';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  function picker(name, options, value, onPick, render = (o) => o) {
    const wrap = h('div', { class: 'pick', role: 'group', 'aria-label': name });
    const buttons = options.map((o) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(o === value), onclick: () => {
        const nowOn = b.getAttribute('aria-pressed') !== 'true';
        buttons.forEach((x) => x.setAttribute('aria-pressed', 'false'));
        if (nowOn || name === 'Status') b.setAttribute('aria-pressed', 'true');
        onPick(nowOn || name === 'Status' ? o : null);
      } }, render(o));
      return b;
    });
    wrap.append(...buttons);
    return wrap;
  }

  // ---------- task notes & links ----------
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/gi;
  const cleanNotes = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n');
  const notesUrls = (s) => cleanNotes(s).match(URL_RE) || [];
  /** The link a 🔗 opens: the Link field, else the first URL typed in Notes. */
  const taskLink = (t) => t.link || notesUrls(t.notes)[0] || null;
  /** Text -> nodes with every http(s) URL turned into a link (built with DOM nodes, never innerHTML). */
  function linkify(text) {
    const out = [];
    let last = 0;
    text.replace(URL_RE, (m, off) => {
      if (off > last) out.push(text.slice(last, off));
      out.push(h('a', { href: m, target: '_blank', rel: 'noopener noreferrer', class: 'nlink' }, m));
      last = off + m.length;
      return m;
    });
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function taskIcons(task) {
    const link = taskLink(task);
    return [
      task.notes ? h('span', { class: 'ticon', title: truncate(cleanNotes(task.notes).replace(/\s+/g, ' ').trim(), 220), 'aria-label': 'Has notes' }, '📝') : null,
      link ? h('a', { class: 'ticon', href: link, target: '_blank', rel: 'noopener noreferrer', title: `Open ${link}`, 'aria-label': 'Open link in a new tab', onclick: (e) => e.stopPropagation() }, '🔗') : null,
    ];
  }
  let taskCaps = { notes: true, link: true }; // updated from /api/tasks

  // ---------- classes & activities (rules live in config/classes.js) ----------
  const classItems = () => me.classes || [];
  const classInfo = (opt) => classItems().find((c) => c.option === opt) || { key: null, option: opt, name: opt, kind: 'class', color: 'default' };
  /** Options to offer: configured ones that exist in Notion, plus any extra options added in Notion by hand. */
  function classOptions() {
    const known = classItems().map((c) => c.option);
    const inNotion = taskCaps.classOptions;
    if (!inNotion) return known;
    return [...known.filter((o) => inNotion.includes(o)), ...inNotion.filter((o) => !known.includes(o))];
  }
  function classTag(opt, { link = true } = {}) {
    const c = classInfo(opt);
    const attrs = { class: `ctag c-${c.color || 'default'}`, title: c.name !== c.option ? `${c.option} · ${c.name}` : c.name };
    if (link && c.key) return h('a', { ...attrs, href: `#classes/${c.key}`, onclick: (e) => e.stopPropagation() }, c.option);
    return h('span', attrs, c.option);
  }
  const classTags = (task) => (task.classes || []).map((o) => classTag(o));
  /** Toggle buttons, grouped Classes / Activities. onChange gets the new list. */
  function classPicker(selected, onChange) {
    const set = new Set(selected || []);
    const opts = classOptions();
    for (const o of set) if (!opts.includes(o)) opts.push(o);
    const btn = (o) => {
      const c = classInfo(o);
      const b = h('button', { type: 'button', class: `cpick c-${c.color || 'default'}`, 'aria-pressed': String(set.has(o)), title: c.name,
        onclick: () => { if (set.has(o)) set.delete(o); else set.add(o); b.setAttribute('aria-pressed', String(set.has(o))); onChange(opts.filter((x) => set.has(x))); } }, o);
      return b;
    };
    const group = (kind, label) => { const list = opts.filter((o) => classInfo(o).kind === kind); return list.length ? h('div', { class: 'cpick-group' }, h('span', { class: 'cpick-label' }, label), list.map(btn)) : null; };
    return h('div', { class: 'cpicker', role: 'group', 'aria-label': 'Class / Activity' }, group('class', 'Classes'), group('activity', 'Activities'));
  }
  const clsOk = (k) => (t) => (!k || k === 'all' ? true : k === 'none' ? !(t.classes || []).length : (t.classes || []).includes(k));
  function classFilter(list, value, onPick) {
    if (!taskCaps.classes) return null;
    const opts = classOptions();
    const v = value === 'none' || opts.includes(value) ? value : 'all';
    const n = (k) => list.filter(clsOk(k)).length;
    const opt = (k, label) => h('option', { value: k, selected: v === k }, `${label} (${n(k)})`);
    const grp = (kind, label) => { const l = opts.filter((o) => classInfo(o).kind === kind); return l.length ? h('optgroup', { label }, l.map((o) => opt(o, o))) : null; };
    const sel = h('select', { class: 'who-filter cls-filter', 'aria-label': 'Filter by class or activity', title: 'Class / Activity (Notion column)', onchange: () => onPick(sel.value) },
      opt('all', 'Any class / activity'), grp('class', 'Classes'), grp('activity', 'Activities'), opt('none', 'No class / activity'));
    return sel;
  }

  /** Right-side detail panel for an existing task. Every field saves on its own (no Save button). */
  function openTaskDetail(task) {
    const today = me.today || todayKey();
    const t = { ...task };
    const state = h('span', { class: 'save-state', 'aria-live': 'polite' });
    const setState = (cls, text) => { state.className = `save-state ${cls}`; state.textContent = text; };
    let chain = Promise.resolve();
    let pending = 0;
    let refresh = null;
    function save(patch) {
      pending += 1; setState('saving', 'Saving…');
      chain = chain.then(async () => {
        try {
          const saved = await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: patch });
          Object.assign(t, saved); Object.assign(task, saved);
          pending -= 1;
          if (!pending) setState('ok', 'Saved');
          if ('link' in patch) showLink();
          clearTimeout(refresh); refresh = setTimeout(render, 250); // refresh the list behind the panel
        } catch (e) { pending -= 1; setState('err', `Couldn't save: ${e.message}`); }
      });
      return chain;
    }

    // Name: saves on blur or Enter
    const nameInput = h('input', { type: 'text', class: 'text-input', id: 'taskName', value: t.name, maxlength: '300', autocomplete: 'off', 'aria-label': 'Task name' });
    const saveName = () => { const v = nameInput.value.trim().replace(/\s+/g, ' '); if (!v) { nameInput.value = t.name; return; } if (v !== t.name) save({ name: v }); };
    nameInput.addEventListener('blur', saveName);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });

    // Due
    const timedDue = t.due?.time;
    const quick = [['Today', today], ['Tomorrow', addDays(today, 1)], ['Next Mon', addDays(weekStart(today), 7)]];
    const dateInput = h('input', { type: 'date', 'aria-label': 'Due date', value: t.due?.key || '' });
    const dueBtns = quick.map(([label, key]) => h('button', { type: 'button', 'aria-pressed': String(t.due?.key === key), dataset: { key }, onclick: () => setDue(t.due?.key === key ? null : key) }, label));
    const noneBtn = h('button', { type: 'button', 'aria-pressed': String(!t.due?.key), onclick: () => setDue(null) }, 'None');
    function setDue(key) {
      dateInput.value = key || '';
      dueBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));
      noneBtn.setAttribute('aria-pressed', String(!key));
      if (key !== (t.due?.key || null)) save({ due: key });
    }
    dateInput.addEventListener('change', () => setDue(dateInput.value || null));

    // Notes: shown with clickable links; click the text (not a link) to edit. Saves on blur / page hide (15s idle as a
    // safety net) rather than every pause, so editing makes one Notion update instead of a stream of them.
    const notesWrap = h('div', { class: 'notes-field' });
    const ta = h('textarea', { class: 'text-input notes-input', id: 'taskNotes', rows: '7', maxlength: '20000', placeholder: 'Type notes, paste links to your apps…', 'aria-label': 'Notes' });
    ta.value = cleanNotes(t.notes);
    let savedNotes = ta.value;
    let notesTimer = null;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(420, Math.max(150, ta.scrollHeight + 2)) + 'px'; };
    const saveNotes = () => { clearTimeout(notesTimer); notesTimer = null; if (ta.value === savedNotes) return; savedNotes = ta.value; save({ notes: ta.value }); };
    ta.addEventListener('input', () => { setState('dirty', 'Editing…'); clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 15000); grow(); });
    onHide(saveNotes);
    ta.addEventListener('blur', () => { saveNotes(); showNotes(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); } });
    const notesView = h('div', { class: 'notes-view', tabindex: '0', role: 'button', 'aria-label': 'Edit notes', title: 'Click to edit',
      onclick: (e) => { if (!e.target.closest('a')) editNotes(); }, onkeydown: (e) => { if (e.key === 'Enter' && !e.target.closest('a')) { e.preventDefault(); editNotes(); } } });
    function showNotes() {
      if (!ta.value.trim()) { fill(notesWrap, ta); grow(); return; }
      fill(notesView, linkify(ta.value));
      fill(notesWrap, notesView);
    }
    function editNotes() { fill(notesWrap, ta); grow(); ta.focus(); }
    showNotes();

    // Link + Open
    const linkInput = h('input', { type: 'url', class: 'text-input', id: 'taskLink', value: t.link || '', placeholder: 'https://… (an app, doc or site)', maxlength: '2000', autocomplete: 'off', 'aria-label': 'Link' });
    const openBtn = h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗');
    function showLink() {
      if (document.activeElement !== linkInput) linkInput.value = t.link || '';
      if (t.link) { openBtn.href = t.link; openBtn.removeAttribute('aria-disabled'); } else { openBtn.removeAttribute('href'); openBtn.setAttribute('aria-disabled', 'true'); }
    }
    const saveLink = () => { const v = linkInput.value.trim(); if (v === (t.link || '')) return; save({ link: v }); };
    linkInput.addEventListener('change', saveLink);
    linkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); linkInput.blur(); } });
    showLink();
    const isThanks = /dayline-thanks:/.test(task.notes || '');
    openSheet([
      h('div', { class: 'detail-head' }, h('div', { class: 'eyebrow' }, 'Task'), state),
      h('div', { class: 'field' }, nameInput),
      isThanks && task.status !== 'Done' ? h('div', { class: 'thank-cta' }, h('span', null, 'You added this from a Dayline thank-you reminder.'), h('button', { type: 'button', class: 'btn small primary', onclick: () => openThankYouDrafts({ taskId: task.id }) }, 'Draft thank-you email')) : null,
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Status'), picker('Status', STATUSES, t.status, (v) => { if (v && v !== t.status) save({ status: v }).then(() => { if (v === 'Done') toast('Marked done'); }); })),
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Due', timedDue ? h('span', { class: 'flabel-note' }, ` (set in Notion for ${timeLabel(t.due.time)})`) : null), h('div', { class: 'pick' }, dueBtns, noneBtn, dateInput)),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Area'), picker('Area', AREAS, t.area, (v) => save({ area: v }), (a) => [h('span', { class: `area a-${a}` }), a])),
        h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Priority'), picker('Priority', PRIORITIES, t.priority, (v) => save({ priority: v })))),
      taskCaps.classes ? h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Class / Activity'), classPicker(t.classes, (v) => save({ classes: v }))) : null,
      taskCaps.link ? h('div', { class: 'field' }, h('label', { for: 'taskLink' }, 'Link'), h('div', { class: 'link-row' }, linkInput, openBtn)) : null,
      taskCaps.notes ? h('div', { class: 'field' }, h('label', { for: 'taskNotes' }, 'Notes', h('span', { class: 'flabel-note' }, ' · links are clickable · saves automatically')), notesWrap,
        t.notesRich ? h('p', { class: 'hint' }, 'This note has Notion formatting. Editing it here saves it as plain text.') : null) : null,
      h('div', { class: 'detail-foot' },
        task.url && me.mode !== 'fixture' ? h('a', { class: 'open-link', href: task.url, target: '_blank', rel: 'noopener' }, 'Open in Notion ↗') : h('span'),
        h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Done')),
    ], 'panel');
    beforeClose = () => { if (document.activeElement === nameInput) saveName(); if (document.activeElement === linkInput) saveLink(); saveNotes(); };
  }

  function openTaskSheet(task, defaults = {}) {
    if (task) return openTaskDetail(task);
    const editing = !!task;
    const today = me.today || todayKey();
    const state = editing
      ? { name: task.name, area: task.area, priority: task.priority, due: task.due?.key || null, status: task.status }
      : { name: '', area: prefs.area !== 'All' ? prefs.area : null, priority: null, due: defaults.due || null, status: 'Not started', classes: defaults.classes || [] };
    const timedDue = editing && task.due?.time; // Notion datetimes: keep the time unless the date is changed

    const nameInput = h('input', { type: 'text', class: 'text-input', id: 'taskName', value: state.name, placeholder: 'What needs doing?', maxlength: '300', autocomplete: 'off', enterkeyhint: 'done' });
    const errEl = h('p', { class: 'form-error', role: 'alert', hidden: true });

    // Due: quick chips + date input
    const quick = [['Today', today], ['Tomorrow', addDays(today, 1)], ['Next Mon', addDays(weekStart(today), 7)]];
    const dateInput = h('input', { type: 'date', 'aria-label': 'Due date', value: state.due || '' });
    const dueBtns = quick.map(([label, key]) => h('button', { type: 'button', 'aria-pressed': String(state.due === key), dataset: { key }, onclick: () => setDue(state.due === key ? null : key) }, label));
    const noneBtn = h('button', { type: 'button', 'aria-pressed': String(!state.due), onclick: () => setDue(null) }, 'None');
    function setDue(key) {
      state.due = key;
      dateInput.value = key || '';
      dueBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));
      noneBtn.setAttribute('aria-pressed', String(!key));
    }
    dateInput.addEventListener('change', () => setDue(dateInput.value || null));

    const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, editing ? 'Save' : 'Add task');
    const newLink = !editing && taskCaps.link ? h('input', { type: 'url', class: 'text-input', id: 'newTaskLink', placeholder: 'https://… (an app, doc or site)', maxlength: '2000', autocomplete: 'off' }) : null;
    const newNotes = !editing && taskCaps.notes ? h('textarea', { class: 'text-input notes-input', id: 'newTaskNotes', rows: '4', maxlength: '20000', placeholder: 'Anything to remember. Links become clickable.' }) : null;
    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      state.name = nameInput.value.trim();
      if (!state.name) { errEl.textContent = 'Give the task a name.'; errEl.hidden = false; nameInput.focus(); return; }
      saveBtn.disabled = true; errEl.hidden = true;
      try {
        if (editing) {
          const patch = {};
          if (state.name !== task.name) patch.name = state.name;
          if (state.status !== task.status) patch.status = state.status;
          if (state.area !== task.area) patch.area = state.area;
          if (state.priority !== task.priority) patch.priority = state.priority;
          if (state.due !== (task.due?.key || null)) patch.due = state.due;
          if (!Object.keys(patch).length) { closeSheet(); return; }
          await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: patch });
          closeSheet(); toast('Saved'); render();
        } else {
          const body = { name: state.name };
          if (state.area) body.area = state.area;
          if (state.priority) body.priority = state.priority;
          if (state.due) body.due = state.due;
          if (newNotes && newNotes.value.trim()) body.notes = newNotes.value;
          if (newLink && newLink.value.trim()) body.link = newLink.value.trim();
          if (taskCaps.classes && state.classes.length) body.classes = state.classes;
          await api('/api/tasks', { method: 'POST', body });
          closeSheet(); toast('Task added'); render();
        }
      } catch (err) { errEl.textContent = err.message; errEl.hidden = false; saveBtn.disabled = false; }
    } },
      h('h2', { id: 'sheetTitle' }, editing ? 'Edit task' : 'New task'),
      h('div', { class: 'field' }, h('label', { for: 'taskName' }, 'Task'), nameInput),
      editing ? h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Status'), picker('Status', STATUSES, state.status, (v) => { state.status = v; })) : null,
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Area'), picker('Area', AREAS, state.area, (v) => { state.area = v; }, (a) => [h('span', { class: `area a-${a}` }), a])),
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Priority'), picker('Priority', PRIORITIES, state.priority, (v) => { state.priority = v; })),
      !editing && taskCaps.classes ? h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Class / Activity ', h('span', { class: 'flabel-note' }, '(optional)')), classPicker(state.classes, (v) => { state.classes = v; })) : null,
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Due', timedDue ? h('span', { style: 'text-transform:none;letter-spacing:0;font-weight:500' }, ` (set in Notion for ${timeLabel(task.due.time)})`) : null),
        h('div', { class: 'pick' }, dueBtns, noneBtn, dateInput)),
      newLink ? h('div', { class: 'field' }, h('label', { for: 'newTaskLink' }, 'Link ', h('span', { class: 'flabel-note' }, '(optional)')), newLink) : null,
      newNotes ? h('div', { class: 'field' }, h('label', { for: 'newTaskNotes' }, 'Notes ', h('span', { class: 'flabel-note' }, '(optional)')), newNotes) : null,
      errEl,
      h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), saveBtn),
      editing && task.url && me.mode !== 'fixture' ? h('a', { class: 'open-link', href: task.url, target: '_blank', rel: 'noopener' }, 'Open in Notion ↗') : null);
    openSheet([form], 'panel');
  }

  function openEvent(ev) {
    const when = ev.allDay
      ? (ev.startKey === ev.endKey ? fmtKey(ev.startKey, { weekday: 'long', month: 'long', day: 'numeric' }) : `${fmtKey(ev.startKey, { month: 'short', day: 'numeric' })} – ${fmtKey(ev.endKey, { month: 'short', day: 'numeric' })}`)
      : `${fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ev.start))} · ${ev.deadline ? 'due ' + timeLabel(ev.start) : `${timeLabel(ev.start)} – ${timeLabel(ev.end)}`}`;
    const safeUrl = ev.url && /^https:\/\//i.test(ev.url) ? ev.url : null;
    openSheet([
      h('div', { class: `next ${groupClass(ev)}`, style: 'box-shadow:none' },
        h('div', { class: 'label' }, ev.deadline ? 'Deadline' : GROUP_LABEL[ev.group] || 'Event', ev.recurring ? ' · repeats' : '', ev.canceled ? ' · canceled' : ''),
        h('h2', { id: 'sheetTitle', class: 'title', style: 'margin:4px 0 3px' }, ev.course ? h('span', { class: 'course' }, ev.course) : null, ev.title),
        h('div', { class: 'meta' }, when)),
      h('div', { style: 'padding:12px 2px 4px;font-size:14.5px;display:grid;gap:6px' },
        ev.location ? h('div', null, h('span', { class: 'muted' }, 'Where  '), ev.location) : null,
        h('div', null, h('span', { class: 'muted' }, 'Calendar  '), calendarName(ev)),
        ev.prep ? h('div', null, h('span', { class: 'muted' }, 'Canvas  '), ev.prep.title) : null),
      ev.description ? h('div', { class: 'notes', style: 'margin-top:8px' }, ev.description) : null,
      h('div', { class: 'sheet-actions', style: 'margin-top:14px' },
        safeUrl ? h('a', { class: 'btn', href: safeUrl, target: '_blank', rel: 'noopener', style: 'text-align:center;text-decoration:none' }, 'Open link ↗') : null,
        h('button', { type: 'button', class: 'btn primary', onclick: closeSheet }, 'Close')),
    ]);
  }

  async function openMenu() {
    let status = { feeds: [], mode: me.mode };
    try { status = await api('/api/status'); } catch { /* shown as empty */ }
    openSheet([
      h('h2', { id: 'sheetTitle' }, 'Sources'),
      h('ul', { class: 'sources' },
        h('li', null, h('span', { class: 'area a-School' }), 'Notion · To Do', h('span', { class: 'state' }, status.mode === 'fixture' ? 'sample copy' : 'connected')),
        status.feeds.map((f) => h('li', { class: `g-${f.group}` }, h('span', { class: 'dot' }), f.label,
          h('span', { class: `state${f.error ? ' bad' : ''}` }, f.error ? (f.stale ? `stale · ${f.error}` : f.error) : f.fetchedAt ? `updated ${timeLabel(f.fetchedAt)}` : 'not loaded yet')))),
      status.mode === 'fixture' ? h('p', { class: 'muted', style: 'font-size:13.5px;margin:0 0 14px' }, 'Fixture mode: this is a snapshot of your data. Changes stay on this computer and never reach Notion.') : null,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn', onclick: async () => { await api('/api/logout', { method: 'POST', body: {} }).catch(() => {}); location.replace('/login'); } }, 'Sign out'),
        h('button', { type: 'button', class: 'btn primary', onclick: closeSheet }, 'Close')),
    ]);
  }

  // ---------- Jobs tracker + Opportunities (Notion "Pipeline" database) ----------
  let jobsData = null;
  const jobPrefs = Object.assign({ oppTrack: 'All', oppBay: false, oppSort: 'fit' }, safeJson(localStorage.getItem('dayline.jobPrefs')));
  const saveJobPrefs = () => localStorage.setItem('dayline.jobPrefs', JSON.stringify(jobPrefs));
  const STATUS_LABEL = { Opportunity: 'Opportunity', Interested: 'Interested', Applied: 'Applied', Interviewing: 'Interviewing', Offer: 'Offer', Closed: 'Closed' };
  const BOARD_ORDER = ['Interested', 'Applied', 'Interviewing', 'Offer', 'Closed'];
  // Interviewing is split into rounds (Notion "Interview round" select). Rounds are still "applied" for deadline styling.
  const ROUNDS = ['Recruiter screen', 'First round', 'Second round', 'Final round'];
  const roundsOn = () => !!jobsData?.caps?.round;
  const statusText = (j) => (j.status === 'Interviewing' && j.round && roundsOn() ? j.round : STATUS_LABEL[j.status] || j.status);
  const jobPill = (j) => h('span', { class: `pill st-${j.status}`, title: j.status === 'Interviewing' && j.round ? `Interviewing · ${j.round}` : null }, statusText(j));
  async function loadJobs() { jobsData = await api('/api/jobs'); return jobsData; }
  const shortDate = (k) => fmtKey(k, { month: 'short', day: 'numeric' });
  const pill = (status) => h('span', { class: `pill st-${status}` }, STATUS_LABEL[status] || status);

  /** Overdue deadlines: bold red only for Researching/Interested (not yet applied). Applied+ get a quiet muted chip. */
  function deadlineBit(k, today, status) {
    if (!k) return null;
    const d = diffDays(today, k);
    const preApply = status === 'Opportunity' || status === 'Interested' || !status;
    const postApply = status === 'Applied' || status === 'Interviewing' || status === 'Offer' || status === 'Closed';
    if (d < 0) {
      // Bold red only before the user has applied. Applied+ always quiet gray (even if status is unexpected).
      if (postApply || !preApply) return h('span', { class: 'dl-passed', title: 'Application deadline has passed' }, `Deadline passed · ${shortDate(k)}`);
      return h('span', { class: 'late' }, `Deadline passed ${shortDate(k)}`);
    }
    return h('span', { class: d <= 7 ? 'soon' : '' }, d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due ${shortDate(k)}`);
  }
  function jobCard(job, today) {
    const watching = !job.url || /\(watch\)/i.test(job.role);
    const canRemove = job.status !== 'Opportunity' && job.status !== 'Closed';
    const removeBtn = canRemove ? h('button', {
      type: 'button', class: 'jcard-remove', title: 'Remove from board', 'aria-label': `Remove ${job.company || job.role} from board`,
      onclick: (e) => { e.stopPropagation(); e.preventDefault(); removeJobFromBoard(job); },
    }, 'Remove') : null;
    // div (not nested button) so the Remove control is a real button on the card
    const card = h('div', {
      class: 'jcard', role: 'button', tabindex: '0',
      onclick: () => openJobSheet(job),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openJobSheet(job); } },
    },
      h('div', { class: 'jtop' }, h('span', { class: 'jco' }, job.company || 'Company?', whoTag(job.addedBy)), h('span', { class: 'jtop-right' }, jobPill(job), removeBtn)),
      h('div', { class: 'jrole' }, job.role),
      h('div', { class: 'jmeta' },
        job.location ? h('span', null, job.location) : null,
        job.track ? h('span', null, job.track) : null,
        job.applied ? h('span', null, `Applied ${shortDate(job.applied)}`) : null,
        job.interview ? h('span', { class: 'soon' }, `Interview ${shortDate(job.interview)}`) : null,
        job.status !== 'Closed' ? deadlineBit(job.deadline, today, job.status) : null,
        watching && job.status === 'Opportunity' ? h('span', { class: 'watch' }, 'Watching') : null),
      job.nextAction && job.status !== 'Closed' ? h('div', { class: 'jnext' }, h('b', null, 'Next: '), job.nextAction, job.nextDate ? ` · ${shortDate(job.nextDate)}` : '') : null,
      jobNetRow(job));
    return card;
  }

  async function moveToTracker(job) {
    try {
      await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { status: 'Interested' } });
      toast(`${job.company || 'Role'} moved to tracker`, { label: 'Undo', fn: () => updateJob(job.id, { status: 'Opportunity' }, 'Moved back') });
      render();
    } catch (e) { toast(e.message); }
  }
  async function updateJob(id, patch, msg) {
    try { await api(`/api/jobs/${id}`, { method: 'PATCH', body: patch }); if (msg) toast(msg); render(); } catch (e) { toast(e.message); }
  }
  async function removeJobFromBoard(job) {
    const prev = { status: job.status };
    const ok = await confirmDialog({
      title: 'Remove from board?',
      body: `“${job.company || 'This role'} · ${job.role}” will be marked Closed in Notion and hidden from the board (turn on “Show closed” to see it again).`,
      confirmLabel: 'Remove',
      danger: true,
      extra: h('p', { class: 'hint' }, 'Closed is also used for rejected roles. This does not delete the Notion page.'),
    });
    if (!ok) return;
    try {
      await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { status: 'Closed' } });
      closeSheet();
      toast('Removed from board (Closed)', { label: 'Undo', fn: () => updateJob(job.id, prev, 'Restored') });
      render();
    } catch (e) { toast(e.message); }
  }
  async function archiveJobPermanently(job) {
    const ok1 = await confirmDialog({
      title: 'Archive in Notion?',
      body: `This archives the Notion page for “${job.company || 'This role'} · ${job.role}”. You can restore it from Notion’s trash. Prefer “Remove from board” (Closed) unless you really want it gone.`,
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!ok1) return;
    const ok2 = await confirmDialog({
      title: 'Really archive this page?',
      body: 'Last chance. Dayline will call Notion’s archive — not a soft Closed. This cannot be undone from Dayline.',
      confirmLabel: 'Archive permanently',
      danger: true,
    });
    if (!ok2) return;
    try {
      await api(`/api/jobs/${job.id}?mode=archive`, { method: 'DELETE', body: {} });
      closeSheet();
      toast('Archived in Notion');
      render();
    } catch (e) { toast(e.message); }
  }

  // ---- Add from URL ----
  const SOURCE_NOTE = { 'json-ld': 'Read from the posting’s structured data', 'greenhouse-api': 'Read from Greenhouse’s public job API', 'lever-api': 'Read from Lever’s public job API', gemini: 'Read by AI (Gemini)', meta: 'Read from the page title and text', text: 'Read from the pasted text' };
  function openAddJob(kind) {
    const isOpp = kind === 'opp';
    const urlInput = h('input', { type: 'url', class: 'text-input', id: 'jobUrl', placeholder: 'https://… job posting link', autocomplete: 'off', inputmode: 'url', enterkeyhint: 'go' });
    const status = h('div', { class: 'hint', role: 'status' });
    const pasteArea = h('textarea', { class: 'textarea', placeholder: 'Paste the job description here…', 'aria-label': 'Job description' });
    const pasteBox = h('div', { class: 'field', hidden: true }, h('label', null, 'Job description'), pasteArea,
      h('div', { class: 'sheet-actions', style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn primary', onclick: () => run({ text: pasteArea.value, url: urlInput.value.trim() }) }, 'Read description')));
    const fetchBtn = h('button', { type: 'submit', class: 'btn primary' }, 'Fetch');
    async function run(body) {
      fill(status, h('span', { class: 'spinner' }), body.text ? 'Reading the description…' : 'Reading the posting…');
      fetchBtn.disabled = true;
      try {
        const r = await api('/api/jobs/parse', { method: 'POST', body });
        openJobForm({ kind, parsed: r });
      } catch (e) {
        fetchBtn.disabled = false;
        fill(status, h('span', { style: 'color:var(--danger)' }, e.message));
        if (/paste/i.test(e.message)) { pasteBox.hidden = false; pasteArea.focus(); }
      }
    }
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); const u = urlInput.value.trim(); if (!u) { urlInput.focus(); return; } run({ url: u }); } },
      h('h2', { id: 'sheetTitle' }, isOpp ? 'Add an opportunity' : 'Add a job'),
      h('div', { class: 'field' }, h('label', { for: 'jobUrl' }, 'Job posting link'), h('div', { class: 'url-row' }, urlInput, fetchBtn), status,
        h('div', { class: 'hint' }, 'Works best with Greenhouse, Lever, Ashby, Workday and most company career sites. Nothing is saved until you review it.')),
      pasteBox,
      h('div', { class: 'alt-links' },
        h('button', { type: 'button', class: 'linkish', onclick: () => { pasteBox.hidden = false; pasteArea.focus(); } }, 'Paste description instead'),
        h('button', { type: 'button', class: 'linkish', onclick: () => openJobForm({ kind }) }, 'Enter manually')));
    openSheet([form], 'panel wide');
  }


  function resumeTipsEligible(status) { return ['Interested', 'Applied', 'Interviewing'].includes(status); }
  function resumeTipsPanel(job) {
    if (!job || !resumeTipsEligible(job.status)) return null;
    const body = h('div', { class: 'rtips-body' });
    const headBtn = h('button', { type: 'button', class: 'btn small' }, 'Generate');
    let open = false;
    let loaded = null;
    const paintLoaded = (r) => {
      loaded = r;
      headBtn.textContent = 'Refresh';
      if (!r?.suggestions?.length) { fill(body, h('p', { class: 'hint' }, 'No suggestions yet.')); return; }
      fill(body,
        h('p', { class: 'hint' }, r.note || 'Copy what you like — nothing is written to your resume file.', r.cached ? ' · cached' : '', r.model ? ` · ${r.model}` : ''),
        h('ul', { class: 'rtips-list' }, r.suggestions.map((sug) => {
          const copyBtn = h('button', { type: 'button', class: 'btn small', onclick: async () => {
            try { await navigator.clipboard.writeText(sug.rewritten); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200); }
            catch { copyBtn.textContent = 'Select & copy'; }
          } }, 'Copy');
          return h('li', { class: 'rtip' },
            h('div', { class: 'rtip-ctx' }, sug.context || 'Resume bullet'),
            sug.original ? h('div', { class: 'rtip-orig' }, sug.original) : null,
            h('div', { class: 'rtip-new' }, sug.rewritten),
            h('div', { class: 'rtip-why' }, sug.why),
            h('div', { class: 'rtip-actions' }, copyBtn));
        })),
      );
    };
    const load = async (refresh) => {
      fill(body, h('div', { class: 'hint' }, h('span', { class: 'spinner' }), refresh ? 'Refreshing suggestions…' : 'Generating suggestions…'));
      headBtn.disabled = true;
      try {
        const r = await api(`/api/jobs/${job.id}/resume-tips`, { method: 'POST', body: { refresh: !!refresh } });
        paintLoaded(r);
      } catch (e) { fill(body, h('p', { class: 'form-error', role: 'alert' }, e.message)); }
      finally { headBtn.disabled = false; }
    };
    headBtn.onclick = () => { if (!open) { open = true; wrap.classList.add('open'); load(false); } else load(true); };
    const wrap = h('div', { class: 'rtips' },
      h('div', { class: 'rtips-head' },
        h('button', { type: 'button', class: 'rtips-toggle', 'aria-expanded': 'false', onclick: () => {
          open = !open; wrap.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open));
          if (open && !loaded) load(false);
        } }, 'Resume tips for this role'),
        headBtn),
      body);
    const toggle = wrap.querySelector('.rtips-toggle');
    return wrap;
  }

  /** Review/edit form. job = existing row (edit); parsed = /api/jobs/parse result (new). */
  function openJobForm({ kind = 'job', job = null, parsed = null }) {
    const caps = jobsData?.caps || { applied: true, nextDate: true, interested: true };
    const opts = jobsData?.options || {};
    const f = parsed?.fields || {};
    const editing = !!job;
    const today = me.today || todayKey();
    const state = editing ? { ...job } : {
      role: f.role || '', company: f.company || '', url: f.url || '', location: f.location || null, track: f.track || null, source: f.source || null,
      deadline: f.deadline || null, status: kind === 'opp' ? 'Opportunity' : 'Interested', priority: null, fit: null,
      applied: null, nextAction: kind === 'opp' ? 'Review JD + decide apply' : '', nextDate: null, notes: parsed?.notes || '', interview: null,
    };
    const input = (key, attrs = {}) => {
      const el = h('input', { class: 'text-input', value: state[key] ?? '', id: `jf-${key}`, autocomplete: 'off', ...attrs });
      el.addEventListener('input', () => { state[key] = el.value; });
      return el;
    };
    const dateInput = (key) => {
      const el = h('input', { type: 'date', class: 'text-input', value: state[key] || '', id: `jf-${key}` });
      el.addEventListener('change', () => { state[key] = el.value || null; });
      return el;
    };
    const statuses = editing ? opts.allStatuses || ['Opportunity', ...BOARD_ORDER] : kind === 'opp' ? ['Opportunity'] : BOARD_ORDER;
    const statusPicker = picker('Status', statuses, state.status, (v) => { state.status = v; roundField.hidden = v !== 'Interviewing' || !caps.round; if (v === 'Interviewing' && caps.round && !state.round) { state.round = ROUNDS[0]; fill(roundPickHost, roundPicker()); } appliedField.hidden = !caps.applied || ['Opportunity', 'Interested'].includes(v); if (v === 'Applied' && !state.applied && caps.applied) { state.applied = today; appliedInput.value = today; } }, (s) => STATUS_LABEL[s]);
    const appliedInput = dateInput('applied');
    const roundPicker = () => picker('Interview round', ROUNDS, state.round, (v) => { state.round = v; });
    const roundPickHost = h('div', null, roundPicker());
    const roundField = h('div', { class: 'field round-field', hidden: state.status !== 'Interviewing' || !caps.round },
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Interview round'), roundPickHost),
        h('div', { class: 'field' }, h('label', { for: 'jf-interview' }, 'Interview date (this round)'), dateInput('interview'))));
    const appliedField = h('div', { class: 'field', hidden: !caps.applied || ['Opportunity', 'Interested'].includes(state.status) }, h('label', { for: 'jf-applied' }, 'Date applied'), appliedInput);
    const notes = h('textarea', { class: 'textarea', id: 'jf-notes' }, state.notes || '');
    notes.addEventListener('input', () => { state.notes = notes.value; });
    const errEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, editing ? 'Save' : kind === 'opp' ? 'Add opportunity' : 'Add to tracker');

    const banner = parsed ? h('div', { class: `parsed-banner${parsed.warnings?.length || parsed.duplicate ? ' warn' : ''}` },
      h('div', null, h('b', null, SOURCE_NOTE[parsed.source] || 'Read from the page'), parsed.model ? ` (${parsed.model})` : '', '. Check everything before saving.',
        parsed.duplicate ? h('div', null, `Already in your Pipeline: ${parsed.duplicate.company} · ${parsed.duplicate.role} (${STATUS_LABEL[parsed.duplicate.status]}).`) : null,
        parsed.warnings?.length ? h('ul', null, parsed.warnings.map((w) => h('li', null, w))) : null)) : null;
    const extra = parsed && (f.salary || f.postedDate || f.locationText || f.requirements?.length) ? h('div', { class: 'field' },
      h('div', { class: 'flabel' }, 'From the posting'),
      h('div', { class: 'notes', style: 'max-height:none;color:var(--ink)' },
        [f.locationText && `📍 ${f.locationText}`, f.salary && `💵 ${f.salary}`, f.postedDate && `Posted ${shortDate(f.postedDate)}`].filter(Boolean).join('   '),
        f.summary ? h('div', { style: 'margin-top:6px;color:var(--muted)' }, f.summary) : null,
        f.requirements?.length ? h('ul', { class: 'req-list', style: 'margin-top:6px' }, f.requirements.map((r) => h('li', null, r))) : null),
      h('div', { class: 'hint' }, 'This is also saved into Notes below (Notion has no columns for pay, summary or requirements).')) : null;

    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!String(state.role || '').trim()) { errEl.textContent = 'Add the role title.'; errEl.hidden = false; return; }
      const fields = ['role', 'company', 'url', 'status', 'location', 'track', 'source', 'priority', 'deadline', 'nextAction', 'notes', 'interview'];
      if (caps.round) fields.push('round');
      if (caps.applied) fields.push('applied');
      if (caps.nextDate) fields.push('nextDate');
      if (state.status === 'Opportunity' || (editing && job.fit != null) || state.fit != null) fields.push('fit');
      const body = {};
      for (const k of fields) {
        let v = state[k];
        if (k === 'fit') v = v === '' || v == null ? null : Number(v);
        if (editing) { const before = job[k] ?? (k === 'notes' || k === 'nextAction' || k === 'company' || k === 'url' ? '' : null); if ((v ?? '') === (before ?? '')) continue; }
        else if (v == null || v === '') continue;
        body[k] = v ?? null;
      }
      if (editing && !Object.keys(body).length) { closeSheet(); return; }
      saveBtn.disabled = true; errEl.hidden = true;
      try {
        const saved = editing ? await api(`/api/jobs/${job.id}`, { method: 'PATCH', body }) : await api('/api/jobs', { method: 'POST', body });
        closeSheet();
        toast(editing ? 'Saved' : kind === 'opp' ? 'Opportunity added' : 'Added to tracker');
        if (!editing) location.hash = kind === 'opp' ? 'opps' : 'jobs';
        render();
        if (body.status === 'Offer' && (!editing || job.status !== 'Offer')) setTimeout(() => openThankPanel(saved), 350);
      } catch (err) { errEl.textContent = err.message; errEl.hidden = false; saveBtn.disabled = false; }
    } },
      h('h2', { id: 'sheetTitle' }, editing ? (job.status === 'Opportunity' ? 'Opportunity' : 'Edit job') : parsed ? 'Review before saving' : kind === 'opp' ? 'New opportunity' : 'New job'),
      banner,
      h('div', { class: 'field' }, h('label', { for: 'jf-role' }, 'Role'), input('role', { placeholder: 'e.g. Product Marketing MBA Intern' })),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'jf-company' }, 'Company'), input('company', { placeholder: 'Company' })),
        h('div', { class: 'field' }, h('label', { for: 'jf-deadline' }, 'Apply by'), dateInput('deadline'))),
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Status'), statusPicker),
      appliedField,
      roundField,
      editing && job.status === 'Offer' ? h('div', { class: 'thank-cta' }, h('div', null, h('b', null, 'Offer 🎉 '), 'Thank the people who helped.'), h('button', { type: 'button', class: 'btn primary', onclick: () => openThankPanel(job) }, 'Say thanks')) : null,
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Location'), picker('Location', opts.locations || ['SF', 'Peninsula', 'South Bay', 'East Bay', 'Remote/Hybrid', 'Other'], state.location, (v) => { state.location = v; }),
        f.locationText ? h('div', { class: 'hint' }, `Posting says: ${f.locationText}`) : null),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Track'), picker('Track', opts.tracks || ['PM', 'PMM', 'Other'], state.track, (v) => { state.track = v; })),
        h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Priority'), picker('Priority', opts.priorities || ['High', 'Medium', 'Low'], state.priority, (v) => { state.priority = v; }))),
      h('div', { class: 'field' }, h('label', { for: 'jf-url' }, 'Link'), input('url', { type: 'url', placeholder: 'https://…', inputmode: 'url' })),
      h('div', { class: caps.nextDate ? 'two' : '' },
        h('div', { class: 'field' }, h('label', { for: 'jf-nextAction' }, 'Next step'), input('nextAction', { placeholder: 'e.g. Coffee chat with alum' })),
        caps.nextDate ? h('div', { class: 'field' }, h('label', { for: 'jf-nextDate' }, 'Next step date'), dateInput('nextDate')) : null),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Source'), picker('Source', opts.sources || ['LinkedIn', 'Company site', 'School', 'Referral', 'Other'], state.source, (v) => { state.source = v; })),
        state.status === 'Opportunity' || (editing && job.fit != null) ? h('div', { class: 'field' }, h('label', { for: 'jf-fit' }, 'Fit (0–10)'), input('fit', { type: 'number', min: '0', max: '10', step: '1', inputmode: 'numeric' })) : h('div')),
      extra,
      h('div', { class: 'field' }, h('label', { for: 'jf-notes' }, state.status === 'Opportunity' ? 'Fit note / notes' : 'Notes'), notes),
      editing && job.status !== 'Opportunity' ? jobContactsPanel(job) : null,
      editing && resumeTipsEligible(job.status) ? resumeTipsPanel(job) : null,
      errEl,
      h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), saveBtn),
      editing ? h('div', { class: 'alt-links' },
        job.status === 'Opportunity' ? h('button', { type: 'button', class: 'linkish', onclick: () => { closeSheet(); moveToTracker(job); } }, 'Move to tracker as Interested') : null,
        job.status !== 'Opportunity' && job.status !== 'Closed' ? h('button', { type: 'button', class: 'linkish danger-link', onclick: () => removeJobFromBoard(job) }, 'Remove from board…') : null,
        job.status === 'Closed' ? h('button', { type: 'button', class: 'linkish', onclick: () => updateJob(job.id, { status: 'Interested' }, 'Restored to Interested').then(closeSheet) }, 'Restore to Interested') : null,
        job.url && /^https?:\/\//i.test(job.url) ? h('a', { class: 'linkish', href: job.url, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, 'Open posting ↗') : null,
        job.notionUrl && me.mode !== 'fixture' ? h('a', { class: 'linkish', href: job.notionUrl, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, 'Open in Notion ↗') : null,
        job.status !== 'Opportunity' ? h('button', { type: 'button', class: 'linkish danger-link', onclick: () => archiveJobPermanently(job) }, 'Archive in Notion…') : null) : null);
    openSheet([form], 'panel wide');
  }
  function openJobSheet(job) { openJobForm({ job, kind: job.status === 'Opportunity' ? 'opp' : 'job' }); }

  // =====================================================================
  // ---------- page building blocks ----------
  // =====================================================================
  const todayStr = () => me.today || todayKey();
  function dHead({ eyebrow, title, summary, actions }) {
    return h('header', { class: 'dhead' },
      h('div', { class: 'dhead-main' },
        eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null,
        h('h1', { class: 'page-title' }, title),
        summary ? h('div', { class: 'summary' }, summary) : null),
      h('div', { class: 'dhead-actions' }, refreshCtl(), actions || null));
  }
  function card(title, opts, ...body) {
    const { count, action, cls = '' } = opts || {};
    return h('section', { class: `dcard ${cls}` },
      h('div', { class: 'dcard-head' }, h('h2', null, title), count != null ? h('span', { class: 'count' }, count) : null, action ? h('div', { class: 'dcard-action' }, action) : null),
      body);
  }
  const searchBox = (placeholder, value, onInput) => {
    const el = h('input', { type: 'search', class: 'tsearch', placeholder, value: value || '', 'aria-label': placeholder });
    el.addEventListener('input', () => onInput(el.value));
    return h('label', { class: 'tsearch-wrap' }, icon('M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM16 16l4.5 4.5'), el);
  };
  const seg = (label, options, value, onPick) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([k, text]) => h('button', { type: 'button', 'aria-pressed': String(value === k), onclick: () => onPick(k) }, text)));
  const matches = (q, ...fields) => !q || q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => fields.some((f) => String(f || '').toLowerCase().includes(w)));

  // ---------- time grid (Today timeline + Week calendar) ----------
  function layoutDay(items, minDur) {
    items.forEach((it) => { it.ve = Math.max(it.e, it.s + minDur); });
    items.sort((a, b) => a.s - b.s || b.ve - a.ve);
    const out = [];
    let cluster = [], end = -1;
    const flush = () => {
      const colsEnd = [];
      for (const it of cluster) {
        let c = colsEnd.findIndex((x) => x <= it.s);
        if (c < 0) { c = colsEnd.length; colsEnd.push(it.ve); } else colsEnd[c] = it.ve;
        it.col = c;
      }
      cluster.forEach((it) => { it.cols = colsEnd.length; });
      out.push(...cluster); cluster = [];
    };
    for (const it of items) { if (cluster.length && it.s >= end) { flush(); end = -1; } cluster.push(it); end = Math.max(end, it.ve); }
    if (cluster.length) flush();
    return out;
  }
  function tblock(it, lo, hourH) {
    const { ev, s, e, col, cols } = it;
    const top = ((s - lo) / 60) * hourH;
    const height = Math.max(((e - s) / 60) * hourH, 22);
    const past = Date.parse(ev.end || ev.start) < nowMs();
    const short = height < 44;
    const narrow = cols > 1;
    const when = ev.deadline ? `due ${timeLabel(ev.start)}` : `${timeLabel(ev.start)} – ${timeLabel(ev.end)}`;
    return h('button', {
      type: 'button', class: `tblock ${groupClass(ev)}${ev.deadline ? ' deadline' : ''}${ev.canceled ? ' canceled' : ''}${past ? ' past' : ''}${short ? ' short' : ''}${narrow ? ' narrow' : ''}`,
      style: `top:${top}px;height:${height - 2}px;left:calc(${(col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px)`,
      title: `${ev.title} · ${when} · ${calendarName(ev)}`, onclick: () => openEvent(ev),
    },
    h('span', { class: 'tb-title' }, ev.deadline ? h('b', { class: 'tb-due' }, 'Due ') : null, ev.course && !narrow ? h('span', { class: 'course' }, ev.course) : null, ev.title),
    h('span', { class: 'tb-time' }, ev.deadline ? timeLabel(ev.start) : narrow ? timeLabel(ev.start) : `${timeLabel(ev.start)} – ${timeLabel(ev.end)}`, !short && !narrow && ev.location ? h('span', { class: 'tb-loc' }, ev.location) : null));
  }
  /** Builds the hour gutter and one positioned column per day. */
  function timeGrid(dayKeys, eventsFor, { hourH = 44, today, minStart = 8, minEnd = 20 } = {}) {
    const perDay = dayKeys.map((k) => eventsFor(k).filter((ev) => !ev.allDay).map((ev) => {
      const s = ev.startKey < k ? 0 : minsOf(ev.start);
      const e = keyOfIso(ev.end) > k ? 1440 : minsOf(ev.end);
      return { ev, s, e: Math.max(e, s) };
    }));
    let lo = minStart * 60, hi = minEnd * 60;
    for (const items of perDay) for (const it of items) { lo = Math.min(lo, Math.floor(it.s / 60) * 60); hi = Math.max(hi, Math.ceil(Math.max(it.e, it.s + 30) / 60) * 60); }
    hi = Math.min(hi, 1440);
    const H = ((hi - lo) / 60) * hourH;
    const gutter = h('div', { class: 'tg-gutter', style: `height:${H}px` });
    for (let m = lo + 60; m < hi; m += 60) gutter.append(h('span', { style: `top:${((m - lo) / 60) * hourH}px` }, hourLabel(m / 60)));
    const nm = minsOf(new Date(nowMs()).toISOString());
    const cols = dayKeys.map((k, i) => {
      const col = h('div', { class: `tg-col${k === today ? ' is-today' : ''}${k < today ? ' is-past' : ''}`, style: `height:${H}px;--hh:${hourH}px` });
      for (const it of layoutDay(perDay[i], 28)) col.append(tblock(it, lo, hourH));
      if (k === today && nm >= lo && nm <= hi) col.append(h('div', { class: 'tg-now', style: `top:${((nm - lo) / 60) * hourH}px` }));
      return col;
    });
    const scrollTop = dayKeys.includes(today) ? Math.max(0, ((nm - lo) / 60 - 1.5) * hourH) : 0;
    return { gutter, cols, H, scrollTop };
  }

  function miniTask(task, today) {
    const el = h('div', { class: `mtask${task.done ? ' done' : ''}` });
    el.append(h('button', { type: 'button', class: `check sm p-${task.priority || 'none'}`, 'aria-label': `Mark "${task.name}" done`, onclick: () => toggleDone(task, el) }, icon(ICON.check)),
      h('button', { type: 'button', class: 'mtask-name', title: task.name, onclick: () => openTaskSheet(task) }, task.name));
    return el;
  }

  // ---------- Today (dashboard) ----------
  async function viewToday() {
    const today = todayStr();
    const [d, t, m, ag, jobs, netCard] = await Promise.all([
      api('/api/today'),
      api('/api/tasks').catch(() => null),
      getMonth(today.slice(0, 7)).catch(() => null),
      api(`/api/agenda?start=${today}&days=15`).catch(() => null),
      loadJobs().catch(() => null),
      todayNetCard().catch(() => null),
    ]);
    const allDay = d.events.filter((e) => e.allDay);
    const timed = d.events.filter((e) => !e.allDay);
    const meetings = timed.filter((e) => !e.deadline && !e.canceled).length;

    // Column 1: tasks
    const quickInput = h('input', { type: 'text', class: 'quick-add', placeholder: 'Add a task due today… press Enter', maxlength: '300', 'aria-label': 'Add a task due today' });
    quickInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !quickInput.value.trim()) return;
      const name = quickInput.value.trim(); quickInput.disabled = true;
      try { await api('/api/tasks', { method: 'POST', body: { name, due: today } }); toast('Task added'); render(); } catch (err) { toast(err.message); quickInput.disabled = false; }
    });
    const week = (t?.open || []).filter((x) => x.due?.key && x.due.key > today && x.due.key <= addDays(today, 7));
    const byDay = new Map();
    for (const x of week) { if (!byDay.has(x.due.key)) byDay.set(x.due.key, []); byDay.get(x.due.key).push(x); }
    const tl = (items, opts) => h('ul', { class: 'tasks' }, items.map((x) => taskRow(x, today, opts)));
    const taskCol = card('Tasks', { count: `${d.overdue.length + d.dueToday.length} need attention`, action: h('a', { class: 'linkish', href: '#tasks' }, 'All tasks →'), cls: 'col-tasks' },
      quickInput,
      d.overdue.length ? [h('div', { class: 'sub-head late' }, 'Overdue', h('span', null, d.overdue.length)), tl(d.overdue)] : null,
      h('div', { class: 'sub-head today' }, 'Due today', h('span', null, d.dueToday.length)),
      d.dueToday.length ? tl(d.dueToday, { showDue: !!d.dueToday.some((x) => x.due?.time) }) : h('div', { class: 'empty' }, 'Nothing else due today.'),
      byDay.size ? [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, items]) => [
        h('div', { class: 'sub-head' }, diffDays(today, k) === 1 ? 'Tomorrow' : fmtKey(k, { weekday: 'long' }), h('em', null, fmtKey(k, { month: 'short', day: 'numeric' })), h('span', null, items.length)),
        tl(items, { showDue: false })]) : null,
      d.noDateCount ? h('a', { class: 'link-row', href: '#tasks' }, `${d.noDateCount} open tasks have no due date · `, h('b', null, 'Review')) : null);

    // Column 2: next up + timeline
    const tg = timeGrid([today], () => timed, { hourH: 46, today, minStart: 8, minEnd: 21 });
    const timelineBody = h('div', { class: 'tl-scroll' }, h('div', { class: 'tl-grid' }, tg.gutter, tg.cols[0]));
    const schedule = card('Schedule', { count: `${meetings} ${meetings === 1 ? 'event' : 'events'}`, action: h('a', { class: 'linkish', href: '#week' }, 'Week →'), cls: 'col-schedule' },
      nextUpCard(d.nextUp, today),
      allDay.length ? h('div', { class: 'tl-allday' }, allDayChips(allDay)) : null,
      timelineBody);

    // Right rail: calendar, deadlines, job next steps
    const deadlines = [];
    const seen = new Set();
    for (const day of ag?.days || []) for (const ev of day.events) if (ev.deadline && !ev.canceled && !seen.has(ev.id) && ev.startKey >= today) { seen.add(ev.id); deadlines.push({ key: ev.startKey, title: ev.title, sub: ev.course || ev.feed, open: () => openEvent(ev), kind: 'cal', group: ev.group }); }
    for (const j of [...(jobs?.tracker || []), ...(jobs?.opportunities || [])]) {
      if (j.deadline && j.status !== 'Closed' && j.deadline >= today && diffDays(today, j.deadline) <= 14) deadlines.push({ key: j.deadline, title: `Apply · ${j.company || j.role}`, sub: j.role, open: () => openJobSheet(j), kind: 'job' });
    }
    deadlines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const dlList = deadlines.length ? h('ul', { class: 'rail-list' }, deadlines.slice(0, 8).map((x) => h('li', null, h('button', { type: 'button', class: `rail-item ${x.kind === 'job' ? 'is-job' : 'g-' + (x.group || 'school')}`, onclick: x.open },
      h('span', { class: 'datebox' }, h('b', null, fmtKey(x.key, { day: 'numeric' })), h('small', null, fmtKey(x.key, { weekday: 'short' }))),
      h('span', { class: 'ri-text' }, h('span', { class: 'ri-title' }, x.title), h('span', { class: 'ri-sub' }, x.sub)))))) : h('div', { class: 'empty' }, 'No deadlines in the next two weeks.');
    const active = (jobs?.tracker || []).filter((j) => j.status !== 'Closed');
    const nextKey = (j) => j.interview || j.nextDate || j.deadline || '9999';
    const steps = active.filter((j) => j.nextAction || j.interview || j.nextDate).sort((a, b) => nextKey(a).localeCompare(nextKey(b))).slice(0, 5);
    const stat = (n, label, cls) => h('a', { class: `stat ${cls || ''}`, href: '#jobs' }, h('b', null, n), h('span', null, label));
    const jobsCard = jobs ? card('Job next steps', { action: h('a', { class: 'linkish', href: '#jobs' }, 'Tracker →') },
      h('div', { class: 'stats' }, stat(active.filter((j) => j.status === 'Applied').length, 'applied'), stat(active.filter((j) => j.status === 'Interviewing').length, 'interviewing', 'iv'), stat(jobs.opportunities.length, 'to explore', 'op')),
      steps.length ? h('ul', { class: 'rail-list' }, steps.map((j) => h('li', null, h('button', { type: 'button', class: 'rail-item step', onclick: () => openJobSheet(j) },
        h('span', { class: 'ri-text' }, h('span', { class: 'ri-title' }, j.company, ' ', jobPill(j)), h('span', { class: 'ri-sub' }, j.nextAction || 'Next step not set')),
        j.interview || j.nextDate ? h('span', { class: 'ri-date' }, j.interview ? `Interview ${shortDate(j.interview)}` : shortDate(j.nextDate)) : null)))) : h('div', { class: 'empty' }, 'No next steps yet.')) : null;
    const rail = h('aside', { class: 'rail' },
      m ? miniCalendar(m, today, { onPick: (key) => { dayFilter = key; calMonth = key.slice(0, 7); location.hash = 'tasks'; }, selected: null }) : null,
      netCard,
      card('Upcoming deadlines', { count: deadlines.length ? `${deadlines.length} in 2 weeks` : null }, dlList),
      jobsCard);

    const summary = [h('b', null, `${meetings} ${meetings === 1 ? 'event' : 'events'}`), ' · ', h('b', null, `${d.dueToday.length} due today`)];
    if (d.overdue.length) summary.push(' · ', h('b', { class: 'late' }, `${d.overdue.length} overdue`));
    const node = h('div', { class: 'view dview' },
      dHead({ eyebrow: fmtKey(today, { weekday: 'long' }), title: fmtKey(today, { month: 'long', day: 'numeric', year: 'numeric' }), summary,
        actions: [h('button', { type: 'button', class: 'btn', onclick: () => { location.hash = 'week'; } }, 'Open week'), h('button', { type: 'button', class: 'btn primary', onclick: () => openTaskSheet(null) }, '+ Add task')] }),
      banner(d.calendarError, d.feeds),
      h('div', { class: 'dash' }, taskCol, schedule, rail));
    node._afterMount = () => { timelineBody.scrollTop = tg.scrollTop; };
    return node;
  }

  // ---------- Week (hour grid) ----------
  async function viewWeek(arg) {
    const today = todayStr();
    const start = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? weekStart(arg) : weekStart(today);
    const d = await api(`/api/agenda?start=${start}&days=7`);
    const end = addDays(start, 6);
    const range = start.slice(0, 7) === end.slice(0, 7)
      ? `${fmtKey(start, { month: 'long', day: 'numeric' })} – ${fmtKey(end, { day: 'numeric' })}, ${end.slice(0, 4)}`
      : `${fmtKey(start, { month: 'short', day: 'numeric' })} – ${fmtKey(end, { month: 'short', day: 'numeric' })}, ${end.slice(0, 4)}`;
    const isThisWeek = start === weekStart(d.today);
    const keys = d.days.map((x) => x.date);
    // Timed deadlines (e.g. "due 11:59 PM") go in the strip with all-day items; the hour grid shows real events only.
    const evFor = (k) => (d.days.find((x) => x.date === k)?.events || []).filter((ev) => !ev.deadline);
    const weekNav = [
      h('button', { type: 'button', class: 'btn', disabled: isThisWeek, onclick: () => { location.hash = 'week'; } }, 'Today'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous week', onclick: () => { location.hash = `week/${addDays(start, -7)}`; } }, icon(ICON.left)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next week', onclick: () => { location.hash = `week/${addDays(start, 7)}`; } }, icon(ICON.right))];
    if (isMobile()) {
      const node = h('div', { class: 'view dview wk-agenda' },
        dHead({ eyebrow: isThisWeek ? 'This week' : 'Week', title: range, actions: weekNav }),
        banner(d.calendarError, d.feeds),
        d.days.map((day) => {
          const evs = day.events.filter((e) => !e.canceled).sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || String(a.start).localeCompare(String(b.start)));
          return card(`${day.date === d.today ? 'Today · ' : ''}${fmtKey(day.date, { weekday: 'long', month: 'short', day: 'numeric' })}`, { count: evs.length + day.tasks.length || null },
            evs.length ? h('ul', { class: 'events' }, evs.map((ev) => eventRow(ev, { today: d.today }))) : null,
            day.tasks.length ? h('ul', { class: 'tasks' }, day.tasks.map((t) => taskRow(t, d.today, { showDue: false }))) : null,
            !evs.length && !day.tasks.length ? h('div', { class: 'empty' }, 'Nothing scheduled.') : null);
        }));
      node._week = start;
      return node;
    }
    const tg = timeGrid(keys, evFor, { hourH: 46, today: d.today, minStart: 8, minEnd: 21 });

    const head = h('div', { class: 'wk-row wk-head' }, h('div', { class: 'wk-corner' }, 'CT'),
      d.days.map((day) => h('button', { type: 'button', class: `wk-day${day.date === d.today ? ' is-today' : ''}${day.date < d.today ? ' is-past' : ''}`, title: 'Show this day in Tasks',
        onclick: () => { dayFilter = day.date; calMonth = day.date.slice(0, 7); location.hash = 'tasks'; } },
      h('span', { class: 'wd' }, fmtKey(day.date, { weekday: 'short' })), h('span', { class: 'dn' }, fmtKey(day.date, { day: 'numeric' })))));
    const strip = h('div', { class: 'wk-row wk-strip' }, h('div', { class: 'wk-corner' }, 'All day', h('br'), 'Tasks'),
      d.days.map((day) => {
        const ad = day.events.filter((e) => e.allDay || e.deadline);
        return h('div', { class: `wk-cell${day.date === d.today ? ' is-today' : ''}` },
          ad.map((ev) => h('button', { type: 'button', class: `wchip ${groupClass(ev)}${ev.deadline ? ' deadline' : ''}${ev.birthday ? ' birthday' : ''}`, title: `${ev.title} · ${ev.allDay ? 'all day' : 'due ' + timeLabel(ev.start)} · ${calendarName(ev)}`, onclick: () => openEvent(ev) },
            ev.deadline ? h('b', null, ev.allDay ? 'Due ' : `Due ${timeLabel(ev.start)} `) : null, ev.birthday && BDAY_RE.test(ev.title) ? '🎂 ' : '', ev.course ? `${ev.course} · ` : '', ev.title)),
          day.tasks.map((t) => miniTask(t, d.today)));
      }));
    const body = h('div', { class: 'wk-body' }, h('div', { class: 'wk-row wk-grid' }, tg.gutter, tg.cols));
    const overdueOpen = null;
    const node = h('div', { class: 'view dview wk-view' },
      dHead({ eyebrow: isThisWeek ? 'This week' : 'Week', title: range,
        actions: [
          h('div', { class: 'legend' }, ['personal', 'school', 'social'].map((g) => h('span', { class: `g-${g}` }, h('span', { class: 'dot' }), GROUP_LABEL[g])), h('span', { class: 'lg-dl' }, h('span', { class: 'dot' }), 'Deadline')),
          h('button', { type: 'button', class: 'btn', disabled: isThisWeek, onclick: () => { location.hash = 'week'; } }, 'Today'),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous week (←)', title: 'Previous week (←)', onclick: () => { location.hash = `week/${addDays(start, -7)}`; } }, icon(ICON.left)),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next week (→)', title: 'Next week (→)', onclick: () => { location.hash = `week/${addDays(start, 7)}`; } }, icon(ICON.right))] }),
      banner(d.calendarError, d.feeds),
      overdueOpen,
      h('div', { class: 'wk' }, head, strip, body));
    node._afterMount = () => { body.scrollTop = tg.scrollTop; };
    node._week = start;
    return node;
  }

  // ---------- Tasks (table) ----------
  let taskQuery = '';
  async function viewTasks() {
    const today = todayStr();
    calMonth = calMonth || today.slice(0, 7);
    const [d, m] = await Promise.all([api(`/api/tasks?sort=${prefs.sort}${prefs.showDone ? '&done=1' : ''}`), getMonth(calMonth).catch(() => null)]);
    if (d.caps) taskCaps = d.caps;
    const inArea = (t) => prefs.area === 'All' || (prefs.area === 'Other' ? (t.area === 'Other' || !t.area) : t.area === prefs.area);
    const counts = { All: d.open.length };
    for (const a of AREAS) counts[a] = d.open.filter((t) => (a === 'Other' ? t.area === 'Other' || !t.area : t.area === a)).length;
    const dayAgenda = dayFilter ? await api(`/api/agenda?start=${dayFilter}&days=1`).catch(() => null) : null;

    const tableHost = h('div', { class: 'ttable-wrap' });
    const paint = () => {
      const open = d.open.filter(inArea).filter(whoOk(prefs.who)).filter(clsOk(prefs.cls)).filter((t) => matches(taskQuery, t.name, t.area, t.notes, t.link, (t.classes || []).join(' ')));
      const done = prefs.showDone && d.done ? d.done.filter(inArea).filter(whoOk(prefs.who)).filter(clsOk(prefs.cls)).filter((t) => matches(taskQuery, t.name, t.area, t.notes, t.link, (t.classes || []).join(' '))) : [];
      const groups = [];
      if (dayFilter) {
        groups.push({ name: fmtKey(dayFilter, { weekday: 'long' }), sub: fmtKey(dayFilter, { month: 'short', day: 'numeric' }), items: [...open, ...done].filter((t) => t.due?.key === dayFilter), cls: dayFilter === today ? 'today' : '' });
      } else if (prefs.sort === 'due') {
        const overdue = open.filter((t) => t.due?.key && t.due.key < today);
        if (overdue.length) groups.push({ name: 'Overdue', items: overdue, cls: 'late' });
        const byDate = new Map();
        for (const t of open) if (t.due?.key && t.due.key >= today) { if (!byDate.has(t.due.key)) byDate.set(t.due.key, []); byDate.get(t.due.key).push(t); }
        for (const [k, items] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
          const dd = diffDays(today, k);
          groups.push({ name: dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : fmtKey(k, { weekday: 'long' }), sub: fmtKey(k, { month: 'short', day: 'numeric' }), items, cls: dd === 0 ? 'today' : '' });
        }
        const noDate = open.filter((t) => !t.due?.key);
        if (noDate.length) groups.push({ name: 'No due date', items: noDate });
        if (done.length) groups.push({ name: 'Done', items: done, cls: 'donegrp' });
      } else {
        const g = { High: [], Medium: [], Low: [], 'No priority': [] };
        for (const t of open) (g[t.priority] || g['No priority']).push(t);
        for (const [k, items] of Object.entries(g)) if (items.length) groups.push({ name: k === 'No priority' ? k : `${k} priority`, items });
        if (done.length) groups.push({ name: 'Done', items: done, cls: 'donegrp' });
      }
      const nonEmpty = groups.filter((g) => g.items.length);
      if (!nonEmpty.length) {
        fill(tableHost, h('div', { class: 'empty soft' }, dayFilter ? 'No tasks due this day.' : taskQuery ? `No tasks match “${taskQuery}”.` : 'All clear. No open tasks.'));
        return;
      }
      if (isMobile()) {
        fill(tableHost, h('div', { class: 'mgroups' }, nonEmpty.map((g) => h('section', { class: `mgroup ${g.cls || ''}` },
          h('div', { class: 'mgroup-head' }, h('span', { class: 'gname' }, g.name), g.sub ? h('span', { class: 'gsub' }, g.sub) : null, h('span', { class: 'gcount' }, g.items.length)),
          h('ul', { class: 'tasks' }, g.items.map((t) => taskRow(t, today, { showDue: !dayFilter })))))));
        return;
      }
      fill(tableHost, h('table', { class: 'ttable' },
        h('colgroup', null, h('col', { style: 'width:40px' }), h('col'), h('col', { class: 'w-due' }), h('col', { class: 'w-area' }), h('col', { class: 'w-prio' }), h('col', { class: 'w-status' }), h('col', { style: 'width:38px' })),
        h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr-only' }, 'Done')), h('th', null, 'Task'), h('th', null, 'Due'), h('th', null, 'Area'), h('th', null, 'Priority'), h('th', null, 'Status'), h('th', null, h('span', { class: 'sr-only' }, 'Open')))),
        nonEmpty.map((g) => h('tbody', null,
          h('tr', { class: `tgroup ${g.cls || ''}` }, h('td', { colspan: '7' }, h('span', { class: 'gname' }, g.name), g.sub ? h('span', { class: 'gsub' }, g.sub) : null, h('span', { class: 'gcount' }, g.items.length))),
          g.items.map((t) => taskTableRow(t, today))))));
    };
    paint();

    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by area' }, ['All', ...AREAS].map((a) =>
      h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(prefs.area === a), onclick: () => { prefs.area = a; savePrefs(); render(); } },
        a !== 'All' ? h('span', { class: `area a-${a}` }) : null, a, h('span', { class: 'n' }, counts[a]))));
    const toolbar = h('div', { class: 'dtoolbar' },
      searchBox('Filter tasks', taskQuery, (q) => { taskQuery = q; paint(); }),
      chips,
      whoFilter(d.open, prefs.who, (k) => { prefs.who = k; savePrefs(); paint(); }),
      classFilter(d.open, prefs.cls, (k) => { prefs.cls = k; savePrefs(); paint(); }),
      h('div', { class: 'spacer' }),
      seg('Group by', [['due', 'By date'], ['priority', 'By priority']], prefs.sort, (k) => { prefs.sort = k; savePrefs(); render(); }),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: prefs.showDone, onchange: (e) => { prefs.showDone = e.target.checked; savePrefs(); render(); } }), 'Show done'));

    const overdueN = d.open.filter((t) => t.due?.key && t.due.key < today).length;
    const dayEvents = dayAgenda?.days?.[0]?.events || [];
    const side = h('aside', { class: 'rail' },
      m ? (isMobile() ? h('details', { class: 'm-cal', open: !!dayFilter }, h('summary', null, dayFilter ? `Calendar · ${fmtKey(dayFilter, { month: 'short', day: 'numeric' })}` : 'Calendar'), miniCalendar(m, today)) : miniCalendar(m, today)) : null,
      dayFilter ? card(fmtKey(dayFilter, { weekday: 'long', month: 'short', day: 'numeric' }), { action: h('button', { type: 'button', class: 'linkish', onclick: () => { dayFilter = null; render(); } }, 'Show all') },
        dayEvents.length ? h('ul', { class: 'events compact' }, dayEvents.map((ev) => eventRow(ev, { compact: true }))) : h('div', { class: 'empty' }, 'Nothing on the calendar.')) : null,
      card('By area', null, h('ul', { class: 'area-bars' }, AREAS.map((a) => h('li', null, h('span', { class: `area a-${a}` }, a), h('span', { class: 'bar' }, h('i', { class: `a-${a}`, style: `width:${d.open.length ? Math.round((counts[a] / d.open.length) * 100) : 0}%` })), h('b', null, counts[a]))))),
      card('Tips', null, h('ul', { class: 'tips' }, h('li', null, 'Click a task to open its details: notes, a link, everything saves as you go. Double-click a name to rename it in place.'), h('li', null, h('kbd', null, 'N'), ' new task · ', h('kbd', null, '/'), ' search'))));

    return h('div', { class: 'view dview' },
      dHead({ eyebrow: 'Notion · To Do', title: dayFilter ? `Tasks · ${fmtKey(dayFilter, { month: 'short', day: 'numeric' })}` : 'Tasks',
        summary: [h('b', null, `${d.open.length} open`), overdueN ? [' · ', h('b', { class: 'late' }, `${overdueN} overdue`)] : null, ` · ${d.open.filter((t) => !t.due).length} without a date`],
        actions: [dayFilter ? h('button', { type: 'button', class: 'btn', onclick: () => { dayFilter = null; render(); } }, 'Show all days') : null, h('button', { type: 'button', class: 'btn primary', onclick: () => openTaskSheet(null, { due: dayFilter }) }, '+ New task')] }),
      isMobile() ? h('div', { class: 'm-stack' }, side, toolbar, tableHost) : h('div', { class: 'split' }, h('div', { class: 'split-main' }, toolbar, tableHost), side));
  }

  // ---------- Socializing (Partiful + lunch/dinner free-busy) ----------
  async function viewSocial() {
    const d = await api('/api/socializing');
    const today = d.today || todayStr();
    const statusLabel = { free: 'Free', partial: 'Short window', tight: 'Tight', busy: 'Busy' };
    const PLAN_STATUSES = d.planStatuses || ['Planned', 'Reached out', 'Confirmed', 'Declined', 'Cancelled'];
    const planStatusSlug = (st) => String(st || 'Planned').toLowerCase().replace(/\s+/g, '-');
    async function editMealPlan(day, meal) {
      const existing = meal.plan?.with || '';
      const curStatus = meal.plan?.planStatus || 'Planned';
      const whoInput = h('input', { type: 'text', class: 'text-input', id: 'mealWho', value: existing, placeholder: 'Name or friend…', maxlength: '120', autocomplete: 'off' });
      const statusSel = h('select', { class: 'text-input', id: 'mealPlanStatus', 'aria-label': 'Plan status' },
        PLAN_STATUSES.map((st) => h('option', { value: st, selected: st === curStatus }, st)));
      const errEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const saveBtn = h('button', { type: 'button', class: 'btn primary' }, existing ? 'Save' : 'Save plan');
      const clearBtn = existing ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        try {
          await api('/api/socializing/plans', { method: 'DELETE', body: { date: day.date, meal: meal.id } });
          closeSheet(); toast('Cleared'); render();
        } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
      } }, 'Clear') : null;
      saveBtn.onclick = async () => {
        const who = whoInput.value.trim();
        if (!who) { errEl.textContent = 'Who are you eating with?'; errEl.hidden = false; whoInput.focus(); return; }
        saveBtn.disabled = true;
        try {
          await api('/api/socializing/plans', { method: 'PUT', body: { date: day.date, meal: meal.id, with: who, planStatus: statusSel.value } });
          closeSheet(); toast(`${meal.label} with ${who} · ${statusSel.value}`); render();
        } catch (e) { errEl.textContent = e.message; errEl.hidden = false; saveBtn.disabled = false; }
      };
      openSheet([
        h('h2', { id: 'sheetTitle' }, `${meal.label} · ${day.date === today ? 'Today' : fmtKey(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}`),
        h('p', { class: 'confirm-body' }, meal.status === 'busy' ? 'This window looks busy on your calendars — you can still plan someone.' : `Free ${meal.slotLabel} (within ${meal.windowLabel}).`),
        h('div', { class: 'field' }, h('label', { for: 'mealWho' }, 'Eating with'), whoInput),
        h('div', { class: 'field' }, h('label', { for: 'mealPlanStatus' }, 'Status'), statusSel),
        errEl,
        h('p', { class: 'hint' }, 'Planned → Reached out → Confirmed. Saved in Dayline — nothing goes on your calendar or your To Do list.'),
        h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), clearBtn, saveBtn),
      ], 'modal');
      setTimeout(() => whoInput.focus(), 40);
    }
    const mealCard = (day, meal) => {
      const ps = meal.plan?.planStatus || 'Planned';
      return h('button', {
        type: 'button',
        class: `meal meal-${meal.status}${meal.plan ? ' has-plan' : ''}${meal.plan ? ` plan-${planStatusSlug(ps)}` : ''}`,
        'data-meal': meal.id,
        'data-date': day.date,
        'data-plan-status': meal.plan ? ps : null,
        'aria-label': meal.plan
          ? `${meal.label} ${meal.slotLabel}, with ${meal.plan.with}, ${ps}. Click to edit.`
          : `${meal.label} ${meal.slotLabel}. Click to plan who you're eating with.`,
        title: meal.plan ? `${ps} · ${meal.plan.with}` : 'Click to plan who you\'re eating with',
        onclick: () => editMealPlan(day, meal),
      },
        h('div', { class: 'meal-head' }, h('span', { class: 'meal-name' }, meal.label), h('span', { class: `meal-status s-${meal.status}` }, statusLabel[meal.status] || meal.status)),
        h('div', { class: 'meal-slot' }, meal.slotLabel),
        h('div', { class: 'meal-window' }, 'in ', meal.windowLabel),
        meal.plan
          ? h('div', { class: 'meal-with' },
              h('span', { class: `plan-chip ps-${planStatusSlug(ps)}` }, ps),
              ' with ', meal.plan.with,
              h('span', { class: 'meal-cta' }, 'Edit'))
          : h('div', { class: 'meal-with meal-cta-row' }, h('span', { class: 'meal-cta' }, '+ Plan who…')),
        meal.status === 'busy' && meal.blockers?.length
          ? h('ul', { class: 'meal-blockers' }, meal.blockers.slice(0, 3).map((b) => h('li', null, h('b', null, b.when), ' · ', b.title, b.feed ? ` (${b.feed})` : '')))
          : null);
    };

    const dayCard = (day) => {
      const isToday = day.date === today;
      const partifulHere = (d.partiful || []).filter((e) => e.startKey === day.date || (!e.allDay && e.startKey <= day.date && e.endKey >= day.date));
      return h('article', { class: `soc-day${isToday ? ' is-today' : ''}` },
        h('header', { class: 'soc-day-head' },
          h('div', null, h('div', { class: 'soc-day-name' }, isToday ? 'Today' : fmtKey(day.date, { weekday: 'long' })),
            h('div', { class: 'soc-day-date' }, fmtKey(day.date, { month: 'short', day: 'numeric' }))),
          partifulHere.length ? h('span', { class: 'soc-pill' }, `${partifulHere.length} Partiful`) : null),
        h('div', { class: 'soc-meals' }, day.meals.map((m) => mealCard(day, m))),
        partifulHere.length ? h('ul', { class: 'soc-day-events' }, partifulHere.map((ev) => h('li', null,
          h('button', { type: 'button', class: 'linkish', onclick: () => openEvent(ev) }, ev.title.replace(/\s*\|\s*Partiful\s*$/i, '')),
          h('span', { class: 'faint' }, ev.allDay ? 'All day' : `${timeLabel(ev.start)}${ev.end ? ' – ' + timeLabel(ev.end) : ''}`)))) : null);
    };

    const partifulList = (d.partiful || []).length
      ? h('ul', { class: 'soc-partiful' }, d.partiful.map((ev) => {
        const when = ev.allDay
          ? fmtKey(ev.startKey, { weekday: 'short', month: 'short', day: 'numeric' })
          : `${fmtKey(ev.startKey, { weekday: 'short', month: 'short', day: 'numeric' })} · ${timeLabel(ev.start)}`;
        return h('li', { class: 'soc-pev' },
          h('button', { type: 'button', class: 'soc-pev-main', onclick: () => openEvent(ev) },
            h('div', { class: 'soc-pev-when' }, when),
            h('div', { class: 'soc-pev-title' }, ev.title.replace(/\s*\|\s*Partiful\s*$/i, '')),
            ev.location ? h('div', { class: 'soc-pev-loc' }, ev.location) : null));
      }))
      : h('div', { class: 'empty soft' }, 'No Partiful events in the next few weeks.');

    const freeLunch = d.plan.filter((day) => day.meals.find((m) => m.id === 'lunch' && m.status === 'free')).length;
    const freeDinner = d.plan.filter((day) => day.meals.find((m) => m.id === 'dinner' && m.status === 'free')).length;

    return h('div', { class: 'view dview' },
      dHead({ eyebrow: 'Partiful · all calendars · America/Chicago', title: 'Socializing',
        summary: [h('b', null, `${(d.partiful || []).length} Partiful`), ` · next ${d.plan.length} days · `, h('b', null, `${freeLunch} free lunch`), ` · `, h('b', null, `${freeDinner} free dinner`), ' hours'],
        actions: [h('span', { class: 'faint small' }, 'Tap a meal to plan who you’re with · no calendar holds')] }),
      d.calendarError ? h('div', { class: 'banner soft' }, 'Some calendars could not be loaded, so free/busy may be incomplete.') : null,
      h('div', { class: 'soc-layout' },
        h('aside', { class: 'soc-side' },
          card('Partiful', { count: (d.partiful || []).length }, partifulList),
          card('How it works', null, h('ul', { class: 'tips' },
            h('li', null, 'Click any Lunch or Dinner card to plan who you’re eating with (saved in Dayline, not your To Do list).'),
            h('li', null, 'Lunch window 11:30am–1:30pm · dinner 6–8pm (Chicago). Green = free stretch on your calendars.'),
            h('li', null, 'All-day items, deadlines and birthdays do not block meal slots.'),
            h('li', null, 'Nothing is written to your calendars or your Notion To Do list.')))),
        h('div', { class: 'soc-main' }, h('div', { class: 'soc-grid' }, d.plan.map(dayCard)))));
  }


  // ---------- Brainstorm stickies (Notion "Dayline Brainstorm") ----------
  // Groups come from config/classes.js on the server (General + your activities + your classes).
  const BRAINSTORM_GROUPS = ['General'];
  const BRAINSTORM_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];
  const groupForClassKey = (key) => (classItems().find((c) => c.key === key) || {}).option || null;

  function brainstormBoard({ filterGroup = null, title = 'Brainstorm', compact = false } = {}) {
    const host = h('section', { class: `cls-section brainstorm${compact ? ' compact' : ''}` });
    let data = { notes: [], groups: BRAINSTORM_GROUPS, colors: BRAINSTORM_COLORS, backend: 'notion' };
    let filter = filterGroup || 'all';
    let draft = '';

    const paint = () => {
      const notes = (data.notes || []).filter((n) => filter === 'all' || n.group === filter);
      const addInput = h('input', { type: 'text', class: 'text-input', placeholder: filterGroup ? `Idea for ${filterGroup}…` : 'Jot an idea…', maxlength: '2000', 'aria-label': 'New brainstorm note', value: draft });
      addInput.addEventListener('input', () => { draft = addInput.value; });
      const groupSel = filterGroup ? null : h('select', { class: 'who-filter', 'aria-label': 'Tag for new note' },
        data.groups.map((g) => h('option', { value: g, selected: g === (filter !== 'all' ? filter : 'General') }, g)));
      const colorSel = h('select', { class: 'who-filter', 'aria-label': 'Sticky color' },
        data.colors.map((c) => h('option', { value: c, selected: c === 'yellow' }, c)));
      const addBtn = h('button', { type: 'button', class: 'btn primary small' }, '+ Add');
      const doAdd = async () => {
        const text = addInput.value.trim();
        if (!text) { addInput.focus(); return; }
        addBtn.disabled = true;
        try {
          const body = { text, group: filterGroup || groupSel?.value || 'General', color: colorSel.value, pinned: false };
          await api('/api/brainstorm', { method: 'POST', body });
          draft = ''; toast('Sticky added'); await reload();
        } catch (e) { toast(e.message); addBtn.disabled = false; }
      };
      addBtn.onclick = doAdd;
      addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

      const filters = filterGroup ? null : h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter brainstorm' },
        ['all', ...data.groups].map((g) => h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(filter === g),
          onclick: () => { filter = g; paint(); } }, g === 'all' ? 'All' : g,
          h('span', { class: 'n' }, g === 'all' ? data.notes.length : data.notes.filter((n) => n.group === g).length))));

      const cardEl = (note) => {
        const ta = h('textarea', { class: 'bn-text', rows: '3', maxlength: '2000' }, note.text);
        ta.value = note.text;
        let saved = note.text;
        let timer = null;
        const saveText = async () => {
          clearTimeout(timer); timer = null;
          const v = ta.value.trim();
          if (!v || v === saved) { if (!v) ta.value = saved; return; }
          try { const u = await api(`/api/brainstorm/${note.id}`, { method: 'PATCH', body: { text: v } }); saved = u.text; Object.assign(note, u); }
          catch (e) { toast(e.message); ta.value = saved; }
        };
        ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(saveText, 15000); }); // one save per edit, not per pause
        ta.addEventListener('blur', saveText);
        onHide(saveText);
        const pinBtn = h('button', { type: 'button', class: `bn-pin${note.pinned ? ' on' : ''}`, title: note.pinned ? 'Unpin' : 'Pin', 'aria-pressed': String(!!note.pinned),
          onclick: async () => { try { Object.assign(note, await api(`/api/brainstorm/${note.id}`, { method: 'PATCH', body: { pinned: !note.pinned } })); paint(); } catch (e) { toast(e.message); } } }, '📌');
        const delBtn = h('button', { type: 'button', class: 'bn-del', title: 'Delete sticky', 'aria-label': 'Delete sticky',
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Delete sticky?', body: `Remove “${note.text.slice(0, 80)}${note.text.length > 80 ? '…' : ''}”? This archives it in Notion.`, confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            try { await api(`/api/brainstorm/${note.id}`, { method: 'DELETE', body: {} }); toast('Sticky deleted'); await reload(); }
            catch (e) { toast(e.message); }
          } }, '×');
        const gSel = h('select', { class: 'bn-meta', 'aria-label': 'Group', onchange: async () => {
          try { Object.assign(note, await api(`/api/brainstorm/${note.id}`, { method: 'PATCH', body: { group: gSel.value } })); paint(); } catch (e) { toast(e.message); gSel.value = note.group; }
        } }, data.groups.map((g) => h('option', { value: g, selected: note.group === g }, g)));
        const cSel = h('select', { class: 'bn-meta', 'aria-label': 'Color', onchange: async () => {
          try { Object.assign(note, await api(`/api/brainstorm/${note.id}`, { method: 'PATCH', body: { color: cSel.value } })); paint(); } catch (e) { toast(e.message); cSel.value = note.color; }
        } }, data.colors.map((c) => h('option', { value: c, selected: note.color === c }, c)));
        return h('article', { class: `bn-card bn-${note.color || 'yellow'}${note.pinned ? ' pinned' : ''}`, dataset: { id: note.id } },
          h('div', { class: 'bn-top' }, pinBtn, delBtn),
          ta,
          h('div', { class: 'bn-foot' }, gSel, cSel));
      };

      fill(host,
        h('div', { class: 'cls-sec-head' },
          h('h2', { class: 'cls-h2' }, title, h('span', { class: 'count' }, notes.length)),
          h('span', { class: 'faint small' }, data.backend === 'notion' ? 'Saved in Notion' : 'Sample data')),
        h('div', { class: 'bn-add' }, addInput, groupSel, colorSel, addBtn),
        filters,
        notes.length ? h('div', { class: 'bn-grid' }, notes.map(cardEl))
          : h('div', { class: 'empty soft' }, filterGroup ? `No stickies for ${filterGroup} yet. Add one above.` : 'No stickies yet. Capture event ideas, class notes, whatever.'));
    };

    async function reload() {
      try {
        data = await api('/api/brainstorm');
        paint();
      } catch (e) {
        fill(host, h('div', { class: 'banner' }, e.message));
      }
    }
    reload();
    return host;
  }


  // ---------- Classes & activities ----------

  // Midterm / final countdown (config + Notion tasks + calendar events).
  const MIDTERM_RE = /\bmid[\s-]?terms?(?:\s+exam)?\b/i;
  const FINAL_RE = /\bfinal\s+exam\b/i;
  function classifyExamTitle(title) {
    const t = String(title || '');
    if (MIDTERM_RE.test(t)) return 'midterm';
    if (FINAL_RE.test(t)) return 'final';
    return null;
  }
  function pickExamCand(cands, today) {
    const up = cands.filter((c) => c.key && c.key >= today).sort((a, b) => a.key.localeCompare(b.key));
    if (up.length) return up[0];
    const past = cands.filter((c) => c.key).sort((a, b) => b.key.localeCompare(a.key));
    return past[0] || null;
  }
  function examsForClassClient(item, tasks, events, today) {
    const mid = [], fin = [];
    const push = (kind, c) => (kind === 'midterm' ? mid : fin).push(c);
    if (item.midterm) push('midterm', { key: item.midterm, label: 'Midterm', source: 'config' });
    if (item.final) push('final', { key: item.final, label: 'Final exam', source: 'config' });
    for (const t of tasks) {
      if (!(t.classes || []).includes(item.option)) continue;
      const kind = classifyExamTitle(t.name);
      if (!kind || !t.due?.key) continue;
      push(kind, { key: t.due.key, label: t.name, source: 'task' });
    }
    for (const e of events) {
      if (e.cls && e.cls !== item.option) continue;
      const kind = e.exam || classifyExamTitle(`${e.title || ''} ${e.rawTitle || ''}`);
      if (!kind) continue;
      push(kind, { key: e.startKey, label: e.title || 'Exam', source: 'calendar' });
    }
    return { midterm: pickExamCand(mid, today), final: pickExamCand(fin, today) };
  }
  function examCountdown(key, today) {
    if (!key) return null;
    const d = diffDays(today, key);
    if (d === 0) return { days: 0, text: 'Today', tone: 'today' };
    if (d === 1) return { days: 1, text: 'Tomorrow', tone: 'soon' };
    if (d < 0) return { days: d, text: 'Done', tone: 'past' };
    if (d <= 7) return { days: d, text: `${d}d`, tone: 'soon' };
    if (d <= 21) return { days: d, text: `${d}d`, tone: 'mid' };
    return { days: d, text: `${d}d`, tone: 'later' };
  }
  function examChips(exams, today) {
    const bits = [];
    for (const [kind, label] of [['midterm', 'Midterm'], ['final', 'Final']]) {
      const ex = exams?.[kind];
      if (!ex?.key) continue;
      const cd = examCountdown(ex.key, today);
      bits.push(h('span', { class: `exam-chip tone-${cd.tone}`, title: `${ex.label} · ${ex.key}` },
        h('b', null, label), ' ', cd.text, cd.tone !== 'past' ? ` · ${shortDate(ex.key)}` : ''));
    }
    return bits.length ? h('div', { class: 'exam-row' }, bits) : null;
  }

  async function viewClasses(arg) {
    const [t, c] = await Promise.all([api('/api/tasks?done=1'), api('/api/classes')]);
    if (t.caps) taskCaps = t.caps;
    const today = c.today || todayStr();
    const items = (c.items && c.items.length ? c.items : classItems());
    const relDay = (k) => { const dd = diffDays(today, k); return dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : dd < 0 ? `${shortDate(k)} (late)` : `${fmtKey(k, { weekday: 'short' })} ${shortDate(k)}`; };
    const byDue = (a, b) => (a.due?.key || '9999').localeCompare(b.due?.key || '9999') || (a.due?.time || '').localeCompare(b.due?.time || '') || a.name.localeCompare(b.name);
    const stats = items.map((it) => {
      const has = (x) => (x.classes || []).includes(it.option);
      const open = t.open.filter(has).sort(byDue);
      const evs = (c.events || []).filter((e) => e.cls === it.option).sort((a, b) => (a.start || a.startKey).localeCompare(b.start || b.startKey));
      const deadlines = evs.filter((e) => e.deadline);
      const sessions = evs.filter((e) => !e.deadline);
      const cands = [
        ...open.filter((x) => x.due?.key && x.due.key >= today).map((x) => ({ key: x.due.key, at: x.due.time || x.due.key, label: x.name, kind: 'task', task: x })),
        ...deadlines.map((e) => ({ key: e.startKey, at: e.allDay ? e.startKey : e.start, label: e.title, kind: 'deadline', ev: e })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      const done = (t.done || []).filter(has).sort((a, b) => String(b.edited || '').localeCompare(String(a.edited || ''))).slice(0, 8);
      const allTasks = [...t.open, ...(t.done || [])];
      const exams = it.kind === 'class' ? examsForClassClient(it, allTasks, c.events || [], today) : { midterm: null, final: null };
      return { ...it, open, deadlines, sessions, next: cands[0] || null, overdue: open.filter((x) => x.due?.key && x.due.key < today).length, done, exams };
    });
    const sel = arg ? stats.find((s) => s.key === arg) : null;
    const unassigned = t.open.filter((x) => !(x.classes || []).length).length;
    const tagged = t.open.length - unassigned;
    const nextLabel = (n) => (n ? h('span', { class: 'cls-next' }, h('b', null, relDay(n.key)), ' · ', n.label) : h('span', { class: 'faint' }, 'No upcoming deadline'));

    const navRow = (s) => h('a', { class: `cls-item${sel && sel.key === s.key ? ' active' : ''}`, href: `#classes/${s.key}`, 'aria-current': sel && sel.key === s.key ? 'page' : null },
      h('span', { class: `cdot c-${s.color || 'default'}` }),
      h('span', { class: 'cls-item-main' }, h('span', { class: 'cls-item-name' }, s.kind === 'class' ? s.option : s.name),
        h('span', { class: 'cls-item-sub' }, (() => {
          const mid = s.exams?.midterm && s.exams.midterm.key >= today ? s.exams.midterm : null;
          const fin = s.exams?.final && s.exams.final.key >= today ? s.exams.final : null;
          const ex = mid || fin;
          if (ex) { const cd = examCountdown(ex.key, today); return `${mid && ex === mid ? 'Midterm' : 'Final'} · ${cd.text}`; }
          return s.next ? `Next: ${relDay(s.next.key)}` : s.kind === 'class' ? s.name : 'No deadline';
        })())),
      h('span', { class: `cls-n${s.overdue ? ' late' : ''}`, title: `${s.open.length} open task${s.open.length === 1 ? '' : 's'}${s.overdue ? `, ${s.overdue} overdue` : ''}` }, s.open.length));
    const group = (kind, label) => { const l = stats.filter((s) => s.kind === kind); return l.length ? [h('div', { class: 'cls-group' }, label), l.map(navRow)] : null; };
    const isBrainstorm = arg === 'brainstorm';
    const nav = h('nav', { class: 'cls-nav', 'aria-label': 'Classes and activities' },
      h('a', { class: `cls-item all${!sel && !isBrainstorm ? ' active' : ''}`, href: '#classes', 'aria-current': !sel && !isBrainstorm ? 'page' : null },
        h('span', { class: 'cdot all' }), h('span', { class: 'cls-item-main' }, h('span', { class: 'cls-item-name' }, 'All')), h('span', { class: 'cls-n' }, tagged)),
      group('class', 'Classes'), group('activity', 'Activities'),
      h('div', { class: 'cls-group' }, 'Board'),
      h('a', { class: `cls-item${isBrainstorm ? ' active' : ''}`, href: '#classes/brainstorm', 'aria-current': isBrainstorm ? 'page' : null },
        h('span', { class: 'cdot c-yellow' }), h('span', { class: 'cls-item-main' }, h('span', { class: 'cls-item-name' }, 'Brainstorm'), h('span', { class: 'cls-item-sub' }, 'Sticky notes')), h('span', { class: 'cls-n' }, '✎')));

    const evLine = (ev) => h('li', { class: `cev${ev.deadline ? ' deadline' : ''}`, tabindex: '0', role: 'button', onclick: () => openEvent(ev), onkeydown: (e) => { if (e.key === 'Enter') openEvent(ev); } },
      h('div', { class: 'cev-date' }, h('b', null, relDay(ev.startKey)), h('small', null, ev.allDay ? (ev.deadline ? 'Due' : 'All day') : `${ev.deadline ? 'Due ' : ''}${timeLabel(ev.start)}${!ev.deadline && ev.end ? ' – ' + timeLabel(ev.end) : ''}`)),
      h('div', { class: 'cev-main' }, h('div', { class: 'cev-title' }, ev.title), h('div', { class: 'cev-sub' }, [ev.location, ev.feed].filter(Boolean).join(' · '))));

    const mNav = h('label', { class: 'm-clsnav' }, h('span', { class: 'sr-only' }, 'Jump to class or activity'),
      h('select', { class: 'text-input', onchange: (e) => { location.hash = e.target.value ? `classes/${e.target.value}` : 'classes'; } },
        h('option', { value: '', selected: !sel && !isBrainstorm }, `All classes & activities (${tagged} open)`),
        h('optgroup', { label: 'Classes' }, stats.filter((x) => x.kind === 'class').map((x) => h('option', { value: x.key, selected: sel?.key === x.key }, `${x.option} · ${x.open.length} open`))),
        h('optgroup', { label: 'Activities' }, stats.filter((x) => x.kind === 'activity').map((x) => h('option', { value: x.key, selected: sel?.key === x.key }, `${x.name} · ${x.open.length} open`))),
        h('optgroup', { label: 'Board' }, h('option', { value: 'brainstorm', selected: isBrainstorm }, 'Brainstorm sticky notes'))));
    let body;
    if (isBrainstorm) {
      body = h('div', { class: 'cls-body' }, brainstormBoard({ title: 'Brainstorm' }));
    } else if (!sel) {
      const gridFor = (kind, label) => {
        const l = stats.filter((s) => s.kind === kind);
        return l.length ? h('section', { class: 'cls-section' }, h('h2', { class: 'cls-h2' }, label),
          h('div', { class: 'cls-grid' }, l.map((s) => h('a', { class: `cls-card c-${s.color || 'default'}`, href: `#classes/${s.key}` },
            h('div', { class: 'cls-card-top' }, h('span', { class: `ctag c-${s.color || 'default'}` }, s.option), s.overdue ? h('span', { class: 'late small' }, `${s.overdue} overdue`) : null),
            h('div', { class: 'cls-card-name' }, s.name),
            h('div', { class: 'cls-card-stats' }, h('span', null, h('b', null, s.open.length), ` open task${s.open.length === 1 ? '' : 's'}`), s.sessions.length ? h('span', null, h('b', null, s.sessions.length), ` session${s.sessions.length === 1 ? '' : 's'} in 3 wks`) : null),
            examChips(s.exams, today),
            h('div', { class: 'cls-card-next' }, h('div', { class: 'flabel' }, 'Next deadline'), nextLabel(s.next)))))) : null;
      };
      body = h('div', { class: 'cls-body' },
        c.calendarError ? h('div', { class: 'banner soft' }, 'Some calendars could not be loaded, so sessions and deadlines may be missing.') : null,
        gridFor('class', 'Classes'), gridFor('activity', 'Activities'),
        unassigned ? h('p', { class: 'hint' }, `${unassigned} open task${unassigned === 1 ? ' has' : 's have'} no class or activity. `, h('a', { href: '#tasks', onclick: () => { prefs.cls = 'none'; savePrefs(); } }, 'See them in Tasks')) : null,
        brainstormBoard({ title: 'Brainstorm', compact: true }));
    } else {
      const s = sel;
      const table = s.open.length && isMobile() ? h('ul', { class: 'tasks' }, s.open.map((x) => taskRow(x, today))) : s.open.length ? h('table', { class: 'ttable' },
        h('colgroup', null, h('col', { style: 'width:40px' }), h('col'), h('col', { class: 'w-due' }), h('col', { class: 'w-area' }), h('col', { class: 'w-prio' }), h('col', { class: 'w-status' }), h('col', { style: 'width:38px' })),
        h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr-only' }, 'Done')), h('th', null, 'Task'), h('th', null, 'Due'), h('th', null, 'Area'), h('th', null, 'Priority'), h('th', null, 'Status'), h('th', null, h('span', { class: 'sr-only' }, 'Open')))),
        h('tbody', null, s.open.map((x) => taskTableRow(x, today)))) : h('div', { class: 'empty soft' }, 'No open tasks. Nice.');
      body = h('div', { class: 'cls-body' },
        examChips(s.exams, today) ? h('div', { class: 'exam-banner' }, h('div', { class: 'flabel' }, 'Exams'), examChips(s.exams, today)) : null,
        h('section', { class: 'cls-section' }, h('div', { class: 'cls-sec-head' }, h('h2', { class: 'cls-h2' }, 'Open tasks', h('span', { class: 'count' }, s.open.length)),
          h('button', { type: 'button', class: 'btn small', onclick: () => openTaskSheet(null, { classes: [s.option] }) }, '+ Add task')), h('div', { class: 'ttable-wrap' }, table)),
        h('div', { class: 'cls-cols' },
          card('Upcoming sessions', { count: s.sessions.length, action: h('span', { class: 'faint small' }, 'Next 3 weeks') },
            s.sessions.length ? h('ul', { class: 'cev-list' }, s.sessions.map(evLine)) : h('div', { class: 'empty' }, c.calendarError ? 'Calendar unavailable right now.' : 'No sessions on the calendar in the next 3 weeks.')),
          card('Canvas deadlines', { count: s.deadlines.length, action: h('span', { class: 'faint small' }, 'Next 6 weeks') },
            s.deadlines.length ? h('ul', { class: 'cev-list' }, s.deadlines.map(evLine)) : h('div', { class: 'empty' }, 'No deadlines on the calendar.'))),
        h('section', { class: 'cls-section' }, h('h2', { class: 'cls-h2' }, 'Recently done', h('span', { class: 'count' }, s.done.length)),
          s.done.length ? h('ul', { class: 'tasks cls-done' }, s.done.map((x) => taskRow(x, today))) : h('div', { class: 'empty soft' }, 'Nothing marked done yet.')),
        groupForClassKey(s.key) ? brainstormBoard({ filterGroup: groupForClassKey(s.key), title: `Brainstorm · ${groupForClassKey(s.key)}`, compact: true }) : null);
    }
    const s = sel;
    return h('div', { class: 'view dview' },
      dHead({ eyebrow: isBrainstorm ? 'Notion · Dayline Brainstorm' : s ? (s.kind === 'class' ? `Class · ${s.option}` : 'Activity') : 'Notion · Calendars',
        title: isBrainstorm ? 'Brainstorm' : s ? s.name : 'Classes & activities',
        summary: isBrainstorm ? ['Sticky notes for ideas, clubs and classes — tag and pin as you go']
          : s ? [h('b', null, `${s.open.length} open`), s.overdue ? [' · ', h('b', { class: 'late' }, `${s.overdue} overdue`)] : null,
              s.exams?.midterm?.key >= today ? [' · midterm ', h('b', null, examCountdown(s.exams.midterm.key, today).text)] : null,
              s.exams?.final?.key >= today ? [' · final ', h('b', null, examCountdown(s.exams.final.key, today).text)] : null,
              ' · next deadline: ', s.next ? `${relDay(s.next.key)} (${s.next.label})` : 'none']
          : [h('b', null, `${stats.filter((x) => x.kind === 'class').length} classes`), ` · ${stats.filter((x) => x.kind === 'activity').length} activities · `, h('b', null, `${tagged} open tasks tagged`), unassigned ? ` · ${unassigned} untagged` : null],
        actions: isBrainstorm ? [h('a', { class: 'btn', href: '#classes' }, '← Classes')] : [!taskCaps.classes ? h('span', { class: 'faint small' }, 'Add a “Class / Activity” column in Notion to tag tasks') : null, h('button', { type: 'button', class: 'btn primary', onclick: () => openTaskSheet(null, s ? { classes: [s.option] } : {}) }, '+ New task')] }),
      isMobile() ? h('div', { class: 'm-stack' }, mNav, body) : h('div', { class: 'cls-layout' }, nav, body));
  }

  function taskTableRow(task, today) {
    const tr = h('tr', { class: `trow${task.done ? ' done' : ''}`, dataset: { id: task.id } });
    const check = h('button', { type: 'button', class: `check p-${task.priority || 'none'}`, 'aria-label': task.done ? `Mark "${task.name}" not done` : `Mark "${task.name}" done`, onclick: () => toggleDone(task, tr) }, icon(ICON.check));
    // Name: click to rename inline
    const nameTd = h('td', { class: 'c-name' });
    const showName = () => fill(nameTd, 
      h('span', { class: 'tname', role: 'button', tabindex: '0', title: 'Open details (double-click to rename)', onclick: (e) => { if (e.detail <= 1) openTimer = setTimeout(() => openTaskSheet(task), 220); }, ondblclick: () => { clearTimeout(openTimer); editName(); }, onkeydown: (e) => { if (e.key === 'Enter') openTaskSheet(task); if (e.key === 'F2') editName(); } }, task.name),
      task.status === 'In progress' ? h('span', { class: 'prog' }, 'In progress') : null,
      classTags(task),
      taskIcons(task),
      whoTag(task.addedBy));
    let openTimer = null;
    function editName() {
      const inp = h('input', { type: 'text', class: 'cell-input', value: task.name, maxlength: '300', 'aria-label': 'Task name' });
      let finished = false;
      const finish = (save) => {
        if (finished) return; finished = true;
        const v = inp.value.trim().replace(/\s+/g, ' ');
        if (save && v && v !== task.name) updateTask(task.id, { name: v }, 'Renamed'); else showName();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
      inp.addEventListener('blur', () => finish(true));
      fill(nameTd, inp); inp.focus(); inp.select();
    }
    showName();
    // Due: click the tag to pick a date
    const dueTd = h('td', { class: 'c-due' });
    const showDue = () => fill(dueTd, h('button', { type: 'button', class: 'cell-btn', title: 'Change due date', onclick: editDue }, dateTag(task, today) || h('span', { class: 'faint' }, '+ Date')));
    function editDue() {
      const inp = h('input', { type: 'date', class: 'cell-input', value: task.due?.key || '', 'aria-label': 'Due date' });
      let finished = false;
      const finish = (save) => {
        if (finished) return; finished = true;
        const v = inp.value || null;
        if (save && v !== (task.due?.key || null)) updateTask(task.id, { due: v }, v ? 'Due date saved' : 'Due date cleared'); else showDue();
      };
      inp.addEventListener('change', () => finish(true));
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } if (e.key === 'Enter') finish(true); });
      fill(dueTd, inp); inp.focus();
      try { inp.showPicker(); } catch { /* not supported */ }
    }
    showDue();
    const sel = (key, options, empty) => {
      const s = h('select', { class: `cell-select${key === 'priority' && task.priority ? ' pr-' + task.priority : ''}`, 'aria-label': `${key} for ${task.name}`,
        onchange: () => updateTask(task.id, { [key]: s.value || null }, key === 'status' && s.value === 'Done' ? 'Marked done' : 'Saved') },
      empty ? h('option', { value: '' }, empty) : null, options.map((o) => h('option', { value: o, selected: task[key] === o }, o)));
      return s;
    };
    tr.append(
      h('td', { class: 'c-check' }, check), nameTd, dueTd,
      h('td', { class: 'c-area' }, h('span', { class: `area a-${task.area || 'Other'}` }), sel('area', AREAS, 'No area')),
      h('td', { class: 'c-prio' }, sel('priority', PRIORITIES, '—')),
      h('td', { class: 'c-status' }, sel('status', STATUSES, null)),
      h('td', { class: 'c-open' }, h('button', { type: 'button', class: 'row-open', 'aria-label': `Open "${task.name}"`, title: 'Open details', onclick: () => openTaskSheet(task) }, icon(ICON.right))));
    return tr;
  }

  // ---------- Jobs (kanban + table) ----------
  let jobQuery = '';
  async function viewJobs() {
    const [d] = await Promise.all([loadJobs(), loadNetwork().catch(() => null)]); // network: "N contacts at …" + Say thanks
    const today = d.today;
    const view = jobPrefs.jobsView === 'table' ? 'table' : 'board';
    const counts = {};
    for (const s of BOARD_ORDER) counts[s] = d.tracker.filter((j) => j.status === s).length;
    const trackOk = (j) => (jobPrefs.jobTrack || 'All') === 'All' || j.track === jobPrefs.jobTrack;
    const sortJobs = (list) => [...list].sort((a, b) => (a.interview || a.nextDate || a.deadline || '9999').localeCompare(b.interview || b.nextDate || b.deadline || '9999') || (b.applied || '').localeCompare(a.applied || ''));
    const host = h('div', { class: 'jobs-host' });

    const showClosed = !!jobPrefs.showClosed;
    const boardCols = showClosed ? BOARD_ORDER : BOARD_ORDER.filter((s) => s !== 'Closed');
    const paint = () => {
      const list = d.tracker.filter(trackOk).filter(whoOk(jobPrefs.jobWho))
        .filter((j) => showClosed || j.status !== 'Closed')
        .filter((j) => matches(jobQuery, j.company, j.role, j.nextAction, j.notes, j.location));
      if (isMobile()) {
        const stage = boardCols.includes(jobPrefs.mStage) ? jobPrefs.mStage : 'Active';
        const stages = ['Active', ...boardCols];
        const mRound = stage === 'Interviewing' && d.caps.round && ROUNDS.includes(jobPrefs.mRound) ? jobPrefs.mRound : 'All rounds';
        const inStage = (j) => (stage === 'Active' ? j.status !== 'Closed' : j.status === stage && (mRound === 'All rounds' || j.round === mRound));
        const items = sortJobs(list.filter(inStage)).sort((a, b) => (stage === 'Active' ? BOARD_ORDER.indexOf(a.status) - BOARD_ORDER.indexOf(b.status) : 0));
        fill(host,
          h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'Stage' }, stages.map((st) => h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(stage === st), onclick: () => { jobPrefs.mStage = st; saveJobPrefs(); paint(); } },
            st, h('span', { class: 'n' }, st === 'Active' ? list.filter((j) => j.status !== 'Closed').length : list.filter((j) => j.status === st).length)))),
          stage === 'Interviewing' && d.caps.round ? h('div', { class: 'chips wrap round-chips', role: 'group', 'aria-label': 'Interview round' }, ['All rounds', ...ROUNDS].map((r) => h('button', { type: 'button', class: 'fchip sm', 'aria-pressed': String(mRound === r), onclick: () => { jobPrefs.mRound = r; saveJobPrefs(); paint(); } },
            r, h('span', { class: 'n' }, r === 'All rounds' ? list.filter((j) => j.status === 'Interviewing').length : list.filter((j) => j.status === 'Interviewing' && j.round === r).length)))) : null,
          items.length ? h('div', { class: 'mlist' }, items.map((j) => jobCard(j, today))) : h('div', { class: 'empty soft' }, jobQuery ? `No jobs match “${jobQuery}”.` : `No ${stage === 'Active' ? 'active' : stage} jobs.`));
        return;
      }
      if (view === 'board') {
        const dragCard = (j) => {
          const c = jobCard(j, today);
          c.draggable = true;
          c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/dayline-job', j.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
          c.addEventListener('dragend', () => c.classList.remove('dragging'));
          return c;
        };
        // Interviewing column: one drop zone per round (Recruiter screen → Final round).
        const roundGroups = (items) => h('div', { class: 'kcol-body rounds' }, [...ROUNDS, null].map((r) => {
          const inRound = items.filter((j) => (r ? j.round === r : !ROUNDS.includes(j.round)));
          if (!r && !inRound.length) return null;
          const g = h('div', { class: 'kround', 'aria-label': r || 'Round not set',
            ondragover: (e) => { e.preventDefault(); e.stopPropagation(); g.classList.add('drop'); }, ondragleave: () => g.classList.remove('drop'),
            ondrop: (e) => { e.preventDefault(); e.stopPropagation(); g.classList.remove('drop'); const id = e.dataTransfer.getData('text/dayline-job'); const job = d.tracker.find((j) => j.id === id); if (job && r && (job.status !== 'Interviewing' || job.round !== r)) moveJob(job, 'Interviewing', d.caps, today, r); } },
          h('div', { class: 'kround-head' }, h('span', null, r || 'Round not set'), h('span', { class: 'count' }, inRound.length)),
          inRound.length ? inRound.map(dragCard) : h('div', { class: 'kempty sm' }, 'Drop here'));
          return g;
        }));
        fill(host, h('div', { class: 'kanban' }, boardCols.map((s) => {
          const items = sortJobs(list.filter((j) => j.status === s));
          const col = h('section', { class: `kcol k-${s}`, 'aria-label': s,
            ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); }, ondragleave: () => col.classList.remove('drop'),
            ondrop: (e) => { e.preventDefault(); col.classList.remove('drop'); const id = e.dataTransfer.getData('text/dayline-job'); const job = d.tracker.find((j) => j.id === id); if (job && job.status !== s) moveJob(job, s, d.caps, today); } },
          h('div', { class: 'kcol-head' }, pill(s), h('span', { class: 'count' }, items.length),
            s === 'Interested' ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Add a job', title: 'Add a job (J)', onclick: () => openAddJob('job') }, '+') : null),
          s === 'Interviewing' && d.caps.round ? roundGroups(items) : h('div', { class: 'kcol-body' }, items.length ? items.map(dragCard) : h('div', { class: 'kempty' }, s === 'Interested' ? 'Drag roles here, or use “Move to tracker” on Opportunities.' : 'Drop a card here')));
          return col;
        })));
      } else {
        const rows = [...list].sort((a, b) => BOARD_ORDER.indexOf(a.status) - BOARD_ORDER.indexOf(b.status) || (a.interview || a.nextDate || a.deadline || '9999').localeCompare(b.interview || b.nextDate || b.deadline || '9999'));
        fill(host, rows.length ? h('div', { class: 'dtable-wrap' }, h('table', { class: 'dtable' },
          h('thead', null, h('tr', null, ['Company', 'Role', 'Status', 'Location', 'Track', 'Applied', 'Next step', 'When', 'Deadline', ''].map((x) => h('th', null, x)))),
          h('tbody', null, rows.map((j) => {
            const statusSel = h('select', { class: 'cell-select', 'aria-label': `Status for ${j.company}`, onclick: (e) => e.stopPropagation(), onchange: () => moveJob(j, statusSel.value, d.caps, today) },
              ['Opportunity', ...BOARD_ORDER].map((s) => h('option', { value: s, selected: j.status === s }, s === 'Opportunity' ? 'Back to Opportunities' : s)));
            return h('tr', { class: 'drow', tabindex: '0', onclick: () => openJobSheet(j), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openJobSheet(j); } },
              h('td', { class: 'strong' }, j.company || '—', whoTag(j.addedBy)), h('td', { class: 'wrap' }, j.role), h('td', null, h('span', { class: `pill-wrap st-${j.status}` }, statusSel), j.status === 'Interviewing' && j.round && d.caps.round ? h('div', { class: 'round-sub' }, j.round) : null),
              h('td', null, j.location || '—'), h('td', null, j.track || '—'), h('td', null, j.applied ? shortDate(j.applied) : '—'),
              h('td', { class: 'wrap muted' }, j.nextAction || '—'), h('td', null, j.interview ? h('span', { class: 'soon' }, `Interview ${shortDate(j.interview)}`) : j.nextDate ? shortDate(j.nextDate) : '—'),
              h('td', null, j.status !== 'Closed' ? deadlineBit(j.deadline, today, j.status) || '—' : '—'),
              h('td', { class: 'jrow-actions' },
                j.url && /^https?:\/\//i.test(j.url) ? h('a', { href: j.url, target: '_blank', rel: 'noopener', class: 'linkish', onclick: (e) => e.stopPropagation() }, 'Posting ↗') : null,
                j.status !== 'Opportunity' && j.status !== 'Closed' ? h('button', { type: 'button', class: 'linkish danger-link', onclick: (e) => { e.stopPropagation(); removeJobFromBoard(j); } }, 'Remove') : null));
          })))) : h('div', { class: 'empty soft' }, jobQuery ? `No jobs match “${jobQuery}”.` : 'No applications yet.'));
      }
    };
    paint();

    const toolbar = h('div', { class: 'dtoolbar' },
      searchBox('Filter jobs', jobQuery, (q) => { jobQuery = q; paint(); }),
      h('div', { class: 'chips' }, ['All', 'PM', 'PMM'].map((t) => h('button', { type: 'button', class: 'fchip', 'aria-pressed': String((jobPrefs.jobTrack || 'All') === t), onclick: () => { jobPrefs.jobTrack = t; saveJobPrefs(); render(); } }, t))),
      whoFilter(d.tracker, jobPrefs.jobWho, (k) => { jobPrefs.jobWho = k; saveJobPrefs(); paint(); }),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: showClosed, onchange: (e) => { jobPrefs.showClosed = e.target.checked; saveJobPrefs(); render(); } }), 'Show closed'),
      h('div', { class: 'spacer' }),
      view === 'board' && !isMobile() ? h('span', { class: 'hint-inline' }, 'Drag cards between columns to change stage') : null,
      isMobile() ? null : seg('View', [['board', 'Board'], ['table', 'Table']], view, (k) => { jobPrefs.jobsView = k; saveJobPrefs(); render(); }));
    const active = d.tracker.filter((j) => j.status !== 'Closed').length;
    return h('div', { class: 'view dview' },
      dHead({ eyebrow: 'Recruiting · Notion pipeline', title: 'Jobs',
        summary: [h('b', null, `${active} active`), ' · ', `${counts.Applied} applied · ${counts.Interviewing} interviewing · ${counts.Interested} interested`, counts.Offer ? [' · ', h('b', null, `${counts.Offer} offer`)] : null, counts.Closed ? [' · ', showClosed ? `${counts.Closed} closed` : h('button', { type: 'button', class: 'linkish', onclick: () => { jobPrefs.showClosed = true; saveJobPrefs(); render(); } }, `${counts.Closed} closed`)] : null, ' · ', h('a', { href: '#opps' }, `${d.opportunities.length} opportunities`)],
        actions: [h('button', { type: 'button', class: 'btn', onclick: () => openJobForm({ kind: 'job' }) }, 'Enter manually'), h('button', { type: 'button', class: 'btn primary', onclick: () => openAddJob('job') }, '+ Add from URL')] }),
      !d.caps.applied || !d.caps.nextDate || !d.caps.interested ? h('div', { class: 'banner' }, 'Optional Notion columns are missing, so a few fields are hidden. See SETUP.md step 4.') : null,
      toolbar, host);
  }
  async function moveJob(job, status, caps, today, round) {
    const prev = { status: job.status };
    const patch = { status };
    if (status === 'Applied' && caps?.applied && !job.applied) { patch.applied = today; prev.applied = null; }
    if (round !== undefined && caps?.round) { patch.round = round; prev.round = job.round || null; }
    else if (status === 'Interviewing' && caps?.round && !job.round) { patch.round = ROUNDS[0]; prev.round = null; }
    if (status === job.status && !('round' in patch)) return;
    try {
      const saved = await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: patch });
      const label = status === 'Opportunity' ? 'Opportunities' : status === 'Interviewing' && patch.round ? patch.round : status;
      toast(`${job.company || 'Job'} → ${label}`, { label: 'Undo', fn: () => updateJob(job.id, prev, 'Moved back') });
      render();
      if (status === 'Offer' && job.status !== 'Offer') setTimeout(() => openThankPanel(saved), 350);
    } catch (e) { toast(e.message); render(); }
  }

  // ---------- Opportunities (table/cards + detail panel) ----------
  let oppQuery = '';
  let oppSel = null;
  async function viewOpps() {
    const d = await loadJobs();
    const today = d.today;
    const view = isMobile() || jobPrefs.oppsView === 'cards' ? 'cards' : 'table';
    const live = (j) => !!j.url && !/\(watch\)/i.test(j.role);
    const filtered = () => {
      let list = d.opportunities.filter((j) => jobPrefs.oppTrack === 'All' || j.track === jobPrefs.oppTrack);
      if (jobPrefs.oppBay) list = list.filter((j) => d.options.bayArea.includes(j.location));
      list = list.filter(whoOk(jobPrefs.oppWho));
      list = list.filter((j) => matches(oppQuery, j.company, j.role, j.notes, j.location, j.source));
      return list.sort(jobPrefs.oppSort === 'deadline'
        ? (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || (b.fit ?? -1) - (a.fit ?? -1)
        : (a, b) => (b.fit ?? -1) - (a.fit ?? -1) || Number(live(b)) - Number(live(a)) || (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    };
    const host = h('div', { class: 'opps-host' });
    const detail = h('aside', { class: 'detail' });
    let current = [];
    const fitBadge = (j) => (j.fit != null ? h('span', { class: `fit ${j.fit >= 8 ? 'hi' : j.fit >= 6 ? 'mid' : ''}`, title: 'Fit score from your Pipeline' }, `Fit ${j.fit}`) : h('span', { class: 'fit' }, '—'));
    const select = (id, fromTap) => {
      oppSel = id;
      if (isMobile()) {
        const j = current.find((x) => x.id === id);
        if (fromTap && j) openSheet([oppDetail(j)], 'panel');
        return;
      }
      host.querySelectorAll('[data-id]').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
      const j = current.find((x) => x.id === id);
      fill(detail, j ? oppDetail(j) : h('div', { class: 'empty' }, 'Select a role to see details.'));
    };
    function oppDetail(j) {
      const safeUrl = j.url && /^https?:\/\//i.test(j.url) ? j.url : null;
      return h('div', { class: 'detail-inner' },
        h('div', { class: 'detail-top' }, h('div', { class: 'detail-co' }, j.company || 'Company?'), fitBadge(j)),
        h('h2', { class: 'detail-role' }, j.role),
        h('div', { class: 'detail-meta' },
          j.location ? h('span', { class: 'tag' }, j.location) : null, j.track ? h('span', { class: 'tag' }, j.track) : null,
          j.source ? h('span', { class: 'tag' }, j.source) : null, j.priority ? h('span', { class: 'tag' }, `${j.priority} priority`) : null,
          !live(j) ? h('span', { class: 'tag watch' }, 'Watching · no posting yet') : null, whoTag(j.addedBy)),
        h('dl', { class: 'detail-dl' },
          h('dt', null, 'Deadline'), h('dd', null, j.deadline ? deadlineBit(j.deadline, today, j.status) : 'Not set'),
          h('dt', null, 'Next step'), h('dd', null, j.nextAction || '—'),
          h('dt', null, 'Posting'), h('dd', null, safeUrl ? h('a', { href: safeUrl, target: '_blank', rel: 'noopener' }, new URL(safeUrl).hostname.replace(/^www\./, '') + ' ↗') : '—')),
        h('div', { class: 'detail-label' }, 'Fit note'),
        h('div', { class: 'detail-notes' }, j.notes || 'No notes yet.'),
        h('div', { class: 'detail-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => moveToTracker(j) }, 'Move to tracker as Interested'),
          h('button', { type: 'button', class: 'btn', onclick: () => openJobSheet(j) }, 'Edit'),
          safeUrl ? h('a', { class: 'btn', href: safeUrl, target: '_blank', rel: 'noopener' }, 'Open posting ↗') : null));
    }
    const paint = () => {
      current = filtered();
      if (!current.length) { fill(host, h('div', { class: 'empty soft' }, 'No opportunities match these filters.')); detail.replaceChildren(); return; }
      if (view === 'table') {
        fill(host, h('div', { class: 'dtable-wrap' }, h('table', { class: 'dtable opps' },
          h('colgroup', null, h('col', { style: 'width:68px' }), h('col', { class: 'w-co' }), h('col'), h('col', { style: 'width:104px' }), h('col', { style: 'width:62px' }), h('col', { style: 'width:104px' }), h('col', { style: 'width:78px' })),
          h('thead', null, h('tr', null, ['Fit', 'Company', 'Role', 'Location', 'Track', 'Deadline', ''].map((x) => h('th', null, x)))),
          h('tbody', null, current.map((j) => h('tr', { class: 'drow', tabindex: '0', dataset: { id: j.id }, onclick: () => select(j.id), onfocus: () => select(j.id), ondblclick: () => openJobSheet(j) },
            h('td', null, fitBadge(j)), h('td', { class: 'strong' }, j.company || '—', whoTag(j.addedBy)), h('td', { class: 'wrap' }, j.role, !live(j) ? h('span', { class: 'watch inline' }, 'watching') : null),
            h('td', null, j.location || '—'), h('td', null, j.track || '—'), h('td', null, deadlineBit(j.deadline, today, j.status) || h('span', { class: 'faint' }, '—')),
            h('td', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small', onclick: (e) => { e.stopPropagation(); moveToTracker(j); } }, 'Move'))))))));
      } else {
        fill(host, h('div', { class: 'ocards' }, current.map((j) => h('button', { type: 'button', class: 'ocard', dataset: { id: j.id }, onclick: () => select(j.id, true), ondblclick: () => openJobSheet(j) },
          h('div', { class: 'jtop' }, h('span', { class: 'jco' }, j.company || 'Company?', whoTag(j.addedBy)), fitBadge(j)),
          h('div', { class: 'jrole' }, j.role),
          h('div', { class: 'jmeta' }, j.location ? h('span', null, j.location) : null, j.track ? h('span', null, j.track) : null, deadlineBit(j.deadline, today, j.status), !live(j) ? h('span', { class: 'watch' }, 'Watching') : null),
          j.notes ? h('div', { class: 'jnote' }, truncate(j.notes.replace(/\s+/g, ' '), 120)) : null))));
      }
      select(current.some((j) => j.id === oppSel) ? oppSel : current[0].id);
    };
    paint();
    viewOpps.move = (dir) => { const i = current.findIndex((j) => j.id === oppSel); const next = current[Math.min(current.length - 1, Math.max(0, i + dir))]; if (next) { select(next.id); host.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); } };

    const soon = d.opportunities.filter((j) => j.deadline && j.deadline >= today && diffDays(today, j.deadline) <= 7).length;
    const toolbar = h('div', { class: 'dtoolbar' },
      searchBox('Filter roles, companies, notes', oppQuery, (q) => { oppQuery = q; paint(); }),
      h('div', { class: 'chips' }, ['All', 'PM', 'PMM'].map((t) => h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(jobPrefs.oppTrack === t), onclick: () => { jobPrefs.oppTrack = t; saveJobPrefs(); render(); } },
        t, h('span', { class: 'n' }, t === 'All' ? d.opportunities.length : d.opportunities.filter((j) => j.track === t).length)))),
      whoFilter(d.opportunities, jobPrefs.oppWho, (k) => { jobPrefs.oppWho = k; saveJobPrefs(); paint(); }),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: jobPrefs.oppBay, onchange: (e) => { jobPrefs.oppBay = e.target.checked; saveJobPrefs(); render(); } }), 'Bay Area only'),
      h('div', { class: 'spacer' }),
      seg('Sort', [['fit', 'Best fit'], ['deadline', 'Deadline']], jobPrefs.oppSort, (k) => { jobPrefs.oppSort = k; saveJobPrefs(); render(); }),
      isMobile() ? null : seg('View', [['table', 'Table'], ['cards', 'Cards']], view, (k) => { jobPrefs.oppsView = k; saveJobPrefs(); render(); }));
    return h('div', { class: 'view dview' },
      dHead({ eyebrow: 'Not applied yet · PM / PMM internships · Bay Area first', title: 'Opportunities',
        summary: [h('b', null, `${d.opportunities.length} roles`), ` · ${d.opportunities.filter(live).length} with a live posting`, soon ? [' · ', h('b', { class: 'late' }, `${soon} due within 7 days`)] : null],
        actions: [h('button', { type: 'button', class: 'btn primary', onclick: () => openAddJob('opp') }, '+ Add opportunity')] }),
      toolbar,
      isMobile() ? host : h('div', { class: 'split opp-split' }, h('div', { class: 'split-main' }, host), detail));
  }

  // =====================================================================
  // ---------- Coffee chats (Notion People + Touch points) ----------
  // =====================================================================
  let netData = null, netAt = 0;
  async function loadNetwork(fresh = false) {
    if (!fresh && netData && Date.now() - netAt < 30000) return netData;
    netData = await api(`/api/network${fresh ? '?fresh=1' : ''}`);
    netAt = Date.now();
    return netData;
  }
  const netDirty = () => { netAt = 0; thanksAt = 0; };
  const netPrefs = Object.assign({ q: '', company: '', strength: '', tag: '', mapMode: '' }, safeJson(localStorage.getItem('dayline.net')));
  const saveNetPrefs = () => localStorage.setItem('dayline.net', JSON.stringify(netPrefs));
  const personById = (id) => netData?.people.find((p) => p.id === id) || null;
  const COMPANY_COLORS = ['#5b3d9b', '#0f7b6c', '#c2410c', '#2563eb', '#b91c5c', '#a16207', '#4d7c0f', '#0e7490', '#7c3aed', '#be123c', '#475569', '#9333ea'];
  function companyColor(name) {
    const s = String(name || '').toLowerCase();
    if (!s) return '#94a3b8';
    let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return COMPANY_COLORS[x % COMPANY_COLORS.length];
  }
  const strengthChip = (s) => (s ? h('span', { class: `strength s-${s.toLowerCase()}` }, s) : null);
  function followChip(p, today) {
    if (!p.nextFollowUp) return null;
    const d = diffDays(today, p.nextFollowUp);
    const text = d < 0 ? `Follow up · ${-d === 1 ? '1 day' : `${-d} days`} late` : d === 0 ? 'Follow up today' : d === 1 ? 'Follow up tomorrow' : `Follow up ${d < 7 ? fmtKey(p.nextFollowUp, { weekday: 'short' }) : shortDate(p.nextFollowUp)}`;
    return h('span', { class: `fu fu-${p.followUpState || 'later'}` }, text);
  }
  const relDay = (k, today) => { if (!k) return ''; const d = diffDays(k, today); return d === 0 ? 'today' : d === 1 ? 'yesterday' : d > 1 && d < 7 ? `${d} days ago` : shortDate(k); };
  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
    return Promise.resolve(fallback());
    function fallback() { const ta = h('textarea', { class: 'copy-buffer' }, text); document.body.append(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); return ok; }
  }
  const mailtoHref = (email, subject, body) => `mailto:${encodeURIComponent(email || '')}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
  const safeHttp = (u) => (u && /^https?:\/\//i.test(u) ? u : null);

  /** Contacts at a job's company (company match or explicit Pipeline link). */
  function contactsForJob(job) {
    if (!netData || !job) return [];
    return netData.people.filter((p) => (p.matchedJobIds || []).includes(job.id));
  }
  function jobNetRow(job) {
    if (job.status === 'Closed') return null;
    const n = contactsForJob(job).length;
    const thanksBtn = job.status === 'Offer' && netData ? h('button', { type: 'button', class: 'jthanks', onclick: (e) => { e.stopPropagation(); openThankPanel(job); } }, 'Say thanks') : null;
    if (!n && !thanksBtn) return null;
    return h('div', { class: 'jnet' },
      n ? h('button', { type: 'button', class: 'jcontacts', title: 'People in your network at this company', onclick: (e) => { e.stopPropagation(); netPrefs.company = job.company || ''; netPrefs.q = ''; saveNetPrefs(); location.hash = 'chats'; } },
        `${n} ${n === 1 ? 'contact' : 'contacts'} at ${job.company}`) : null,
      thanksBtn);
  }
  function jobContactsPanel(job) {
    const host = h('div', { class: 'field job-net' });
    const paint = () => {
      const list = contactsForJob(job);
      fill(host,
        h('div', { class: 'flabel' }, `Network at ${job.company || 'this company'}`, list.length ? h('span', { class: 'flabel-note' }, ` · ${list.length}`) : null),
        list.length ? h('ul', { class: 'mini-people' }, list.map((p) => h('li', null, h('button', { type: 'button', class: 'linkish', onclick: () => openPersonSheet(p.id) }, p.name), h('span', { class: 'faint' }, [p.role, p.lastTouch ? `last ${p.lastTouch.type.toLowerCase()} ${relDay(p.lastTouch.date, todayStr())}` : 'no touches yet'].filter(Boolean).join(' · '))))) : h('div', { class: 'hint' }, 'No one from your network here yet.'),
        h('div', { class: 'row-btns' },
          h('button', { type: 'button', class: 'btn small', onclick: () => openLogChat({ company: job.company, jobId: job.id }) }, '+ Log coffee chat'),
          ['Applied', 'Interviewing', 'Offer'].includes(job.status) ? h('button', { type: 'button', class: 'btn small', onclick: () => openLogInterview(job) }, '+ Log interview') : null,
          job.status === 'Interviewing' || job.status === 'Offer' ? h('button', { type: 'button', class: 'btn small', onclick: () => openThankYouDrafts({ kind: 'interview', jobId: job.id, round: job.round, date: job.interview }) }, 'Draft interview thank-you') : null));
    };
    if (netData) paint(); else { host.append(h('div', { class: 'hint' }, 'Loading network…')); loadNetwork().then(paint, () => fill(host)); }
    return host;
  }

  // ---- Coffee chats page ----
  async function viewChats(arg) {
    const [d, th] = await Promise.all([loadNetwork(), loadThanks().catch(() => null)]);
    const today = d.today || todayStr();
    const mode = arg === 'map' ? 'map' : 'list';
    const companies = [...new Set(d.people.map((p) => p.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const tags = [...new Set([...(d.options.tags || []), ...d.people.flatMap((p) => p.tags || [])])];
    if (netPrefs.company && !companies.includes(netPrefs.company)) netPrefs.company = '';
    const host = h('div', { class: 'chats-host' });
    const fuRank = { overdue: 0, today: 1, soon: 2, later: 3 };
    const filtered = () => d.people
      .filter((p) => !netPrefs.company || p.company === netPrefs.company)
      .filter((p) => !netPrefs.strength || p.strength === netPrefs.strength)
      .filter((p) => !netPrefs.tag || (p.tags || []).includes(netPrefs.tag))
      .filter((p) => matches(netPrefs.q, p.name, p.company, p.role, p.school, p.howMet, p.notes, (p.tags || []).join(' ')))
      .sort((a, b) => (fuRank[a.followUpState] ?? 4) - (fuRank[b.followUpState] ?? 4) || String(a.nextFollowUp || '').localeCompare(String(b.nextFollowUp || '')) || String(b.lastTouch?.date || '').localeCompare(String(a.lastTouch?.date || '')) || a.name.localeCompare(b.name));
    const personCard = (p) => h('div', { class: `pcard${p.followUpState === 'overdue' ? ' is-overdue' : ''}`, role: 'button', tabindex: '0', dataset: { id: p.id },
      onclick: () => openPersonSheet(p.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPersonSheet(p.id); } } },
    h('div', { class: 'pc-top' },
      h('span', { class: 'pc-dot', style: `background:${companyColor(p.company)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'pc-name' }, p.name), strengthChip(p.strength), whoTag(p.addedBy, { botOnly: true })),
    h('div', { class: 'pc-role' }, [p.role, p.company].filter(Boolean).join(' · ') || 'No company yet'),
    p.tags?.length ? h('div', { class: 'pc-tags' }, p.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
    h('div', { class: 'pc-meta' },
      h('span', null, p.lastTouch ? `Last: ${p.lastTouch.type} · ${relDay(p.lastTouch.date, today)}` : 'No touch points yet'),
      h('span', null, `${p.touchCount} ${p.touchCount === 1 ? 'touch' : 'touches'}`)),
    followChip(p, today));
    const paintList = () => {
      const list = filtered();
      fill(host, list.length ? h('div', { class: 'pgrid' }, list.map(personCard))
        : h('div', { class: 'empty soft chats-empty' }, d.people.length ? 'No one matches these filters.' : [h('b', null, 'No people yet.'), ' Log your first coffee chat and Dayline adds the person to your Notion People list.', h('div', null, h('button', { type: 'button', class: 'btn primary', onclick: () => openLogChat({}) }, '+ Log coffee chat'))]));
    };
    const paintMap = () => {
      const list = filtered();
      const graphMode = netPrefs.mapMode ? netPrefs.mapMode !== 'company' : !isMobile(); // phones default to the simpler company view
      const box = h('div', { class: 'netmap-wrap' });
      fill(host, h('div', { class: 'map-bar' }, seg('Map style', [['graph', 'Graph'], ['company', 'By company']], graphMode ? 'graph' : 'company', (k) => { netPrefs.mapMode = k; saveNetPrefs(); paintMap(); }),
        h('span', { class: 'hint-inline' }, graphMode ? (isMobile() ? 'Pinch or drag to move · tap a person' : 'Scroll to zoom · drag to pan · click a person') : 'Grouped by company · intros shown as “via”')), box);
      if (!list.length) { fill(box, h('div', { class: 'empty soft' }, d.people.length ? 'No one matches these filters.' : 'Your network map appears here once you add people.')); return; }
      if (graphMode) networkGraph(box, list, d); else fill(box, companyGroups(list, d));
    };
    const paint = () => (mode === 'map' ? paintMap() : paintList());
    paint();
    const stat = (n, label, cls) => h('div', { class: `nstat ${cls || ''}` }, h('b', null, n), h('span', null, label));
    const stats = h('div', { class: 'nstats' },
      stat(d.stats.chatsThisWeek, 'chats this week'), stat(d.stats.chatsThisMonth, 'this month'),
      stat(d.stats.followUpsDue, 'follow-ups due', d.stats.followUpsDue ? 'late' : ''), stat(d.stats.people, d.stats.people === 1 ? 'person' : 'people'),
      d.stats.byCompany.length ? h('div', { class: 'nstat-co' }, d.stats.byCompany.slice(0, isMobile() ? 4 : 7).map((c) => h('button', { type: 'button', class: 'co-chip', 'aria-pressed': String(netPrefs.company === c.company),
        onclick: () => { netPrefs.company = netPrefs.company === c.company || c.company === 'No company' ? '' : c.company; saveNetPrefs(); render(); } }, h('i', { style: `background:${companyColor(c.company === 'No company' ? '' : c.company)}` }), c.company, h('span', { class: 'n' }, c.count)))) : null);
    const select = (label, value, options, onPick) => h('select', { class: 'who-filter', 'aria-label': label, onchange: (e) => onPick(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
    const toolbar = h('div', { class: 'dtoolbar' },
      searchBox('Search people, companies, notes', netPrefs.q, (q) => { netPrefs.q = q; saveNetPrefs(); paint(); }),
      select('Company', netPrefs.company, [['', 'All companies'], ...companies.map((c) => [c, c])], (v) => { netPrefs.company = v; saveNetPrefs(); paint(); }),
      h('div', { class: 'chips' }, ['', 'Cold', 'Warm', 'Strong'].map((st) => h('button', { type: 'button', class: 'fchip', 'aria-pressed': String((netPrefs.strength || '') === st), onclick: () => { netPrefs.strength = st; saveNetPrefs(); render(); } }, st || 'Any strength'))),
      select('Tag', netPrefs.tag, [['', 'All tags'], ...tags.map((t) => [t, t])], (v) => { netPrefs.tag = v; saveNetPrefs(); paint(); }),
      h('div', { class: 'spacer' }),
      seg('View', [['list', 'People'], ['map', 'Network map']], mode, (k) => { location.hash = k === 'map' ? 'chats/map' : 'chats'; }));
    return h('div', { class: 'view dview' },
      dHead({ eyebrow: 'Recruiting · Notion People + Touch points', title: 'Coffee chats',
        summary: [h('b', null, `${d.stats.people} ${d.stats.people === 1 ? 'person' : 'people'}`), ` · ${d.stats.touches} touch points`, d.stats.followUpsDue ? [' · ', h('b', { class: 'late' }, `${d.stats.followUpsDue} follow-ups due`)] : null, d.backend === 'file' ? ' · sample data' : null],
        actions: [h('button', { type: 'button', class: 'btn', onclick: () => openPersonForm(null) }, 'Add person'), h('button', { type: 'button', class: 'btn primary', id: 'logChatBtn', onclick: () => openLogChat({}) }, '+ Log coffee chat')] }),
      th && mode === 'list' ? thanksSection(th) : null,
      stats, toolbar, host);
  }

  // ---- by-company grouping (map alternative, default-friendly on phones) ----
  function companyGroups(list) {
    const groups = new Map();
    for (const p of list) { const k = p.company || 'No company'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    const byId = new Map(netData.people.map((p) => [p.id, p]));
    return h('div', { class: 'cogroups' }, [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([co, ps]) => h('section', { class: 'cogroup' },
      h('header', null, h('i', { style: `background:${companyColor(co === 'No company' ? '' : co)}` }), h('b', null, co), h('span', { class: 'count' }, ps.length)),
      h('ul', null, ps.map((p) => h('li', null, h('button', { type: 'button', class: 'co-person', onclick: () => openPersonSheet(p.id) },
        h('span', { class: 'cp-name' }, p.name), strengthChip(p.strength),
        h('span', { class: 'cp-sub' }, [p.role, p.introducedBy?.length ? `via ${p.introducedBy.map((x) => byId.get(x)?.name).filter(Boolean).join(', ')}` : null, `${p.touchCount} ${p.touchCount === 1 ? 'touch' : 'touches'}`].filter(Boolean).join(' · ')))))))));
  }

  // ---- network graph (d3-force, self-hosted, rendered to SVG with our own pan/zoom) ----
  let d3Promise = null;
  function loadD3() {
    if (window.d3?.forceSimulation) return Promise.resolve(window.d3);
    if (!d3Promise) d3Promise = new Promise((resolve, reject) => { const s = h('script', { src: '/vendor/d3-force.min.js' }); s.onload = () => resolve(window.d3); s.onerror = () => { d3Promise = null; reject(new Error('Could not load the map library')); }; document.head.append(s); });
    return d3Promise;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}, ...kids) { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); for (const k of kids) if (k != null) el.append(k); return el; }
  async function networkGraph(box, list, d) {
    fill(box, h('div', { class: 'empty soft' }, 'Drawing your network…'));
    let d3;
    try { d3 = await loadD3(); } catch (e) { fill(box, h('div', { class: 'banner' }, e.message), companyGroups(list)); return; }
    const today = d.today || todayStr();
    const ids = new Set(list.map((p) => p.id));
    const companies = [...new Set(list.map((p) => p.company || ''))];
    const anchor = Object.fromEntries(companies.map((c, i) => { const a = (i / Math.max(1, companies.length)) * Math.PI * 2 - Math.PI / 2; const r = companies.length > 1 ? 150 + Math.min(120, companies.length * 8) : 0; return [c, { x: Math.cos(a) * r, y: Math.sin(a) * r }]; }));
    const recency = (p) => { if (!p.lastTouch?.date) return 0.45; const age = diffDays(p.lastTouch.date, today); return age <= 14 ? 1 : age <= 45 ? 0.8 : age <= 120 ? 0.62 : 0.5; };
    const nodes = [{ id: 'me', name: 'You', me: true, fx: 0, fy: 0, r: 20 }, ...list.map((p) => ({ id: p.id, p, name: p.name, company: p.company || '', r: Math.min(20, 8 + Math.sqrt(p.touchCount || 0) * 4), op: recency(p) }))];
    const links = [];
    for (const p of list) {
      const intro = (p.introducedBy || []).filter((x) => ids.has(x));
      if (intro.length) for (const s of intro) links.push({ source: s, target: p.id, kind: 'intro' });
      else links.push({ source: 'me', target: p.id, kind: 'direct' });
    }
    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((n) => n.id).distance((l) => (l.kind === 'intro' ? 70 : 130)).strength((l) => (l.kind === 'intro' ? 0.9 : 0.15)))
      .force('charge', d3.forceManyBody().strength(-220))
      .force('collide', d3.forceCollide().radius((n) => n.r + 16))
      .force('x', d3.forceX((n) => (n.me ? 0 : anchor[n.company].x)).strength(0.18))
      .force('y', d3.forceY((n) => (n.me ? 0 : anchor[n.company].y)).strength(0.18))
      .stop();
    for (let i = 0; i < 320; i++) sim.tick();

    for (let i = 0; i < 40 && !box.isConnected; i++) await new Promise((r) => requestAnimationFrame(r)); // measure after mount
    if (!box.isConnected) return;
    const W = box.clientWidth || 800, H = Math.max(360, Math.min(isMobile() ? 460 : 620, Math.round(W * 0.66)));
    const view = svgEl('g');
    const svg = svgEl('svg', { class: 'netmap', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `Network map: ${list.length} people, ${companies.length} companies` }, svgEl('rect', { class: 'nm-bg', x: 0, y: 0, width: W, height: H }), view);
    const edgeG = svgEl('g', { class: 'nm-edges' }), nodeG = svgEl('g', { class: 'nm-nodes' });
    svg.style.height = `${H}px`;
    view.append(edgeG, nodeG);
    for (const l of links) edgeG.append(svgEl('line', { class: `nm-edge ${l.kind}`, x1: l.source.x, y1: l.source.y, x2: l.target.x, y2: l.target.y }));
    for (const n of nodes) {
      const color = n.me ? '#1f2937' : companyColor(n.company);
      const g = svgEl('g', { class: `nm-node${n.me ? ' me' : ''}`, transform: `translate(${n.x},${n.y})`, tabindex: n.me ? null : '0', role: n.me ? null : 'button', 'aria-label': n.me ? null : `${n.name}${n.company ? ', ' + n.company : ''}, ${n.p?.touchCount || 0} touches`, 'data-id': n.me ? null : n.id },
        svgEl('title', {}, n.me ? 'You' : `${n.name}${n.company ? ' · ' + n.company : ''}\n${n.p.touchCount} touches${n.p.lastTouch ? ` · last ${n.p.lastTouch.date}` : ''}`),
        svgEl('circle', { r: n.r, fill: color, 'fill-opacity': n.me ? 1 : n.op, class: n.p?.followUpState === 'overdue' ? 'late' : null }),
        n.me ? svgEl('text', { class: 'nm-me', 'text-anchor': 'middle', dy: '0.35em' }, 'You') : null,
        n.me ? null : svgEl('text', { class: 'nm-label', 'text-anchor': 'middle', y: n.r + 13 }, n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name));
      if (!n.me) g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPersonSheet(n.id); } });
      nodeG.append(g);
    }
    const legend = h('div', { class: 'nm-legend' }, companies.filter(Boolean).slice(0, 12).map((c) => h('span', null, h('i', { style: `background:${companyColor(c)}` }), c)),
      h('span', { class: 'nm-key' }, 'Bigger = more touches · fainter = longer since last touch · lines = who introduced whom'));
    let t = { k: 1, x: W / 2, y: H / 2 };
    const apply = () => view.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    const fit = () => {
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40, minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + 50;
      const k = Math.max(0.3, Math.min(1.6, Math.min(W / (maxX - minX), H / (maxY - minY))));
      t = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k }; apply();
    };
    const toLocal = (e) => { const r = svg.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
    const zoomAt = (pt, factor) => { const k = Math.max(0.25, Math.min(4, t.k * factor)); t.x = pt.x - ((pt.x - t.x) * k) / t.k; t.y = pt.y - ((pt.y - t.y) * k) / t.k; t.k = k; apply(); };
    svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(toLocal(e), e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    const pts = new Map(); let moved = 0, last = null, pinch = null, downNode = null;
    svg.addEventListener('pointerdown', (e) => { downNode = e.target.closest?.('.nm-node[data-id]')?.getAttribute('data-id') || null; svg.setPointerCapture(e.pointerId); pts.set(e.pointerId, toLocal(e)); moved = 0; last = toLocal(e); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) }; } });
    svg.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = toLocal(e); pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; const dist = Math.hypot(a.x - b.x, a.y - b.y); zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist / pinch.dist); pinch.dist = dist; moved += 10; return; }
      const dx = p.x - last.x, dy = p.y - last.y; moved += Math.abs(dx) + Math.abs(dy); t.x += dx; t.y += dy; last = p; apply();
    });
    const end = (e) => {
      const wasTap = pts.size === 1 && moved < 6;
      pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
      if (pts.size === 1) last = [...pts.values()][0];
      if (wasTap && e.type === 'pointerup' && downNode) openPersonSheet(downNode);
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    const zbtn = (label, text, fn) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, onclick: fn }, text);
    fill(box, h('div', { class: 'netmap-stage' }, svg, h('div', { class: 'nm-zoom' }, zbtn('Zoom in', '+', () => zoomAt({ x: W / 2, y: H / 2 }, 1.3)), zbtn('Zoom out', '−', () => zoomAt({ x: W / 2, y: H / 2 }, 1 / 1.3)), zbtn('Fit to screen', '⤢', fit))), legend);
    fit();
  }

  // ---- person sheet ----
  async function openPersonSheet(id) {
    if (!netData || !personById(id)) { try { await loadNetwork(true); } catch (e) { toast(e.message); return; } }
    const p = personById(id);
    if (!p) { toast('That person is no longer in your list'); return; }
    const today = netData.today || todayStr();
    const touches = netData.touches.filter((x) => x.personId === id).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const introBy = (p.introducedBy || []).map(personById).filter(Boolean);
    const introduced = netData.people.filter((x) => (x.introducedBy || []).includes(id));
    const jobsAt = (netData.jobs || []).filter((j) => (p.matchedJobIds || []).includes(j.id));
    const linkedin = safeHttp(p.linkedin);
    const personLink = (x) => h('button', { type: 'button', class: 'linkish', onclick: () => openPersonSheet(x.id) }, x.name);
    const fuDate = h('input', { type: 'date', class: 'text-input sm', value: p.nextFollowUp || '', 'aria-label': 'Next follow-up date' });
    fuDate.addEventListener('change', () => savePerson(p.id, { nextFollowUp: fuDate.value || null }, fuDate.value ? 'Follow-up set' : 'Follow-up cleared'));
    const logForm = touchForm({ person: p, onSaved: () => openPersonSheet(id) });
    const draftsHost = h('div', { class: 'drafts-host' });
    const lastChat = touches.find((x) => x.type === 'Coffee chat' || x.type === 'Call');
    const suggestBtn = h('button', { type: 'button', class: 'btn small', onclick: async () => { suggestBtn.remove(); const out = await renderDrafts(draftsHost, { kind: 'chat', personId: p.id, touchId: lastChat?.id }); if (out) draftsHost.append(h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn small', onclick: () => logThankYou(p.id, draftsHost._text?.()) }, 'I sent it · log Thank-you note'))); } }, 'Suggest 3 versions');
    openSheet([
      h('div', { class: 'detail-head' }, h('div', { class: 'eyebrow' }, 'Person'), strengthChip(p.strength)),
      h('h2', { id: 'sheetTitle', class: 'person-name' }, p.name),
      h('div', { class: 'person-sub' }, [p.role, p.company].filter(Boolean).join(' · ') || 'No company yet'),
      p.tags?.length ? h('div', { class: 'pc-tags' }, p.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
      h('div', { class: 'row-btns person-links' },
        linkedin ? h('a', { class: 'btn small', href: linkedin, target: '_blank', rel: 'noopener' }, 'LinkedIn ↗') : null,
        p.email ? h('a', { class: 'btn small', href: `mailto:${encodeURIComponent(p.email)}` }, 'Email') : null,
        p.url && me.mode !== 'fixture' ? h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener' }, 'Notion ↗') : null),
      h('div', { class: `fu-box${p.followUpState === 'overdue' ? ' late' : ''}` },
        h('div', null, h('b', null, 'Next follow-up'), ' ', p.nextFollowUp ? followChip(p, today) : h('span', { class: 'faint' }, 'none')),
        h('div', { class: 'fu-ctl' }, fuDate, p.nextFollowUp ? h('button', { type: 'button', class: 'btn small', onclick: () => savePerson(p.id, { nextFollowUp: null }, 'Follow-up done') }, 'Done') : null)),
      h('dl', { class: 'detail-dl' },
        p.school ? [h('dt', null, 'School'), h('dd', null, p.school)] : null,
        p.howMet ? [h('dt', null, 'How we met'), h('dd', null, p.howMet)] : null,
        introBy.length ? [h('dt', null, 'Introduced by'), h('dd', null, introBy.map((x, i) => [i ? ', ' : '', personLink(x)]))] : null,
        introduced.length ? [h('dt', null, 'Introduced you to'), h('dd', null, introduced.map((x, i) => [i ? ', ' : '', personLink(x)]))] : null,
        jobsAt.length ? [h('dt', null, 'Pipeline'), h('dd', null, jobsAt.map((j, i) => [i ? ', ' : '', `${j.company} · ${j.role.length > 40 ? j.role.slice(0, 39) + '…' : j.role} (${j.status === 'Interviewing' && j.round ? j.round : j.status})`]))] : null),
      p.notes ? [h('div', { class: 'detail-label' }, 'Notes'), h('div', { class: 'detail-notes' }, p.notes)] : null,
      h('section', { class: 'thank-draft-box' },
        h('div', { class: 'tdb-head' }, h('b', null, 'Draft thank-you email'), h('span', { class: 'faint' }, lastChat ? ` · after your ${lastChat.type.toLowerCase()} ${relDay(lastChat.date, today)}` : ' · log a chat first for a more specific note')),
        suggestBtn, draftsHost),
      h('details', { class: 'log-box', open: !touches.length || undefined }, h('summary', null, 'Log touch point'), logForm),
      h('div', { class: 'detail-label' }, `Timeline · ${touches.length}`),
      touches.length ? h('ol', { class: 'timeline' }, touches.map((x) => h('li', { class: `tl-item t-${x.type.replace(/[^a-z]+/gi, '-').toLowerCase()}` },
        h('div', { class: 'tl-when' }, x.date ? fmtKey(x.date, { month: 'short', day: 'numeric' }) : '—', h('small', null, x.date ? x.date.slice(0, 4) : '')),
        h('div', { class: 'tl-body' },
          h('div', { class: 'tl-type' }, x.type, x.jobId ? h('span', { class: 'faint' }, ` · ${(netData.jobs || []).find((j) => j.id === x.jobId)?.company || 'job'}`) : null,
            h('button', { type: 'button', class: 'tl-del', 'aria-label': `Delete ${x.type} on ${x.date || 'no date'}`, title: 'Delete', onclick: () => deleteTouch(x, id) }, '×')),
          x.notes ? h('div', { class: 'tl-notes' }, x.notes) : null,
          x.action || x.followUp ? h('div', { class: 'tl-next' }, h('b', null, 'Next: '), x.action || 'Follow up', x.followUp ? ` · ${shortDate(x.followUp)}` : '') : null)))) : h('div', { class: 'empty' }, 'No touch points yet.'),
      h('div', { class: 'detail-foot' },
        h('button', { type: 'button', class: 'linkish danger-link', onclick: () => deletePerson(p) }, 'Delete…'),
        h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn', onclick: () => openPersonForm(p) }, 'Edit'), h('button', { type: 'button', class: 'btn primary', onclick: closeSheet }, 'Done'))),
    ], 'panel wide');
  }
  async function logThankYou(personId, text) {
    try { await api('/api/network/touches', { method: 'POST', body: { personId, type: 'Thank-you note', date: todayStr(), notes: String(text || '').slice(0, 7900) } }); netDirty(); await loadNetwork(true); toast('Thank-you note logged'); openPersonSheet(personId); if (current.view === 'chats') render(); } catch (e) { toast(e.message); }
  }
  async function savePerson(id, patch, msg) {
    try { await api(`/api/network/people/${id}`, { method: 'PATCH', body: patch }); netDirty(); await loadNetwork(true); toast(msg || 'Saved'); openPersonSheet(id); if (['chats', 'today'].includes(current.view)) render(); } catch (e) { toast(e.message); }
  }
  async function deleteTouch(x, personId) {
    const ok = await confirmDialog({ title: 'Delete this touch point?', body: `${x.type} on ${x.date ? shortDate(x.date) : 'no date'} moves to Notion trash (restorable there).`, confirmLabel: 'Delete', danger: true });
    if (!ok) { openPersonSheet(personId); return; }
    try { await api(`/api/network/touches/${x.id}`, { method: 'DELETE', body: {} }); netDirty(); await loadNetwork(true); toast('Touch point deleted'); openPersonSheet(personId); if (current.view === 'chats') render(); } catch (e) { toast(e.message); }
  }
  async function deletePerson(p) {
    const n = netData.touches.filter((t) => t.personId === p.id).length;
    const ok = await confirmDialog({ title: `Delete ${p.name}?`, body: `${p.name}${n ? ` and their ${n} touch point${n === 1 ? '' : 's'}` : ''} move to Notion trash. You can restore them from Notion’s trash.`, confirmLabel: 'Delete', danger: true });
    if (!ok) { openPersonSheet(p.id); return; }
    try { await api(`/api/network/people/${p.id}`, { method: 'DELETE', body: {} }); netDirty(); await loadNetwork(true); closeSheet(); toast(`${p.name} deleted`); render(); } catch (e) { toast(e.message); }
  }

  /** Inline "Log touch point" form (person sheet). */
  function touchForm({ person, onSaved }) {
    const today = todayStr();
    const st = { type: 'Coffee chat', date: today, notes: '', action: '', followUp: '', jobId: '', remind: true };
    const remindBox = h('label', { class: 'switch remind' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.remind = e.target.checked; } }), 'Remind me to send a thank-you tomorrow');
    const syncRemind = () => { remindBox.hidden = st.type !== 'Coffee chat'; };
    const typePick = picker('Type', netData?.options.types || ['Coffee chat'], st.type, (v) => { st.type = v || 'Coffee chat'; syncRemind(); });
    const date = h('input', { type: 'date', class: 'text-input', value: today, 'aria-label': 'Date', onchange: (e) => { st.date = e.target.value || today; if (diffDays(st.date, today) > 7) { st.remind = false; remindBox.querySelector('input').checked = false; } } });
    const notes = h('textarea', { class: 'textarea sm', placeholder: 'Takeaways: what you talked about, advice, names…', 'aria-label': 'Notes / takeaways', oninput: (e) => { st.notes = e.target.value; } });
    const action = h('input', { type: 'text', class: 'text-input', placeholder: 'Follow-up action (optional)', 'aria-label': 'Follow-up action', oninput: (e) => { st.action = e.target.value; } });
    const fu = h('input', { type: 'date', class: 'text-input', 'aria-label': 'Follow-up date', onchange: (e) => { st.followUp = e.target.value; } });
    const quick = h('div', { class: 'pick' }, [[3, '+3 days'], [7, '+1 week'], [14, '+2 weeks']].map(([n, l]) => h('button', { type: 'button', onclick: () => { fu.value = addDays(st.date || today, n); st.followUp = fu.value; } }, l)));
    const jobSel = jobSelect(person?.company, '', (v) => { st.jobId = v; });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn primary' }, 'Save touch point');
    syncRemind();
    return h('form', { class: 'touch-form', novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.hidden = true;
      try {
        const out = await api('/api/network/touches', { method: 'POST', body: { personId: person.id, type: st.type, date: st.date, notes: st.notes, action: st.action, followUp: st.followUp || null, jobId: st.jobId || null, remind: st.type === 'Coffee chat' ? st.remind : undefined } });
        netDirty(); await loadNetwork(true);
        toast(out.reminderError || (out.reminder ? `${st.type} logged · thank-you reminder due ${shortDate(out.reminder.due)}` : `${st.type} logged`));
        onSaved?.(out);
        if (['chats', 'today'].includes(current.view)) render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    } },
    h('div', { class: 'field' }, typePick),
    h('div', { class: 'two' }, h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Date'), date), h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Related job'), jobSel)),
    h('div', { class: 'field' }, notes),
    h('div', { class: 'two' }, h('div', { class: 'field' }, action), h('div', { class: 'field' }, fu, quick)),
    remindBox, err, h('div', { class: 'sheet-actions inline' }, btn));
  }
  /** Related-job select; jobs at the person's company first (and preselected when there's exactly one). */
  function jobSelect(company, selected, onPick) {
    const sel = h('select', { class: 'text-input', 'aria-label': 'Related job', onchange: (e) => onPick(e.target.value) });
    sel._sync = (co, sel0) => {
      const list = (netData?.jobs || []).filter((j) => j.status !== 'Closed');
      const key = String(co || '').toLowerCase().trim();
      const atCo = list.filter((j) => key && String(j.company || '').toLowerCase().trim() === key);
      let pick = sel0 || '';
      if (!pick && atCo.length === 1) pick = atCo[0].id;
      fill(sel, h('option', { value: '' }, 'No related job'), [...atCo, ...list.filter((j) => !atCo.includes(j))].slice(0, 80).map((j) => h('option', { value: j.id, selected: j.id === pick }, `${j.company} · ${j.role.length > 44 ? j.role.slice(0, 43) + '…' : j.role}`)));
      onPick(pick);
    };
    sel._sync(company, selected);
    return sel;
  }

  // ---- add / edit person ----
  function openPersonForm(person, prefill = {}) {
    const editing = !!person;
    const st = editing ? { ...person, tags: [...(person.tags || [])], introducedBy: [...(person.introducedBy || [])] } : { name: '', company: '', role: '', school: '', howMet: '', linkedin: '', email: '', strength: null, tags: [], nextFollowUp: null, notes: '', introducedBy: [], ...prefill };
    const inp = (key, attrs = {}) => { const el = h('input', { class: 'text-input', id: `pf-${key}`, value: st[key] || '', autocomplete: 'off', ...attrs }); el.addEventListener('input', () => { st[key] = el.value; }); return el; };
    const companies = [...new Set([...(netData?.people || []).map((p) => p.company), ...(netData?.jobs || []).map((j) => j.company)].filter(Boolean))].sort();
    const dl = h('datalist', { id: 'pf-companies' }, companies.map((c) => h('option', { value: c })));
    const others = (netData?.people || []).filter((p) => p.id !== person?.id);
    const introSel = h('select', { class: 'text-input', id: 'pf-intro', onchange: (e) => { st.introducedBy = e.target.value ? [e.target.value] : []; } }, h('option', { value: '' }, 'No one (I reached out directly)'), others.map((p) => h('option', { value: p.id, selected: st.introducedBy[0] === p.id }, `${p.name}${p.company ? ' · ' + p.company : ''}`)));
    const tagOpts = [...new Set([...(netData?.options.tags || []), ...st.tags])];
    const tagHost = h('div', { class: 'pick tag-pick' });
    const paintTags = () => fill(tagHost, tagOpts.map((t) => h('button', { type: 'button', 'aria-pressed': String(st.tags.includes(t)), onclick: () => { st.tags = st.tags.includes(t) ? st.tags.filter((x) => x !== t) : [...st.tags, t]; paintTags(); } }, t)),
      h('input', { class: 'text-input sm tag-new', placeholder: '+ new tag', 'aria-label': 'New tag', maxlength: '60', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim().replace(/,/g, ''); if (v && !tagOpts.includes(v)) tagOpts.push(v); if (v && !st.tags.includes(v)) st.tags.push(v); paintTags(); tagHost.querySelector('.tag-new')?.focus(); } } }));
    paintTags();
    const notes = h('textarea', { class: 'textarea', id: 'pf-notes' }, st.notes || ''); notes.addEventListener('input', () => { st.notes = notes.value; });
    const fu = h('input', { type: 'date', class: 'text-input', id: 'pf-fu', value: st.nextFollowUp || '', onchange: (e) => { st.nextFollowUp = e.target.value || null; } });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn primary' }, editing ? 'Save' : 'Add person');
    const fields = ['name', 'company', 'role', 'school', 'howMet', 'linkedin', 'email', 'strength', 'tags', 'nextFollowUp', 'notes', 'introducedBy'];
    openSheet([h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!String(st.name || '').trim()) { err.textContent = 'Add their name.'; err.hidden = false; return; }
      const body = {};
      for (const k of fields) { const v = st[k]; if (editing && JSON.stringify(v ?? '') === JSON.stringify(person[k] ?? '')) continue; if (!editing && (v == null || v === '' || (Array.isArray(v) && !v.length))) continue; body[k] = v === '' ? null : v; }
      if (editing && !Object.keys(body).length) { openPersonSheet(person.id); return; }
      btn.disabled = true; err.hidden = true;
      try {
        const saved = editing ? await api(`/api/network/people/${person.id}`, { method: 'PATCH', body }) : await api('/api/network/people', { method: 'POST', body });
        netDirty(); await loadNetwork(true); toast(editing ? 'Saved' : `${saved.name} added`);
        if (current.view === 'chats' || current.view === 'today') render();
        openPersonSheet(saved.id);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    } },
    h('h2', { id: 'sheetTitle' }, editing ? `Edit ${person.name}` : 'Add person'),
    h('div', { class: 'field' }, h('label', { for: 'pf-name' }, 'Name'), inp('name', { placeholder: 'Full name', maxlength: '200' })),
    h('div', { class: 'two' },
      h('div', { class: 'field' }, h('label', { for: 'pf-company' }, 'Company'), inp('company', { list: 'pf-companies', placeholder: 'e.g. Visa' }), dl),
      h('div', { class: 'field' }, h('label', { for: 'pf-role' }, 'Role / title'), inp('role', { placeholder: 'e.g. Senior PM' }))),
    h('div', { class: 'two' },
      h('div', { class: 'field' }, h('label', { for: 'pf-school' }, 'School / affiliation'), inp('school', { placeholder: 'e.g. State U alum' })),
      h('div', { class: 'field' }, h('label', { for: 'pf-howMet' }, 'How we met'), inp('howMet', { placeholder: 'e.g. PM club event' }))),
    h('div', { class: 'field' }, h('label', { for: 'pf-intro' }, 'Introduced by'), introSel),
    h('div', { class: 'two' },
      h('div', { class: 'field' }, h('label', { for: 'pf-linkedin' }, 'LinkedIn URL'), inp('linkedin', { type: 'url', inputmode: 'url', placeholder: 'https://linkedin.com/in/…' })),
      h('div', { class: 'field' }, h('label', { for: 'pf-email' }, 'Email (optional)'), inp('email', { type: 'email', inputmode: 'email' }))),
    h('div', { class: 'two' },
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Relationship strength'), picker('Strength', ['Cold', 'Warm', 'Strong'], st.strength, (v) => { st.strength = v; })),
      h('div', { class: 'field' }, h('label', { for: 'pf-fu' }, 'Next follow-up'), fu)),
    h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Tags'), tagHost),
    h('div', { class: 'field' }, h('label', { for: 'pf-notes' }, 'Notes'), notes),
    err, h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => (editing ? openPersonSheet(person.id) : closeSheet()) }, 'Cancel'), btn))], 'panel wide');
  }

  // ---- quick "Log coffee chat": pick or create a person + the touch point, in a few taps ----
  async function openLogChat(prefill = {}) {
    try { await loadNetwork(); } catch (e) { toast(e.message); return; }
    const today = todayStr();
    const st = { personId: null, name: '', company: prefill.company || '', role: '', howMet: '', strength: 'Warm', introducedBy: '', type: 'Coffee chat', date: today, notes: '', action: '', followUp: '', jobId: prefill.jobId || '', remind: true };
    const who = h('input', { type: 'text', class: 'text-input', id: 'lcWho', placeholder: 'Who did you talk to?', autocomplete: 'off', maxlength: '200', enterkeyhint: 'next', 'aria-label': 'Person' });
    const sugg = h('div', { class: 'lc-sugg' });
    const newBox = h('div', { class: 'lc-new', hidden: true });
    const picked = h('div', { class: 'lc-picked', hidden: true });
    const companies = [...new Set([...netData.people.map((p) => p.company), ...(netData.jobs || []).map((j) => j.company)].filter(Boolean))].sort();
    const jobSel = jobSelect(st.company, st.jobId, (v) => { st.jobId = v; });
    const coIn = h('input', { class: 'text-input', id: 'lcCompany', list: 'lc-cos', value: st.company, placeholder: 'Company', 'aria-label': 'Company', oninput: (e) => { st.company = e.target.value; } });
    coIn.addEventListener('change', () => jobSel._sync(st.company, ''));
    const roleIn = h('input', { class: 'text-input', placeholder: 'Role / title (optional)', 'aria-label': 'Role', oninput: (e) => { st.role = e.target.value; } });
    const metIn = h('input', { class: 'text-input', placeholder: 'How you met (optional)', 'aria-label': 'How you met', oninput: (e) => { st.howMet = e.target.value; } });
    const introSel = h('select', { class: 'text-input', 'aria-label': 'Introduced by', onchange: (e) => { st.introducedBy = e.target.value; } }, h('option', { value: '' }, 'Introduced by: no one'), netData.people.map((p) => h('option', { value: p.id }, `Introduced by ${p.name}`)));
    fill(newBox, h('div', { class: 'lc-new-label' }, 'New person · added to your Notion People list'),
      h('div', { class: 'two' }, coIn, roleIn), h('div', { class: 'two' }, metIn, introSel), h('datalist', { id: 'lc-cos' }, companies.map((c) => h('option', { value: c }))),
      picker('Strength', ['Cold', 'Warm', 'Strong'], st.strength, (v) => { st.strength = v; }));
    const choose = (p) => {
      st.personId = p.id; st.company = p.company || ''; who.value = p.name; fill(sugg); newBox.hidden = true; picked.hidden = false;
      fill(picked, h('span', null, h('b', null, p.name), p.company ? ` · ${p.company}` : '', ` · ${p.touchCount} ${p.touchCount === 1 ? 'touch' : 'touches'}`), h('button', { type: 'button', class: 'linkish', onclick: () => { st.personId = null; picked.hidden = true; who.value = ''; who.focus(); paintSugg(); } }, 'Change'));
      jobSel._sync(st.company, st.jobId);
    };
    const paintSugg = () => {
      const q = who.value.trim();
      st.name = q;
      if (st.personId) return;
      const exact = netData.people.some((p) => p.name.toLowerCase() === q.toLowerCase());
      const hits = q ? netData.people.filter((p) => matches(q, p.name, p.company)).slice(0, 5) : netData.people.slice().sort((a, b) => String(b.lastTouch?.date || '').localeCompare(String(a.lastTouch?.date || ''))).slice(0, 4);
      if (!q) newBox.hidden = true;
      fill(sugg, hits.map((p) => h('button', { type: 'button', class: 'lc-opt', onclick: () => choose(p) }, h('b', null, p.name), h('span', null, p.company || ''))),
        q && !exact && newBox.hidden ? h('button', { type: 'button', class: 'lc-opt new', onclick: () => { newBox.hidden = false; paintSugg(); coIn.focus(); } }, h('b', null, `+ New person: ${q}`), h('span', null, 'add to People')) : null);
    };
    who.addEventListener('input', () => { if (st.personId) { st.personId = null; picked.hidden = true; } paintSugg(); });
    const remindBox = h('label', { class: 'switch remind' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.remind = e.target.checked; } }), 'Remind me to send a thank-you tomorrow (in Dayline)');
    const typePick = picker('Type', netData.options.types.filter((t) => t !== 'Interview'), st.type, (v) => { st.type = v || 'Coffee chat'; remindBox.hidden = st.type !== 'Coffee chat'; });
    const date = h('input', { type: 'date', class: 'text-input', value: today, 'aria-label': 'Date', onchange: (e) => { st.date = e.target.value || today; if (diffDays(st.date, today) > 7) { st.remind = false; remindBox.querySelector('input').checked = false; } } });
    const notes = h('textarea', { class: 'textarea sm', id: 'lcNotes', placeholder: 'Takeaways (optional): advice, what they work on, names to follow up with…', 'aria-label': 'Takeaways', oninput: (e) => { st.notes = e.target.value; } });
    const action = h('input', { class: 'text-input', placeholder: 'Follow-up action (optional)', 'aria-label': 'Follow-up action', oninput: (e) => { st.action = e.target.value; } });
    const fu = h('input', { type: 'date', class: 'text-input', 'aria-label': 'Follow-up date', onchange: (e) => { st.followUp = e.target.value; } });
    const quick = h('div', { class: 'pick' }, [[7, '+1 week'], [14, '+2 weeks'], [30, '+1 month']].map(([n, l]) => h('button', { type: 'button', onclick: () => { fu.value = addDays(st.date || today, n); st.followUp = fu.value; } }, l)));
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn primary', id: 'lcSave' }, 'Save');
    openSheet([h('form', { class: 'logchat', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!st.personId && !st.name) { err.textContent = 'Who did you talk to?'; err.hidden = false; who.focus(); return; }
      btn.disabled = true; err.hidden = true;
      const touch = { type: st.type, date: st.date, notes: st.notes, action: st.action, followUp: st.followUp || null, jobId: st.jobId || null };
      const body = st.personId ? { personId: st.personId, touch } : { person: { name: st.name, company: st.company, role: st.role, howMet: st.howMet, strength: st.strength, introducedBy: st.introducedBy ? [st.introducedBy] : [], jobIds: st.jobId ? [st.jobId] : [] }, touch };
      if (st.type === 'Coffee chat') body.remind = st.remind;
      try {
        const out = await api('/api/network/log', { method: 'POST', body });
        netDirty(); await loadNetwork(true);
        closeSheet();
        toast(out.reminderError || `${st.type} with ${out.person.name} logged${out.createdPerson ? ' · added to People' : ''}${out.reminder ? ` · thank-you due ${shortDate(out.reminder.due)}` : ''}`, { label: 'Open', fn: () => openPersonSheet(out.person.id) });
        if (['chats', 'today', 'jobs'].includes(current.view)) render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    } },
    h('h2', { id: 'sheetTitle' }, 'Log coffee chat'),
    h('div', { class: 'field' }, who, sugg, picked, newBox),
    h('div', { class: 'field' }, typePick),
    h('div', { class: 'two' }, h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Date'), date), h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Related job'), jobSel)),
    h('div', { class: 'field' }, notes),
    h('div', { class: 'two' }, h('div', { class: 'field' }, action), h('div', { class: 'field' }, fu, quick)),
    remindBox, err,
    h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), btn))], 'panel');
    const pre = prefill.personId && personById(prefill.personId);
    if (pre) choose(pre); else paintSugg();
    if (!isMobile()) setTimeout(() => who.focus(), 40);
  }

  // ---- thank-you reminders (24h after every coffee chat + interview round) ----
  let thanksData = null, thanksAt = 0;
  async function loadThanks(fresh = false) {
    if (!fresh && thanksData && Date.now() - thanksAt < 30000) return thanksData;
    thanksData = await api(`/api/thanks${fresh ? '?fresh=1' : ''}`);
    thanksAt = Date.now();
    return thanksData;
  }
  function reminderTitle(r) {
    if (r.kind === 'chat') return `Thank ${r.person?.name || 'your coffee chat'}`;
    return r.interviewers?.length ? `Thank ${r.interviewers.map((x) => x.name || x.email).join(', ')}` : `Thank your ${r.job?.company || ''} interviewer${r.round ? ` (${r.round})` : ''}`.replace('  ', ' ');
  }
  const reminderSub = (r) => (r.kind === 'chat'
    ? ['Coffee chat', r.date ? shortDate(r.date) : null, r.person?.company].filter(Boolean).join(' · ')
    : [r.job?.company, r.round || 'Interview', r.date ? shortDate(r.date) : null].filter(Boolean).join(' · '));
  function reminderDue(r, today) {
    if (!r.due) return null;
    const d = diffDays(today, r.due);
    return h('span', { class: `dtag ${d < 0 ? 'late' : d === 0 ? 'today' : ''}` }, d < 0 ? `Overdue · ${shortDate(r.due)}` : d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due ${shortDate(r.due)}`);
  }
  function thanksSection(th, { compact = false } = {}) {
    const today = th.today || todayStr();
    const rems = th.reminders || [];
    const check = th.toCheck || [];
    if (!rems.length && !check.length) return null;
    const late = rems.filter((r) => r.overdue).length;
    const remList = rems.length ? h('ul', { class: 'rail-list thanks-list' }, rems.slice(0, compact ? 5 : 30).map((r) => h('li', null, h('button', { type: 'button', class: `rail-item thank-item${r.overdue ? ' late' : ''}`, onclick: () => openThankYouDrafts({ id: r.id }) },
      h('span', { class: 'ri-text' }, h('span', { class: 'ri-title' }, reminderTitle(r)), h('span', { class: 'ri-sub' }, reminderSub(r))),
      reminderDue(r, today))))) : null;
    const checkList = check.length ? h('div', { class: 'tocheck' },
      h('div', { class: 'sub-head' }, 'Thank-yous to check', h('span', { class: 'count' }, check.length)),
      h('p', { class: 'hint' }, 'Interviews from before thank-you reminders existed. Nothing was added to your To Do for these.'),
      h('ul', { class: 'check-list' }, check.slice(0, compact ? 3 : 30).map((c) => h('li', { class: 'check-item' },
        h('div', { class: 'ri-text' }, h('span', { class: 'ri-title' }, `${c.company} · ${c.round || 'Interview'}`), h('span', { class: 'ri-sub' }, `${c.role ? (c.role.length > 50 ? c.role.slice(0, 49) + '…' : c.role) + ' · ' : ''}${c.why}`)),
        h('div', { class: 'check-btns' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => openThankYouDrafts({ kind: 'interview', jobId: c.jobId, round: c.round, date: c.date }) }, 'Send now'),
          h('button', { type: 'button', class: 'btn small', onclick: () => resolveThanks({ jobId: c.jobId, round: c.round, date: c.date, action: 'sent' }, 'Marked as already sent') }, 'Already sent'),
          h('button', { type: 'button', class: 'btn small ghost', onclick: () => resolveThanks({ jobId: c.jobId, round: c.round, date: c.date, action: 'skip' }, 'Skipped') }, 'Skip')))))) : null;
    return card('Thank-yous', { count: rems.length ? `${rems.length} to send${late ? ` · ${late} overdue` : ''}` : null, cls: `thanks-card${late ? ' has-late' : ''}` }, remList,
      rems.length && !compact ? h('p', { class: 'hint' }, 'Kept in Dayline. Nothing goes to your Notion To Do unless you open one and tap “Add to my to-dos”.') : null, checkList);
  }
  async function resolveThanks(body, msg) {
    try {
      const out = await api('/api/thanks/resolve', { method: 'POST', body });
      netDirty();
      toast(`${msg}${out.logged ? ` · logged ${out.logged} thank-you note${out.logged === 1 ? '' : 's'}` : ''}`);
      closeSheet(); render(); return out;
    } catch (e) { toast(e.message); return null; }
  }
  /** 2–3 editable versions per recipient, each with Copy + mailto:. Nothing is ever sent from Dayline. */
  async function renderDrafts(host, req) {
    fill(host, h('div', { class: 'hint' }, 'Drafting…'));
    let out;
    try { out = await api('/api/thanks/drafts', { method: 'POST', body: req }); } catch (e) { fill(host, h('p', { class: 'form-error' }, e.message)); return null; }
    const blocks = out.drafts.map((dft) => {
      const rcpt = dft.recipient || {};
      const ta = h('textarea', { class: 'textarea draft-text', 'aria-label': `Thank-you draft${rcpt.name ? ' for ' + rcpt.name : ''}` });
      const subj = h('input', { class: 'text-input sm draft-subj', 'aria-label': 'Subject' });
      const mail = h('a', { class: 'btn small' }, rcpt.email ? 'Open in email' : 'Open in email (add address)');
      const sync = () => { mail.href = mailtoHref(rcpt.email || '', subj.value, ta.value); };
      const tabs = h('div', { class: 'draft-tabs pick', role: 'group', 'aria-label': 'Versions' });
      const pick = (i) => { ta.value = dft.versions[i].body; subj.value = dft.versions[i].subject; tabs.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i))); sync(); };
      dft.versions.forEach((v, i) => tabs.append(h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => pick(i) }, v.label)));
      ta.addEventListener('input', sync); subj.addEventListener('input', sync);
      pick(0);
      const copyBtn = h('button', { type: 'button', class: 'btn small primary', onclick: async () => { const ok = await copyText(ta.value); copyBtn.textContent = ok ? 'Copied ✓' : 'Select & copy'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800); } }, 'Copy');
      const li = safeHttp(rcpt.linkedin);
      return { el: h('div', { class: 'draft-block' },
        rcpt.name || rcpt.email ? h('div', { class: 'draft-to' }, 'To ', h('b', null, rcpt.name || rcpt.email), rcpt.email && rcpt.name ? h('span', { class: 'faint' }, ` · ${rcpt.email}`) : null) : null,
        tabs, subj, ta,
        h('div', { class: 'row-btns' }, copyBtn, mail, li ? h('a', { class: 'btn small', href: li, target: '_blank', rel: 'noopener' }, 'LinkedIn ↗') : null),
        dft.note ? h('div', { class: 'hint' }, dft.note) : null), text: () => ta.value };
    });
    fill(host, blocks.map((b) => b.el), h('p', { class: 'hint' }, `${out.drafts[0]?.source === 'gemini' ? 'Drafted with Gemini from your notes' : 'Drafted from your notes'} · edit freely. Dayline never sends email: copy it or open it in your mail app and send it yourself.`));
    host._text = () => blocks.map((b) => b.text()).join('\n\n---\n\n');
    return out;
  }
  async function openThankYouDrafts(req) {
    const byRef = !!(req.id || req.taskId);
    const th = await loadThanks(byRef).catch(() => null);
    let rec = req.id ? th?.reminders.find((r) => r.id === req.id) : req.taskId ? th?.reminders.find((r) => r.taskId === req.taskId) : null;
    if (byRef && !rec) { toast('This thank-you is already done'); return; }
    const kind = rec?.kind || req.kind;
    const host = h('div', { class: 'drafts-host' });
    const today = todayStr();
    let ivRows = null, ivNotes = null, ivBox = null;
    const interviewersNow = () => (ivRows ? [...ivRows.querySelectorAll('.iv-row')].map((r) => ({ name: r.querySelector('.iv-name').value.trim(), email: r.querySelector('.iv-email').value.trim() })).filter((x) => x.name || x.email) : []);
    const draftReq = () => {
      if (kind !== 'interview') return rec ? { id: rec.id } : { kind: 'chat', personId: req.personId, touchId: req.touchId };
      return { ...(rec ? { id: rec.id } : { kind: 'interview', jobId: req.jobId, round: req.round, date: req.date }), interviewers: interviewersNow(), notes: ivNotes.value };
    };
    if (kind === 'interview') {
      ivRows = h('div', { class: 'iv-rows' });
      const addRow = (x = {}) => ivRows.append(h('div', { class: 'iv-row two' }, h('input', { class: 'text-input iv-name', placeholder: 'Interviewer name', value: x.name || '', 'aria-label': 'Interviewer name' }), h('input', { class: 'text-input iv-email', type: 'email', placeholder: 'Email (optional)', value: x.email || '', 'aria-label': 'Interviewer email' })));
      (rec?.interviewers?.length ? rec.interviewers : [{}]).forEach(addRow);
      ivNotes = h('textarea', { class: 'textarea sm', placeholder: 'Your interview notes: topics, questions, anything memorable', 'aria-label': 'Interview notes' }, rec?.notes || '');
      ivBox = h('div', { class: 'iv-box' }, h('div', { class: 'flabel' }, 'Interviewer(s)'), ivRows,
        h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'linkish', onclick: () => addRow() }, '+ Add interviewer'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn small', onclick: () => renderDrafts(host, draftReq()) }, 'Update drafts')),
        ivNotes);
    }
    const sentBtn = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      sentBtn.disabled = true;
      if (!rec && kind === 'chat') { await logThankYou(req.personId, host._text?.()); return; }
      const extra = kind === 'interview' ? { interviewers: interviewersNow(), notes: ivNotes.value } : {};
      const body = rec ? { id: rec.id, action: 'sent', message: host._text?.(), ...extra } : { jobId: req.jobId, round: req.round, date: req.date, action: 'sent', message: host._text?.(), ...extra };
      if (!(await resolveThanks(body, 'Marked sent'))) sentBtn.disabled = false;
    } }, 'I sent it · mark done');
    const job = rec?.job || (thanksData?.toCheck || []).find((c) => c.jobId === req.jobId) || null;
    // Reminders live in Dayline; a Notion To Do is created only when the user taps this.
    const todoRow = h('div', { class: 'todo-row' });
    const sentHint = h('p', { class: 'hint' });
    const paintTodo = () => {
      if (!rec) return;
      sentHint.textContent = `Marking it sent logs a “Thank-you note” touch point${rec.taskId ? ' and completes the To Do you added' : ''}.`;
      const url = safeHttp(rec.taskUrl);
      if (rec.taskId) fill(todoRow, h('span', { class: 'hint' }, '✓ In your to-dos'), url ? h('a', { class: 'linkish', href: url, target: '_blank', rel: 'noopener' }, 'Open in Notion ↗') : null);
      else {
        const b = h('button', { type: 'button', class: 'btn small', onclick: async () => {
          b.disabled = true;
          try { const out = await api('/api/thanks/todo', { method: 'POST', body: { id: rec.id } }); rec = { ...rec, ...out.reminder, person: rec.person, job: rec.job }; thanksAt = 0; toast('Added to your to-dos'); paintTodo(); } catch (e) { toast(e.message); b.disabled = false; }
        } }, '+ Add to my to-dos');
        fill(todoRow, b, h('span', { class: 'hint' }, 'Only in Dayline until you add it.'));
      }
    };
    paintTodo();
    openSheet([
      h('div', { class: 'detail-head' }, h('div', { class: 'eyebrow' }, kind === 'interview' ? 'Interview thank-you' : 'Coffee chat thank-you'), rec ? reminderDue(rec, today) : null),
      h('h2', { id: 'sheetTitle' }, rec ? reminderTitle(rec) : kind === 'interview' ? `Thank your ${job?.company || ''} interviewer`.replace('  ', ' ') : 'Draft thank-you email'),
      h('div', { class: 'person-sub' }, rec ? reminderSub(rec) : [job?.company, req.round, req.date ? shortDate(req.date) : null].filter(Boolean).join(' · ')),
      ivBox, h('div', { class: 'detail-label' }, 'Draft thank-you email'), host,
      h('div', { class: 'sheet-actions' },
        rec ? h('button', { type: 'button', class: 'btn ghost', onclick: () => resolveThanks({ id: rec.id, action: 'skip' }, 'Skipped') }, 'Skip') : h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Close'),
        sentBtn),
      rec ? todoRow : null,
      rec ? sentHint : h('p', { class: 'hint' }, kind === 'interview' ? 'Marking it sent records it so Dayline stops asking, and logs a touch point for interviewers in your People list.' : 'Marking it sent logs a “Thank-you note” touch point.'),
    ], 'panel wide');
    renderDrafts(host, draftReq());
  }
  /** Log an interview round: interviewers (+ optional People), date, notes -> 24h thank-you reminder. */
  function openLogInterview(job) {
    const today = todayStr();
    const st = { round: job.round || ROUNDS[0], date: job.interview || today, notes: '' };
    const rows = h('div', { class: 'iv-rows' });
    const addRow = () => rows.append(h('div', { class: 'iv-row' },
      h('div', { class: 'two' }, h('input', { class: 'text-input iv-name', placeholder: 'Interviewer name', 'aria-label': 'Interviewer name' }), h('input', { class: 'text-input iv-email', type: 'email', placeholder: 'Email (optional)', 'aria-label': 'Interviewer email' })),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', class: 'iv-net', checked: true }), 'Add to my network (People)')));
    addRow();
    const date = h('input', { type: 'date', class: 'text-input', value: st.date, 'aria-label': 'Interview date', onchange: (e) => { st.date = e.target.value; } });
    const notes = h('textarea', { class: 'textarea sm', placeholder: 'Notes: topics, questions they asked, anything to mention in the thank-you', 'aria-label': 'Interview notes', oninput: (e) => { st.notes = e.target.value; } });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn primary' }, 'Save interview');
    openSheet([h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.hidden = true;
      const interviewers = [...rows.querySelectorAll('.iv-row')].map((r) => ({ name: r.querySelector('.iv-name').value.trim(), email: r.querySelector('.iv-email').value.trim(), addToNetwork: r.querySelector('.iv-net').checked })).filter((x) => x.name || x.email);
      try {
        const out = await api('/api/thanks/interview', { method: 'POST', body: { jobId: job.id, round: st.round, date: st.date, interviewers, notes: st.notes } });
        netDirty(); jobsData = null;
        closeSheet();
        toast(`${st.round} logged · thank-you reminder due ${shortDate(out.reminder.due)}`, { label: 'Draft now', fn: () => openThankYouDrafts({ id: out.reminder.id }) });
        render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    } },
    h('h2', { id: 'sheetTitle' }, `Log interview · ${job.company}`),
    h('div', { class: 'person-sub' }, job.role),
    h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Round'), picker('Round', ROUNDS, st.round, (v) => { st.round = v || st.round; })),
    h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Date'), date),
    h('div', { class: 'field' }, h('div', { class: 'flabel' }, 'Interviewer(s)'), rows, h('button', { type: 'button', class: 'linkish', onclick: addRow }, '+ Add interviewer')),
    h('div', { class: 'field' }, notes),
    h('p', { class: 'hint' }, 'Adds a thank-you reminder in Dayline (Today + Coffee chats), due the next day, and moves the job to this round. Nothing is added to your To Do unless you tap “Add to my to-dos”.'),
    err, h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), btn))], 'panel');
  }

  // ---- Offer: "Thank your network" (separate from the 24h thank-you reminders) ----
  async function openThankPanel(job) {
    let cand;
    try { [cand] = await Promise.all([api(`/api/network/thanks?jobId=${encodeURIComponent(job.id)}`), loadNetwork()]); } catch (e) { toast(e.message); return; }
    const picked = new Set(cand.candidates.filter((c) => c.selected !== false).map((c) => c.id));
    const why = Object.fromEntries(cand.candidates.map((c) => [c.id, c.why]));
    let accepted = false;
    const goBtn = h('button', { type: 'button', class: 'btn primary', id: 'thankDraftBtn', onclick: () => draft() });
    const syncBtn = () => { goBtn.textContent = picked.size ? `Draft ${picked.size} note${picked.size === 1 ? '' : 's'}` : 'Pick someone to thank'; goBtn.disabled = !picked.size; };
    const row = (p) => h('label', { class: 'thank-row' },
      h('input', { type: 'checkbox', checked: picked.has(p.id), onchange: (e) => { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); syncBtn(); } }),
      h('span', { class: 'tr-main' }, h('span', null, h('b', null, p.name), h('span', { class: 'faint' }, ` · ${[p.role, p.company].filter(Boolean).join(', ') || 'no company'}`)),
        why[p.id] ? h('span', { class: 'tr-why' }, why[p.id].join(' · ')) : p.lastTouch ? h('span', { class: 'tr-why' }, `Last: ${p.lastTouch.type} ${shortDate(p.lastTouch.date)}`) : null));
    const listHost = h('div', { class: 'thank-people' }, cand.candidates.length ? cand.candidates.map((c) => personById(c.id)).filter(Boolean).map(row) : h('div', { class: 'hint' }, `No one in your network is tied to ${job.company} yet. Add people below.`));
    const others = netData.people.filter((p) => !why[p.id]);
    const otherList = h('div', { class: 'thank-people' });
    const otherQ = h('input', { type: 'search', class: 'text-input sm', placeholder: 'Find someone else to thank…', 'aria-label': 'Find people', oninput: () => paintOthers() });
    const paintOthers = () => fill(otherList, others.filter((p) => matches(otherQ.value, p.name, p.company, p.role)).slice(0, 30).map(row));
    paintOthers();
    const othersHost = h('div', { class: 'thank-others', hidden: !!cand.candidates.length || !others.length }, otherQ, otherList);
    const draftHost = h('div', { class: 'thank-drafts' });
    syncBtn();
    async function draft() {
      goBtn.disabled = true;
      fill(draftHost, h('div', { class: 'hint' }, 'Drafting…'));
      let out;
      try { out = await api('/api/network/thanks/drafts', { method: 'POST', body: { jobId: job.id, personIds: [...picked], accepted } }); } catch (e) { fill(draftHost, h('p', { class: 'form-error' }, e.message)); syncBtn(); return; }
      fill(draftHost, h('div', { class: 'detail-label' }, 'Drafts'), out.drafts.map((dft) => {
        const p = personById(dft.personId) || { name: 'Contact' };
        const ta = h('textarea', { class: 'textarea draft-text', 'aria-label': `Thank-you for ${p.name}` }, dft.message);
        const mail = h('a', { class: 'btn small', href: mailtoHref(p.email || '', dft.subject, dft.message) }, 'Open in email');
        ta.addEventListener('input', () => { mail.href = mailtoHref(p.email || '', dft.subject, ta.value); });
        const copyBtn = h('button', { type: 'button', class: 'btn small primary', onclick: async () => { const ok = await copyText(ta.value); copyBtn.textContent = ok ? 'Copied ✓' : 'Select & copy'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800); } }, 'Copy');
        const sent = h('button', { type: 'button', class: 'btn small', onclick: async () => {
          sent.disabled = true;
          try { await api('/api/network/touches', { method: 'POST', body: { personId: dft.personId, type: 'Thank-you note', date: todayStr(), notes: `Offer thank-you (${job.company}):\n${ta.value}`.slice(0, 7900), jobId: job.id } }); netDirty(); sent.textContent = 'Logged ✓'; sent.classList.add('done'); } catch (e) { toast(e.message); sent.disabled = false; }
        } }, 'Mark sent');
        const li = safeHttp(p.linkedin);
        return h('div', { class: 'draft-block' },
          h('div', { class: 'draft-to' }, 'To ', h('b', null, p.name), dft.lastTouch ? h('span', { class: 'faint' }, ` · last ${dft.lastTouch.type.toLowerCase()} ${shortDate(dft.lastTouch.date)}`) : null, dft.source === 'gemini' ? h('span', { class: 'src' }, 'Gemini') : null),
          ta, h('div', { class: 'row-btns' }, copyBtn, mail, li ? h('a', { class: 'btn small', href: li, target: '_blank', rel: 'noopener' }, 'LinkedIn ↗') : null, sent),
          dft.note ? h('div', { class: 'hint' }, dft.note) : null);
      }), h('p', { class: 'hint' }, 'Nothing is sent from Dayline. Copy each note or open it in email or LinkedIn and send it yourself, then tap “Mark sent” to log a Thank-you note touch point.'));
      syncBtn();
      draftHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    openSheet([
      h('div', { class: 'detail-head' }, h('div', { class: 'eyebrow' }, 'Offer 🎉'), h('span', { class: 'pill st-Offer' }, 'Offer')),
      h('h2', { id: 'sheetTitle' }, 'Thank your network'),
      h('div', { class: 'person-sub' }, `${job.company} · ${job.role}`),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', onchange: (e) => { accepted = e.target.checked; } }), 'I accepted the offer (changes the wording)'),
      h('div', { class: 'detail-label' }, 'People tied to this offer'), listHost,
      others.length ? h('button', { type: 'button', class: 'linkish', onclick: () => { othersHost.hidden = !othersHost.hidden; if (!othersHost.hidden) otherQ.focus(); } }, '+ Add others from your network') : null, othersHost,
      h('div', { class: 'sheet-actions inline' }, goBtn),
      draftHost,
    ], 'panel wide');
  }

  // ---- Today: follow-ups due + thank-yous ----
  async function todayNetCard() {
    const [d, th] = await Promise.all([netData ? loadNetwork() : loadNetwork().catch(() => null), loadThanks().catch(() => null)]);
    const today = d?.today || todayStr();
    const fus = (d?.people || []).filter((p) => p.followUpState === 'overdue' || p.followUpState === 'today').sort((a, b) => String(a.nextFollowUp).localeCompare(String(b.nextFollowUp)));
    const rems = th?.reminders || [];
    const check = th?.toCheck || [];
    if (!fus.length && !rems.length && !check.length) return null;
    const late = fus.filter((p) => p.followUpState === 'overdue').length + rems.filter((r) => r.overdue).length;
    const items = [
      ...rems.slice(0, 5).map((r) => h('li', null, h('button', { type: 'button', class: `rail-item thank-item${r.overdue ? ' late' : ''}`, onclick: () => openThankYouDrafts({ id: r.id }) },
        h('span', { class: 'ri-text' }, h('span', { class: 'ri-title' }, reminderTitle(r)), h('span', { class: 'ri-sub' }, reminderSub(r))), reminderDue(r, today)))),
      ...fus.slice(0, 5).map((p) => h('li', { class: 'fu-row' },
        h('button', { type: 'button', class: `rail-item${p.followUpState === 'overdue' ? ' late' : ''}`, onclick: () => openPersonSheet(p.id) },
          h('span', { class: 'ri-text' }, h('span', { class: 'ri-title' }, `Follow up with ${p.name}`), h('span', { class: 'ri-sub' }, [p.company, p.lastTouch ? `last ${p.lastTouch.type.toLowerCase()} ${relDay(p.lastTouch.date, today)}` : null].filter(Boolean).join(' · '))),
          h('span', { class: `dtag ${p.followUpState === 'overdue' ? 'late' : 'today'}` }, p.followUpState === 'overdue' ? `Late · ${shortDate(p.nextFollowUp)}` : 'Today')),
        h('button', { type: 'button', class: 'icon-btn sm fu-done', 'aria-label': `Mark follow-up with ${p.name} done`, title: 'Done', onclick: async (e) => { e.stopPropagation(); try { await api(`/api/network/people/${p.id}`, { method: 'PATCH', body: { nextFollowUp: null } }); netDirty(); toast(`Follow-up with ${p.name} cleared`); render(); } catch (ex) { toast(ex.message); } } }, '✓'))),
    ];
    return card('Follow-ups & thank-yous', { count: late ? `${late} overdue` : null, cls: `net-today${late ? ' has-late' : ''}`, action: h('a', { class: 'linkish', href: '#chats' }, 'Chats →') },
      items.length ? h('ul', { class: 'rail-list' }, items) : null,
      check.length ? h('button', { type: 'button', class: 'rail-more', onclick: () => { location.hash = 'chats'; } }, `${check.length} past interview thank-you${check.length === 1 ? '' : 's'} to check →`) : null);
  }

  // ---------- search palette + shortcuts ----------
  async function openSearch() {
    const input = h('input', { type: 'search', class: 'pal-input', placeholder: 'Search tasks, jobs, opportunities, events…', 'aria-label': 'Search', autocomplete: 'off' });
    const list = h('ul', { class: 'pal-list', role: 'listbox' });
    openSheet([h('div', { class: 'pal' }, input, list, h('div', { class: 'pal-foot' }, h('kbd', null, '↑'), h('kbd', null, '↓'), ' to move · ', h('kbd', null, 'Enter'), ' to open · ', h('kbd', null, 'Esc'), ' to close'))], 'modal palette');
    setTimeout(() => input.focus(), 30);
    const today = todayStr();
    const commands = [
      { kind: 'Go to', label: 'New task', hint: 'N', run: () => openTaskSheet(null) },
      { kind: 'Go to', label: 'Add job from a link', hint: 'J', run: () => openAddJob('job') },
      { kind: 'Go to', label: 'Today', hint: '1', run: () => { location.hash = 'today'; } },
      { kind: 'Go to', label: 'Week', hint: '2', run: () => { location.hash = 'week'; } },
      { kind: 'Go to', label: 'Tasks', hint: '3', run: () => { location.hash = 'tasks'; } },
      { kind: 'Go to', label: 'Jobs', hint: '4', run: () => { location.hash = 'jobs'; } },
      { kind: 'Go to', label: 'Opportunities', hint: '5', run: () => { location.hash = 'opps'; } },
      { kind: 'Go to', label: 'Coffee chats', hint: '8', run: () => { location.hash = 'chats'; } },
      { kind: 'Go to', label: 'Log coffee chat', sub: 'Who you talked to + takeaways', run: () => openLogChat({}) },
    ];
    let items = commands.map((c) => ({ ...c, hay: c.label }));
    let active = 0, shown = [];
    const paint = () => {
      const q = input.value.trim();
      shown = (q ? items.filter((it) => matches(q, it.hay)) : items.filter((it) => it.kind === 'Go to')).slice(0, 14);
      active = Math.min(active, Math.max(0, shown.length - 1));
      let lastKind = null;
      fill(list, ...(shown.length ? shown.flatMap((it, i) => {
        const out = [];
        if (it.kind !== lastKind) { out.push(h('li', { class: 'pal-kind', role: 'presentation' }, it.kind)); lastKind = it.kind; }
        out.push(h('li', { role: 'option', class: `pal-item${i === active ? ' active' : ''}`, 'aria-selected': String(i === active), onmousemove: () => { if (active !== i) { active = i; paint(); } }, onclick: () => { closeSheet(); it.run(); } },
          h('span', { class: 'pal-label' }, it.label), it.sub ? h('span', { class: 'pal-sub' }, it.sub) : null, it.hint ? h('kbd', null, it.hint) : null));
        return out;
      }) : [h('li', { class: 'pal-empty' }, 'No matches')]));
    };
    input.addEventListener('input', () => { active = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); paint(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      if (e.key === 'Enter' && shown[active]) { e.preventDefault(); const it = shown[active]; closeSheet(); it.run(); }
    });
    paint();
    const [t, j, ag, nd] = await Promise.all([api('/api/tasks').catch(() => null), api('/api/jobs').catch(() => null), api(`/api/agenda?start=${weekStart(today)}&days=21`).catch(() => null), loadNetwork().catch(() => null)]);
    if (sheet.hidden) return;
    items.push({ kind: 'Go to', label: 'Socializing', sub: 'Partiful · lunch & dinner free time', hay: 'socializing partiful lunch dinner', run: () => { location.hash = 'social'; } });
    for (const c of classItems()) items.push({ kind: 'Classes & activities', label: c.option === c.name ? c.name : `${c.option} · ${c.name}`, sub: c.kind === 'class' ? 'Class' : 'Activity', hay: `${c.option} ${c.name}`, run: () => { location.hash = `classes/${c.key}`; } });
    for (const x of t?.open || []) items.push({ kind: 'Tasks', label: x.name, sub: [x.due?.key ? shortDate(x.due.key) : 'No date', x.area].filter(Boolean).join(' · '), hay: `${x.name} ${x.area || ''} ${x.notes || ''} ${x.link || ''}`, run: () => openTaskSheet(x) });
    for (const x of j?.tracker || []) items.push({ kind: 'Jobs', label: `${x.company} · ${x.role}`, sub: x.status, hay: `${x.company} ${x.role} ${x.notes || ''}`, run: () => openJobForm({ job: x, kind: 'job' }) });
    for (const x of j?.opportunities || []) items.push({ kind: 'Opportunities', label: `${x.company} · ${x.role}`, sub: x.fit != null ? `Fit ${x.fit}` : '', hay: `${x.company} ${x.role} ${x.notes || ''}`, run: () => { oppSel = x.id; location.hash = 'opps'; if (current.view === 'opps') render(); } });
    for (const x of nd?.people || []) items.push({ kind: 'People', label: x.name, sub: [x.role, x.company].filter(Boolean).join(' · '), hay: `${x.name} ${x.company || ''} ${x.role || ''} ${x.school || ''} ${(x.tags || []).join(' ')}`, run: () => openPersonSheet(x.id) });
    const seenEv = new Set();
    for (const day of ag?.days || []) for (const ev of day.events) if (!seenEv.has(ev.id)) { seenEv.add(ev.id); items.push({ kind: 'Events', label: ev.title, sub: `${fmtKey(ev.startKey, { weekday: 'short', month: 'short', day: 'numeric' })}${ev.allDay ? '' : ' · ' + timeLabel(ev.start)} · ${ev.feed}`, hay: `${ev.title} ${ev.course || ''} ${ev.location || ''}`, run: () => openEvent(ev) }); }
    if (jobsData == null && j) jobsData = j;
    paint();
  }
  function openShortcuts() {
    const rows = [['N', 'New task'], ['J', 'Add a job from a link'], ['/', 'Search everything'], ['1 – 7', 'Today · Week · Tasks · Jobs · Opportunities · Classes · Socializing'], ['8', 'Coffee chats'], ['R', 'Refresh from Notion and calendars'], ['T', 'Jump to today / this week'], ['← →', 'Previous / next week (Week)'], ['↑ ↓', 'Move through opportunities'], ['Esc', 'Close a panel'], ['?', 'This list']];
    openSheet([h('h2', { id: 'sheetTitle' }, 'Keyboard shortcuts'), h('table', { class: 'keys' }, rows.map(([k, v]) => h('tr', null, h('td', null, k.split(' ').map((x) => (x === '–' ? ' – ' : h('kbd', null, x)))), h('td', null, v))))], 'modal');
  }

  // ---------- boot ----------
  $('#menuBtn').addEventListener('click', openMenu);
  function openMoreSheet() {
    const go = (hash) => { closeSheet(); location.hash = hash; };
    const row = (label, sub, fn, active) => h('button', { type: 'button', class: `more-item${active ? ' active' : ''}`, onclick: fn }, h('span', { class: 'more-label' }, label), sub ? h('span', { class: 'more-sub' }, sub) : null);
    openSheet([
      h('h2', { id: 'sheetTitle' }, 'Dayline'),
      h('div', { class: 'more-list' },
        row('Today', 'Schedule, tasks, deadlines', () => go('today'), current.view === 'today'),
        row('Week', 'Day-by-day agenda', () => go('week'), current.view === 'week'),
        row('Tasks', 'Notion To Do', () => go('tasks'), current.view === 'tasks'),
        row('Jobs', 'Applications by stage', () => go('jobs'), current.view === 'jobs'),
        row('Opportunities', 'Roles to explore', () => go('opps'), current.view === 'opps'),
        row('Coffee chats', 'People, touch points, network map', () => go('chats'), current.view === 'chats'),
        row('Classes & activities', 'Tasks, sessions, exams', () => go('classes'), current.view === 'classes' && current.arg !== 'brainstorm'),
        row('Brainstorm', 'Sticky notes', () => go('classes/brainstorm'), current.view === 'classes' && current.arg === 'brainstorm'),
        row('Socializing', 'Partiful, lunch & dinner plans', () => go('social'), current.view === 'social')),
      h('div', { class: 'more-list' },
        row('Search', 'Tasks, jobs, events', () => { closeSheet(); openSearch(); }),
        row('Add task', null, () => { closeSheet(); openTaskSheet(null); }),
        row('Add job', null, () => { closeSheet(); openAddJob(current.view === 'opps' ? 'opp' : 'job'); }),
        row('Log coffee chat', null, () => { closeSheet(); openLogChat({}); }),
        row('Sources & sign out', null, () => { closeSheet(); openMenu(); })),
    ], 'modal');
  }
  $('#mMore').addEventListener('click', openMoreSheet);
  $('#mSearch').addEventListener('click', openSearch);
  $('#mRefresh')?.addEventListener('click', () => doRefresh());
  $('#mAdd').addEventListener('click', () => (current.view === 'jobs' ? openAddJob('job') : current.view === 'opps' ? openAddJob('opp') : current.view === 'chats' ? openLogChat({}) : openTaskSheet(null)));
  mobileMq.addEventListener('change', () => { document.documentElement.classList.toggle('is-mobile', isMobile()); render(); });
  $('#searchBtn').addEventListener('click', openSearch);
  $('#helpBtn').addEventListener('click', openShortcuts);
  $('#quickTask').addEventListener('click', () => openTaskSheet(null));
  $('#quickJob').addEventListener('click', () => openAddJob(current.view === 'opps' ? 'opp' : 'job'));
  window.addEventListener('hashchange', () => { closeSheet(); render(); main.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  // Keyboard shortcuts (ignored while typing in a field)
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (!sheet.hidden) return;
    const go = (hash) => { e.preventDefault(); location.hash = hash; };
    switch (e.key) {
      case 'n': case 'N': e.preventDefault(); openTaskSheet(null); break;
      case 'j': case 'J': e.preventDefault(); openAddJob(current.view === 'opps' ? 'opp' : 'job'); break;
      case '/': e.preventDefault(); openSearch(); break;
      case '?': e.preventDefault(); openShortcuts(); break;
      case '1': go('today'); break;
      case '2': go('week'); break;
      case '3': go('tasks'); break;
      case '4': go('jobs'); break;
      case '5': go('opps'); break;
      case '6': go('classes'); break;
      case '7': go('social'); break;
      case '8': go('chats'); break;
      case 'r': case 'R': e.preventDefault(); doRefresh(); break;
      case 't': case 'T':
        if (current.view === 'week') go('week');
        else if (current.view === 'tasks') { e.preventDefault(); dayFilter = null; calMonth = todayStr().slice(0, 7); render(); }
        else go('today');
        break;
      case 'ArrowLeft': case 'ArrowRight':
        if (current.view === 'week') { const node = main.firstChild; const wk = node?._week || weekStart(todayStr()); go(`week/${addDays(wk, e.key === 'ArrowLeft' ? -7 : 7)}`); }
        break;
      case 'ArrowDown': case 'ArrowUp':
        if (current.view === 'opps' && viewOpps.move) { e.preventDefault(); viewOpps.move(e.key === 'ArrowDown' ? 1 : -1); }
        break;
      default:
    }
  });
  let lastRefresh = Date.now();
  const refreshIfStale = () => { if (document.visibilityState === 'visible' && sheet.hidden && Date.now() - lastRefresh > 60000) { lastRefresh = Date.now(); render(); } };
  document.addEventListener('visibilitychange', refreshIfStale);
  window.addEventListener('focus', refreshIfStale);
  setInterval(() => { if (current.view === 'today' && sheet.hidden && document.visibilityState === 'visible') { lastRefresh = Date.now(); render(); } }, 5 * 60000);

  (async () => {
    // Accept /week and /tasks paths as entry points too.
    const p = location.pathname.replace(/^\//, '');
    if (!location.hash && ['week', 'tasks', 'today', 'jobs', 'opportunities', 'classes', 'social'].includes(p)) history.replaceState(null, '', `/#${p === 'opportunities' ? 'opps' : p}`);
    try {
      me = Object.assign(me, await api('/api/me'));
      clockOffset = Date.parse(me.now) - Date.now();
      const pill = $('#modePill');
      pill.textContent = me.mode === 'fixture' ? 'Sample data' : 'Read-only';
      pill.title = me.mode === 'fixture' ? 'Demo data: changes stay on this computer' : 'Changes to Notion are turned off on this server';
      pill.hidden = !(me.mode === 'fixture' || me.readOnly);
    } catch { /* api() redirects on 401 */ }
    render();
  })();
})();
