# Bunny.net findings (verified 2026-09-23 and 2026-09-30)

Sources: official OpenAPI specs (`https://core-api-public-docs.b-cdn.net/docs/v3/public.json` and `compute.json`), docs at `bunny.net/docs` (docs.bunny.net redirects there), the `@bunny.net/edgescript-sdk` package, the Bunny CLI 0.16.1 binary, and live tests on throwaway resources (2026-09-23: storage zone 1931485, pull zone 6671152, script 92103; 2026-09-30: storage zone 1955250, pull zone 6715744, script 93293; all deleted afterwards. A second 2026-09-30 run on another account: storage zone 1955340 and script 93304 deleted, pull zone 6715927 left disabled because the account was suspended).

## Live-tested behavior

### Standalone script as the pull zone origin (2026-09-30, `@bunny.net/astro-adapter` 0.1.0 on Astro 7.3.5)
- `POST /compute/script {Name, ScriptType: 1, CreateLinkedPullZone: false}` followed by `POST /pullzone {Name, OriginType: 4, EdgeScriptId}` gives a working script-origin zone. The script's `LinkedPullZones` then lists that zone.
- Defaults of that zone differ from a storage-origin zone: `CacheControlMaxAgeOverride -1`, `CacheControlPublicMaxAgeOverride -1`, `EnableSmartCache false`, `DisableCookies true`, `EnableCacheSlice false`, `IgnoreQueryStrings true`, `StorageZoneId -1`, `MiddlewareScriptId null`, `OriginUrl https://bunnycdn.com`, TLS 1.0 and 1.1 on.
- `POST /pullzone/{id} {DisableCookies, EnableSmartCache, CacheControlMaxAgeOverride}` updates those fields on a script-origin zone.
- The `POST /storagezone` response includes `Password`, `ReadOnlyPassword` and `StorageHostname`.
- Script responses carry `cdn-cache`. `public, max-age=60` was a HIT on the second request, `public, max-age=31536000, immutable` too, and `private, no-store` stayed a MISS.
- Nothing in the storage zone is public except what the script serves: `/.bunny-edge-deploy/state.json` and `/deploys/<id>/robots.txt` at the zone root returned 404 through the pull zone, and encoded traversal (`/%2e%2e/...`, `/..%2f...`) returned 400.
- Request headers seen by an Astro endpoint behind the adapter: `host` and `cdn-host` are the public hostname; `x-forwarded-for` and `x-real-ip` carry the client IP; plus `cdn-requestid`, `cdn-requestcountrycode`, `cdn-pullzoneid`, `cdn-serverzone`, `x-forwarded-proto`, `via`.
- A release id is an 8-character string (`sjSMbTEz`), not a UUID. `POST /compute/script/{id}/publish/{id}` makes an older release active again without creating a new one, and a `Note` sent with it is not stored.
- Rollback restores code and files together when each release names its own storage folder: after deploying a changed build to `deploys/<new>/` and publishing the previous release by id, the site served the old page and the old hashed CSS.
- `DELETE https://storage.bunnycdn.com/<zone>/deploys/<id>/` (trailing slash) deletes the folder and everything in it (200).

### Static site on a storage-origin pull zone with edge rules (2026-09-30, storage zone 1955601, pull zone 6716544, deleted)
- `POST /pullzone` accepts `CacheControlMaxAgeOverride: 2592000` and `CacheControlPublicMaxAgeOverride: 0` at creation. With them, HTML and other files answer `public, max-age=0`; an `OverrideBrowserCacheTime` (16) rule with `ActionParameter1: "31536000"` on Url `*/_astro/*` makes those answer `public, max-age=31536000` (no `immutable`).
- An `OriginStorage` (17) rule with `ActionParameter3: /deploys/<id>/` and trigger Url `*/deploys/*` with MatchNone serves `/about/` and `/about` both from `about/index.html` with 200, no redirect, nested paths too.
- `SetResponseHeader` (5) with six `ExtraActions` is accepted. Its headers reach the browser on MISS and HIT, and on redirect and 404 responses. A rule on Url `*://*/about` and `*://*/about/` adds its header to that page only.
- `Redirect` (1): `ActionParameter1` must be an absolute URL. `/about/` and `https://{{hostname}}/about/` are refused with 400 "The entered path is not a valid URL."; `%{Url.Scheme}://%{Url.Hostname}/…` is stored with `http://` in front. `https://%{Url.Hostname}/about/` works and redirects to the requested host. `ActionParameter2` sets the status (301 and 302 checked).
- The trigger `*://*/old` also matches `/x/old`. `pattern:^https?://[^/]+/gone/?$` matches `/gone` and `/gone/` only.
- `BlockRequest` (4) on `*/_headers`, `*/_redirects` and `*/deploys/*` answers 403.
- `POST /storagezone/{id} {Custom404FilePath: "/deploys/<id>/404.html", Rewrite404To200: false}` (204) made missing paths answer 404 with that page within 10 s.
- `addOrUpdate` with an existing rule's `Guid` updates it in place, and `DELETE /pullzone/{id}/edgerules/{Guid}` removes a rule (a removed redirect answered 404 right after the next publish).
- `SetResponseHeader` rules on `pattern:^https?://[^/]+/about/?$` style triggers gave each page its own CSP from `_headers`, alongside a rule on `*` with the headers every page shares.

### Active release and anchored triggers (2026-09-30, script 93341, storage zones 1955887, 1955890, 1955891, pull zones 6717078, 6717081, 6717084, deleted)
- `GET /compute/script/{id}/releases/active` returns the release's `Note` as sent with `POST /compute/script/{id}/publish`, its full `Code`, `Uuid` and `Status` 1; `CommitSha` is null. After republishing an older release by id, it returns that release with its original `Note` and code.
- `addOrUpdate` refuses a `pattern:` trigger that does not end in `$` with 400 `edgerule.invalid` "The trigger path is not a valid URL." (`pattern:^https?://[^/]+/deploys/` and `.../deploys/.*` both), for MatchAny and MatchNone alike. Ending it in `$` is accepted, which says nothing about how the rest of the pattern is read.
- An `OriginStorage` rule on `pattern:^https?://[^/]+/deploys/.*$` with MatchNone, plus a `BlockRequest` rule on the same pattern with MatchAny, serves `/` and `/docs/deploys/x/` from the deploy folder with 200 and answers 403 on `/deploys/` and `/deploys/<id>/index.html`.
- In a `pattern:` trigger, `%-` and `%.` match a literal `-` and `.`: `.../my%-page/?$` matched `/my-page/` and not `/mypage/`, and `.../file%.v2%.txt$` matched `/file.v2.txt` and not `/fileXv2Xtxt`.
- A script that was never published answers `GET /compute/script/{id}/releases/active` with 404 and an empty body, and `GET .../releases` with an empty `Items` list (script 93344, deleted).

### Loading an npm package at runtime instead of bundling it (2026-09-30, Shiki 4.4.3 behind `@bunny.net/astro-adapter`)
- A script that keeps `import ... from "npm:shiki@4.4.3"` (plus `/langs`, `/engine/oniguruma` and a dynamic `import("npm:shiki@4.4.3/wasm")`) instead of bundling Shiki boots and highlights code on Bunny. Grammars that the package loads with dynamic imports were fetched on first use at request time (js, python, rust, go, ruby, sql all rendered). The script stayed at 2.95 MB, where bundling Shiki made it 12.85 MB.
- The import runs when an isolate starts, so every route pays for it on a cold start: 15 requests to a cheap on-demand route took median 0.44 s and max 0.99 s, against median 0.27 s and max 0.30 s for the same site with Shiki left out.
- In the local Deno harness the first import took 846 ms while Deno downloaded the package and 37 ms once cached, so the startup probe fails on a fresh CI runner.

### A suspended account (2026-09-30, trial account without a verified card)
- `GET /user` reported `Suspended: true` in the middle of a test run, with no error from any API call before it.
- The pull zone then reported `Enabled: false` and answered 403, and Storage rejected the zone's own passwords with 401 on every path, so a deploy looks like a storage zone that is not ready yet.
- `DELETE /pullzone/{id}` returned 404 `pullZone.not_found` while `GET /pullzone/{id}` still returned the zone. Deleting the script and the storage zone still worked (204).

### SSR responses returned from `onOriginRequest`
- A new pull zone has `CacheControlMaxAgeOverride = 2592000`. With that default every script response is cached 30 days regardless of its Cache-Control, including `private` and `no-store`, and one visitor's cookie-personalized page was served to another.
- With `CacheControlMaxAgeOverride = -1` (and `CacheControlPublicMaxAgeOverride = -1`, the default) the origin header is respected:
  - `public, s-maxage=120`, `public, max-age=120`, `max-age=5, stale-while-revalidate=120`: cached (HIT on second request), header passed through unchanged.
  - `private`, `no-store`, `no-cache`, `public, max-age=0`: not cached (MISS every time).
  - no Cache-Control at all: Bunny adds `public, max-age=2592000` and caches for 30 days.
- `stale-while-revalidate` is not honored as async revalidation by itself. After `max-age` expiry the CDN re-renders synchronously (`cdn-cache: EXPIRED`). With the pull zone setting `UseStaleWhileUpdating = true` it serves `cdn-cache: STALE` and refreshes in the background.
- Cookies are never part of the cache key. Query strings are ignored in the cache key by default (`IgnoreQueryStrings = true`); with `false` each query string is a separate cache entry.
- A short-circuit response from `onOriginRequest` does not pass through `onOriginResponse`.
- Cache HITs never invoke the script (post-cache phase, `EdgeScriptExecutionPhase = 0`).
- Error responses from the script (404 with `max-age=120`) were not cached (`CacheErrorResponses = false` default).

### Static files from the storage zone origin
- Storage sends no Cache-Control. With the override at -1, Bunny serves storage files with `cache-control: max-age=25600000` (296 days) to the CDN and browsers. With the 30-day override it is `public, max-age=2592000`.
- Content-Type is sniffed from the extension when the upload had none (`.css` served as `text/css`, `.bin` as `application/octet-stream`).
- The middleware's `onOriginResponse` runs for storage responses on a cache MISS, so the script can rewrite Cache-Control for static files. The rewritten headers are what gets cached.
- Storage 404 passes through the middleware as a 404 with `cache-control: no-cache`; `onOriginResponse` can replace it with a full 200 response, which is then cached per its own Cache-Control.
- Latency on MISS from Amsterdam: render in `onOriginRequest` ~105 ms; storage 404 then render in `onOriginResponse` ~140 ms.

### Edge rules
- `OriginStorage` (ActionType 17, `ActionParameter1` = zone id, `ActionParameter2` = zone name, `ActionParameter3` = path prefix prepended to the request path) routes to storage but the middleware still runs. It cannot bypass the script.
- `RunEdgeScript` (ActionType 21) accepts a rule with `ActionParameter1` = script id but requests then return 401 `{"HttpCode":401,"Message":"Unauthorized"}`. Parameters are undocumented.
- Limits (docs): 50 rules per zone, 5 triggers per rule.

### Script size and startup
- `POST /compute/script/{id}/code` accepted 12 MB. Documented limit is 10 MB.
- Publish and serve: 2, 5, 8 MB (comment padding) boot reliably; 9.5 MB and 10.5 MB served the first request (15 s and 2.5 s) and then returned 400 on most requests.
- 2 MB of real functions: cold requests 460-520 ms, warm ~100 ms. 5 MB of real functions: cold 1.1-1.9 s, warm ~100 ms. Documented startup limit is 500 ms.
- A file bundled by esbuild from the npm SDK (bare import resolved, 12.8 KB, `--format=esm --platform=neutral`) runs on Bunny. The runtime also resolves `npm:` and `https://esm.sh/` specifiers at runtime.
- On the Bunny runtime `servePullZone()` calls `Bunny.v1.registerMiddlewares({ onOriginRequest: [...], onOriginResponse: [...] })`; standalone `serve()` calls `Bunny.v1.serve(handler)`. A local Deno harness that stubs `globalThis.Bunny` imports a 13 KB bundle in ~2-12 ms; a 320 KB bundle with a 10,000-path manifest in ~9 ms.
- Each cache MISS may hit a different isolate (boot id changed between consecutive requests).

### Node compatibility (probed from a deployed middleware script)
- Runtime reports Deno 2.7.12, V8 14.7, Node compat `process.version` v24.2.0.
- `node:` modules that import and pass a functional call: assert, async_hooks, buffer, console, crypto (createHash), diagnostics_channel, dns (resolve4 works), dns/promises, domain, events, fs and fs/promises (write and read under /tmp), http, http2, https, module, net, os (`linux`), path, path/posix, perf_hooks, process, punycode, querystring, readline, readline/promises, stream, stream/promises, stream/web, string_decoder, timers, timers/promises, tls, url, util, util/types, zlib (gzip round trip).
- Fail with "failed to resolve module": child_process, cluster, constants, dgram, inspector, repl, sys, trace_events, tty, v8, vm, wasi, worker_threads.
- Not tested: sea, sqlite, test. Globals present: Buffer, process, global, setImmediate, caches, HTMLRewriter, Deno, Bunny, WebSocket, URLPattern, CompressionStream, BroadcastChannel, WebAssembly, navigator; `crypto.subtle.digest` works.

### Environment variables and secrets
- API accepts values up to 4096 bytes and more than 128 variables, but the script then fails to boot and every request, including static files, returns 400 with an empty body.
- Effective boot limits: value ≤ 2048 bytes (2049 breaks), ≤ 128 variables (129 breaks). Secrets do not count toward the 128 (128 variables + 2 secrets boots).
- Changing a variable or secret takes effect without a republish, within ~10 s, on new isolates only. A running isolate kept the old value.
- Rollback via `POST /compute/script/{id}/publish/{uuid}` works and does not touch variables: values are script-level, not per release.
- Secrets cannot be read back (`GET /secrets` returns name and LastModified only). Variables can be read back.
- Endpoints: `PUT /compute/script/{id}/variables` upsert `{Name, DefaultValue, Required}` (200 created, 204 updated); `PUT /compute/script/{id}/secrets` upsert `{Name, Secret}`; `DELETE .../variables/{id}`, `DELETE .../secrets/{id}`. Names must be unique across both.

### Storage API
- Requires the zone `Password` as `AccessKey`; the account API key returns 401.
- `Checksum` upload header is uppercase hex SHA-256; mismatch returns 400.
- Directory listing returns `Checksum` = uppercase hex SHA-256 of the content (verified equal to a local hash) and `ContentType` empty. Listing is per directory, not recursive.
- A folder in a listing has `DateCreated` and `LastChanged` from when it was first created, in UTC without a zone suffix and with two or three decimals (`2026-09-30T08:37:34.39`). Uploading more files into it later changes neither (2026-09-30).
- Limits (docs): 100 concurrent connections per IP, 5 concurrent listings, 30 concurrent deletes, 6000-char paths.

### Other
- Compression: gzip, br and zstd are applied automatically to text responses based on Accept-Encoding; tiny bodies are left uncompressed. No pull zone field controls it.
- `POST /pullzone/{id}/setForceSSL {Hostname, ForceSSL}` on the system hostname makes http redirect 301 to https.
- Wildcard purge `POST /purge?url=https://host/assets/*` returns 200 and works. Docs rate limit: 30 prefix purges per minute, 300 exact purges per minute.
- Middleware attach: `POST /pullzone/{id} {MiddlewareScriptId}`. Detach uses `0` (CLI source; `null` is ignored and `-1` rejected).

## Defaults of a freshly created pull zone (storage origin, EU only requested)
`Type 0 (Standard)`, `CacheControlMaxAgeOverride 2592000`, `CacheControlPublicMaxAgeOverride -1`, `EnableSmartCache false`, `IgnoreQueryStrings true`, `EnableQueryStringOrdering true`, `DisableCookies true` (strips Set-Cookie), `EnableCookieVary false`, all Vary features false, `AddCanonicalHeader false`, `EnableAccessControlOriginHeader true` (auto CORS on 16 asset extensions), `CacheErrorResponses false`, `UseStaleWhileUpdating false`, `UseStaleWhileOffline false`, `EnableTLS1 true`, `EnableTLS1_1 true`, `TlsSecurityLevel 0`, `EnableOriginShield false`, `OptimizerEnabled false`, `PermaCacheStorageZoneId 0`, `EnableLogging true`, `LoggingIPAnonymizationEnabled true`, `LogAnonymizationType 0`, `MonthlyBandwidthLimit 0`, `EnableCacheSlice true`, `EnableWebSockets true`, `EdgeScriptExecutionPhase 0`, system hostname `<name>.b-cdn.net` with `ForceSSL false`, `RoutingFilters ["all"]`. The `EnableGeoZone*` flags in the create body were honored.

## Docs facts used
- Enums: `PullZoneType` 0 Premium (Standard) / 1 Volume; `OriginType` 2 StorageZone / 4 EdgeScript; `ExecutionPhase` 0 Cache / 2 PreCache; `StorageZoneTier` 0 Standard / 1 Edge; `LogAnonymizationType` 0 OneDigit / 1 Drop; `ScriptType` 1 CDN (standalone) / 2 Middleware.
- Storage regions: DE is documented as Frankfurt; Falkenstein appears only on stale OpenAPI pages. Standard tier regions: DE, UK, SE, NY, LA, SG, SYD, BR, ZA/JH. Replication regions cannot be removed after creation. Edge tier requires DE as primary and costs $0.02/GB vs $0.01/GB.
- Disabled pricing regions: "requests are automatically routed to the nearest enabled region".
- Volume tier PoPs: Frankfurt, Paris, Chicago, Dallas, Los Angeles, Miami, São Paulo, Hong Kong, Singapore, Tokyo. Standard tier includes Amsterdam. Standard EU $0.01/GB, Volume $0.005/GB.
- Add-on prices: Optimizer $9.50 per zone per month; Origin Shield free; Perma-Cache billed as storage and unavailable for storage origins; Edge Scripting $0.20 per million requests + $0.02 per 1000 s CPU, $0.22 minimum.
- Keys: one account API key, full access; no scoped keys documented. Scripts have a `DeploymentKey` for the `BunnyWay/actions/deploy-script` action, endpoint undocumented.
- Before-cache execution is GA (changelog 2026-09-10) and exposed in SDK 0.13.0-rc.0 as `onClientRequest`/`onClientResponse`; runs the script on every request.
- The CLI's experimental `bunny sites` provisions storage + pull zone and routes with `OriginStorage` edge rules to immutable `deploys/<id>/` directories, no middleware and no SSR.
