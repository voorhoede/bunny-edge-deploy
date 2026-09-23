# Agent instructions

<!-- bunny-cli:start -->

## bunny.net CLI

This project uses bunny.net. Manage its resources with the `bunny` CLI: databases, DNS, storage, Edge Scripts, static sites, and cloud sandboxes.

- Authenticate once with `bunny login` (or set `BUNNYNET_API_KEY`); verify with `bunny api GET /user`.
- Discover commands with `bunny --help` and `bunny <namespace> --help`; resource commands support `--output json` for machine-readable output (a few browser-opening helpers like `bunny docs` do not).
- In unattended runs, pass a flag for every value a command would prompt for, and `--force` on destructive commands; prompts otherwise block or cancel without a TTY.
- Key namespaces: `bunny db` (Bunny Database: create, shell, studio, tokens), `bunny dns` (zones, records, presets), `bunny sites` (static hosting and deploys), `bunny scripts` (Edge Scripts), `bunny storage` (Edge Storage zones and files), `bunny sandbox` (cloud sandboxes).
- To query a Bunny Database from application code, use `@bunny.net/database-client`; it is server-side only, since an auth token grants access to the whole database.
- When the CLI has no command for something, fall back to `bunny api <METHOD> <path>` against api.bunny.net.

<!-- bunny-cli:end -->

## This repository

`bunny-edge-deploy` is a GitHub Action (Node 24, zero dependencies, ESM) that deploys a built website to Bunny.net: `client-dir` to a storage zone, `server-entry` as a middleware edge script on a pull zone. It only deploys; building is the caller's job.

- Layout by domain: `src/bunny/` API and storage clients, `src/compat/` the pre-deploy checks, `src/provision/` find-or-create and settings drift, `src/deploy/` upload, env sync, publish, purge, retention and smoke test, `src/github/` the Actions glue, `src/run.js` the orchestration, `src/main.js` the entry point.
- Tests live next to the code as `*.test.js` and run with `npm test` (`node --test`). Deno on the PATH enables the startup probe tests; without it they are skipped.
- Write the test before the implementation, and let a person confirm the expectation first.
- Every Bunny API field, enum, limit and behavior used here was verified against the official OpenAPI spec or on a live account. The verified facts are in `docs/bunny-findings.md`; read it before changing anything that talks to Bunny, and add to it when you verify something new.
- When testing against a real account, prefix throwaway resources with `bed-test-`, log every created ID, and delete them at the end, also when the run fails.
- Code, comments, commit messages and docs are US English. Commits follow Conventional Commits. Comments only for constraints the code cannot show.
