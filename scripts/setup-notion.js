#!/usr/bin/env node
'use strict';
// First-time setup from the command line (same as the in-app /setup page).
// Creates the Dayline databases under ONE Notion page you shared with your integration, then prints the
// environment variables to paste into Vercel (or your local .env). Safe to re-run: it reuses what it made.
//
//   NOTION_TOKEN=ntn_xxx node scripts/setup-notion.js "https://www.notion.so/My-Dayline-page-0123..."
//   node scripts/setup-notion.js --list        (shows the pages your integration can see)
// If NOTION_TOKEN is not set (and not in .env) you are asked to paste it; it is never saved or printed.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
const { createSetupClient } = require('../lib/setup');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}

async function main() {
  const args = process.argv.slice(2);
  let token = process.env.NOTION_TOKEN || process.env.DAYLINE_NOTION_TOKEN || '';
  if (!token) token = await ask('Paste your Notion integration token (starts with ntn_): ');
  const client = createSetupClient({ token });
  if (args.includes('--list') || !args.length) {
    const pages = await client.listPages();
    if (!pages.length) console.log('Your integration cannot see any pages yet. In Notion open the page, click ••• > Connections, and add your integration.');
    for (const p of pages) console.log(`- ${p.title}\n  ${p.url}`);
    if (!args.length) console.log('\nRun again with the link of the page Dayline should live under:\n  node scripts/setup-notion.js "<page link>"');
    return;
  }
  const out = await client.createAll(args.find((a) => !a.startsWith('--')), { log: (m) => console.log('  ' + m) });
  console.log(`\nDone. Created ${out.created.length}, reused ${out.reused.length}.\nPaste these into Vercel (Settings > Environment Variables), then redeploy:\n`);
  console.log(out.env);
}

main().catch((e) => { console.error('Setup failed: ' + e.message); process.exit(1); });
