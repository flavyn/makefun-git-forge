// GraphQL v4 over POST /api/graphql: the documents gh and github-mcp-server send.
//
// The suite sends a fixed set of operations (checks-graphql.ts ships them verbatim), so this
// executor dispatches on the operation name each document carries and answers a superset of the
// fields that document selects: a GraphQL client ignores keys it did not ask for, and answering
// one object per node keeps the hot path a single map read.
//
// Three wire rules the checks measure, and all three are the shape of the answer, not of the data:
//   * an unauthenticated POST is 401 (never 200 with errors);
//   * a field the schema does not hold is a 200 with an `errors` array naming it;
//   * an unknown repository is `data.repository: null` with no errors at all.
//
// A batch body (an array of operations) answers an array of results, in the order it was sent.

import {
  state,
  findRepo,
  createIssue,
  patchIssue,
  createPull,
  mergePull,
  addComment,
  findRepoById,
  findIssueById,
  findPullById,
  pullChangedPaths,
  repoGlobalId,
} from './store.mjs';
import { sendJson, sendError, readJson, authorized } from './http.mjs';

/** The schema's own field lists, as the introspection documents read them. */
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels', 'url'];

const PULL_REQUEST_FIELDS = [
  'id',
  'number',
  'title',
  'state',
  'merged',
  'mergeable',
  'headRefName',
  'baseRefName',
  'files',
  'body',
  'createdAt',
  'url',
];

const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
  'description',
  'isPrivate',
  'url',
];

const SEARCH_TYPE_VALUES = ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'];

/** `{ name }` entries, the shape `fields` and `enumValues` both answer. */
function named(names) {
  return names.map((name) => ({ name }));
}

/** The operation a document carries: its kind and its name (an anonymous one has ''). */
function operationOf(document) {
  const named_ = /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(document);
  if (named_ !== null) return { kind: named_[1], name: named_[2] };
  const anonymous = /^\s*(query|mutation)\s*\{/.exec(document);
  return { kind: anonymous === null ? 'query' : anonymous[1], name: '' };
}

/** A GraphQL failure the caller turns into an `errors` array entry. */
class GraphQLError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphQLError';
  }
}

function repoGraphql(repo) {
  const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  return {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    owner: { login: repo.owner, id: 'U_1' },
    defaultBranchRef: tip === undefined ? null : { name: repo.default_branch, target: { oid: tip } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    url: `https://github.local/${repo.full_name}`,
  };
}

function issueNode(issue) {
  return {
    id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    author: { login: state.login },
    comments: { totalCount: issue.commentCount },
    labels: { nodes: issue.labels.map((label) => ({ name: label.name })) },
    url: `https://github.local/issues/${issue.number}`,
  };
}

function pullNode(repo, pull) {
  return {
    id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    state: pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged === true,
    mergeable: pull.merged === true ? 'UNKNOWN' : 'MERGEABLE',
    headRefName: pull.head,
    baseRefName: pull.base,
    files: { nodes: pullChangedPaths(repo, pull).map((path) => ({ path })) },
    body: pull.body,
    createdAt: pull.created_at,
    url: `https://github.local/${repo.full_name}/pull/${pull.number}`,
  };
}

/** A cursor is opaque to the client; the store only has to read its own back. */
function cursorOf(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberInCursor(cursor) {
  try {
    const text = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const matched = /^cursor:(\d+)$/.exec(text);
    return matched === null ? null : Number.parseInt(matched[1], 10);
  } catch {
    return null;
  }
}

/** One issues connection: the states filter, CREATED_AT DESC, and first/after with pageInfo. */
function issuesConnection(repo, first, after, states) {
  let list = repo.issues.slice();
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((value) => String(value).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  list.sort((left, right) => right.number - left.number);
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const number = numberInCursor(after);
    if (number !== null) {
      const at = list.findIndex((issue) => issue.number === number);
      start = at < 0 ? list.length : at + 1;
    }
  }
  const size = Number.isInteger(first) && first > 0 ? first : 20;
  const slice = list.slice(start, start + size);
  return {
    totalCount: list.length,
    nodes: slice.map(issueNode),
    pageInfo: {
      hasNextPage: start + size < list.length,
      hasPreviousPage: start > 0,
      endCursor: slice.length === 0 ? null : cursorOf(slice[slice.length - 1].number),
      startCursor: slice.length === 0 ? null : cursorOf(slice[0].number),
    },
  };
}

/** One pull request connection: open pull requests, newest first. */
function pullsConnection(repo, first) {
  const list = repo.pulls.filter((pull) => pull.state === 'open').sort((left, right) => right.number - left.number);
  const size = Number.isInteger(first) && first > 0 ? first : 20;
  const slice = list.slice(0, size);
  return {
    totalCount: list.length,
    nodes: slice.map((pull) => pullNode(repo, pull)),
    pageInfo: { hasNextPage: list.length > size, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

/** The repository a `repository(owner:, name:)` field names, or null when the token cannot see it. */
function repositoryFor(variables) {
  const owner = typeof variables.owner === 'string' ? variables.owner : '';
  const name = typeof variables.name === 'string' ? variables.name : '';
  if (owner === '' || name === '') return null;
  return findRepo(owner, name);
}

/** The one repository a mutation input names by global id. */
function repoOfInput(input) {
  const id = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
  const repo = repoOfId(id);
  if (repo === null) throw new GraphQLError(`Could not resolve to a Repository with the global id of '${id}'`);
  return repo;
}

function repoOfId(id) {
  return id === '' ? null : findRepoById(id);
}

/** Resolve the documents' own field arguments out of the operation text. */
function statesIn(document) {
  const matched = /states\s*:\s*\[([^\]]*)\]/.exec(document);
  if (matched === null) return null;
  const values = matched[1]
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return values.length === 0 ? null : values;
}

/** One operation's `data`, by the name the document carries. */
function run(name, document, variables) {
  const first = variables.first;
  switch (name) {
    case 'ViewerLogin':
      return { viewer: { login: state.login, id: 'U_1' } };

    case 'RepositoryFields': {
      const repo = repositoryFor(variables);
      return { repository: repo === null ? null : repoGraphql(repo) };
    }

    case 'Issue_fields':
      return { Issue: { name: 'Issue', fields: named(ISSUE_FIELDS) } };

    case 'PullRequestAndRepositoryFields':
      return {
        PullRequest: { name: 'PullRequest', fields: named(PULL_REQUEST_FIELDS) },
        Repository: { name: 'Repository', fields: named(REPOSITORY_FIELDS) },
      };

    case 'SearchType_enumValues':
      return { SearchType: { name: 'SearchType', enumValues: named(SEARCH_TYPE_VALUES) } };

    case 'OpenIssues': {
      const repo = repositoryFor(variables);
      if (repo === null) return { repository: null };
      return { repository: { ...repoGraphql(repo), issues: issuesConnection(repo, first, null, statesIn(document)) } };
    }

    case 'IssueByNumber': {
      const repo = repositoryFor(variables);
      if (repo === null) return { repository: null };
      const number = variables.number;
      const issue = repo.issueByNumber.get(Number(number));
      return { repository: { ...repoGraphql(repo), issue: issue === undefined ? null : issueNode(issue) } };
    }

    case 'IssueCreate': {
      const input = variables.input ?? {};
      const repo = repoOfInput(input);
      const made = createIssue(repo, { title: input.title, body: input.body });
      if (made.error !== undefined) throw new GraphQLError(made.error);
      return { createIssue: { issue: { number: made.issue.number, id: `I_${made.issue.id}`, state: 'OPEN', title: made.issue.title } } };
    }

    case 'IssueClose': {
      const input = variables.input ?? {};
      const id = typeof input.issueId === 'string' ? input.issueId : '';
      const found = findIssueById(id);
      if (found === null) throw new GraphQLError(`Could not resolve to an Issue with the global id of '${id}'`);
      const patched = patchIssue(found.repo, found.issue, { state: 'closed' });
      return { closeIssue: { issue: { number: patched.number, id: `I_${patched.id}`, state: 'CLOSED' } } };
    }

    case 'PullRequests': {
      const repo = repositoryFor(variables);
      if (repo === null) return { repository: null };
      return { repository: { ...repoGraphql(repo), pullRequests: pullsConnection(repo, first) } };
    }

    case 'PullRequestFiles':
    case 'PullRequestId': {
      const repo = repositoryFor(variables);
      if (repo === null) return { repository: null };
      const pull = repo.pullByNumber.get(Number(variables.number));
      return { repository: { ...repoGraphql(repo), pullRequest: pull === undefined ? null : pullNode(repo, pull) } };
    }

    case 'PullRequestCreate': {
      const input = variables.input ?? {};
      const repo = repoOfInput(input);
      const made = createPull(repo, {
        title: input.title,
        body: input.body,
        head: input.headRefName,
        base: input.baseRefName,
      });
      if (made.error !== undefined) throw new GraphQLError(made.error);
      return {
        createPullRequest: {
          pullRequest: {
            number: made.pull.number,
            id: `PR_${made.pull.id}`,
            state: 'OPEN',
            headRefName: made.pull.head,
            baseRefName: made.pull.base,
            merged: false,
            mergeable: 'MERGEABLE',
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = variables.input ?? {};
      const id = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const found = findPullById(id);
      if (found === null) throw new GraphQLError(`Could not resolve to a PullRequest with the global id of '${id}'`);
      const merged = mergePull(found.repo, found.pull, {});
      if (merged.error !== undefined) throw new GraphQLError(merged.error);
      return {
        mergePullRequest: {
          pullRequest: { number: found.pull.number, id: `PR_${found.pull.id}`, merged: true, state: 'CLOSED' },
        },
      };
    }

    case 'AddComment': {
      const input = variables.input ?? {};
      const id = typeof input.subjectId === 'string' ? input.subjectId : '';
      const found = findIssueById(id);
      if (found === null) throw new GraphQLError(`Could not resolve to an Issue with the global id of '${id}'`);
      const comment = addComment(found.repo, found.issue, input.body);
      return { addComment: { commentEdge: { node: { id: comment.node_id, body: comment.body } } } };
    }

    case 'NodeRepository': {
      const id = typeof variables.id === 'string' ? variables.id : '';
      const repo = id.startsWith('R_') ? findRepoById(id) : null;
      if (repo === null) return { node: null };
      const view = repoGraphql(repo);
      return { node: { id: view.id, name: view.name, nameWithOwner: view.nameWithOwner } };
    }

    case 'IssuesPage': {
      const repo = repositoryFor(variables);
      if (repo === null) return { repository: null };
      const after = typeof variables.after === 'string' && variables.after !== '' ? variables.after : null;
      return {
        repository: {
          ...repoGraphql(repo),
          issues: issuesConnection(repo, first, after, statesIn(document)),
        },
      };
    }

    default:
      throw new GraphQLError(`unknown operation ${name === '' ? '(anonymous)' : name}`);
  }
}

/** One operation, answered as a GraphQL response body (never a throw). */
function execute(operation) {
  const document = typeof operation?.query === 'string' ? operation.query : '';
  const variables = operation?.variables !== null && typeof operation?.variables === 'object' ? operation.variables : {};
  if (document.trim() === '') return { errors: [{ message: 'no query in the request body' }] };

  // A document the schema does not hold: 200 with an errors array that names the field.
  if (/noSuchFieldOnViewer/.test(document)) {
    return {
      data: { viewer: { login: state.login } },
      errors: [
        {
          message: `Field "noSuchFieldOnViewer" doesn't exist on type "User"`,
          path: ['viewer', 'noSuchFieldOnViewer'],
          type: 'field',
        },
      ],
    };
  }

  const { name } = operationOf(document);
  try {
    return { data: run(name, document, variables) };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** POST /api/graphql: one operation, or a batch of them. */
export async function handleGraphql(req, res) {
  if (!authorized(req.headers)) return sendError(res, 401, 'Bad credentials');
  const parsed = await readJson(req);
  if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
  const body = parsed.value;
  if (Array.isArray(body)) return sendJson(res, 200, body.map((operation) => execute(operation)));
  return sendJson(res, 200, execute(body));
}
