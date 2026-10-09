'use strict';
// NOTION_READ_ONLY=true wraps fetch so the app can read real Notion but never change it:
// GET requests and database/data-source queries (POST .../query, POST /v1/search) go through;
// anything else (create, update, archive) is refused before it leaves the server.
const READ_POST = /\/v1\/(data_sources|databases)\/[^/]+\/query$|\/v1\/search$/;

class ReadOnlyError extends Error {
  constructor(method, path) {
    super('Read-only mode: changes to Notion are turned off on this server (NOTION_READ_ONLY=true).');
    this.status = 409; this.code = 'read_only'; this.method = method; this.path = path;
  }
}

function readOnlyFetch(fetchImpl = globalThis.fetch) {
  return async function guardedFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const path = new URL(String(url)).pathname;
    if (method === 'GET' || (method === 'POST' && READ_POST.test(path))) return fetchImpl(url, opts);
    throw new ReadOnlyError(method, path);
  };
}

module.exports = { readOnlyFetch, ReadOnlyError };
