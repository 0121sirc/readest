# AGENTS.md

Readest: cross-platform ebook reader. pnpm monorepo; the product is the **Next.js 16 + Tauri v2** app, deployed to web (Cloudflare), desktop, iOS, and Android from one codebase.

## Layout

| Path | What it is |
| --- | --- |
| `apps/readest-app/` | The app (Next.js frontend + `src-tauri/` Rust + Cloudflare/OpenNext deploy). Almost all work happens here. |
| `apps/readest.koplugin/` | KOReader plugin (Lua) + standalone `native/localsend-bin` Cargo crate. |
| `apps/readest-calibre-plugin/` | Calibre plugin (Python). |
| `packages/*` | Git submodules (`foliate-js`, `tauri`, `simplecc-wasm`, `qcms`, `js-mdict`) — don't edit in place; they're separate repos. |

App-internal conventions (design system, E-ink, i18n, read-aloud, PR-review rules, skill routing) live in **`apps/readest-app/AGENTS.md`** and `apps/readest-app/docs/`. Read the app file before touching app UI/code.

## Toolchain (critical)

- **Node 24 is required**, but the sandbox default `node` is v18 and will break installs/tests/hooks. Put nvm's v24 first:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
  ```
- `pnpm@11.1.1` is pinned via `packageManager`; don't use npm/yarn.

## Setup

```bash
git submodule update --init --recursive
pnpm install
pnpm --filter @readest/readest-app setup-vendors   # copies pdf.js worker/wasm/fonts to public/
```

## Commands

Root scripts just delegate to `@readest/readest-app`; run app commands from `apps/readest-app` (or the root alias).

```bash
pnpm dev-web        # web-only dev server (no Rust build)
pnpm tauri dev      # desktop app (Linux = CEF; needs Rust; compiles backend)
pnpm lint           # tsc --noEmit && biome lint .   (web)
pnpm test           # unit tests (vitest + jsdom)
pnpm format:check   # Biome check (also `pnpm format` to write)
```

Test tiers and single-file usage are documented in `apps/readest-app/docs/testing.md`. Rust checks (only when `src-tauri/` changed): `pnpm fmt:check`, `pnpm clippy:check`, `pnpm test:rust`. Lua checks (only when `apps/readest.koplugin/` changed): `pnpm lint:lua`, `pnpm test:lua`.

### Running one test (documented command is broken)

`pnpm test -- <file>` expands to `vitest -- <file>` — vitest ignores the filter and runs the **entire** suite. Use the explicit form instead:

```bash
pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run src/__tests__/path/to/foo.test.ts
```

Unit tests load `.env` + `.env.test.local` via `dotenv-cli`; `pnpm test` already wires this.

## Git hooks

- **pre-commit**: `lint-staged` runs `biome format --write` on staged JS/TS/CSS/JSON.
- **pre-push**: `format:check` + `lint` (tsc + biome) + the full `test` suite. It is slow and its timing-sensitive tests flake in sandboxes; if it fails, verify the failures are unrelated before considering `git push --no-verify` (ask first).

Formatting/linting is **Biome**, configured at the repo root; it ignores `packages/**` (submodules) and generated dirs. Commit messages follow conventional commits with a scope (`feat(reader):`, `fix(android):`, `chore(deps):`).

## Local web server

`./web_app.sh start|stop|restart|status` runs `pnpm dev-web` in the background on port 3000 (loads nvm Node 24 itself). PID `.web_app.pid`, log `.web_app.log`. Equivalent to `pnpm dev-web` for foreground use.

## Worktrees

Use `pnpm worktree:new <branch|pr-number>` / `pnpm worktree:rm` — never `git worktree add` directly. The script initializes submodules, installs deps, copies `.env`, and sets up vendor assets/Tauri gen symlinks needed for lint and tests.

## Public text

Commits, PR titles/bodies, issues, and review replies are public. Never include user counts, payment/subscription data, or user identifiers (ids, emails, session/payment ids). Describe the mechanism, not the numbers.
