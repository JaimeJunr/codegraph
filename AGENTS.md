# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
Single npm package at the repo root (`@colbymchenry/codegraph`) — a TypeScript
library + CLI + MCP server. The CLI/server entry is `dist/bin/codegraph.js`
(built from `src/`). `site/` (docs/landing) and `telemetry-worker/` (Cloudflare
worker) are auxiliary and not part of the core product setup.

### Node + SQLite FTS5 gotcha (most important)
The product stores its graph in SQLite via Node's built-in `node:sqlite` and
**requires the FTS5 extension** (see `src/db/sqlite-adapter.ts`). The default
`node` on `PATH` (`/exec-daemon/node`) is a custom build **without FTS5** — with
it, every DB-backed test and CLI command fails with `Error: no such module:
fts5` (≈446 tests fail). The nvm-managed node is an official Node.org build that
**does** include FTS5.

The cloud shell prepends `/exec-daemon` to `PATH` after `.bashrc` runs, so the
nvm node does not win automatically. Prepend it once at the start of each
session before running tests or the CLI:

```bash
export PATH="$(ls -d "$HOME"/.nvm/versions/node/*/bin | head -1):$PATH"
node --version   # should be the nvm version (e.g. v22.22.2), not /exec-daemon/node
```

`npm ci` itself does not need FTS5, so the update script works under either node;
only test/CLI/server runs require the nvm node.

**Local dev (mise):** this repo ships a `mise.toml` pinning `node = "22.22.2"`
(an official build *with* FTS5). With mise active, `node` in this directory
resolves to it automatically — no manual PATH juggling. The default system node
(e.g. 22.14) is built *without* FTS5, so without mise you'll hit the same
`no such module: fts5` failures; run tests with `mise exec node@22.22.2 -- npm test`
or `mise exec node@22.22.2 -- npx vitest run <file>`.

### Build / lint / test / run
Standard scripts live in `package.json`. There is no separate lint/ESLint setup —
`tsc` (run by `npm run build`) is the type/lint check.

- Build: `npm run build` (tsc + copies `schema.sql`/`*.wasm` into `dist/`). Needed
  before running the CLI/MCP server from `dist/`.
- Test: `npm test` (vitest; ~82 files, takes ~1–2 min). Must use the nvm node.
- Run CLI: `node dist/bin/codegraph.js <cmd>` (e.g. `init <path>`, `query <term>`,
  `callers <symbol>`, `status`). It prints an experimental-SQLite warning to
  stderr — harmless.
- Run MCP server (stdio JSON-RPC): `node dist/bin/codegraph.js serve --mcp --path <project>`.
