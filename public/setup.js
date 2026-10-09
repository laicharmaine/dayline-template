'use strict';
// First-time setup page (no inline scripts: the CSP only allows files from this site).
const $ = (id) => document.getElementById(id);
let picked = null;
const err = (msg) => { $('setupError').textContent = msg || ''; $('setupError').hidden = !msg; };
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: $('token').value.trim() || undefined, ...body }) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login'); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
function showEnv(env, msg) {
  $('env').value = env;
  $('envStep').hidden = false;
  if (msg) { $('setupNote').textContent = msg; $('setupNote').hidden = false; }
  $('envStep').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
(async () => {
  try {
    const st = await (await fetch('/api/setup/status')).json();
    if (st.hasToken) { $('tokenOk').hidden = false; $('tokenBox').hidden = true; }
    if (st.mode === 'fixture') { $('setupNote').textContent = 'Demo mode (sample data): setup is turned off here. Deploy your own copy to connect Notion.'; $('setupNote').hidden = false; }
    else if (!st.setupMode) { $('setupNote').textContent = 'Dayline is already connected. You only need this page to re-create or find your databases.'; $('setupNote').hidden = false; }
  } catch { /* ignore */ }
})();
$('findPages').addEventListener('click', async () => {
  err(''); $('findPages').disabled = true; $('findPages').textContent = 'Looking…';
  try {
    const { pages } = await post('/api/setup/pages', {});
    const ul = $('pages'); ul.replaceChildren();
    if (!pages.length) ul.append(Object.assign(document.createElement('li'), { className: 'hint', textContent: 'No pages yet. Share a page with your integration (••• › Connections), then try again.' }));
    for (const p of pages) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small setup-page-btn'; b.textContent = p.title;
      b.addEventListener('click', () => { picked = p.id; $('pageLink').value = ''; ul.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
      const li = document.createElement('li'); li.append(b); ul.append(li);
    }
  } catch (e) { err(e.message); }
  $('findPages').disabled = false; $('findPages').textContent = 'Show pages I shared';
});
$('pageLink').addEventListener('input', () => { picked = null; $('pages').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')); });
$('create').addEventListener('click', async () => {
  err('');
  const parent = picked || $('pageLink').value.trim();
  if (!parent) { err('Pick a page (step 2) or paste its link.'); return; }
  $('create').disabled = true; $('create').textContent = 'Creating… (up to a minute)';
  try {
    const out = await post('/api/setup/create', { parent });
    showEnv(out.env, `Done: ${out.created.length} created${out.reused.length ? `, ${out.reused.length} reused` : ''}. Open the page in Notion to see them.`);
  } catch (e) { err(e.message); }
  $('create').disabled = false; $('create').textContent = 'Create my databases';
});
$('find').addEventListener('click', async () => {
  err('');
  try {
    const out = await post('/api/setup/find', {});
    if (!out.env) { err('No Dayline databases found yet. Use “Create my databases”.'); return; }
    showEnv(out.env, 'Found your Dayline databases.');
  } catch (e) { err(e.message); }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('env').value); } catch { $('env').select(); document.execCommand('copy'); }
  $('copied').hidden = false; setTimeout(() => { $('copied').hidden = true; }, 2000);
});
