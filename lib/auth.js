'use strict';
// Single-password gate. A successful login sets a signed, httpOnly session cookie (no server state).
// The signature also covers a fingerprint of APP_PASSWORD, so changing the password logs out every device.
const crypto = require('crypto');

const COOKIE = 'dl_session';
const MAX_AGE_S = 30 * 24 * 3600;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function createAuth({ appPassword, sessionSecret, now = () => Date.now() }) {
  if (!appPassword) throw new Error('APP_PASSWORD is required');
  const secret = sessionSecret || hmac('dayline-session-v1', appPassword).toString('hex');
  const pwFingerprint = hmac(secret, 'pw:' + appPassword).toString('hex').slice(0, 16);

  function sign(payload) { return b64u(hmac(secret, payload + '|' + pwFingerprint)); }

  function issue() {
    const iat = Math.floor(now() / 1000);
    const payload = b64u(JSON.stringify({ v: 1, iat, exp: iat + MAX_AGE_S }));
    return `${payload}.${sign(payload)}`;
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length > 512 || !token.includes('.')) return false;
    const [payload, sig] = token.split('.');
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig || '');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.v === 1 && typeof data.exp === 'number' && data.exp * 1000 > now();
    } catch { return false; }
  }

  function checkPassword(input) {
    if (typeof input !== 'string' || input.length > 200) return false;
    const a = hmac(secret, 'cmp:' + input), b = hmac(secret, 'cmp:' + appPassword);
    return crypto.timingSafeEqual(a, b);
  }

  return { issue, verify, checkPassword };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(value, { secure, maxAge = MAX_AGE_S }) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Fixed-window limiter for failed logins: `limit` failures per `windowMs` per key (IP). */
function createLimiter({ limit = 8, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    blocked(key) { const h = hits.get(key); if (!h || h.reset < now()) return false; return h.count >= limit; },
    fail(key) {
      const h = hits.get(key);
      if (!h || h.reset < now()) hits.set(key, { count: 1, reset: now() + windowMs }); else h.count++;
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now()) hits.delete(k);
    },
    clear(key) { hits.delete(key); },
  };
}

module.exports = { createAuth, parseCookies, cookieHeader, createLimiter, COOKIE, MAX_AGE_S };
