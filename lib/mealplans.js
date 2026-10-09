'use strict';
// Who you plan to eat lunch/dinner with (Socializing tab).
// Stored in Dayline's own store (lib/store.js), not the user's To Do list. No calendar writes.
// TITLE_RE / parseNotes still recognise the old "[Dayline] Lunch|Dinner YYYY-MM-DD — Name" To Do rows
// (used once by scripts/migrate-mealplans.js to move them out of To Do).
const crypto = require('crypto');

const MARKER = 'dayline-meal:';
const TITLE_RE = /^\[Dayline\]\s+(Lunch|Dinner)\s+(\d{4}-\d{2}-\d{2})\s+[—–-]\s+(.+)$/i;
/** Outreach status for a planned meal (separate from Notion To Do Status). */
const PLAN_STATUSES = ['Planned', 'Reached out', 'Confirmed', 'Declined', 'Cancelled'];
const DEFAULT_PLAN_STATUS = 'Planned';

function planKey(date, meal) { return `${date}:${meal}`; }

function normalizePlanStatus(s) {
  const raw = String(s || '').trim().toLowerCase();
  if (!raw) return DEFAULT_PLAN_STATUS;
  const hit = PLAN_STATUSES.find((x) => x.toLowerCase() === raw);
  return hit || null;
}

function validatePlan({ date, meal, with: who, planStatus }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'Need a date (YYYY-MM-DD).' };
  if (meal !== 'lunch' && meal !== 'dinner') return { error: 'Meal must be lunch or dinner.' };
  const name = String(who || '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Who are you eating with?' };
  if (name.length > 120) return { error: 'Keep the name under 120 characters.' };
  const status = planStatus == null || planStatus === ''
    ? DEFAULT_PLAN_STATUS
    : normalizePlanStatus(planStatus);
  if (!status) return { error: `Status must be one of: ${PLAN_STATUSES.join(', ')}.` };
  return { value: { date, meal, with: name, planStatus: status } };
}

function parseTitle(name) {
  const m = String(name || '').match(TITLE_RE);
  if (!m) return null;
  return { meal: m[1].toLowerCase(), date: m[2], with: m[3].trim() };
}

function titleFor({ date, meal, with: who }) {
  const label = meal === 'lunch' ? 'Lunch' : 'Dinner';
  return `[Dayline] ${label} ${date} — ${who}`;
}

function notesFor({ meal, date, with: who, planStatus }) {
  return `${MARKER}${meal}:${date}\nwith:${who}\nstatus:${planStatus || DEFAULT_PLAN_STATUS}`;
}

function parseNotes(notes) {
  const text = String(notes || '');
  if (!text.includes(MARKER)) return null;
  const who = (text.match(/^with:\s*(.+)$/im) || [])[1]?.trim() || null;
  const status = normalizePlanStatus((text.match(/^status:\s*(.+)$/im) || [])[1]) || DEFAULT_PLAN_STATUS;
  return { with: who, planStatus: status };
}

/** Meal plans live in Dayline's own store (lib/store.js), key "YYYY-MM-DD:lunch|dinner". Never a To Do row. */
function createStoreMealPlans({ store }) {
  const toPlan = (r) => ({
    id: r.data?.id || r.key, date: r.data?.date || String(r.key).split(':')[0], meal: r.data?.meal || String(r.key).split(':')[1],
    with: r.data?.with || '', planStatus: normalizePlanStatus(r.data?.planStatus) || DEFAULT_PLAN_STATUS, edited: r.data?.edited || r.updated || null,
  });
  return {
    backend: store.backend,
    statuses: PLAN_STATUSES,
    async list({ from, to } = {}) {
      return (await store.list('meal')).map(toPlan).filter((p) => p.with && (!from || p.date >= from) && (!to || p.date <= to));
    },
    async upsert(input) {
      const { value, error } = validatePlan(input);
      if (error) throw Object.assign(new Error(error), { status: 400 });
      const key = planKey(value.date, value.meal);
      const prev = await store.get('meal', key);
      // Keep prior status when the client omits it on a name-only edit.
      const planStatus = input.planStatus != null && input.planStatus !== ''
        ? value.planStatus
        : (normalizePlanStatus(prev?.data?.planStatus) || value.planStatus);
      const plan = { id: prev?.data?.id || crypto.randomBytes(8).toString('hex'), ...value, planStatus, edited: new Date().toISOString() };
      await store.put('meal', key, plan, { date: value.date });
      return plan;
    },
    async clear({ date, meal }) {
      const key = planKey(date, meal);
      const prev = await store.get('meal', key);
      if (!prev) return { cleared: false };
      await store.remove('meal', key);
      return { cleared: true, id: prev.data?.id || key };
    },
  };
}

module.exports = {
  MARKER, TITLE_RE, planKey, validatePlan, parseTitle, titleFor, notesFor, parseNotes,
  PLAN_STATUSES, DEFAULT_PLAN_STATUS, normalizePlanStatus,
  createStoreMealPlans,
};

/** Convenience for tests/fixtures: meal plans on a JSON-file store. */
function createFileMealPlans({ file }) {
  const { createFileStore } = require('./store');
  return createStoreMealPlans({ store: createFileStore({ file }) });
}
module.exports.createFileMealPlans = createFileMealPlans;
