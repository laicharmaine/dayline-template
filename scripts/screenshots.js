// Desktop screenshots (1440x900) of every page, the add-from-URL panel, search and the new-task panel.
// Also checks that a window narrower than the 1100px minimum keeps the desktop layout and scrolls sideways.
// Usage: NOW=2026-10-05T10:56:00-05:00 scripts/start.sh   (fixture mode), then:
//        node scripts/screenshots.js [baseUrl] [password]
// The add-from-URL shot does one read-only fetch of a public job posting. Nothing is saved.
const { chromium } = require('playwright-core');
const path = require('path');
// LIVE=1: the live instance on 4321 (password from data/.live-password); saves only live-*.png page shots.
// PROD=1 PROD_URL=https://…vercel.app: the deployed site, password from DAYLINE_APP_PASSWORD / APP_PASSWORD (env, never argv); saves prod-today/jobs/classes.png.
const PROD = !!process.env.PROD;
const LIVE = !!process.env.LIVE || PROD;
const BASE = process.argv[2] || (PROD ? process.env.PROD_URL : LIVE ? 'http://localhost:4321' : 'http://localhost:4320');
const PASSWORD = process.argv[3] || (PROD ? process.env.DAYLINE_APP_PASSWORD || process.env.APP_PASSWORD
  : LIVE ? require('fs').readFileSync(path.join(__dirname, '..', 'data', '.live-password'), 'utf8').trim() : process.env.APP_PASSWORD || 'dayline-local');
const OUT = path.join(__dirname, '..', 'screenshots');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const POSTING = process.env.POSTING_URL || 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/XMLNAME-2027-MBA-Intern---Product-Marketing-Manager_R172262';
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Chicago', colorScheme: 'light' };
const extraWidths = (process.env.WIDTHS || '').split(',').filter(Boolean).map(Number); // e.g. WIDTHS=1280,1920

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors = [];
  const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(OUT, name), fullPage });
  const newPage = async (opts) => {
    const ctx = await browser.newContext(opts); const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(BASE + '/login'); await p.fill('#password', PASSWORD);
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('#loginBtn')]);
    return p;
  };
  const go = async (p, hash, sel) => { await p.goto(BASE + '/' + hash); await p.waitForSelector(sel); await p.waitForLoadState('networkidle'); await p.waitForTimeout(400); };

  const d = await newPage(desktop);
  if (LIVE) {
    const pages = [['#today', '.dash', 'today'], ['#week', '.wk', 'week'], ['#tasks', '.ttable', 'tasks'], ['#jobs', '.kanban', 'jobs'], ['#opps', '.opps-host .drow', 'opportunities'], ['#classes', '.cls-grid', 'classes'], ['#social', '.soc-grid', 'socializing']];
    for (const [hash, sel, name] of pages.filter((x) => !PROD || ['today', 'jobs', 'classes', 'socializing'].includes(x[2]))) {
      await go(d, hash, sel); await shot(d, `${PROD ? 'prod' : 'live'}-${name}.png`);
    }
    await browser.close();
    if (errors.length) { console.log('Browser errors:\n' + [...new Set(errors)].join('\n')); process.exitCode = 1; } else console.log((PROD ? 'Production' : 'Live') + ' screenshots saved to', OUT, '(no browser errors)');
    return;
  }
  await go(d, '#today', '.dash'); await shot(d, 'desktop-01-today.png');
  await go(d, '#week', '.wk'); await shot(d, 'desktop-02-week.png');
  await go(d, '#tasks', '.ttable'); await shot(d, 'desktop-03-tasks.png');
  await d.locator('.trow .c-name .tname').first().click(); await d.waitForSelector('.sheet.panel #taskNotes, .sheet.panel .notes-view'); await d.waitForTimeout(300);
  await shot(d, 'desktop-03b-task-detail.png');
  await d.keyboard.press('Escape');
  await go(d, '#jobs', '.kanban'); await shot(d, 'desktop-04-jobs-board.png');
  await d.click('.dtoolbar .seg button:has-text("Table")'); await d.waitForSelector('.dtable'); await d.waitForTimeout(300);
  await shot(d, 'desktop-04b-jobs-table.png');
  await d.click('.dtoolbar .seg button:has-text("Board")'); await d.waitForSelector('.kanban');
  await d.keyboard.press('j'); await d.waitForSelector('#jobUrl');
  await d.fill('#jobUrl', POSTING); await d.waitForTimeout(200);
  await shot(d, 'desktop-05-add-from-url.png');
  await d.click('#sheet button[type=submit]');
  await d.waitForSelector('#jf-role', { timeout: 30000 }); await d.waitForTimeout(400);
  await shot(d, 'desktop-05b-add-from-url-review.png');
  await d.keyboard.press('Escape');
  await go(d, '#opps', '.opps-host .drow'); await shot(d, 'desktop-06-opportunities.png');
  await d.click('.dtoolbar .seg button:has-text("Cards")'); await d.waitForSelector('.ocards'); await d.waitForTimeout(300);
  await shot(d, 'desktop-06b-opportunities-cards.png');
  await d.click('.dtoolbar .seg button:has-text("Table")'); await d.waitForSelector('.dtable');
  await go(d, '#today', '.dash'); await d.keyboard.press('/'); await d.waitForSelector('.pal-input'); await d.waitForTimeout(600);
  await d.keyboard.type('intuit'); await d.waitForTimeout(300); await shot(d, 'desktop-07-search.png');
  await d.keyboard.press('Escape');
  await d.keyboard.press('n'); await d.waitForSelector('#taskName'); await d.waitForTimeout(250); await shot(d, 'desktop-08-new-task-panel.png');
  await d.keyboard.press('Escape');
  await go(d, '#classes', '.cls-grid'); await shot(d, 'desktop-09-classes.png');
  await go(d, '#classes/class-a', '.cls-cols'); await shot(d, 'desktop-09b-class-detail.png');
  await go(d, '#social', '.soc-grid'); await shot(d, 'desktop-10-socializing.png');

  for (const w of extraWidths) {
    const p = await newPage({ ...desktop, viewport: { width: w, height: w >= 1900 ? 1080 : 800 } });
    for (const [hash, sel, name] of [['#today', '.dash', 'today'], ['#week', '.wk', 'week'], ['#tasks', '.ttable', 'tasks'], ['#jobs', '.kanban', 'jobs'], ['#opps', '.drow', 'opps']]) { await go(p, hash, sel); await shot(p, `w${w}-${name}.png`); }
  }

  // Narrow window: same desktop layout, page scrolls horizontally instead of switching to a phone layout.
  const n = await newPage({ ...desktop, viewport: { width: 960, height: 800 } });
  await go(n, '#tasks', '.ttable');
  const narrow = await n.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, sidebar: getComputedStyle(document.querySelector('.nav')).width }));
  if (narrow.scrollW < 1100) errors.push(`narrow window did not keep the 1100px minimum (scrollWidth ${narrow.scrollW})`);
  else console.log(`960px window: page is ${narrow.scrollW}px wide (scrolls sideways), sidebar ${narrow.sidebar}`);

  await browser.close();
  if (errors.length) { console.log('Browser errors:\n' + [...new Set(errors)].join('\n')); process.exitCode = 1; }
  else console.log('Screenshots saved to', OUT, '(no browser errors)');
})().catch((e) => { console.error(e); process.exit(1); });
