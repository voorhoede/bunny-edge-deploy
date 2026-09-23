import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { smokeTest } from "./smoke.js";

function fetchWith(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const entry = responses[new URL(url).pathname] ?? {};
    const { status = 200, headers = {} } = Array.isArray(entry) ? entry.shift() : entry;
    return new Response("body", { status, headers });
  };
  return { fetch, calls };
}

const noWait = { sleep: async () => {}, retryForMs: 1000, now: (() => { let t = 0; return () => (t += 100); })() };

const cdn = (extra) => ({ "cdn-cache": "MISS", ...extra });

describe("smokeTest", () => {
  it("passes when the static file and the server route return 2xx through the CDN, reporting their cache-control", async () => {
    const { fetch, calls } = fetchWith({ "/assets/app.abc12345.js": { headers: cdn({ "cache-control": "public, max-age=31536000, immutable" }) }, "/": { headers: cdn({ "cache-control": "public, s-maxage=60" }) } });
    const result = await smokeTest({ hostname: "site.b-cdn.net", staticPath: "assets/app.abc12345.js", serverRoute: "/", fetch, ...noWait });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.checks[0].cacheControl, "public, max-age=31536000, immutable");
    assert.equal(result.checks[1].cacheControl, "public, s-maxage=60");
    assert.ok(calls.every((c) => c.init.cache === "no-store" && c.init.redirect === "manual"));
    assert.ok(calls.every((c) => new URL(c.url).search.startsWith("?bunny-edge-deploy-smoke=")));
  });

  it("fails on a non-2xx status and on a response that did not come through the CDN", async () => {
    const { fetch } = fetchWith({ "/assets/app.abc12345.js": { status: 404, headers: cdn() }, "/": { headers: {} } });
    const result = await smokeTest({ hostname: "site.b-cdn.net", staticPath: "assets/app.abc12345.js", serverRoute: "/", fetch, ...noWait });
    assert.match(result.errors[0], /assets\/app\.abc12345\.js.*404/);
    assert.match(result.errors[1], /\/.*cdn-cache/i);
  });

  it("warns when the server route carries Bunny's default cache header, since the app sent none", async () => {
    const { fetch } = fetchWith({ "/assets/app.abc12345.js": { headers: cdn({ "cache-control": "public, max-age=31536000" }) }, "/": { headers: cdn({ "cache-control": "public, max-age=2592000" }) } });
    const result = await smokeTest({ hostname: "site.b-cdn.net", staticPath: "assets/app.abc12345.js", serverRoute: "/", fetch, ...noWait });
    assert.deepEqual(result.errors, []);
    assert.match(result.warnings[0], /no Cache-Control.*30 days/);
  });

  it("retries 403, 5xx and network errors while the zone propagates, then passes", async () => {
    const { fetch, calls } = fetchWith({ "/assets/app.abc12345.js": [{ status: 403 }, { status: 502 }, { headers: cdn() }], "/": [{ headers: cdn({ "cache-control": "no-store" }) }] });
    let failures = 2;
    const flaky = async (url, init) => { if (new URL(url).pathname === "/" && failures-- > 0) throw new TypeError("fetch failed"); return fetch(url, init); };
    const result = await smokeTest({ hostname: "site.b-cdn.net", staticPath: "assets/app.abc12345.js", serverRoute: "/", fetch: flaky, ...noWait });
    assert.deepEqual(result.errors, []);
    assert.equal(calls.length, 4);
  });

  it("gives up retrying after the deadline and reports the last status", async () => {
    const { fetch } = fetchWith({ "/assets/app.abc12345.js": { status: 403 }, "/": { headers: cdn() } });
    const result = await smokeTest({ hostname: "site.b-cdn.net", staticPath: "assets/app.abc12345.js", serverRoute: "/", fetch, ...noWait });
    assert.match(result.errors[0], /403.*after retrying/);
  });
});
