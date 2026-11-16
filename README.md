# makefun-forge

[![make.fun - github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/flavyn/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/flavyn/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge: one Node 22 process, its own store, no UI and no
outside service. It serves the four surfaces an agent already speaks, and a sealed suite
drives it as a client.

## What it serves

| Surface | Where |
| --- | --- |
| REST v3 | `/api/v3` — repositories, contents, git refs, issues, pull requests, labels |
| MCP | `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision `2026-07-28` |
| Git smart HTTP | `/{owner}/{repo}.git` |
| GraphQL v4 | `/api/graphql` |
| Health probe | `/healthz` |

## The store

Everything lives in memory. A trial hands the process a fresh pod and a read-only `/bot`, and
the replay the export is compared against is another fresh pod, so durability would buy no
point and would cost most of the write workload's budget. Ids and timestamps come from
counters, never from a clock or a random source, so two runs of the same instance write the
same numbers.

Git objects are real: blobs, nested trees and commits are built with their own sha1, so the
contents route, the git data route, pull requests and the git transport all share one object
database.

## Running it

```
node main.ts            # PORT picks the port; with no PORT the kernel chooses one
```

In a trial the process binds an ephemeral port, POSTs it to `$MAKEFUN_ENV_URL/register`, and
long-polls `$MAKEFUN_ENV_URL/done`, exiting 0 when the suite says it is done. It never binds
8080, where the suite listens.

## Checking it locally

The kit ships the sealed suite as source. `sdk/run.ts` drives a server you started yourself:

```
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:7100 --token TOK --json
```

## License

MIT, see [LICENSE](LICENSE).
