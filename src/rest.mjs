// The REST v3 surface under /api/v3. One store backs every route here and every MCP tool, so
// an object written over one surface reads back over the other with the same id.

import { state, findRepo, createRepo, repoView, createIssue, listIssues, patchIssue, issueView, issueWireBytes, createPull, pullView, mergePull, closePull, createLabel, commitView, commitPaths, fileAt, tipOf, writeFile, blobSha, tick, iso, listComments } from './store.mjs';
import { sendJson, sendJsonBytes, sendError, notFound, readJson, authorized } from './http.mjs';

/** One path segment, decoded (a malformed escape stays as it came). */
function seg(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The contents of one file at a branch, as the contents route answers it. */
function contentView(repo, path, entry, body) {
  return {
    name: path.split('/').pop(),
    path,
    sha: entry.sha,
    size: body === null ? 0 : body.length,
    type: 'file',
    content: body === null ? '' : body.toString('base64'),
    encoding: 'base64',
    url: `https://github.local/api/v3/repos/${repo.full_name}/contents/${path}`,
    html_url: `https://github.local/${repo.full_name}/blob/${path}`,
    git_url: `https://github.local/api/v3/repos/${repo.full_name}/git/blobs/${entry.sha}`,
    download_url: `https://github.local/${repo.full_name}/raw/${path}`,
  };
}

/** The blob bytes behind a file entry. */
function blobBody(repo, entry) {
  const object = repo.objects.get(entry.sha);
  return object === undefined ? null : object.body;
}

/** A commit summary for a write's answer. */
function commitAnswer(repo, sha, message) {
  const view = commitView(repo, sha);
  return {
    sha,
    node_id: view === null ? `C_${sha.slice(0, 12)}` : view.node_id,
    message,
    url: `https://github.local/api/v3/repos/${repo.full_name}/git/commits/${sha}`,
    author: view === null ? null : view.author,
    committer: view === null ? null : view.committer,
    tree: view === null ? null : view.tree,
  };
}

/** The per-page count a list route honours, clamped. */
function perPage(query) {
  const raw = query.get('per_page');
  const value = raw === null ? 30 : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(value, 100);
}

/** The page a list route honours. */
function pageOf(query) {
  const raw = query.get('page');
  const value = raw === null ? 1 : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/** The next-page Link header a list route owes when more than one page exists. */
function linkHeader(origin, path, query, page, per, total) {
  if (page * per >= total) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(per));
  return { link: `<${origin}${path}?${next.toString()}>; rel="next"` };
}

/**
 * Route one /api/v3 request. Every reply is JSON with a request id; every error carries a
 * message; an unknown route or another owner's repository is 404, never 403.
 */
export async function handleRest(req, res, path, query, origin) {
  if (!authorized(req.headers)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const parts = path.split('/').filter((part) => part !== '');
  const method = req.method;

  if (parts.length === 0) {
    if (method !== 'GET' && method !== 'HEAD') return notFound(res);
    sendJson(res, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_url: `${origin}/api/v3/users/{user}`,
      graphql_url: `${origin}/api/graphql`,
      installed_version: '1.0.0',
    }, { 'x-oauth-scopes': 'repo, user' });
    return;
  }

  if (parts[0] === 'meta') {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  if (parts[0] === 'user') {
    if (parts.length === 1) {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, { login: state.login, id: 1, type: 'User', site_admin: false, name: state.login });
      return;
    }
    if (parts.length === 2 && parts[1] === 'repos') {
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        if (typeof parsed.value?.name !== 'string' || parsed.value.name === '') return sendError(res, 422, 'name is required');
        const repo = createRepo(parsed.value);
        if (repo === null) return sendError(res, 422, 'a repository with that name already exists');
        sendJson(res, 201, repoView(repo));
        return;
      }
      if (method === 'GET') {
        const owned = [...state.repos.values()];
        const per = perPage(query);
        const page = pageOf(query);
        const slice = owned.slice((page - 1) * per, page * per);
        const link = linkHeader(origin, path, query, page, per, owned.length);
        sendJson(res, 200, slice.map(repoView), link ?? undefined);
        return;
      }
      return notFound(res);
    }
    return notFound(res);
  }

  if (parts[0] !== 'repos' || parts.length < 3) return notFound(res);

  const owner = seg(parts[1]);
  const name = seg(parts[2]);
  const repo = findRepo(owner, name);
  if (repo === null) return notFound(res);
  const rest = parts.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoView(repo));
    if (method === 'PATCH') {
      const parsed = await readJson(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (typeof parsed.value?.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value?.name === 'string' && parsed.value.name !== '' && parsed.value.name !== repo.name) {
        if (state.repos.has((`${repo.owner}/${parsed.value.name}`).toLowerCase())) return sendError(res, 422, 'a repository with that name already exists');
        state.repos.delete(`${repo.owner}/${repo.name}`.toLowerCase());
        repo.name = parsed.value.name;
        repo.full_name = `${repo.owner}/${repo.name}`;
        state.repos.set(`${repo.owner}/${repo.name}`.toLowerCase(), repo);
      }
      if (typeof parsed.value?.private === 'boolean') repo.private = parsed.value.private;
      repo.updated_at = iso(tick());
      return sendJson(res, 200, repoView(repo));
    }
    if (method === 'DELETE') {
      state.repos.delete(`${repo.owner}/${repo.name}`.toLowerCase());
      res.writeHead(204, { 'x-github-request-id': 'req-del' });
      res.end();
      return;
    }
    return notFound(res);
  }

  const head = rest[0];

  if (head === 'contents') {
    const filePath = rest.slice(1).map(seg).join('/');
    if (method === 'GET') {
      const branch = query.get('ref') ?? repo.default_branch;
      const entry = fileAt(repo, branch, filePath);
      if (entry === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, contentView(repo, filePath, entry, blobBody(repo, entry)));
    }
    if (method === 'PUT') {
      const parsed = await readJson(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const body = parsed.value ?? {};
      if (typeof body.content !== 'string') return sendError(res, 422, 'content is required');
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
      const existed = fileAt(repo, branch, filePath) !== null;
      const tip = tipOf(repo, branch);
      const flat = tip === null ? new Map() : new Map(tip.flat);
      const entry = writeFile(repo, Buffer.from(body.content, 'base64'));
      flat.set(filePath, entry);
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${filePath}`;
      const sha = commitPaths(repo, branch, flat, message);
      repo.pushed_at = repo.updated_at = iso(tick());
      const answer = contentView(repo, filePath, entry, blobBody(repo, entry));
      answer.commit = commitAnswer(repo, sha, message);
      return sendJson(res, existed ? 200 : 201, answer);
    }
    if (method === 'DELETE') {
      const parsed = await readJson(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const body = parsed.value ?? {};
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
      const entry = fileAt(repo, branch, filePath);
      if (entry === null) return sendError(res, 404, 'Not Found');
      if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== entry.sha) return sendError(res, 409, 'sha does not match');
      const tip = tipOf(repo, branch);
      const flat = tip === null ? new Map() : new Map(tip.flat);
      flat.delete(filePath);
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${filePath}`;
      const sha = commitPaths(repo, branch, flat, message);
      return sendJson(res, 200, { content: null, commit: commitAnswer(repo, sha, message) });
    }
    return notFound(res);
  }

  if (head === 'git') {
    const tail = rest.slice(1);
    if (tail[0] === 'refs') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
          const ref = String(parsed.value?.ref ?? '');
          const sha = String(parsed.value?.sha ?? '');
          if (!ref.startsWith('refs/heads/') || sha === '') return sendError(res, 422, 'ref and sha are required');
          if (!repo.commits.has(sha)) return sendError(res, 422, 'sha is not a commit in this repository');
          const branch = ref.slice('refs/heads/'.length);
          repo.refs.set(ref, sha);
          return sendJson(res, 201, { ref, node_id: `R_${sha.slice(0, 8)}`, url: `https://github.local/api/v3/repos/${repo.full_name}/git/refs/heads/${branch}`, object: { sha, type: 'commit', url: `https://github.local/api/v3/repos/${repo.full_name}/git/commits/${sha}` } });
        }
        if (method === 'GET') {
          const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `R_${sha.slice(0, 8)}`, url: `https://github.local/api/v3/repos/${repo.full_name}/git/${ref}`, object: { sha, type: 'commit', url: `https://github.local/api/v3/repos/${repo.full_name}/git/commits/${sha}` } }));
          return sendJson(res, 200, refs);
        }
        return notFound(res);
      }
      if (tail[1] === 'heads' && tail.length >= 3) {
        const branch = tail.slice(2).map(seg).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (method !== 'GET') return notFound(res);
        if (sha === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: `R_${sha.slice(0, 8)}`, url: `https://github.local/api/v3/repos/${repo.full_name}/git/heads/${branch}`, object: { sha, type: 'commit', url: `https://github.local/api/v3/repos/${repo.full_name}/git/commits/${sha}` } });
      }
      return notFound(res);
    }
    if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') {
      const view = commitView(repo, tail[1]);
      if (view === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, view);
    }
    if (tail[0] === 'blobs' && tail.length === 2 && method === 'GET') {
      const object = repo.objects.get(tail[1]);
      if (object === undefined || object.type !== 'blob') return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { sha: tail[1], content: object.body.toString('base64'), encoding: 'base64', size: object.body.length });
    }
    return notFound(res);
  }

  if (head === 'branches') {
    if (method !== 'GET') return notFound(res);
    if (rest.length === 1) {
      const view = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
      return sendJson(res, 200, view);
    }
    const branch = rest.slice(1).map(seg).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return sendError(res, 404, 'Branch not found');
    return sendJson(res, 200, { name: branch, commit: commitView(repo, sha) });
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const label = createLabel(repo, parsed.value ?? {});
        if (label === null) return sendError(res, 422, 'label name is required or already taken');
        return sendJson(res, 201, label);
      }
      if (method === 'GET') return sendJson(res, 200, [...repo.labels.values()]);
    }
    return notFound(res);
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const made = createIssue(repo, parsed.value ?? {});
        if (made.error !== undefined) return sendError(res, 422, made.error);
        return sendJson(res, 201, issueView(repo, made.issue));
      }
      if (method === 'GET') {
        const issues = listIssues(repo, { state: query.get('state') ?? 'open' });
        const per = perPage(query);
        const page = pageOf(query);
        const slice = issues.slice((page - 1) * per, page * per);
        const link = linkHeader(origin, path, query, page, per, issues.length);
        return sendJson(res, 200, slice.map((issue) => issueView(repo, issue)), link ?? undefined);
      }
      return notFound(res);
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = repo.issueByNumber.get(number);
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
      const base = `https://github.local/api/v3/repos/${repo.full_name}`;
      const comments = listComments(repo, issue).map((comment) => ({
        id: comment.id,
        node_id: comment.node_id,
        body: comment.body,
        user: comment.user,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        issue_url: `${base}/issues/${issue.number}`,
        url: `${base}/issues/comments/${comment.id}`,
        html_url: `https://github.local/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`,
      }));
      return sendJson(res, 200, comments);
    }
    if (method === 'GET') {
      return sendJsonBytes(res, 200, issueWireBytes(repo, issue));
    }
    if (method === 'PATCH') {
      const parsed = await readJson(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const patched = patchIssue(repo, issue, parsed.value ?? {});
      return sendJson(res, 200, issueView(repo, patched));
    }
    return notFound(res);
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const made = createPull(repo, parsed.value ?? {});
        if (made.error !== undefined) return sendError(res, 422, made.error);
        return sendJson(res, 201, pullView(repo, made.pull));
      }
      if (method === 'GET') {
        const wanted = query.get('state') ?? 'open';
        const pulls = wanted === 'all' ? repo.pulls.slice() : repo.pulls.filter((pull) => pull.state === wanted);
        const per = perPage(query);
        const page = pageOf(query);
        const slice = pulls.slice((page - 1) * per, page * per);
        const link = linkHeader(origin, path, query, page, per, pulls.length);
        return sendJson(res, 200, slice.map((pull) => pullView(repo, pull)), link ?? undefined);
      }
      return notFound(res);
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = repo.pullByNumber.get(number);
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return notFound(res);
      if (pull === undefined) return sendError(res, 404, 'Not Found');
      const parsed = await readJson(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const merged = mergePull(repo, pull, parsed.value ?? {});
      if (merged.error !== undefined) return sendError(res, merged.error === 'already merged' ? 405 : 405, 'Pull Request is not mergeable');
      return sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, pullView(repo, pull));
    if (method === 'PATCH') {
      const parsed = await readJson(req);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (parsed.value?.state === 'closed' && pull.state === 'open') closePull(repo, pull);
      if (typeof parsed.value?.title === 'string') {
        pull.title = parsed.value.title;
        pull.wire = undefined;
      }
      return sendJson(res, 200, pullView(repo, pull));
    }
    return notFound(res);
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const branch = query.get('sha') ?? repo.default_branch;
    const tip = tipOf(repo, branch);
    if (tip === null) return sendJson(res, 200, []);
    const views = [];
    let current = tip;
    while (current !== null && views.length < perPage(query)) {
      views.push(commitView(repo, current.sha));
      current = current.parent === null ? null : repo.commits.get(current.parent) ?? null;
    }
    return sendJson(res, 200, views);
  }

  return notFound(res);
}

export { blobSha };
