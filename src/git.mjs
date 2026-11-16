// The git smart-HTTP transport: upload-pack protocol v2 for clone and fetch, receive-pack v0 for
// push. There is no git binary in the pod, so every byte here is framed and parsed by hand.
//
// Nothing in this module reads a clock: object ids, pack bytes and report lines are a pure
// function of the store, so two runs of the same instance answer identically.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { state, findRepo, registerCommit, tipOf } from './store.mjs';
import { sendError } from './http.mjs';

/** The all-zero object id: a push's "the ref did not exist" and a delete's new value. */
const ZERO = '0000000000000000000000000000000000000000';

/** The most a single pkt-line may carry. */
const PKT_MAX = 65516;

/** The object types a pack records, by their pack header number. */
const TYPE_NUMBER = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

/** The sha1 of a buffer, hex. */
function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line carrying a payload. */
function pkt(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (body.length > PKT_MAX) throw new Error(`pkt-line payload ${body.length} is over ${PKT_MAX}`);
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

/** The flush packet that ends a section. */
const FLUSH = Buffer.from('0000', 'ascii');

/** The delimiter that separates a v2 command's capabilities from its arguments. */
const DELIM = Buffer.from('0001', 'ascii');

/** Frame a list of payloads, then a flush. */
function pktStream(payloads) {
  const chunks = payloads.map((payload) => pkt(payload));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** Split a pkt-line stream into packets: `data` carries a payload, the rest are controls. */
function decodePktLines(bytes) {
  const packets = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const header = bytes.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    at += 4;
    if (length === 0) {
      packets.push({ kind: 'flush' });
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      continue;
    }
    packets.push({ kind: 'data', payload: bytes.subarray(at, at + length - 4) });
    at += length - 4;
  }
  return packets;
}

// ---------------------------------------------------------------- pack writing

/** One object's pack header: its type and inflated length, as a varint. */
function packHeader(type, size) {
  const bytes = [];
  let first = (TYPE_NUMBER[type] << 4) | (size & 0x0f);
  let rest = size >>> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of whole objects: deflated bodies, a count, and the sha1 trailer. */
function writePack(objects) {
  const chunks = [Buffer.from('PACK', 'ascii'), Buffer.alloc(4), Buffer.alloc(4)];
  chunks[1].writeUInt32BE(2, 0);
  chunks[2].writeUInt32BE(objects.length, 0);
  for (const object of objects) {
    chunks.push(packHeader(object.type, object.body.length), deflateSync(object.body));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** Read a varint object header: its type number and its inflated size. */
function readPackHeader(buffer, at) {
  let byte = buffer[at];
  at += 1;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    byte = buffer[at];
    at += 1;
    size += (byte & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, at };
}

/**
 * Inflate one object's body that starts at `at` inside a pack, answering the body and the offset
 * the next object starts at. A deflate stream carries no length, but node's synchronous inflate
 * reports how many input bytes it consumed when asked for its info, so the next offset is exact
 * with no second pass over the bytes.
 */
function inflateSyncAt(buffer, at) {
  const result = inflateSync(buffer.subarray(at), { info: true });
  const consumed = result.engine.bytesWritten;
  return { data: result.buffer, next: at + consumed };
}

/** Read an offset-delta's distance to its base (a little-endian varint with a bias). */
function readOfsDelta(buffer, at) {
  let byte = buffer[at];
  at += 1;
  let offset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buffer[at];
    at += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { offset, at };
}

/** Apply a git delta to its base, answering the rebuilt body. */
function applyDelta(base, delta) {
  let at = 0;
  let baseSize = 0;
  let shift = 0;
  for (;;) {
    const byte = delta[at];
    at += 1;
    baseSize |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  let size = 0;
  shift = 0;
  for (;;) {
    const byte = delta[at];
    at += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  void baseSize;
  const out = Buffer.alloc(size);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if ((op & 0x80) !== 0) {
      let copyAt = 0;
      let copySize = 0;
      if (op & 0x01) copyAt |= delta[at++];
      if (op & 0x02) copyAt |= delta[at++] << 8;
      if (op & 0x04) copyAt |= delta[at++] << 16;
      if (op & 0x08) copyAt |= delta[at++] << 24;
      if (op & 0x10) copySize |= delta[at++];
      if (op & 0x20) copySize |= delta[at++] << 8;
      if (op & 0x40) copySize |= delta[at++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyAt, copyAt + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, at, at + op);
      written += op;
      at += op;
    } else {
      break;
    }
  }
  return out.subarray(0, written);
}

/**
 * Read a packfile into objects. Deltas are resolved against the objects already read and, when a
 * delta names a base this pack does not hold, against the store's own objects.
 */
function readPack(buffer, lookup) {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buffer.readUInt32BE(8);
  let at = 12;
  const byOffset = new Map();
  const objects = [];
  const pending = [];
  for (let index = 0; index < count; index += 1) {
    const start = at;
    const head = readPackHeader(buffer, at);
    at = head.at;
    const typeName = NUMBER_TYPE[head.type];
    if (typeName === 'ofs-delta') {
      const ofs = readOfsDelta(buffer, at);
      at = ofs.at;
      const body = inflateSyncAt(buffer, at);
      at = body.next;
      pending.push({ offset: start, kind: 'ofs', baseOffset: start - ofs.offset, delta: body.data });
      byOffset.set(start, null);
      continue;
    }
    if (typeName === 'ref-delta') {
      const base = buffer.subarray(at, at + 20).toString('hex');
      at += 20;
      const body = inflateSyncAt(buffer, at);
      at = body.next;
      pending.push({ offset: start, kind: 'ref', base, delta: body.data });
      byOffset.set(start, null);
      continue;
    }
    const body = inflateSyncAt(buffer, at);
    at = body.next;
    const sha = objectSha(typeName, body.data);
    const object = { sha, type: typeName, body: body.data };
    objects.push(object);
    byOffset.set(start, object);
  }
  for (const item of pending) {
    let base = null;
    if (item.kind === 'ofs') base = byOffset.get(item.baseOffset) ?? null;
    else base = lookup(item.base) ?? null;
    if (base === null) {
      base = objects.find((object) => object.sha === item.base) ?? null;
    }
    if (base === null) throw new Error('a pack delta names a base this pack and the store do not hold');
    const body = applyDelta(base.body, item.delta);
    const type = base.type;
    const sha = objectSha(type, body);
    const object = { sha, type, body };
    objects.push(object);
    byOffset.set(item.offset, object);
  }
  return { objects, trailer: buffer.subarray(at, at + 20).toString('hex') };
}

/** An object's id: the sha1 of its type, its size and its body. */
function objectSha(type, body) {
  return sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\u0000`, 'utf8'), body]));
}

// ---------------------------------------------------------------- the object graph

/** The commit object a sha names, parsed, or null. */
function commitOf(repo, sha) {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const text = object.body.toString('utf8');
  const lines = text.split('\n');
  let tree = null;
  const parents = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line === '') break;
  }
  const at = text.indexOf('\n\n');
  return { sha, tree, parents, message: at < 0 ? '' : text.slice(at + 2) };
}

/** The tag object a sha names, parsed, or null. */
function tagOf(repo, sha) {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'tag') return null;
  const text = object.body.toString('utf8');
  let target = null;
  let targetType = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) targetType = line.slice(5).trim();
    else if (line === '') break;
  }
  return { sha, target, targetType };
}

/** The entries of a tree object, in their own order. */
function treeEntries(repo, sha) {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'tree') return [];
  const entries = [];
  let at = 0;
  const body = object.body;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const nul = body.indexOf(0x00, space);
    if (space < 0 || nul < 0) break;
    const mode = body.subarray(at, space).toString('ascii');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const id = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha: id });
    at = nul + 21;
  }
  return entries;
}

/** Every object a commit reaches, with the commit's own depth from the tip. */
function reachable(repo, tips, options) {
  const maxDepth = options?.maxDepth ?? Number.POSITIVE_INFINITY;
  const seen = new Map();
  const commits = [];
  const shallow = [];
  const queue = tips.map((sha) => ({ sha, depth: 1 }));
  while (queue.length > 0) {
    const item = queue.shift();
    if (seen.has(item.sha)) continue;
    const commit = commitOf(repo, item.sha);
    if (commit === null) continue;
    seen.set(item.sha, item.depth);
    commits.push({ sha: item.sha, depth: item.depth });
    if (item.depth === maxDepth) {
      if (commit.parents.length > 0) shallow.push(item.sha);
      continue;
    }
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push({ sha: parent, depth: item.depth + 1 });
  }
  return { commits, shallow };
}

/** Every object id a set of commits reaches: their trees, subtrees and blobs. */
function objectsUnder(repo, commitShas, into) {
  const add = (sha) => {
    if (into.has(sha)) return false;
    into.add(sha);
    return true;
  };
  const walkTree = (sha, depth) => {
    if (depth > 64 || !add(sha)) return;
    for (const entry of treeEntries(repo, sha)) {
      if (entry.mode === '40000' || entry.mode === '040000') walkTree(entry.sha, depth + 1);
      else add(entry.sha);
    }
  };
  for (const sha of commitShas) {
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    if (commit.tree !== null) walkTree(commit.tree, 0);
    add(sha);
  }
  return into;
}

/** An object as a pack needs it. */
function packObjectsOf(repo, ids) {
  const objects = [];
  for (const id of ids) {
    const object = repo.objects.get(id);
    if (object === undefined) continue;
    objects.push({ sha: id, type: object.type, body: object.body });
  }
  return objects;
}

// ---------------------------------------------------------------- advertisements

/** The capabilities the v2 upload-pack advertises. */
function uploadPackCapabilities() {
  return ['version 2\n', 'agent=makefun-forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
}

/** The capabilities the v0 receive-pack advertisement carries. */
function receivePackCapabilities() {
  return 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
}

/** Every ref a repository exposes to a fetch, HEAD first. */
function advertisedRefs(repo) {
  const refs = [];
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (head !== undefined) refs.push({ name: 'HEAD', sha: head, symref: `refs/heads/${repo.default_branch}`, peeled: null });
  for (const [name, sha] of repo.refs) {
    if (!name.startsWith('refs/')) continue;
    let peeled = null;
    if (name.startsWith('refs/tags/')) {
      const tag = tagOf(repo, sha);
      if (tag !== null && tag.target !== null) peeled = tag.target;
    }
    refs.push({ name, sha, symref: null, peeled });
  }
  return refs;
}

/** The v2 upload-pack advertisement. */
function advertisementV2(repo) {
  const chunks = [pkt('# service=git-upload-pack\n'), FLUSH];
  for (const line of uploadPackCapabilities()) chunks.push(pkt(line));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** The v0 upload-pack advertisement, for a client that asked for no protocol version. */
function advertisementV0UploadPack(repo) {
  const chunks = [pkt('# service=git-upload-pack\n'), FLUSH];
  const refs = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/'));
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
  const capabilities = 'side-band-64k ofs-delta no-progress include-tag agent=makefun-forge/1.0';
  const rows = [];
  if (head !== undefined) rows.push({ name: 'HEAD', sha: head });
  for (const ref of refs) rows.push({ name: ref[0], sha: ref[1] });
  if (rows.length === 0) {
    chunks.push(pkt(`${ZERO} capabilities^{}\u0000${capabilities}\n`));
  } else {
    rows.forEach((row, index) => {
      const suffix = index === 0 ? `\u0000${capabilities}` : '';
      chunks.push(pkt(`${row.sha} ${row.name}${suffix}\n`));
    });
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** The v0 receive-pack advertisement, capabilities on the first ref (or the zero id when empty). */
function advertisementReceivePack(repo) {
  const chunks = [pkt('# service=git-receive-pack\n'), FLUSH];
  const refs = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/'));
  const capabilities = receivePackCapabilities();
  if (refs.length === 0) {
    chunks.push(pkt(`${ZERO} capabilities^{}\u0000${capabilities}\n`));
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  refs.forEach(([name, sha], index) => {
    chunks.push(pkt(index === 0 ? `${sha} ${name}\u0000${capabilities}\n` : `${sha} ${name}\n`));
  });
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- requests

/** Split a v2 request into its command, its capabilities and its arguments. */
function parseV2Request(bytes) {
  const packets = decodePktLines(bytes);
  const capabilities = [];
  const args = [];
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice(8).trim();
      else capabilities.push(line.trim());
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  return { command, capabilities, args };
}

// ---------------------------------------------------------------- ls-refs

/** Answer a v2 ls-refs command. */
function answerLsRefs(repo, args) {
  const peel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const wanted = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out = [];
  for (const ref of advertisedRefs(repo)) {
    if (!wanted(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (ref.symref !== null && wantSymrefs) line += ` symref-target:${ref.symref}`;
    if (ref.peeled !== null && peel) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  return pktStream(out);
}

// ---------------------------------------------------------------- fetch

/** Answer a v2 fetch command: acknowledgments, shallow-info, then the packfile section. */
function answerFetch(repo, args) {
  const wants = args.filter((arg) => arg.startsWith('want ')).map((arg) => arg.slice(5).trim());
  const haves = args.filter((arg) => arg.startsWith('have ')).map((arg) => arg.slice(5).trim());
  const deepenLine = args.find((arg) => arg.startsWith('deepen '));
  const depth = deepenLine === undefined ? null : Number.parseInt(deepenLine.slice(7), 10);
  const clientShallow = args.filter((arg) => arg.startsWith('shallow ')).map((arg) => arg.slice(8).trim());
  const out = [];

  // A want may name an annotated tag rather than a commit: the tag object ships in the pack with
  // its target, and the history walk starts from that target.
  const commitWants = [];
  const tagged = new Set();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagged.add(want);
      const tag = tagOf(repo, want);
      if (tag !== null && tag.target !== null) {
        const target = repo.objects.get(tag.target);
        if (target !== undefined && target.type === 'tag') tagged.add(tag.target);
        else commitWants.push(tag.target);
      }
      continue;
    }
    commitWants.push(want);
  }
  const reach = reachable(repo, commitWants, depth === null ? {} : { maxDepth: depth });
  const excluded = new Set();
  // A deepening request is answered from the tips alone: the client's own haves name the shallow
  // boundary it already holds, and excluding their closure would hide exactly the ancestors the
  // deepen was asked for.
  if (haves.length > 0 && depth === null) {
    const haveReach = reachable(repo, haves, {});
    objectsUnder(repo, haveReach.commits.map((commit) => commit.sha), excluded);
  }
  const included = objectsUnder(repo, reach.commits.map((commit) => commit.sha), new Set());
  for (const sha of tagged) included.add(sha);
  for (const sha of excluded) included.delete(sha);

  if (depth !== null) {
    const nowShallow = new Set(reach.shallow);
    const lines = [];
    for (const sha of reach.shallow) lines.push(`shallow ${sha}\n`);
    for (const sha of clientShallow) if (!nowShallow.has(sha)) lines.push(`unshallow ${sha}\n`);
    if (lines.length > 0) {
      out.push(pkt('shallow-info\n'));
      for (const line of lines) out.push(pkt(line));
      out.push(FLUSH);
    }
  }

  const objects = packObjectsOf(repo, [...included]);
  objects.sort((left, right) => (left.sha < right.sha ? -1 : left.sha > right.sha ? 1 : 0));
  const pack = writePack(objects);
  out.push(pkt('packfile\n'));
  for (let at = 0; at < pack.length; at += PKT_MAX - 1) {
    const slice = pack.subarray(at, at + PKT_MAX - 1);
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack

/** Read the command list of a v0 receive-pack request and the pack that follows it. */
function parseReceiveRequest(bytes) {
  const commands = [];
  let capabilities = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const header = bytes.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    at += 4;
    if (length === 0) break;
    const payload = bytes.subarray(at, at + length - 4);
    at += length - 4;
    const text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const commandText = nul < 0 ? text : text.slice(0, nul);
    if (nul >= 0) capabilities = text.slice(nul + 1).trim().split(' ').filter(Boolean);
    const parts = commandText.split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const pack = at < bytes.length ? bytes.subarray(at) : Buffer.alloc(0);
  return { commands, capabilities, pack };
}

/** Whether `ancestor` is reachable from `commit` by parents (the fast-forward test). */
function isAncestor(repo, ancestor, commit) {
  if (ancestor === commit) return true;
  const seen = new Set();
  const queue = [commit];
  while (queue.length > 0) {
    const sha = queue.shift();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const parsed = commitOf(repo, sha);
    if (parsed === null) continue;
    for (const parent of parsed.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Store every object a push's pack carries. */
function ingestPack(repo, pack) {
  if (pack.length < 12) return { ok: true, count: 0 };
  const read = readPack(pack, (sha) => {
    const object = repo.objects.get(sha);
    return object === undefined ? null : { sha, type: object.type, body: object.body };
  });
  for (const object of read.objects) {
    if (!repo.objects.has(object.sha)) repo.objects.set(object.sha, { type: object.type, body: object.body });
  }
  return { ok: true, count: read.objects.length };
}

/** Apply a push's command list, answering one report line per command. */
function applyPush(repo, commands) {
  const lines = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO;
    if (command.newOid === ZERO) {
      if (current !== command.oldOid) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      lines.push(`ng ${command.ref} missing necessary objects`);
      continue;
    }
    // A branch carries a commit; a tag ref carries a commit or an annotated tag object whose
    // target the repository holds. A fast-forward only means something for a branch.
    if (object.type === 'tag') {
      const tag = tagOf(repo, command.newOid);
      if (tag === null || tag.target === null || !repo.objects.has(tag.target)) {
        lines.push(`ng ${command.ref} missing necessary objects`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (object.type !== 'commit') {
      lines.push(`ng ${command.ref} missing necessary objects`);
      continue;
    }
    if (command.oldOid !== ZERO && !isAncestor(repo, command.oldOid, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    registerCommit(repo, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return lines;
}

/** Answer a v0 receive-pack request: the report, framed in side-band-64k when asked. */
function answerReceivePack(repo, body) {
  const request = parseReceiveRequest(body);
  const sideband = request.capabilities.includes('side-band-64k');
  let unpack = 'ok';
  if (request.pack.length > 0) {
    try {
      ingestPack(repo, request.pack);
    } catch (error) {
      unpack = error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ') : 'unpacker error';
    }
  }
  const report = unpack === 'ok' ? applyPush(repo, request.commands) : request.commands.map((command) => `ng ${command.ref} unpacker error`);
  const reportStream = Buffer.concat([pkt(`unpack ${unpack}\n`), ...report.map((line) => pkt(`${line}\n`)), FLUSH]);
  if (!sideband) return reportStream;
  const out = [];
  for (let at = 0; at < reportStream.length; at += PKT_MAX - 1) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + PKT_MAX - 1)])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- routing

/** Which service a request path names. */
function serviceOf(path) {
  if (path.startsWith('/git-upload-pack')) return 'upload-pack';
  if (path.startsWith('/git-receive-pack')) return 'receive-pack';
  return null;
}

/** The content type an answer carries. */
function resultType(service) {
  return `application/x-git-${service === 'upload-pack' ? 'upload-pack' : 'receive-pack'}-result`;
}

/** Answer a git smart-HTTP request, or the JSON 404 for a repository this token does not own. */
export async function handleGit(req, res, owner, name, suffix, query, bodyReader) {
  const repo = findRepo(owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const isInfoRefs = suffix.startsWith('/info/refs');
  if (isInfoRefs) {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'unsupported service');
      return;
    }
    const wantsV2 = req.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack') {
      const body = wantsV2 ? advertisementV2(repo) : advertisementV0UploadPack(repo);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': body.length,
        'cache-control': 'no-cache',
        'x-github-request-id': `git-${(state.seq.request += 1)}`,
      });
      res.end(body);
      return;
    }
    const body = advertisementReceivePack(repo);
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-github-request-id': `git-${(state.seq.request += 1)}`,
    });
    res.end(body);
    return;
  }

  const service = serviceOf(suffix);
  if (service === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST is the only method this route serves');
    return;
  }
  const body = await bodyReader(req);
  let answer;
  try {
    answer = service === 'upload-pack' ? answerUploadPack(repo, body) : answerReceivePack(repo, body);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : 'git transport error');
    return;
  }
  res.writeHead(200, {
    'content-type': resultType(service),
    'content-length': answer.length,
    'cache-control': 'no-cache',
    'x-github-request-id': `git-${(state.seq.request += 1)}`,
  });
  res.end(answer);
}

/** Dispatch one upload-pack POST by its v2 command. */
function answerUploadPack(repo, body) {
  const request = parseV2Request(body);
  if (request.command === 'ls-refs') return answerLsRefs(repo, request.args);
  if (request.command === 'fetch') return answerFetch(repo, request.args);
  throw new Error(`unknown upload-pack command ${JSON.stringify(request.command)}`);
}

export { writePack, readPack, decodePktLines, pkt, FLUSH, objectsUnder, commitOf, tagOf, treeEntries };
void tipOf;



