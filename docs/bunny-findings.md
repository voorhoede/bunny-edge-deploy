# Bunny.net findings (verified 2026-09-23)

Sources: official OpenAPI specs (`https://core-api-public-docs.b-cdn.net/docs/v3/public.json` and `compute.json`), docs at `bunny.net/docs` (docs.bunny.net redirects there), the `@bunny.net/edgescript-sdk` package, the Bunny CLI 0.16.1 binary, and live tests on throwaway resources (storage zone 1931485, pull zone 6671152, script 92103, all deleted afterwards).

## Live-tested behavior

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
- Limits (docs): 100 concurrent connections per IP, 5 concurrent listings, 30 concurrent deletes, 6000-char paths.

### Other
- Compression: gzip, br and zstd are applied automatically to text responses based on Accept-Encoding; tiny bodies are left uncompressed. No pull zone field controls it.
- `POST /pullzone/{id}/setForceSSL {Hostname, ForceSSL}` on the system hostname makes http redirect 301 to https.
- Wildcard purge `POST /purge?url=https://host/assets/*` returns 200 and works. Docs rate limit: 30 prefix purges per minute, 300 exact purges per minute.
- Middleware attach: `POST /pullzone/{id} {MiddlewareScriptId}`. Detach uses `0` (CLI source; `null` is ignored and `-1` rejected).

## Defaults of a freshly created pull zone (storage origin, EU only requested)
`Type 0 (Standard)`, `CacheControlMaxAgeOverride 2592000`, `CacheControlPublicMaxAgeOverride -1`, `EnableSmartCache false`, `IgnoreQueryStrings true`, `EnableQueryStringOrdering true`, `DisableCookies true` (strips Set-Cookie), `EnableCookieVary false`, all Vary features false, `AddCanonicalHeader false`, `EnableAccessControlOriginHeader true` (auto CORS on 16 asset extensions), `CacheErrorResponses false`, `UseStaleWhileUpdating false`, `UseStaleWhileOffline false`, `EnableTLS1 true`, `EnableTLS1_1 true`, `TlsSecurityLevel 0`, `EnableOriginShield false`, `OptimizerEnabled false`, `PermaCacheStorageZoneId 0`, `EnableLogging true`, `LoggingIPAnonymizationEnabled true`, `LogAnonymizationType 0`, `MonthlyBandwidthLimit 0`, `EnableCacheSlice true`, `EnableWebSockets true`, `EdgeScriptExecutionPhase 0`, system hostname `<name>.b-cdn.net` with `ForceSSL false`, `RoutingFilters ["all"]`. The `EnableGeoZone*` flags in the create body were honored.

## Docs facts used
- Enums: `PullZoneType` 0 Premium (Standard) / 1 Volume; `OriginType` 2 StorageZone; `ExecutionPhase` 0 Cache / 2 PreCache; `StorageZoneTier` 0 Standard / 1 Edge; `LogAnonymizationType` 0 OneDigit / 1 Drop; `ScriptType` 1 CDN (standalone) / 2 Middleware.
- Storage regions: DE is documented as Frankfurt; Falkenstein appears only on stale OpenAPI pages. Standard tier regions: DE, UK, SE, NY, LA, SG, SYD, BR, ZA/JH. Replication regions cannot be removed after creation. Edge tier requires DE as primary and costs $0.02/GB vs $0.01/GB.
- Disabled pricing regions: "requests are automatically routed to the nearest enabled region".
- Volume tier PoPs: Frankfurt, Paris, Chicago, Dallas, Los Angeles, Miami, São Paulo, Hong Kong, Singapore, Tokyo. Standard tier includes Amsterdam. Standard EU $0.01/GB, Volume $0.005/GB.
- Add-on prices: Optimizer $9.50 per zone per month; Origin Shield free; Perma-Cache billed as storage and unavailable for storage origins; Edge Scripting $0.20 per million requests + $0.02 per 1000 s CPU, $0.22 minimum.
- Keys: one account API key, full access; no scoped keys documented. Scripts have a `DeploymentKey` for the `BunnyWay/actions/deploy-script` action, endpoint undocumented.
- Before-cache execution is GA (changelog 2026-09-10) and exposed in SDK 0.13.0-rc.0 as `onClientRequest`/`onClientResponse`; runs the script on every request.
- The CLI's experimental `bunny sites` provisions storage + pull zone and routes with `OriginStorage` edge rules to immutable `deploys/<id>/` directories, no middleware and no SSR.
