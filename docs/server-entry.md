# What the server entry must look like

The action deploys `server-entry` unchanged as the code of a Bunny Edge Scripting **middleware** script attached to the pull zone. It does not bundle, transform or wrap it. Whoever builds the file, usually a framework adapter, owns everything below.

## Shape

One self-contained ESM file, JavaScript or TypeScript. Bunny's runtime is Deno based and resolves `npm:` and `https:` specifiers at run time, so these are allowed; bundling the SDK with esbuild works too. Relative imports and bare package names are not allowed, because nothing else is uploaded.

```js
import * as BunnySDK from "@bunny.net/edgescript-sdk";

BunnySDK.net.http
  .servePullZone()
  .onOriginRequest(async ({ request }) => {
    const url = new URL(request.url);
    if (isStaticPath(url.pathname)) return request;
    return render(request);
  })
  .onOriginResponse(async ({ request, response }) => {
    if (response.status === 404 && !isStaticPath(new URL(request.url).pathname)) return render(request);
    return withStaticHeaders(request, response);
  });
```

The SDK is `@bunny.net/edgescript-sdk`. On Bunny, `servePullZone()` registers the middleware through the `Bunny.v1` global; locally it starts an HTTP server on port 8080 that proxies to the `url` option.

## When the script runs

- A cache hit never reaches the script.
- On a cache miss, `onOriginRequest` runs first. Returning the request (or a modified one) sends it to the storage zone. Returning a `Response` short-circuits: the response goes to the client and into the cache according to its `Cache-Control`, and `onOriginResponse` does not run for it.
- `onOriginResponse` runs for every storage response on a miss, including 404s. It may return a replacement response, which is cached according to its own `Cache-Control`. Rendering here instead of in `onOriginRequest` costs one extra storage round trip, about 35 ms measured from Amsterdam.

## Responsibilities

**Routing.** The adapter knows which paths are static because it produced them. Pass those through, render the rest. A storage 404 fallback in `onOriginResponse` covers paths outside the manifest.

**Cache-Control on rendered responses.** Bunny follows the header exactly. A response without one is cached for 30 days, and cookies are not part of the cache key, so every personalized response must carry `private` or `no-store`.

**Cache-Control on static files.** Storage sends none, and Bunny then serves the file with `max-age=25600000`. Set the header in `onOriginResponse`, for example `public, max-age=31536000, immutable` for hashed assets and `public, max-age=0, must-revalidate` for HTML. This is the only place that can set per-file headers; storage has no file metadata.

**Configuration.** Read variables and secrets with `process.env.NAME` (from `node:process`) or `Deno.env.get("NAME")`. Values are read when the isolate starts; a change made through the action reaches new isolates within about 10 seconds without a republish.

## What the compatibility check enforces

Errors fail the workflow before anything is uploaded:

- file missing, syntax error, or larger than `script-size-limit-mb` (default 8 MB);
- relative imports, bare package imports, `require(`, `module.exports`, `__dirname`, `__filename`;
- no `servePullZone(...).onOriginRequest(...)` in the source;
- when Deno is on the PATH: importing the file in a harness with a stubbed `Bunny` global throws, registers no request middleware, or takes longer than `startup-limit-ms` (default 500 ms). This is a local approximation of Bunny's startup limit.

- `node:` modules that do not resolve on the runtime: child_process, cluster, constants, dgram, inspector, repl, sys, trace_events, tty, v8, vm, wasi, worker_threads.

Warnings: larger than 2 MB (cold starts measured at 0.5 s and up), and `node:` modules not yet verified on the runtime (sea, sqlite, test).

## Node modules verified on the runtime

Imported from a deployed script on Deno 2.7 with Node compat reporting v24.2: assert, async_hooks, buffer, console, crypto, diagnostics_channel, dns, dns/promises, domain, events, fs, fs/promises, http, http2, https, module, net, os, path, path/posix, perf_hooks, process, punycode, querystring, readline, readline/promises, stream, stream/promises, stream/web, string_decoder, timers, timers/promises, tls, url, util, util/types, zlib. Globals present: Buffer, process, caches, HTMLRewriter, WebSocket, URLPattern, CompressionStream, WebAssembly, crypto.subtle. Bunny only documents process, fs, fs/promises and tls, so treat the rest as observed rather than promised.

## Runtime limits

From Bunny's docs unless marked verified: 30 s CPU per request, 128 MB memory, 50 subrequests, 500 ms startup. Verified: scripts of 9.5 MB and up fail to boot reliably; more than 128 variables or a value over 2048 bytes makes the script fail to boot, after which every request returns 400.
