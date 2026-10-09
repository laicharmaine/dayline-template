'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { heuristicTips, loadBaseline, jobCorpus, fingerprint, suggestResumeTips, tokens } = require('../lib/resume-tips');

test('baseline resume loads with experience bullets', () => {
  const b = loadBaseline();
  assert.ok(b.bullets.length >= 5);
  assert.ok(b.bullets.every((x) => x.id && x.text.length > 20));
});

test('tokens drop stopwords and punctuation', () => {
  assert.ok(tokens('Go-to-market launches.').includes('go-to-market'));
  assert.ok(!tokens('the product and the team').includes('the'));
});

test('heuristic tips return 3–6 copyable rewrites for a PMM role', () => {
  const job = {
    id: 'job1', role: 'Product Marketing MBA Intern', company: 'Adobe', track: 'PMM',
    notes: 'Summary: Own messaging for Creative Cloud launches.\nKey requirements:\n• Product marketing strategy\n• Cross-functional collaboration\n• Customer insights\n• Go-to-market positioning',
  };
  const r = heuristicTips(job, loadBaseline());
  assert.equal(r.source, 'heuristic');
  assert.ok(r.suggestions.length >= 3 && r.suggestions.length <= 6);
  for (const s of r.suggestions) {
    assert.ok(s.rewritten.length > 20);
    assert.ok(s.original);
    assert.ok(s.why);
  }
  assert.match(r.note, /Gemini/i);
});

test('suggestResumeTips caches by job fingerprint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayline-tips-'));
  const cachePath = path.join(dir, 'cache.json');
  const job = { id: 'abc', role: 'PM Intern', company: 'Acme', track: 'PM', status: 'Interested', notes: 'Summary: Build roadmaps.\nKey requirements:\n• Product discovery\n• Roadmap prioritization' };
  const a = await suggestResumeTips(job, { cachePath, geminiKey: '' });
  assert.equal(a.cached, false);
  const b = await suggestResumeTips(job, { cachePath, geminiKey: '' });
  assert.equal(b.cached, true);
  assert.equal(a.fingerprint, b.fingerprint);
  const c = await suggestResumeTips(job, { cachePath, geminiKey: '', refresh: true });
  assert.equal(c.cached, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('jobCorpus reads requirements from Dayline Notes format', () => {
  const c = jobCorpus({ role: 'X', notes: 'Pay: $40/hr\nSummary: Hello world.\nKey requirements:\n• Foo\n• Bar\n\nExtra note' });
  assert.equal(c.summary, 'Hello world.');
  assert.deepEqual(c.requirements, ['Foo', 'Bar']);
});
