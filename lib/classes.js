'use strict';
// Maps tasks and calendar events to your classes and activities using config/classes.js.
const CONFIG = require('../config/classes');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildItems(config = CONFIG) {
  const items = [];
  for (const c of config.classes || []) {
    const codes = (c.codes || []).map(norm);
    // "ABC-101", "ABC 101", "ABC_101-0", "2026FA_ABC_101-0_SEC36" (not "ABC-1010")
    const res = codes.map((code) => { const [subj, num] = code.split(' '); return new RegExp(`(?:^|[^A-Z0-9])${subj}[\\s_-]?${num}(?![0-9])`, 'i'); });
    items.push({ key: slug(c.option), option: c.option, name: c.name || c.option, kind: 'class', codes, color: c.color || 'default', midterm: c.midterm || null, final: c.final || null, test: (t) => res.some((r) => r.test(t)) });
  }
  for (const a of config.activities || []) {
    const res = (a.keywords || []).map((k) => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(k).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'i'));
    items.push({ key: slug(a.option), option: a.option, name: a.name || a.option, kind: 'activity', codes: [], color: a.color || 'default', test: (t) => res.some((r) => r.test(t)) });
  }
  return items;
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function createClassMatcher(config = CONFIG) {
  const items = buildItems(config);
  const byOption = new Map(items.map((i) => [i.option, i]));
  /** Options whose course code or keyword appears in `title` (classes first). */
  function matchTitle(title) {
    const t = String(title || '');
    const classHits = items.filter((i) => i.kind === 'class' && i.test(t));
    const actHits = items.filter((i) => i.kind === 'activity' && i.test(t));
    return [...classHits, ...actHits].map((i) => i.option);
  }
  /** One option for a calendar event: its parsed course code first, then the title. */
  function matchEvent(ev) {
    if (ev.course) {
      const c = items.find((i) => i.kind === 'class' && i.codes.includes(norm(ev.course)));
      if (c) return c.option;
    }
    const hits = matchTitle(`${ev.rawTitle || ''} ${ev.title || ''}`);
    return hits[0] || null;
  }
  const publicItems = () => items.map(({ test, ...rest }) => rest);
  return { items: publicItems(), options: items.map((i) => i.option), byOption, matchTitle, matchEvent };
}

module.exports = { createClassMatcher, CONFIG, slug };
