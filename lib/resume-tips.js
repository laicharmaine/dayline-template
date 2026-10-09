'use strict';
// On-demand resume bullet suggestions for a Pipeline job.
// Uses Gemini when GEMINI_API_KEY is set; otherwise a keyword-overlap heuristic.
// Suggestions are copy-paste only — Dayline never edits the user's resume file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.7-flash'];
const BASELINE_PATH = path.join(__dirname, '..', 'config', 'resume-baseline.json');
const BASELINE_LOCAL = path.join(__dirname, '..', 'data', 'resume-baseline.json');
// Vercel serverless FS is read-only except /tmp; keep data/ for local/fixture.
const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const CACHE_PATH = ON_VERCEL
  ? path.join('/tmp', 'dayline-resume-tips-cache.json')
  : path.join(__dirname, '..', 'data', 'resume-tips-cache.json');
const memoryCache = {}; // always available if disk write fails
const STOP = new Set(('a an the and or of to for in on at by with from as is are was were be been being this that these those it its '
  + 'you your we our they their will can may should would could into about over under than then so if not no yes also than more most '
  + 'other such only own same too very just across per via using based include including includes role job team company internship '
  + 'intern mba summer 2026 2027 2028 work working opportunity position').split(/\s+/));

function loadBaseline(file) {
  const candidates = file ? [file] : [BASELINE_LOCAL, BASELINE_PATH];
  for (const f of candidates) {
    if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  throw Object.assign(new Error('Resume baseline not found. Expected config/resume-baseline.json.'), { status: 503, code: 'no_resume' });
}

function readCache(file = CACHE_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ...memoryCache }; }
}
function writeCache(cache, file = CACHE_PATH) {
  Object.keys(memoryCache).forEach((k) => delete memoryCache[k]);
  Object.assign(memoryCache, cache);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Disk unavailable (or full) — in-memory cache still works for this instance.
  }
}

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+#\/\-\s]/g, ' ').split(/[\s\/|,;:]+/).map((w) => w.replace(/^-+|-+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w));
}
function uniq(arr) { return [...new Set(arr)]; }

/** Pull JD text from Notes (Dayline stores summary + requirements there) plus role/company. */
function jobCorpus(job) {
  const notes = String(job.notes || '');
  const reqs = [];
  const m = notes.match(/Key requirements:\n([\s\S]*?)(?:\n\n|$)/i);
  if (m) for (const line of m[1].split('\n')) { const t = line.replace(/^•\s*/, '').trim(); if (t) reqs.push(t); }
  const summary = (notes.match(/Summary:\s*([^\n]+)/i) || [])[1] || '';
  return {
    role: job.role || '',
    company: job.company || '',
    track: job.track || '',
    summary,
    requirements: reqs,
    notes,
    text: [job.role, job.company, job.track, summary, reqs.join('\n'), notes].filter(Boolean).join('\n'),
  };
}

function fingerprint(job, baseline) {
  const c = jobCorpus(job);
  return crypto.createHash('sha1').update(JSON.stringify({
    role: c.role, company: c.company, track: c.track, notes: c.notes.slice(0, 4000),
    bullets: (baseline.bullets || []).map((b) => b.text),
  })).digest('hex').slice(0, 16);
}

function scoreBullet(bullet, jdTokens) {
  const bt = new Set(tokens(bullet.text + ' ' + bullet.role + ' ' + bullet.company));
  const hits = jdTokens.filter((t) => bt.has(t) || [...bt].some((b) => b.includes(t) || t.includes(b)));
  return { score: hits.length, hits: uniq(hits).slice(0, 8) };
}

function rewriteHeuristic(bullet, jd, missingKeywords, overlapHits) {
  const kw = missingKeywords.filter((w) => w.length > 3 && !/^[0-9.]+$/.test(w)).slice(0, 4);
  const hits = (overlapHits || []).slice(0, 4);
  const lead = bullet.text.replace(/\.$/, '');
  const theme = [jd.role, jd.track, jd.summary, ...(jd.requirements || [])].join(' ');
  const whyBits = kw.length
    ? `The posting leans on ${kw.slice(0, 3).join(', ')}. This rewrite keeps your real work and mirrors that language.`
    : hits.length
      ? `This bullet already overlaps (${hits.slice(0, 3).join(', ')}). Small wording tweaks make the match clearer.`
      : 'Closest match to this role’s language among your bullets.';
  let rewritten = lead;
  if (/\b(product|PM|roadmap|requirement|discovery)\b/i.test(theme)) {
    rewritten = rewritten
      .replace(/\bmarket research\b/gi, 'product discovery and market research')
      .replace(/\bgo-to-\s*market messaging\b/gi, 'positioning and go-to-market messaging')
      .replace(/\bproduct capabilities\b/gi, 'product requirements and capabilities')
      .replace(/\bdogfooding sessions\b/gi, 'customer discovery and dogfooding sessions');
  }
  if (/\b(PMM|product marketing|brand|content|campaign|messaging|GTM|go-to-market)\b/i.test(theme)) {
    rewritten = rewritten
      .replace(/\bhigh-impact blogs and content\b/gi, 'high-impact product marketing content')
      .replace(/\bmulti-channel marketing\b/gi, 'multi-channel product marketing')
      .replace(/\bbranding revamp\b/gi, 'brand and web positioning revamp');
  }
  if (/\b(AI|machine learning|LLM|generative)\b/i.test(theme)) {
    rewritten = rewritten
      .replace(/\bgenerative AI platform\b/gi, 'generative AI / LLM platform')
      .replace(/\bAPI documentation\b/gi, 'developer-facing API documentation for an AI platform');
  }
  if (rewritten === lead && kw[0]) {
    // Soft append only when we could not reshape wording — keep it honest.
    rewritten = `${lead}, with clear relevance to ${kw.slice(0, 2).join(' and ')}`;
  }
  if (!rewritten.endsWith('.')) rewritten += '.';
  return {
    bulletId: bullet.id,
    original: bullet.text,
    context: [bullet.role, bullet.company].filter(Boolean).join(' · '),
    rewritten,
    why: whyBits,
  };
}

function heuristicTips(job, baseline) {
  const jd = jobCorpus(job);
  const jdTokens = uniq(tokens(jd.text));
  const scored = baseline.bullets.map((b) => ({ b, ...scoreBullet(b, jdTokens) }))
    .sort((a, b) => b.score - a.score || b.b.text.length - a.b.text.length);
  const allBulletTokens = new Set(baseline.bullets.flatMap((b) => tokens(b.text)));
  const companyBits = new Set(tokens(jd.company));
  const missing = jdTokens.filter((t) => !allBulletTokens.has(t) && t.length > 3 && !companyBits.has(t) && !/\d/.test(t)).slice(0, 12);
  const picks = scored.slice(0, 6);
  const suggestions = picks.map(({ b, hits }) => {
    const prefer = missing.length ? missing : hits;
    return rewriteHeuristic(b, jd, prefer, hits);
  });
  // Prefer 3–6, drop near-duplicates
  const out = [];
  const seen = new Set();
  for (const s of suggestions) {
    const key = s.rewritten.slice(0, 48);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 6) break;
  }
  return {
    source: 'heuristic',
    model: null,
    note: 'Generated with keyword overlap (no Gemini key on this server). Add GEMINI_API_KEY for stronger, JD-specific rewrites.',
    keywords: missing.slice(0, 10),
    suggestions: out.slice(0, Math.max(3, Math.min(6, out.length))),
  };
}

const TIPS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          bulletId: { type: 'STRING' },
          rewritten: { type: 'STRING' },
          why: { type: 'STRING' },
        },
        required: ['bulletId', 'rewritten', 'why'],
      },
    },
  },
  required: ['suggestions'],
};

async function callGeminiTips({ job, baseline, apiKey, models = DEFAULT_GEMINI_MODELS, fetchImpl = globalThis.fetch }) {
  const jd = jobCorpus(job);
  const bullets = baseline.bullets.map((b) => ({ id: b.id, role: b.role, company: b.company, text: b.text }));
  const prompt = `You help a job seeker tailor their resume for ONE internship posting. Return 3 to 6 concrete suggestions.
Rules:
- Only rewrite bullets from the list (use their bulletId). Do not invent employers, titles, or metrics.
- Keep each rewrite to one sentence, first-person implied (no "I"), action-led, with a real outcome from the original.
- Emphasize keywords from the job description when they honestly fit their experience.
- "why" is one short sentence they can read quickly.
Job:
${JSON.stringify({ company: jd.company, role: jd.role, track: jd.track, summary: jd.summary, requirements: jd.requirements, notesExcerpt: jd.notes.slice(0, 2500) })}
Resume bullets:
${JSON.stringify(bullets)}`;

  let lastErr;
  for (const model of (models?.length ? models : DEFAULT_GEMINI_MODELS)) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, responseMimeType: 'application/json', responseSchema: TIPS_SCHEMA },
        }),
      });
      if (r.status === 404 || r.status === 429 || r.status >= 500) { lastErr = new Error(`gemini ${model} ${r.status}`); continue; }
      if (!r.ok) { lastErr = new Error(`gemini ${model} ${r.status}`); continue; }
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      const raw = JSON.parse(text);
      const byId = Object.fromEntries(baseline.bullets.map((b) => [b.id, b]));
      const suggestions = (raw.suggestions || []).slice(0, 6).map((s) => {
        const b = byId[s.bulletId] || baseline.bullets[0];
        return {
          bulletId: b.id,
          original: b.text,
          context: [b.role, b.company].filter(Boolean).join(' · '),
          rewritten: String(s.rewritten || '').trim(),
          why: String(s.why || '').trim(),
        };
      }).filter((s) => s.rewritten.length > 20);
      if (suggestions.length < 3) { lastErr = new Error('too few suggestions'); continue; }
      return { source: 'gemini', model, note: 'Suggestions from Gemini. Copy what you like — nothing is written to your resume file.', keywords: [], suggestions };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('gemini failed');
}

/**
 * @param {object} job - parsed Dayline job
 * @param {object} opts
 * @param {boolean} [opts.refresh] - ignore cache
 * @param {string} [opts.geminiKey]
 * @param {string[]} [opts.geminiModels]
 * @param {string} [opts.baselinePath]
 * @param {string} [opts.cachePath]
 */
async function suggestResumeTips(job, opts = {}) {
  const baseline = loadBaseline(opts.baselinePath);
  const fp = fingerprint(job, baseline);
  const cacheKey = `${job.id}:${fp}`;
  const cacheFile = opts.cachePath || CACHE_PATH;
  if (!opts.refresh) {
    const cache = readCache(cacheFile);
    if (cache[cacheKey]) return { ...cache[cacheKey], cached: true, fingerprint: fp };
  }
  let result;
  if (opts.geminiKey) {
    try { result = await callGeminiTips({ job, baseline, apiKey: opts.geminiKey, models: opts.geminiModels, fetchImpl: opts.fetchImpl }); }
    catch { result = heuristicTips(job, baseline); result.note = 'Gemini unavailable; used keyword overlap instead. ' + result.note; }
  } else {
    result = heuristicTips(job, baseline);
  }
  result.cached = false;
  result.fingerprint = fp;
  result.jobId = job.id;
  result.generatedAt = new Date().toISOString();
  result.resumeLabel = baseline.label;
  const cache = readCache(cacheFile);
  cache[cacheKey] = result;
  // keep cache bounded
  const keys = Object.keys(cache);
  if (keys.length > 80) for (const k of keys.slice(0, keys.length - 60)) delete cache[k];
  writeCache(cache, cacheFile);
  return result;
}

module.exports = {
  loadBaseline, jobCorpus, fingerprint, heuristicTips, suggestResumeTips, tokens,
  BASELINE_PATH, CACHE_PATH, DEFAULT_GEMINI_MODELS,
};
