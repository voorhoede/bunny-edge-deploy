# Contributing

## Setup

- Node 24, the version in `.node-version` (`fnm use` or `nvm use`).
- Deno 2 on the PATH, optional. It enables the startup probe and its tests; without it those tests are skipped.
- No dependencies to install. `npm test` runs everything with `node --test`.

## How we work

- **Tests first.** Write the test, agree on the expected result, then implement. A bug fix gets a regression test that fails before the fix.
- **Verify against Bunny, not memory.** Every API field, enum, limit and behavior in this code was checked against the official OpenAPI spec or on a live account. The facts are in `docs/bunny-findings.md`. Read it before touching anything that talks to Bunny, and add what you verify.
- **Live tests use throwaway resources.** Prefix them with `bed-test-`, log every created ID, and delete them at the end of the run, also when it fails. Never point a test at a real site.
- **Nothing destructive in the action.** It creates and updates, it never deletes or recreates a zone or script. Keep it that way.
- **Zero dependencies.** The action runs from source on the runner. Prefer Node built-ins and `fetch`; a package needs a reason in the pull request.
- **Code and docs in US English.** Comments only for a constraint the code cannot show.

## Pull requests

- One commit per reviewable step, written as a [Conventional Commit](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`, with a body only when the diff does not show the why.
- Describe what changes and why, where the risk is, and what you tested, including whether you ran it against a live account.
- CI runs the test suite on every push and pull request.
