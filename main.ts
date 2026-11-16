// make.fun github-core-clone-01 entry: one process, one store, no UI, no outside service.
//
// Startup follows the wire contract the suite states: bind an ephemeral port, POST that port to
// $MAKEFUN_ENV_URL/register, serve, and long-poll $MAKEFUN_ENV_URL/done until it says done,
// then exit 0. Outside a trial the same server starts with PORT set and registers nothing.

import http from 'node:http';
import { configure, state } from './src/store.mjs';
import { handleRest } from './src/rest.mjs';
import { handleMcp } from './src/mcp.mjs';
import { sendJson, notFound } from './src/http.mjs';

configure(process.env);

/** Split a request target into its path and its query, without building a URL per request. */
function splitTarget(target) {
  const at = target.indexOf('?');
  if (at < 0) return { path: target, query: new URLSearchParams() };
  return { path: target.slice(0, at), query: new URLSearchParams(target.slice(at + 1)) };
}

/** The origin the client dialled, rebuilt from its own Host header. */
function originOf(req) {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1';
  return `http://${host}`;
}

/** One request in, one reply out. */
async function route(req, res) {
  const target = typeof req.url === 'string' ? req.url : '/';
  const { path, query } = splitTarget(target);

  if (path === '/healthz' || path === '/') {
    sendJson(res, 200, { ok: true, service: 'makefun-forge', objects: state.repos.size });
    return;
  }

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    await handleMcp(req, res);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const inner = path.slice('/api/v3'.length);
    await handleRest(req, res, inner === '' ? '' : inner.replace(/\/$/, ''), query, originOf(req));
    return;
  }

  // GraphQL and the git smart-HTTP transport land here next; until then an unknown route is
  // the JSON 404 every client expects, and the process stays up.
  notFound(res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { message: 'internal error' });
    else res.destroy();
  });
});

// The read workload is 2,000 sequential requests on one keep-alive connection: keep it open,
// and never let Nagle hold a small body back.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;
server.on('connection', (socket) => socket.setNoDelay(true));
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.destroy();
});

/** Wait, without a busy loop, before the next /done poll. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Announce the port and long-poll /done, exactly as the wire contract states. */
async function joinTrial(port) {
  const envUrl = typeof process.env.MAKEFUN_ENV_URL === 'string' ? process.env.MAKEFUN_ENV_URL.replace(/\/+$/, '') : '';
  if (envUrl === '') return;
  try {
    await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch {
    return;
  }
  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${envUrl}/done`, { headers: { accept: 'application/json' } });
      const answer = await response.json();
      done = answer?.done === true;
    } catch {
      done = false;
    }
    if (done) {
      process.exit(0);
    }
    await sleep(150);
  }
}

const wanted = Number.parseInt(process.env.PORT ?? '0', 10);
server.listen(Number.isFinite(wanted) ? wanted : 0, '0.0.0.0', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : wanted;
  if (process.env.MAKEFUN_ENV_URL === undefined) process.stdout.write(`makefun-forge listening on http://127.0.0.1:${port}\n`);
  void joinTrial(port);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
