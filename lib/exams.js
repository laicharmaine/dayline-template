'use strict';
// Midterm / final countdown helpers for Classes & activities.
// Sources (first match wins per kind, earliest upcoming date): config dates, Notion tasks, calendar events.

const MIDTERM_RE = /\bmid[\s-]?terms?(?:\s+exam)?\b/i;
const FINAL_RE = /\bfinal\s+exam\b/i;

function classifyExamTitle(title) {
  const t = String(title || '');
  if (MIDTERM_RE.test(t)) return 'midterm';
  if (FINAL_RE.test(t)) return 'final';
  return null;
}

function pickExam(cands, today) {
  const upcoming = cands.filter((c) => c.key && c.key >= today).sort((a, b) => a.key.localeCompare(b.key));
  if (upcoming.length) return upcoming[0];
  // If all past, still return the most recent so UI can show "done"
  const past = cands.filter((c) => c.key).sort((a, b) => b.key.localeCompare(a.key));
  return past[0] || null;
}

/**
 * @param {{ option: string, midterm?: string, final?: string }} item
 * @param {{ name: string, due?: { key?: string }, classes?: string[] }[]} tasks
 * @param {{ title?: string, rawTitle?: string, startKey: string, cls?: string, deadline?: boolean }[]} events
 * @param {string} today YYYY-MM-DD
 */
function examsForClass(item, { tasks = [], events = [], today }) {
  const midtermCands = [];
  const finalCands = [];
  const push = (kind, cand) => { (kind === 'midterm' ? midtermCands : finalCands).push(cand); };

  if (item.midterm && /^\d{4}-\d{2}-\d{2}$/.test(item.midterm)) {
    push('midterm', { key: item.midterm, label: 'Midterm (config)', source: 'config' });
  }
  if (item.final && /^\d{4}-\d{2}-\d{2}$/.test(item.final)) {
    push('final', { key: item.final, label: 'Final (config)', source: 'config' });
  }

  for (const t of tasks) {
    if (!(t.classes || []).includes(item.option)) continue;
    const kind = classifyExamTitle(t.name);
    if (!kind || !t.due?.key) continue;
    push(kind, { key: t.due.key, label: t.name, source: 'task', task: t });
  }

  for (const e of events) {
    if (e.cls && e.cls !== item.option) continue;
    const kind = classifyExamTitle(`${e.title || ''} ${e.rawTitle || ''}`);
    if (!kind) continue;
    push(kind, { key: e.startKey, label: e.title || e.rawTitle, source: 'calendar', ev: e });
  }

  return {
    midterm: pickExam(midtermCands, today),
    final: pickExam(finalCands, today),
  };
}

function countdownLabel(key, today) {
  if (!key) return null;
  const d = Math.round((Date.parse(key + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  if (d === 0) return { days: 0, text: 'Today', tone: 'today' };
  if (d === 1) return { days: 1, text: 'Tomorrow', tone: 'soon' };
  if (d < 0) return { days: d, text: `${Math.abs(d)}d ago`, tone: 'past' };
  if (d <= 7) return { days: d, text: `${d} days`, tone: 'soon' };
  if (d <= 21) return { days: d, text: `${d} days`, tone: 'mid' };
  return { days: d, text: `${d} days`, tone: 'later' };
}

module.exports = { MIDTERM_RE, FINAL_RE, classifyExamTitle, examsForClass, countdownLabel, pickExam };
