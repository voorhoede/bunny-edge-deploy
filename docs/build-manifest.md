# What the action reads from the build

The action deploys what a Bunny framework adapter describes in `.bunny/build.json`, the build manifest from [Bunny's adapter contract](https://github.com/BunnyWay/bunny-adapters/blob/main/docs/writing-an-adapter.md). It reads the manifest at the `build-manifest` input (default `.bunny/build.json`) and resolves every path in it from the directory above `.bunny/`.

## The manifest

| Field | Used for |
| --- | --- |
| `manifestVersion` | Must be 1. A newer version fails the run, since its meaning may have changed. |
| `kind` | `"ssr"` deploys a script, `"static"` deploys files only. |
| `script.entry`, `script.type` | Server builds only. The type must be `"standalone"`. |
| `assets.dir` | The client files, uploaded to `deploys/<deploy id>/` in the storage zone. |
| `requires.pullZone` | Server builds only. `disableCookies`, `enableSmartCache` and `enableCacheSlice`, set on the pull zone on every deploy. |
| `requires.storage.write` | Server builds only. Whether the script gets the storage password that can write (sessions). |
| `requires.env` | Server builds only. Which platform variables the action sets on the script (below). |

`adapter` and `framework` only appear in the log. `script.bytes`, `requires.cliVersion`, `requires.env[].reason`, `requires.env[].secret` and `dev` are ignored, as are fields the action does not know. Whether a platform variable is a secret comes from the table below.

## Server builds

### The script

The script is deployed as the code of a **standalone** Edge Script, the origin of the pull zone. The action writes one line in front of it before uploading:

```js
globalThis.__BUNNY_DEPLOY__ = {"id":"<deploy id>","assetPrefix":"deploys/<deploy id>","site":"<name>","environment":"production"};
```

The adapter reads `assetPrefix` at startup, so every release knows its own deploy folder. That is what makes a rollback bring back code and files together.

### Variables the action sets

Only the ones `requires.env` names, read live from the zones on every deploy:

| Variable | Value | Kind |
| --- | --- | --- |
| `BUNNY_STORAGE_ZONE` | storage zone name | variable |
| `BUNNY_STORAGE_HOST` | the zone's regional endpoint | variable |
| `BUNNY_STORAGE_KEY` | the zone's read-only password | secret |
| `BUNNY_SESSION_ZONE` | storage zone name, only with `requires.storage.write` | variable |
| `BUNNY_SESSION_KEY` | the zone's password that can write, only with `requires.storage.write` | secret |
| `BUNNY_PULLZONE_ID` | pull zone ID | variable |

The `env` and `secrets` inputs add the app's own variables; they may not reuse these names. A required entry nobody sets gets a warning unless it already exists on the script. An entry marked optional, such as `BUNNY_API_KEY` for cache purging in the Astro adapter's manifest, gets none.

### What the compatibility check enforces

Errors fail the workflow before anything is uploaded:

- the script is missing, has a syntax error, or is larger than `script-size-limit-mb` (default 8 MB);
- relative imports or bare package imports, since nothing but the one file is uploaded (`npm:`, `jsr:`, `http:` and `https:` specifiers resolve at run time);
- `node:` modules that do not resolve on the runtime: child_process, cluster, constants, dgram, inspector, repl, sys, trace_events, tty, v8, vm, wasi, worker_threads;
- when Deno is on the PATH: importing the script in a harness with a stubbed `Bunny` global throws, registers no `serve()` handler, or takes longer than `startup-limit-ms` (default 500 ms). This approximates Bunny's startup limit. The harness runs twice and times the second import, so downloading `npm:` imports does not count, and it stops after 120 s.

Warnings: a script larger than 2 MB (cold starts measured at 0.5 s and up), and `node:` modules not yet verified on the runtime (sea, sqlite, test).

Node modules verified from a deployed script (Deno 2.7, Node compat v24.2): assert, async_hooks, buffer, console, crypto, diagnostics_channel, dns, dns/promises, domain, events, fs, fs/promises, http, http2, https, module, net, os, path, path/posix, perf_hooks, process, punycode, querystring, readline, readline/promises, stream, stream/promises, stream/web, string_decoder, timers, timers/promises, tls, url, util, util/types, zlib.

### Runtime limits

From Bunny's docs unless marked verified: 30 s CPU per request, 128 MB memory, 50 subrequests, 500 ms startup. Verified: scripts of 9.5 MB and up fail to boot reliably, and more than 128 variables or a value over 2048 bytes makes the script fail to boot, after which every request returns 400.

## Static builds

A static build has no script, so `env` and `secrets` are refused. The files are served from the storage zone through edge rules the action owns ([managing-the-zone.md](managing-the-zone.md)), and a `404.html` at the root becomes the zone's 404 page.

`_headers` and `_redirects` are uploaded with the deploy but blocked from the public, and applied as edge rules:

- **`Cache-Control` with `max-age=N`** on a path becomes a browser cache time of N seconds for that path. `immutable` cannot be expressed and is dropped. A `Cache-Control` without `max-age` is not applied, and the compatibility check warns about it. Without any `max-age` block, common asset extensions get one day.
- **A block ending in `*`**, such as `/*` or `/api/*`, becomes a rule for every path under it. A `*` elsewhere in the path or a `:placeholder` cannot be matched by an edge rule, so that block is not applied and the check warns about it.
- **Headers every page shares** go into one rule for all URLs, but only when every HTML page in the build has a block; the pages Astro writes for a redirect do not count. Otherwise each page keeps its own headers, so a single `/admin` block with `noindex` stays on `/admin`. The remaining headers of each page, such as a CSP with that page's hashes, go into one rule per distinct set, up to 25 pages per rule. A page matches with and without its trailing slash.
- **A `Location` header** is left out, and the check names the page. Its meta refresh still redirects the visitor.
- **Each redirect** becomes a rule for that path, with status 301, 302, 307 or 308. A relative target goes to the host the visitor asked for. Another status, or a line without a target, fails the compatibility check.

Bunny allows 50 edge rules per zone, counting rules you add yourself. A deploy that would need more fails before uploading anything.
