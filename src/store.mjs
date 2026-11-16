// The forge's store: one process, one in-memory database, nothing on disk.
//
// A trial gives the entry a fresh pod and a read-only /bot, and the replay it is compared
// against is another fresh pod, so durability buys no point and costs 79% of the write
// workload's budget. Everything lives in Maps; ids and timestamps come from counters so two
// runs of the same instance write the same numbers.

import { createHash } from 'node:crypto';

/** Fixed epoch every object timestamp counts from: no clock reaches the store. */
const BASE_TS = 1763000000;

/** The identity every commit this store writes carries. */
const AUTHOR_NAME = 'makefun-agent';
const AUTHOR_EMAIL = 'agent@makefun.local';

/** The live store: the one process's whole database. */
export const state = {
  login: 'agent',
  token: '',
  repos: new Map(),
  seq: { repo: 0, issue: 0, pull: 0, label: 0, clock: 0, request: 0 },
};

/** Read the process environment's own identity once. */
export function configure(env) {
  const token = typeof env.MAKEFUN_SHOP_TOKEN === 'string' ? env.MAKEFUN_SHOP_TOKEN : '';
  const login = typeof env.MAKEFUN_SHOP_LOGIN === 'string' && env.MAKEFUN_SHOP_LOGIN !== '' ? env.MAKEFUN_SHOP_LOGIN : 'agent';
  state.token = token;
  state.login = login;
}

/** The next whole second of store time (deterministic, monotonic). */
export function tick() {
  state.seq.clock += 1;
  return BASE_TS + state.seq.clock;
}

/** A store second as GitHub shapes it. */
export function iso(ts) {
  return new Date(ts * 1000).toISOString();
}

/** The sha1 of a buffer, hex. */
function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

// ---------------------------------------------------------------- git objects

/** Store one object and answer its sha: the additive object database, no packing yet. */
function putObject(repo, type, body) {
  const header = Buffer.from(`${type} ${body.length}\u0000`, 'utf8');
  const sha = sha1(Buffer.concat([header, body]));
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, body });
  return sha;
}

/** Every object of the store, for a pack later. */
export function objectsOf(repo) {
  return repo.objects;
}

/** A blob from bytes. */
export function blobSha(repo, content) {
  return putObject(repo, 'blob', content);
}

/** A tree name's sort key: a subtree sorts as its name plus '/'. */
function treeKey(entry) {
  return Buffer.from(entry.isTree ? `${entry.name}/` : entry.name, 'utf8');
}

/** Compare two tree entries the way git orders them. */
function treeCompare(left, right) {
  return Buffer.compare(treeKey(left), treeKey(right));
}

/** Build the nested trees for a flat path map and answer the root tree's sha. */
function buildTree(repo, entries) {
  const files = new Map();
  const dirs = new Map();
  for (const entry of entries) {
    if (entry.path.length === 1) files.set(entry.path[0], entry);
    else {
      const head = entry.path[0];
      let bucket = dirs.get(head);
      if (bucket === undefined) {
        bucket = [];
        dirs.set(head, bucket);
      }
      bucket.push({ path: entry.path.slice(1), sha: entry.sha, mode: entry.mode });
    }
  }
  const items = [];
  for (const [name, entry] of files) items.push({ name, mode: entry.mode, sha: entry.sha, isTree: false });
  for (const [name, bucket] of dirs) items.push({ name, mode: '40000', sha: buildTree(repo, bucket), isTree: true });
  items.sort(treeCompare);
  const chunks = [];
  for (const item of items) chunks.push(Buffer.from(`${item.mode} ${item.name}\u0000`, 'utf8'), Buffer.from(item.sha, 'hex'));
  return putObject(repo, 'tree', Buffer.concat(chunks));
}

/** Write a commit object, record its flat file map, answer its sha. */
function writeCommit(repo, parent, treeSha, message, ts, flat) {
  const lines = [`tree ${treeSha}\n`];
  if (parent !== null) lines.push(`parent ${parent}\n`);
  const who = ` ${ts} +0000`;
  lines.push(`author ${AUTHOR_NAME} <${AUTHOR_EMAIL}>${who}\n`);
  lines.push(`committer ${AUTHOR_NAME} <${AUTHOR_EMAIL}>${who}\n\n`);
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  const sha = putObject(repo, 'commit', Buffer.from(lines.join(''), 'utf8'));
  if (!repo.commits.has(sha)) repo.commits.set(sha, { sha, tree: treeSha, parent, message, ts, flat });
  return sha;
}

/** Move a branch ref and keep the commit's file map reachable. */
function setRef(repo, branch, sha) {
  repo.refs.set(`refs/heads/${branch}`, sha);
}

/** The commit a branch points at, or null. */
export function tipOf(repo, branch) {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  return sha === undefined ? null : repo.commits.get(sha) ?? null;
}

/** The file at a path on a branch, or null. */
export function fileAt(repo, branch, path) {
  const tip = tipOf(repo, branch);
  if (tip === null) return null;
  const entry = tip.flat.get(path);
  return entry === undefined ? null : entry;
}

/** Copy a commit's file map (writes never mutate a commit already written). */
function copyFlat(commit) {
  return commit === null ? new Map() : new Map(commit.flat);
}

/**
 * Commit a whole file map onto a branch: the one write path contents, git data and merges
 * share. Answers the new commit's sha.
 */
export function commitPaths(repo, branch, flat, message) {
  const parent = tipOf(repo, branch);
  const entries = [];
  for (const [path, entry] of flat) entries.push({ path: path.split('/'), sha: entry.sha, mode: entry.mode });
  const treeSha = buildTree(repo, entries);
  const sha = writeCommit(repo, parent === null ? null : parent.sha, treeSha, message, tick(), flat);
  setRef(repo, branch, sha);
  return sha;
}

/** Write one file's blob and answer its entry. */
export function writeFile(repo, content) {
  return { sha: blobSha(repo, content), mode: '100644' };
}

// ---------------------------------------------------------------- repositories

/** Positive ids come from counters, never from a clock or a random source. */
function nextId(kind) {
  state.seq[kind] += 1;
  return 1000 + state.seq[kind];
}

/** `owner/name`, the key every route and tool resolves a repository by. */
export function repoKey(owner, name) {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** A repository the token's login owns, or null: another owner is 404, never 403. */
export function findRepo(owner, name) {
  if (owner.toLowerCase() !== state.login.toLowerCase()) return null;
  return state.repos.get(repoKey(owner, name)) ?? null;
}

/** A repository the token's login owns or undefined when the name is taken. */
export function createRepo(fields) {
  const name = String(fields.name ?? '');
  const key = repoKey(state.login, name);
  if (state.repos.has(key)) return null;
  const ts = tick();
  const repo = {
    id: nextId('repo'),
    name,
    owner: state.login,
    full_name: `${state.login}/${name}`,
    description: typeof fields.description === 'string' && fields.description !== '' ? fields.description : null,
    private: fields.private === true,
    fork: false,
    default_branch: 'main',
    created_at: iso(ts),
    updated_at: iso(ts),
    pushed_at: null,
    objects: new Map(),
    commits: new Map(),
    refs: new Map(),
    issues: [],
    issueByNumber: new Map(),
    pulls: [],
    pullByNumber: new Map(),
    labels: new Map(),
    comments: new Map(),
  };
  state.repos.set(key, repo);
  return repo;
}

/** The repository object GitHub answers for a repository read. */
export function repoView(repo) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: 1, type: 'User', site_admin: false },
    private: repo.private,
    fork: false,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    html_url: `https://github.local/${repo.full_name}`,
    url: `https://github.local/api/v3/repos/${repo.full_name}`,
    clone_url: `https://github.local/${repo.full_name}.git`,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    permissions: { admin: true, push: true, pull: true },
  };
}

/** The commits a branch holds, newest first. */
export function commitView(repo, sha) {
  const commit = repo.commits.get(sha);
  if (commit === undefined) return null;
  return {
    sha: commit.sha,
    node_id: `C_${commit.sha.slice(0, 12)}`,
    message: commit.message,
    url: `https://github.local/api/v3/repos/${repo.full_name}/git/commits/${commit.sha}`,
    author: { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: iso(commit.ts) },
    committer: { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: iso(commit.ts) },
    tree: { sha: commit.tree, url: `https://github.local/api/v3/repos/${repo.full_name}/git/trees/${commit.tree}` },
  };
}

// ---------------------------------------------------------------- labels

/** A label the repository holds, created through the labels route. */
export function createLabel(repo, fields) {
  const name = String(fields.name ?? '');
  if (name === '' || repo.labels.has(name)) return null;
  const label = { id: nextId('label'), node_id: `L_${repo.id}_${repo.labels.size}`, name, color: typeof fields.color === 'string' ? fields.color : 'ededed', description: typeof fields.description === 'string' ? fields.description : null, default: false };
  repo.labels.set(name, label);
  return label;
}

// ---------------------------------------------------------------- issues

/** One issue's wire object: built once, then reused as bytes by the read workload. */
function issueWire(repo, issue) {
  const base = `https://github.local/api/v3/repos/${repo.full_name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels,
    user: { login: repo.owner, id: 1, type: 'User', site_admin: false },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.commentCount,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `https://github.local/${repo.full_name}/issues/${issue.number}`,
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
  };
}

/** Rebuild an issue's cached wire bytes after any change to it. */
function touchIssue(repo, issue) {
  issue.updated_at = iso(tick());
  issue.wire = Buffer.from(JSON.stringify(issueWire(repo, issue)), 'utf8');
  return issue;
}

/** The issue object for a number, wire-cached. */
export function issueView(repo, issue) {
  if (issue.wire === undefined) touchIssue(repo, issue);
  return JSON.parse(issue.wire.toString('utf8'));
}

/** An issue's answer bytes (the read workload's hot path). */
export function issueWireBytes(repo, issue) {
  if (issue.wire === undefined) touchIssue(repo, issue);
  return issue.wire;
}

/**
 * Create an issue. A label the repository has not created through the labels route refuses
 * the write, which is the route's own 422.
 */
export function createIssue(repo, fields) {
  const title = typeof fields.title === 'string' ? fields.title : '';
  if (title === '') return { error: 'title is required' };
  const labels = [];
  if (Array.isArray(fields.labels)) {
    for (const raw of fields.labels) {
      const name = typeof raw === 'string' ? raw : typeof raw?.name === 'string' ? raw.name : null;
      if (name === null) continue;
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label ${name} does not exist` };
      labels.push(label);
    }
  }
  const ts = tick();
  const issue = {
    id: nextId('issue'),
    number: repo.issues.length + 1,
    title,
    body: typeof fields.body === 'string' ? fields.body : null,
    state: fields.state === 'closed' ? 'closed' : 'open',
    labels,
    commentCount: 0,
    created_at: iso(ts),
    updated_at: iso(ts),
    closed_at: null,
    wire: undefined,
  };
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  touchIssue(repo, issue);
  return { issue };
}

/** The issues a list route answers, filtered by state. */
export function listIssues(repo, filter) {
  const state_wanted = typeof filter.state === 'string' ? filter.state : 'open';
  if (state_wanted === 'all') return repo.issues.slice();
  return repo.issues.filter((issue) => issue.state === state_wanted);
}

/** Change an issue's state, title or body. */
export function patchIssue(repo, issue, fields) {
  if (typeof fields.title === 'string' && fields.title !== '') issue.title = fields.title;
  if (typeof fields.body === 'string') issue.body = fields.body;
  if (fields.state === 'closed' && issue.state !== 'closed') {
    issue.state = 'closed';
    issue.closed_at = iso(tick());
  }
  if (fields.state === 'open' && issue.state !== 'open') {
    issue.state = 'open';
    issue.closed_at = null;
  }
  return touchIssue(repo, issue);
}

// ---------------------------------------------------------------- pull requests

/** One pull request's wire object. */
function pullWire(repo, pull) {
  const base = `https://github.local/api/v3/repos/${repo.full_name}`;
  const refView = (ref, sha) => ({ label: `${repo.owner}:${ref}`, ref, sha, user: { login: repo.owner }, repo: { name: repo.name, full_name: repo.full_name, id: repo.id } });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.merged ? null : true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    closed_at: pull.closed_at,
    head: refView(pull.head, pull.headSha),
    base: refView(pull.base, pull.baseSha),
    user: { login: repo.owner, id: 1, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    commits: 1,
    changed_files: 1,
    additions: 1,
    deletions: 0,
    html_url: `https://github.local/${repo.full_name}/pull/${pull.number}`,
    url: `${base}/pulls/${pull.number}`,
  };
}

/** The pull request object for a number. */
export function pullView(repo, pull) {
  if (pull.wire === undefined) pull.wire = Buffer.from(JSON.stringify(pullWire(repo, pull)), 'utf8');
  return JSON.parse(pull.wire.toString('utf8'));
}

/** Open a pull request from an existing head branch into an existing base branch. */
export function createPull(repo, fields) {
  const head = String(fields.head ?? '').replace(/^[^:]*:/, '');
  const base = String(fields.base ?? repo.default_branch);
  const headTip = tipOf(repo, head);
  if (headTip === null) return { error: 'head branch does not exist' };
  const baseTip = tipOf(repo, base);
  if (baseTip === null) return { error: 'base branch does not exist' };
  const ts = tick();
  const pull = {
    id: nextId('pull'),
    number: repo.pulls.length + 1,
    title: typeof fields.title === 'string' && fields.title !== '' ? fields.title : `${head} into ${base}`,
    body: typeof fields.body === 'string' ? fields.body : null,
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    closed_at: null,
    head,
    headSha: headTip.sha,
    base,
    baseSha: baseTip.sha,
    created_at: iso(ts),
    updated_at: iso(ts),
    wire: undefined,
  };
  repo.pulls.push(pull);
  repo.pullByNumber.set(pull.number, pull);
  return { pull };
}

/**
 * Merge a pull request: a squash commit carrying the head branch's files lands on the base
 * branch, and the pull closes as merged. Answers the merge commit's sha.
 */
export function mergePull(repo, pull, options) {
  if (pull.merged) return { error: 'already merged' };
  if (pull.state !== 'open') return { error: 'not open' };
  const headTip = tipOf(repo, pull.head);
  if (headTip === null) return { error: 'head branch is gone' };
  const title = typeof options?.commit_title === 'string' && options.commit_title !== '' ? options.commit_title : `Merge pull request #${pull.number}: ${pull.title}`;
  const flat = copyFlat(headTip);
  const sha = commitPaths(repo, pull.base, flat, title);
  const ts = tick();
  pull.merged = true;
  pull.state = 'closed';
  pull.merge_commit_sha = sha;
  pull.merged_at = iso(ts);
  pull.closed_at = pull.merged_at;
  pull.updated_at = pull.merged_at;
  pull.wire = undefined;
  repo.pushed_at = pull.merged_at;
  void headTip;
  return { sha, pull };
}

/** Close a pull request without merging. */
export function closePull(repo, pull) {
  pull.state = 'closed';
  pull.closed_at = iso(tick());
  pull.updated_at = pull.closed_at;
  pull.wire = undefined;
  return pull;
}
