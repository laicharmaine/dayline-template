'use strict';
// Shared test helpers: a recording fetch mock and a Response-like object.
function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => JSON.parse(text), text: async () => text };
}
/** routes: array of [predicate(url, init) | string-prefix, responder(url, init) | response] */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : undefined });
    for (const [match, reply] of routes) {
      const hit = typeof match === 'function' ? match(String(url), init) : String(url).startsWith(match);
      if (hit) return typeof reply === 'function' ? reply(String(url), init) : reply;
    }
    throw new Error('unexpected fetch ' + url);
  };
  fn.calls = calls;
  return fn;
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
module.exports = { res, mockFetch, publicLookup };
