# wiki9

Agent-native LLM Wiki powered by [DB9](https://db9.ai). Based on [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). The readme is also available in [中文](./docs/README.zh-CN.md).

Instead of traditional RAG, the LLM incrementally builds and maintains a persistent wiki — a structured, interlinked collection of markdown files. Instead of embedding LLM calls in the tool itself, wiki9 generates `AGENTS.md` + skill files so any AI agent (Claude Code, Cursor, Windsurf, etc.) can operate the wiki directly.

## Why DB9

- DB9 has built-in vector support, which makes it a natural fit for powering vector indexes and semantic search for a knowledge base.
- A knowledge base can be shared simply by sharing the DB9 instance, making it easier to distribute pages, indexes, and backups across a team.

```
User ↔ AI Agent (Claude Code / Cursor / ...)
         │  reads AGENTS.md for instructions
         │  uses skills: ingest, query, lint
         │  reads/writes local markdown files
         ▼
    Local filesystem (primary)
    ├── wiki/       ← wiki pages
    ├── sources/    ← raw source materials
    └── log.md      ← edit history
         │
         │  wiki9 sync
         ▼
    DB9 Database
    ├── wiki_index   ← vector search index
    ├── wiki_page_sources ← page ↔ source references
    ├── fs9:/wiki/   ← page backups
    └── fs9:/sources/← source backups
```

## Quick Start

Install DB9 first. The official site is [db9.ai](https://db9.ai).

```bash
# Install the DB9 CLI
curl -fsSL https://db9.ai/install | sh

# Install wiki9
npm install -g wiki9
```

```bash
# It is recommended to log in first so your DB9 data is tied to your account
# and won't be lost with an expiring temporary account
db9 login

# Create a DB9 database
db9 create --name my-wiki

# Create an API token
db9 token create --name wiki-agent --expires-in-days 30

# Initialize the wiki
cd my-knowledge-base
wiki9 init --db <database-id>  # Uses your DB9 login; alternatively set WIKI9_TOKEN
```

This generates:

```
my-knowledge-base/
├── AGENTS.md          # Agent instructions (works with any AI agent)
├── .agents/
│   └── skills/
│       ├── ingest.md  # Ingest skill: process sources into wiki pages
│       ├── query.md   # Query skill: search + synthesize answers
│       └── lint.md    # Lint skill: health-check the wiki
├── .claude/
│   └── skills -> ../.agents/skills
├── wiki9.toml         # Config (DB9 credentials — auto-added to .gitignore)
├── log.md             # Append-only edit log
├── wiki/              # Wiki pages (markdown)
└── sources/           # Raw source materials
```

Now open the project with your AI agent and start using the skills. For example, open the folder in Codex and send: `Help me add /some/dir/documents.md into the knowledge base.`

## CLI Commands

```bash
wiki9 init --db <id>                     # Initialize with DB9 login or WIKI9_TOKEN
wiki9 sync                              # Sync local files → DB9 (vector index + fs9 backup)
wiki9 search "query"                    # Semantic search across wiki pages
wiki9 index                             # List all pages (slug, title, description, tags)
wiki9 status                            # Wiki stats
```

## Skills

### ingest

Process new source material into wiki pages. The agent reads the source, copies it into `sources/YYYY-MM-DD/`, preserves the original file or directory name when possible, renames on conflicts, creates/updates wiki pages in `wiki/`, maintains Obsidian-style cross-references, and runs `wiki9 sync`.

### query

Answer questions from the wiki. The agent runs `wiki9 search` to find relevant pages, reads them, and synthesizes an answer. Valuable answers get written back as new wiki pages so explorations compound over time.

### lint

Health-check the wiki. The agent scans all pages for broken links, ambiguous short wiki links, orphan pages, missing frontmatter, stale content, duplicate topics, and unreferenced files in `sources/`. Reports findings and applies fixes after user confirmation.

## Wiki Page Format

```markdown
---
title: JavaScript Closures
description: How closures work in JavaScript
tags: [javascript, functions, scope]
sources: [2026-04-07/mdn-closures.md]
updated: 2026-04-07
---

# JavaScript Closures

A closure is a function bundled with its lexical environment.

## Related

- [[scope]]
- [[javascript/functions]]
```

Use `sources` entries as paths relative to `sources/` without the `sources/` prefix. Use Obsidian-style wiki links with the shortest unique filename, and switch to the full path relative to `wiki/` when filenames collide.

## Edit Log

Every operation is recorded in `log.md`:

```markdown
## [2026-04-07] ingest | MDN Closures Article
- created `javascript/closures` — extracted from 2026-04-07/mdn-closures.md
- updated `javascript/scope` — added [[javascript/closures]] reference

## [2026-04-07] query | What are closures?
- created `javascript/closures-explained` — captured query synthesis
```

## How Sync Works

`wiki9 sync` diffs local files against DB9:

1. Scans `wiki/`, `sources/`, and `log.md`
2. Computes content hashes, compares with DB9 records
3. For changed wiki pages: generates embeddings via DB9's built-in `embedding()` function, upserts to `wiki_index`
4. Rebuilds `wiki_page_sources` from each page's `sources` frontmatter
5. Backs up all files to DB9's fs9 filesystem

### Safe synchronization and sharing

One DB9 instance is one shared knowledge base. Everyone with access to that instance may be able to retrieve its pages and **all original files in `sources/`**, including binary files. Access is controlled by DB9 credentials; wiki9 does not create private per-member spaces or its own role system. Use separate instances when content must be kept separate.

Normal sync still propagates local page, source, and log deletions recorded by the last successful sync. Missing directories, unreadable files, symlinks, and special files abort synchronization instead of being treated as deleted content. Copy the intended files into `wiki/` or `sources/` rather than placing symlinks there. The generated `.claude/skills` link remains supported.

Local changes are detected by full SHA-256 content hashes, including binary sources and `log.md`; preserving a file's old modification time does not hide a change. Each sync reads local content to compute these hashes, while uploads and embeddings remain incremental. Version-two sync records migrate after a successful sync, retaining their tracked paths and remote conflict check. An incompatible or invalid record cannot authorize implicit remote cleanup.

Every sync path uses the same deletion checks and displays its deletion targets before execution. When the saved state is absent, invalid, or belongs to another database, sync performs a full scan. It lists and refuses to delete remote-only content that is outside that state. Restore missing files with `wiki9 init --db <id>` first. To deliberately replace the remote wiki with the complete local copy, review the differences and run:

```bash
wiki9 sync --full --prune
```

`--prune` requires `--full`. This explicit replacement rewrites local pages' remote index fields and embeddings, uploads all local pages, sources and logs even when remote hashes or timestamps match, and deletes remote-only content. It can incur full upload and embedding costs. A normal `--full` rescan preserves deletion protection and skips unchanged content. A failed restore must be retried with `init` before sync can proceed. Init preserves existing local files, so merge conflicting content before syncing.

Sync records the remote index, references, and file metadata. If these change before the next sync, it stops before updating content so a stale directory cannot silently replace another writer's changes. Restore the current remote copy in a separate directory and merge it into the working copy; use the explicit replacement command only after reviewing the merged copy. Coordinate writers: this check is not a distributed lock, and simultaneous syncs are not atomic across SQL and file storage. After a partially failed sync, inspect and reconcile both copies before explicitly replacing remote data. The fs9 mirror follows deletions and is not a versioned backup.

Local state is not a security boundary against another process with the same account and DB9 credential. Unsupported path names, including backslashes and control characters, fail before synchronization instead of being silently skipped or renamed. Ordinary Unicode, spaces, and apostrophes remain supported.

Restored pages, binary sources and logs are created with owner-only permissions (`0600`), and newly created private content directories use `0700`. Existing files and directory permissions are preserved; review those separately when sharing a host or working directory. Sources remain normal files, not enforced immutable storage.

### Agent output and local operation records

`search`, `index`, and `status` support `--json` for structured content data. Human-readable output escapes terminal controls and shortens long summaries; JSON preserves metadata values and escapes control bytes. Neither format makes retrieved instructions trustworthy. Generated agent instructions and skills treat wiki/source contents and results as data, not permission to run commands, access credentials, export content, or delete files. Wiki names are escaped when generating the Markdown title without changing their saved value. Existing `AGENTS.md` and skill files are not overwritten by init; review and update older generated instructions manually.

If either database count query fails, `wiki9 status` prints a warning to stderr and shows `unavailable` for `Indexed pages`, `Unindexed`, `Referenced sources`, and `Source links`. Local page/source counts and local analysis remain available. With `--json`, `databaseAvailable` is `false` and `indexedPages`, `referencedSourceCount`, and `pageSourceLinks` are `null`; when both queries succeed, `databaseAvailable` is `true` and real zero counts remain numeric `0`. A count query failure alone does not cause a nonzero exit code: if the remaining local processing succeeds, the command still exits with code `0`. Callers should check `databaseAvailable` in JSON or the `unavailable` values in human-readable output; exit code `0` alone does not establish that database statistics are complete.

`.wiki9/operations.jsonl` contains local timestamps, run IDs, database targets, deletion plans and outcomes, and init/schema/credential-update events. It does not contain credential values, document bodies or raw backend error responses. The file is owner-only and append-written; a write failure warns without claiming to roll back a successful remote operation. It is a best-effort troubleshooting record, not a tamper-proof audit service, and is not mirrored remotely. `log.md` remains the agent-maintained edit history, append-only by convention, with ordinary mirror replacement and deletion behavior. Keep credentials and unnecessary sensitive material out of edit logs.

### Credentials

Omit `--token` to use your existing `db9 login`, or provide `WIKI9_TOKEN` through your shell's secret input mechanism or secret manager. Environment tokens override the config for that invocation and are not written by init. An explicit init `--token` takes precedence over the environment. An empty `WIKI9_TOKEN` is rejected; unset it to use configured or login credentials. The existing `--token` option remains available and prints a warning without echoing the value; it stores the token in `wiki9.toml`, so avoid putting literal secrets in shell history or process arguments. Keeping this compatibility option retains those exposure risks.

Config files use owner-only permissions (`0600`); existing permissions are tightened when read. Init adds exact ignore rules for `wiki9.toml` and `.wiki9/`. Keep them out of version control, including files already tracked by Git. Running init again for the same database with `--token` replaces the stored token while retaining the wiki name and search settings. Revoke replaced or exposed tokens with `db9 token revoke <token-id>`, and choose an expiry suited to the task rather than an effectively permanent token. An empty configured token uses the SDK's local DB9 login credentials and fails if none are available; it does not bypass authentication.

## Development

```bash
npm install
npm run dev -- sync           # Run commands in dev mode
npm run build                 # Build with tsup
npm run typecheck             # Type check
npx vitest run test/safety.test.ts test/output.test.ts test/errors.test.ts  # Offline regression tests
npx vitest run test/integration.test.ts  # Live integration tests (temporary DB9 database)
```

If your account is already at the DB9 database limit, set `WIKI9_TEST_DB_ID` to a disposable database reserved for tests. You can also set `WIKI9_TEST_TOKEN` to provide an explicit test token.

## License

BSD-3-Clause
