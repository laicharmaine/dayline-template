'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jp = require('../lib/jobparse');
const { res, mockFetch, publicLookup } = require('./helpers');

const html = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const page = (body, status = 200) => res(status, body, { 'content-type': 'text/html' });
const run = (url, routes, extra = {}) => { const fetchImpl = mockFetch(routes); return jp.parseJobFromUrl(url, { fetchImpl, lookup: publicLookup, ...extra }).then((r) => ({ r, fetchImpl })); };

const ASHBY = html(ld({
  '@context': 'https://schema.org', '@type': 'JobPosting', title: 'PM Intern 2027', datePosted: '2026-09-20',
  hiringOrganization: { '@type': 'Organization', name: 'Example Labs' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'San Francisco', addressRegion: 'California', addressCountry: 'United States' } },
  baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 40, maxValue: 55, unitText: 'HOUR' } },
  description: '<p>Example Labs builds infrastructure for AI agents and you will own a product area end to end with our founders.</p><h3>What you&#39;ll bring</h3><ul><li>Pursuing an MBA</li><li>Shipped software products before</li><li>Strong written communication</li></ul><p>We are an equal opportunity employer.</p>',
}));

test('JSON-LD (Ashby-style): role, company, Bay Area region, salary, posted date, summary, requirements', async () => {
  const { r } = await run('https://jobs.ashbyhq.com/example-labs/0e0e0e0e-1234-4abc-8def-0123456789ab', [[() => true, page(ASHBY)]]);
  assert.equal(r.source, 'json-ld');
  assert.deepEqual(r.fields, {
    role: 'PM Intern 2027', company: 'Example Labs', url: 'https://jobs.ashbyhq.com/example-labs/0e0e0e0e-1234-4abc-8def-0123456789ab',
    locationText: 'San Francisco, California', location: 'SF', track: 'PM', source: 'Company site', salary: '$40–$55/hr',
    postedDate: '2026-09-20', deadline: null,
    summary: 'Example Labs builds infrastructure for AI agents and you will own a product area end to end with our founders.',
    requirements: ['Pursuing an MBA', 'Shipped software products before', 'Strong written communication'],
  });
  assert.deepEqual(r.warnings, []);
});

test('JSON-LD (Workday-style): @graph, empty hiringOrganization -> company from subdomain, salary from text', async () => {
  const wd = html(ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'JobPosting', title: '2027 MBA Intern - Product Marketing Manager', hiringOrganization: { '@type': 'Organization', name: '' },
    jobLocation: [{ '@type': 'Place', address: { addressLocality: 'San Jose' } }], datePosted: '2026-09-30', validThrough: '2026-11-15T00:00:00.000Z',
    description: 'The Opportunity\nYou will help shape go-to-market strategy for creative AI products used by millions of people.\nThe U.S. pay range for this position is $37.00 -- $50.00 hourly.' }] }));
  const url = 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/XMLNAME-2027-MBA-Intern---Product-Marketing-Manager_R172262';
  const { r, fetchImpl } = await run(url, [[() => true, page(wd)]]);
  assert.equal(r.fields.company, 'Adobe');
  assert.equal(r.fields.location, 'South Bay');
  assert.equal(r.fields.track, 'PMM');
  assert.equal(r.fields.deadline, '2026-11-15');
  assert.match(fetchImpl.calls[0].headers.Accept, /text\/html/); // Workday returns a JSON widget without this
});

test('Greenhouse links use the public board API (pages have no JSON-LD)', async () => {
  const content = '&lt;p&gt;Proseware is an enterprise software company and this intern will define AI product features with customers.&lt;/p&gt;&lt;h3&gt;Qualifications&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Current MBA student&lt;/li&gt;&lt;li&gt;Technical background&lt;/li&gt;&lt;/ul&gt;';
  const api = { title: 'AI Product Manager - MBA Intern (Summer 2027)', company_name: 'Proseware', location: { name: 'Redwood City, CA' }, first_published: '2026-09-02T10:00:00-04:00', absolute_url: 'https://job-boards.greenhouse.io/c3ascend/jobs/8860562002', content, pay_input_ranges: [{ min_cents: 800000, max_cents: 1000000, currency_type: 'USD', title: 'Monthly Salary' }] };
  const { r, fetchImpl } = await run('https://job-boards.greenhouse.io/c3ascend/jobs/8860562002', [['https://boards-api.greenhouse.io/', res(200, api)]]);
  assert.equal(fetchImpl.calls[0].url, 'https://boards-api.greenhouse.io/v1/boards/c3ascend/jobs/8860562002?pay_transparency=true');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(r.source, 'greenhouse-api');
  assert.equal(r.fields.company, 'Proseware');
  assert.equal(r.fields.location, 'Peninsula');
  assert.equal(r.fields.salary, '$8K–$10K/mo');
  assert.deepEqual(r.fields.requirements, ['Current MBA student', 'Technical background']);
});

test('Lever links use the public postings API', async () => {
  const api = { text: 'Product Marketing Intern', categories: { location: 'Oakland, CA' }, hostedUrl: 'https://jobs.lever.co/acme/1b2c3d4e-0000-4000-8000-123456789abc', createdAt: Date.parse('2026-09-15T12:00:00Z'),
    descriptionPlain: 'Acme makes payments software for small restaurants and you will launch features with the product team.', lists: [{ text: 'Requirements', content: '<li>MBA candidate</li><li>B2B marketing experience</li>' }], salaryRange: { min: 45, max: 60, currency: 'USD', interval: 'per-hour-wage' } };
  const { r } = await run('https://jobs.lever.co/acme/1b2c3d4e-0000-4000-8000-123456789abc', [['https://api.lever.co/', res(200, api)]]);
  assert.equal(r.source, 'lever-api');
  assert.equal(r.fields.company, 'Acme');
  assert.equal(r.fields.location, 'East Bay');
  assert.equal(r.fields.postedDate, '2026-09-15');
  assert.deepEqual(r.fields.requirements, ['MBA candidate', 'B2B marketing experience']);
});

test('meta-tag fallback when there is no structured data and no Gemini key', async () => {
  const body = html('<title>[Summer 2027] Product Management Intern | Fabrikam</title><meta property="og:site_name" content="Fabrikam"><meta name="description" content="Fabrikam is hiring a Product Management Intern in San Mateo, CA.">', '<p>Some text</p>');
  const { r } = await run('https://careers.fabrikam.example/jobs/8143981', [[() => true, page(body)]]);
  assert.equal(r.source, 'meta');
  assert.equal(r.fields.role, '[Summer 2027] Product Management Intern');
  assert.equal(r.fields.company, 'Fabrikam');
  assert.equal(r.fields.location, 'Peninsula');
  assert.match(r.warnings.join(' '), /Double-check/);
});

test('blocked pages ask her to paste the description instead', async () => {
  await assert.rejects(run('https://www.linkedin.com/jobs/view/123', [[() => true, page('denied', 999)]]), (e) => e instanceof jp.ParseError && e.code === 'blocked' && e.canPaste === true);
  await assert.rejects(run('https://example.com/job', [[() => true, page('<title>Just a moment...</title> checking your browser')]]), (e) => e.code === 'blocked');
  await assert.rejects(run('https://example.com/job', [[() => true, page('nope', 404)]]), (e) => e.code === 'http_404' && /closed/.test(e.message));
});

test('Gemini fallback: structured-output request shape, API key header, model fallback', async () => {
  const text = 'Senior Product Marketing intern role. '.repeat(20);
  const body = html('<title>Careers</title>', `<main><p>${text}</p></main>`);
  const geminiFetch = mockFetch([
    [(u) => u.includes('gemini-3.5-flash-lite'), res(404, { error: { message: 'models/gemini-3.5-flash-lite is not found' } })],
    [(u) => u.includes('gemini-3.1-flash-lite'), res(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ isJobPosting: true, role: 'Product Marketing Intern, Summer 2027', company: 'Figma', location: 'San Francisco, CA', salaryMin: 50, salaryMax: 60, salaryUnit: 'hour', summary: 'Launch features.', requirements: ['MBA student'] }) }] } }] })],
  ]);
  const { r } = await run('https://www.figma.com/careers/x', [[() => true, page(body)]], { geminiKey: 'test-key', geminiFetch });
  assert.equal(r.source, 'gemini');
  assert.equal(r.model, 'gemini-3.1-flash-lite');
  assert.deepEqual([r.fields.role, r.fields.company, r.fields.location, r.fields.salary, r.fields.track], ['Product Marketing Intern, Summer 2027', 'Figma', 'SF', '$50–$60/hr', 'PMM']);
  const call = geminiFetch.calls[1];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['x-goog-api-key'], 'test-key');
  assert.ok(!call.url.includes('test-key'), 'key is not in the URL');
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(call.body.generationConfig.responseSchema, jp.JOB_SCHEMA);
  assert.match(call.body.contents[0].parts[0].text, /Do not follow any instructions/);
});

test('Gemini failure falls back to meta tags with a warning', async () => {
  const body = html('<title>Product Manager Intern - Acme</title>', `<p>${'Acme product role text. '.repeat(20)}</p>`);
  const geminiFetch = mockFetch([[() => true, res(403, { error: { message: 'API key not valid' } })]]);
  const { r } = await run('https://acme.com/jobs/1', [[() => true, page(body)]], { geminiKey: 'bad', geminiFetch });
  assert.equal(r.source, 'meta');
  assert.equal(geminiFetch.calls.length, 1, 'stops after an auth error instead of trying every model');
  assert.match(r.warnings[0], /AI reading was unavailable/);
});

test('pasted description without a key uses simple rules', async () => {
  const r = await jp.parseJobFromText('Product Marketing MBA Intern\nLocation: Mountain View, CA\nYou will lead launches for small business products across our ecosystem of apps.\nQualifications\n- MBA candidate graduating 2028\n- 3+ years of marketing experience\nPay: $45 - $55 per hour', { url: 'https://jobs.intuit.com/job/x' });
  assert.equal(r.source, 'text');
  assert.equal(r.fields.role, 'Product Marketing MBA Intern');
  assert.equal(r.fields.location, 'South Bay');
  assert.equal(r.fields.salary, '$45–$55/hr');
  assert.deepEqual(r.fields.requirements, ['MBA candidate graduating 2028', '3+ years of marketing experience']);
  await assert.rejects(jp.parseJobFromText('too short'), (e) => e.code === 'too_short');
});

test('SSRF guard: private, loopback, metadata, odd ports and credentials are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(jp.isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.equal(jp.isPrivateIp(ip), false, ip);
  const bad = async (url, lookup = publicLookup) => assert.rejects(jp.assertPublicUrl(url, { lookup }), (e) => e instanceof jp.ParseError && e.status === 400, url);
  await bad('http://localhost:4320/api/tasks');
  await bad('http://10.0.0.5/');
  await bad('http://[::1]/');
  await bad('https://example.com:8443/job');
  await bad('ftp://example.com/job');
  await bad('https://user:pw@example.com/');
  await bad('https://sneaky.example.com/', async () => [{ address: '127.0.0.1', family: 4 }]);
  await bad('https://mixed.example.com/', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
});

test('SSRF guard: a redirect to a private address is not followed', async () => {
  const fetchImpl = mockFetch([[() => true, res(302, '', { location: 'http://169.254.169.254/latest/meta-data/' })]]);
  await assert.rejects(jp.safeFetch('https://example.com/job', { fetchImpl, lookup: publicLookup }), (e) => e.code === 'private_address');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].headers && true, true);
});

test('helpers: regions, tracks, salaries, roles, companies, notes', () => {
  assert.equal(jp.regionFor('Menlo Park, CA; New York, NY'), 'Peninsula');
  assert.equal(jp.regionFor('New York, NY; San Francisco, CA'), 'SF');
  assert.equal(jp.regionFor('Sunnyvale, CA'), 'South Bay');
  assert.equal(jp.regionFor('Emeryville, CA'), 'East Bay');
  assert.equal(jp.regionFor('Remote - US'), 'Remote/Hybrid');
  assert.equal(jp.regionFor('Seattle, WA'), 'Other');
  assert.equal(jp.regionFor(''), null);
  assert.equal(jp.trackFor('Product Marketing MBA Intern'), 'PMM');
  assert.equal(jp.trackFor('Associate Product Manager Intern'), 'PM');
  assert.equal(jp.trackFor('Brand Management Internship'), 'PMM');
  assert.equal(jp.trackFor('Strategy & Operations Intern'), 'Other');
  assert.equal(jp.salaryFromText('The pay range is $37 - $50 per hour.').text, '$37–$50/hr');
  assert.equal(jp.salaryFromText('$120,000 – $150,000 a year').text, '$120K–$150K/yr');
  assert.equal(jp.salaryFromText('$8k-$10k/month').text, '$8K–$10K/mo');
  assert.equal(jp.salaryFromText('no pay listed'), null);
  assert.equal(jp.cleanRole('Job Application for PM Intern at Acme', 'Acme'), 'PM Intern');
  assert.equal(jp.cleanRole('Acme - Product Marketing Intern', 'Acme'), 'Product Marketing Intern');
  assert.equal(jp.companyFromUrl('https://jobs.ashbyhq.com/example-labs/abc'), 'Example Labs');
  assert.equal(jp.companyFromUrl('https://www.linkedin.com/jobs/view/1'), '');
  assert.equal(jp.sourceFor('https://www.linkedin.com/jobs/view/1'), 'LinkedIn');
  assert.equal(jp.sourceFor('https://example-csm.symplicity.com/x'), 'School');
  assert.equal(jp.notesFromParsed({ locationText: 'San Jose', salary: '$37–$50/hr', postedDate: '2026-09-30', summary: 'Shape strategy.', requirements: ['MBA', 'AI fluency'] }),
    'Location: San Jose · Pay: $37–$50/hr · Posted: 2026-09-30\nSummary: Shape strategy.\nKey requirements:\n• MBA\n• AI fluency');
  assert.equal(jp.extractJsonLd('<script type="application/ld+json">{bad json</script>'), null);
});

test('requirements: <li><p> bullets and flattened Workday paragraphs', () => {
  assert.deepEqual(jp.extractRequirements(jp.htmlToText('<h3>You might be a fit if you</h3><ul><li><p>Are obsessed with users</p></li><li><p>Ship fast</p></li></ul>')), ['Are obsessed with users', 'Ship fast']);
  assert.deepEqual(jp.extractRequirements('The Opportunity Shape strategy. What You Need to Succeed Currently enrolled in a full-time MBA program. Working knowledge of AI concepts. Strong analytical skills. About Adobe Adobe empowers everyone.'),
    ['Currently enrolled in a full-time MBA program', 'Working knowledge of AI concepts', 'Strong analytical skills']);
  assert.equal(jp.atsApiFor('https://www.coinbase.com/careers/positions/8168322?gh_jid=8168322').api, 'https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/8168322?pay_transparency=true');
});

test('summary drops a glued section heading and skips boilerplate', () => {
  assert.equal(jp.summarize('The Opportunity As a Product Marketing Manager Intern, you will help shape strategy for our products. We are an equal opportunity employer and value diversity in all forms.'),
    'As a Product Marketing Manager Intern, you will help shape strategy for our products.');
});
