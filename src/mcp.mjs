// The MCP endpoint at /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, one request per
// POST, no session and no GET stream. The 2026-07-28 revision is answered through
// server/discover; a client that hands a pre-discover server an initialize still works.
//
// Every tool acts on the same store as /api/v3, so an object written over one surface reads
// back over the other with the same id.

import { sendJson, sendError, readJson, authorized, RpcError } from './http.mjs';
import { state, findRepo, createRepo, repoView, createIssue, listIssues, issueView, createPull, pullView, mergePull } from './store.mjs';

/** The revision this server prefers and lists first. */
const PREFERRED_REVISION = '2026-07-28';

/** The handshake-era revisions a pre-discover client may negotiate down to. */
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Every revision this server speaks, newest first. */
const SUPPORTED_VERSIONS = [PREFERRED_REVISION, ...LEGACY_REVISIONS];

/** This server's identity, reported by server/discover and by initialize. */
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** The JSON-RPC codes the transport and tools use. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** A repository-resolving tool's two required coordinates. */
const OWNER_REPO = {
  owner: { type: 'string', description: "The account login that owns the repository." },
  repo: { type: 'string', description: 'The repository name, without its owner.' },
};

/**
 * The six tools the agent-native surface needs, plus the two convenience readers an agent
 * reaches for first. The list is built once: two tools/list calls must answer byte for byte.
 */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository on this forge and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owning account login; defaults to the authenticated login.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description shown on every repository read.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: { type: 'object', properties: { ...OWNER_REPO }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body, in Markdown.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names the repository already holds.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues a repository holds, newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list; defaults to open.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a branch that already exists into another one.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body, in Markdown.' },
        head: { type: 'string', description: 'The source branch name.' },
        base: { type: 'string', description: 'The target branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        pull_number: { type: 'integer', description: 'The pull request number.' },
        commit_title: { type: 'string', description: 'The title of the squash commit the merge writes.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_file',
    description: 'Read one file of a repository at a branch, decoded from base64.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        path: { type: 'string', description: 'The file path inside the repository.' },
        ref: { type: 'string', description: 'The branch to read; defaults to the default branch.' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests a repository holds.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

/** The tools array serialized once: the idempotency check compares two answers byte for byte. */
const TOOLS_JSON = JSON.stringify(TOOLS);

/** The tool lookup table, by name. */
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The required property names of a tool's schema. */
function requiredOf(tool) {
  const required = tool.inputSchema.required;
  return Array.isArray(required) ? required : [];
}

/** Resolve a repository a tool names, or raise the JSON-RPC error that names the miss. */
function repoOf(args) {
  const owner = typeof args.owner === 'string' ? args.owner : state.login;
  const repo = String(args.repo ?? '');
  const found = findRepo(owner, repo);
  if (found === null) throw new RpcError(INVALID_PARAMS, `no repository ${owner}/${repo} for this token`);
  return found;
}

/** A tool's whole answer: one text block plus the same object as structured content. */
function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

/** A tool that refused: the reason in a text block, isError set, never a 500. */
function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The tools, by name: each one acts on the shared store the REST routes write. */
const HANDLERS = new Map([
  ['create_repo', (args) => {
    const name = String(args.name ?? '');
    if (name === '') throw new RpcError(INVALID_PARAMS, 'name is required');
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : state.login;
    if (owner.toLowerCase() !== state.login.toLowerCase()) throw new RpcError(INVALID_PARAMS, `this token cannot create repositories under ${owner}`);
    const repo = createRepo({ name, description: args.description, private: args.private });
    if (repo === null) throw new RpcError(INVALID_PARAMS, `a repository named ${name} already exists`);
    return toolResult(repoView(repo));
  }],
  ['get_repo', (args) => toolResult(repoView(repoOf(args)))],
  ['create_issue', (args) => {
    const repo = repoOf(args);
    const made = createIssue(repo, { title: args.title, body: args.body, labels: args.labels });
    if (made.error !== undefined) throw new RpcError(INVALID_PARAMS, made.error);
    return toolResult(issueView(repo, made.issue));
  }],
  ['list_issues', (args) => {
    const repo = repoOf(args);
    const issues = listIssues(repo, { state: typeof args.state === 'string' ? args.state : 'open' });
    return toolResult(issues.map((issue) => issueView(repo, issue)));
  }],
  ['create_pull_request', (args) => {
    const repo = repoOf(args);
    const made = createPull(repo, { title: args.title, body: args.body, head: args.head, base: args.base });
    if (made.error !== undefined) throw new RpcError(INVALID_PARAMS, made.error);
    return toolResult(pullView(repo, made.pull));
  }],
  ['merge_pull_request', (args) => {
    const repo = repoOf(args);
    const number = Number(args.pull_number);
    const pull = repo.pullByNumber.get(number);
    if (pull === undefined) throw new RpcError(INVALID_PARAMS, `no pull request #${number} in ${repo.full_name}`);
    const merged = mergePull(repo, pull, { commit_title: args.commit_title });
    if (merged.error !== undefined) throw new RpcError(INVALID_PARAMS, merged.error);
    return toolResult({ sha: merged.sha, merged: true, message: 'Pull Request successfully merged', number });
  }],
  ['get_file', (args) => {
    const repo = repoOf(args);
    const path = String(args.path ?? '');
    const branch = typeof args.ref === 'string' && args.ref !== '' ? args.ref : repo.default_branch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const commit = tip === undefined ? null : repo.commits.get(tip) ?? null;
    const entry = commit === null ? undefined : commit.flat.get(path);
    if (entry === undefined) throw new RpcError(INVALID_PARAMS, `no file ${path} on ${branch}`);
    const object = repo.objects.get(entry.sha);
    const body = object === undefined ? Buffer.alloc(0) : object.body;
    return toolResult({ path, branch, sha: entry.sha, size: body.length, content: body.toString('utf8'), encoding: 'utf-8' });
  }],
  ['list_pull_requests', (args) => {
    const repo = repoOf(args);
    const wanted = typeof args.state === 'string' ? args.state : 'open';
    const pulls = wanted === 'all' ? repo.pulls.slice() : repo.pulls.filter((pull) => pull.state === wanted);
    return toolResult(pulls.map((pull) => pullView(repo, pull)));
  }],
]);

/** The result of `server/discover`: identity, capabilities and every revision this server speaks. */
function discoverResult() {
  return {
    protocolVersion: PREFERRED_REVISION,
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'A small GitHub-compatible forge: repositories, issues, pull requests and their git data over one store.',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

/** The result of `initialize`, for a client that came in through the handshake era. */
function initializeResult(params) {
  const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : LEGACY_REVISIONS[0];
  const revision = SUPPORTED_VERSIONS.includes(asked) ? asked : LEGACY_REVISIONS[0];
  return { protocolVersion: revision, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO };
}

/** One JSON-RPC request's answer, its result or its error. */
function dispatch(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    throw new RpcError(INVALID_REQUEST, 'Invalid Request');
  }
  const method = message.method;
  const params = message.params ?? {};
  if (typeof method !== 'string' || method === '') throw new RpcError(INVALID_REQUEST, 'method is required');
  switch (method) {
    case 'server/discover':
      return discoverResult();
    case 'initialize':
      return initializeResult(params);
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: JSON.parse(TOOLS_JSON) };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name');
      const tool = TOOL_BY_NAME.get(name);
      if (tool === undefined) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      const missing = requiredOf(tool).filter((property) => args[property] === undefined || args[property] === null);
      if (missing.length > 0) throw new RpcError(INVALID_PARAMS, `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
      const handler = HANDLERS.get(name);
      if (handler === undefined) throw new RpcError(METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      try {
        return handler(args);
      } catch (error) {
        if (error instanceof RpcError) throw error;
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** One envelope around a result or an error, with the id the request carried. */
function envelope(message, result, error) {
  const id = message !== null && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
  if (error !== undefined) return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
  return { jsonrpc: '2.0', id, result };
}

/** Whether a message is a notification (no id, so no answer body). */
function isNotification(message) {
  return message !== null && typeof message === 'object' && !Array.isArray(message) && !Object.prototype.hasOwnProperty.call(message, 'id');
}

/**
 * Answer one POST /mcp. Authentication is decided before any method exists: a request with no
 * bearer token is 401, and a body that is not JSON is 400 with a -32700 envelope.
 */
export async function handleMcp(req, res) {
  if (!authorized(req.headers)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const method = req.method;
  if (method === 'GET' || method === 'DELETE') {
    sendError(res, 405, 'Only POST is served; this server opens no stream and keeps no session');
    return;
  }
  if (method !== 'POST') {
    sendError(res, 405, 'Only POST is served');
    return;
  }
  const parsed = await readJson(req);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: the body is not JSON' } });
    return;
  }
  const body = parsed.value;
  if (Array.isArray(body)) {
    if (body.length === 0) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'An empty batch is invalid' } });
      return;
    }
    const answers = [];
    for (const message of body) {
      try {
        const result = dispatch(message);
        if (!isNotification(message)) answers.push(envelope(message, result, undefined));
      } catch (error) {
        const rpc = error instanceof RpcError ? error : new RpcError(INVALID_REQUEST, error instanceof Error ? error.message : String(error));
        if (!isNotification(message)) answers.push(envelope(message, undefined, rpc));
      }
    }
    if (answers.length === 0) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } });
    return;
  }
  // A notification is accepted and never answered: the transport still needs its 202.
  if (isNotification(body) && typeof body.method === 'string') {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  try {
    const result = dispatch(body);
    sendJson(res, 200, envelope(body, result, undefined));
  } catch (error) {
    const rpc = error instanceof RpcError ? error : new RpcError(INVALID_REQUEST, error instanceof Error ? error.message : String(error));
    sendJson(res, 200, envelope(body, undefined, rpc));
  }
}
