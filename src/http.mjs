// The wire helpers every route shares: one JSON reply shape, one body reader, one JSON-RPC
// error type. Every REST answer is application/json and carries a non-empty request id.

import { state } from './store.mjs';

/** A fresh request id: non-empty on every REST reply, never in the state export. */
export function nextRequestId() {
  state.seq.request += 1;
  return `req-${state.seq.request}`;
}

/** Send one JSON reply with its own length and request id. */
export function sendJson(res, status, value, extraHeaders) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': nextRequestId(),
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

/** Send pre-built bytes as JSON (the read workload's path: no serialization per request). */
export function sendJsonBytes(res, status, body, extraHeaders) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

/** Every error body carries a string message, never HTML. */
export function sendError(res, status, message) {
  sendJson(res, status, { message });
}

/** The 404 that closes every unknown route. */
export function notFound(res) {
  sendError(res, 404, 'Not Found');
}

/** Read a request body whole, up to a cap. */
export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Read and parse a JSON body; answers `{ok, value}` so a caller can answer 400. */
export async function readJson(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false, value: null };
  }
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

/** A JSON-RPC error a method raises into the envelope. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Whether the request presents the trial's own bearer token. */
export function authorized(headers) {
  const value = headers.authorization;
  if (typeof value !== 'string') return false;
  if (state.token === '') return value.startsWith('Bearer ');
  return value === `Bearer ${state.token}`;
}
