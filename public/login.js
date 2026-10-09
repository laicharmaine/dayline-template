'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.password.value }) });
    if (res.ok) { location.replace('/'); return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Could not sign in';
    err.hidden = false;
    form.password.select();
  } catch {
    err.textContent = 'Network error. Check your connection.';
    err.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = 'Sign in';
});
