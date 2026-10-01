import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeScript, probeScript } from "./script.js";

async function entryFile(source) {
  const dir = await mkdtemp(join(tmpdir(), "bed-"));
  const path = join(dir, "server.js");
  await writeFile(path, source);
  return path;
}

const ok = `import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.12.1";
BunnySDK.net.http.serve(async () => new Response("ok"));
`;

describe("analyzeScript static checks", () => {
  it("passes a self-contained standalone script", async () => {
    const result = await analyzeScript({ path: await entryFile(ok), sizeLimit: 8 * 1024 * 1024 });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.size, Buffer.byteLength(ok));
  });

  it("errors when the file is missing", async () => {
    const result = await analyzeScript({ path: "/nope/server.js", sizeLimit: 8 * 1024 * 1024 });
    assert.match(result.errors[0], /not found/);
  });

  it("errors on relative imports, since they are not bundled", async () => {
    const source = `import { render } from "./render.js";\nexport * from "./x.js";\n${ok}`;
    const { errors } = await analyzeScript({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.filter((e) => /relative import/.test(e)).length, 2);
    assert.match(errors[0], /\.\/render\.js/);
  });

  it("does not read import() out of comments, as Astro's bundled code has them in JSDoc", async () => {
    const source = `/** The inverse of {@link import('./data-store-writer.js').ChunkedWriter}. */\n// import("./chunk.js")\n${ok}`;
    const { errors } = await analyzeScript({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.deepEqual(errors, []);
  });

  it("errors on bare package imports, allows npm:, https: and node: modules verified on the runtime", async () => {
    const source = `import react from "react";\nimport fs from "node:fs/promises";\nimport { createHash } from "node:crypto";\nimport zlib from "node:zlib";\nimport sdk from "https://esm.sh/@bunny.net/edgescript-sdk@0.12.1";\n${ok}`;
    const { errors, warnings } = await analyzeScript({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bare import "react"/);
    assert.deepEqual(warnings, []);
  });

  it("errors on node: modules that do not resolve on the runtime and warns on unverified ones", async () => {
    const source = `import { execSync } from "node:child_process";\nimport { DatabaseSync } from "node:sqlite";\n${ok}`;
    const { errors, warnings } = await analyzeScript({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /node:child_process.*does not resolve/);
    assert.match(warnings[0], /node:sqlite.*not been verified/);
  });

  it("ignores import-like text inside strings and comments, and reports syntax errors", async () => {
    const source = `const s = 'import x from "fake"';\n/* import y from "./z.js" */\n${ok}`;
    const clean = await analyzeScript({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.deepEqual(clean.errors, []);
    const broken = await analyzeScript({ path: await entryFile(`import { from "broken"`), sizeLimit: 1e7 });
    assert.match(broken.errors[0], /syntax error/i);
  });

  it("accepts a TypeScript entry by stripping types before parsing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bed-"));
    const path = join(dir, "server.ts");
    await writeFile(path, `const routes: Record<string, string> = {};\nexport type Ctx = { request: Request };\n${ok}`);
    const result = await analyzeScript({ path, sizeLimit: 1e7 });
    assert.deepEqual(result.errors, []);
  });

  it("passes CommonJS dependencies that esbuild wrapped into the ES module", async () => {
    const source = `var __commonJS = (cb, mod) => () => (mod || cb[Object.keys(cb)[0]]((mod = { exports: {} }).exports, mod), mod.exports);\nvar require_extend = __commonJS({ "node_modules/extend/index.js"(exports, module) { module.exports = function extend() {}; } });\n${ok}`;
    const { errors } = await analyzeScript({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.deepEqual(errors, []);
  });

  it("errors above the size limit and warns above the cold start threshold", async () => {
    const big = ok + "// " + "x".repeat(3 * 1024 * 1024) + "\n";
    const over = await analyzeScript({ path: await entryFile(big), sizeLimit: 2 * 1024 * 1024 });
    assert.match(over.errors[0], /3\.0 MB.*limit.*2\.0 MB/);
    const warned = await analyzeScript({ path: await entryFile(big), sizeLimit: 8 * 1024 * 1024, coldStartWarnSize: 2 * 1024 * 1024 });
    assert.deepEqual(warned.errors, []);
    assert.match(warned.warnings[0], /cold start/);
  });
});

const denoAvailable = await hasDeno();

describe("probeScript runtime probe", () => {
  it("reports import time and the registered serve handler from the Deno harness", { skip: !denoAvailable }, async () => {
    const source = `globalThis.Bunny.v1.serve(() => new Response("hi"));`;
    const result = await probeScript({ path: await entryFile(source), startupLimitMs: 500 });
    assert.equal(result.skipped, false);
    assert.ok(result.importMs >= 0 && result.importMs < 500);
    assert.deepEqual(result.registered, { serve: 1 });
    assert.deepEqual(result.errors, []);
  });

  it("resolves npm: specifiers, so the real SDK registers its handler", { skip: !denoAvailable }, async () => {
    const real = await probeScript({ path: await entryFile(ok), startupLimitMs: 5000 });
    assert.deepEqual(real.errors, []);
    assert.equal(real.registered.serve, 1);
  });

  it("errors when the file throws on import or serves no requests, as a middleware script does", { skip: !denoAvailable }, async () => {
    const result = await probeScript({ path: await entryFile(`throw new Error("boom")`), startupLimitMs: 500 });
    assert.match(result.errors[0], /boom/);
    const middleware = await probeScript({ path: await entryFile(`globalThis.Bunny.v1.registerMiddlewares({ onOriginRequest: [async (ctx) => ctx.request], onOriginResponse: [] });`), startupLimitMs: 500 });
    assert.match(middleware.errors[0], /no request handler.*serve/);
  });

  it("errors when the script is CommonJS, which fails as soon as it is imported", { skip: !denoAvailable }, async () => {
    const result = await probeScript({ path: await entryFile(`module.exports = function handler() {};`), startupLimitMs: 500 });
    assert.match(result.errors[0], /module is not defined/);
  });

  it("is skipped with a notice when deno is not installed", async () => {
    const result = await probeScript({ path: "/x.js", startupLimitMs: 500, deno: "/definitely/not/deno" });
    assert.equal(result.skipped, true);
    assert.match(result.notice, /deno/i);
  });
});

// Stands in for deno, so the probe's handling of the harness can be tested without it.
async function fakeDeno(script) {
  const dir = await mkdtemp(join(tmpdir(), "bed-fake-deno-"));
  const path = join(dir, "deno");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("probeScript harness handling", () => {
  it("measures the second of two imports, since the first may download npm: packages", async () => {
    const deno = await fakeDeno(`count="$(dirname "$0")/count"; n=$(cat "$count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$count"
if [ "$n" -eq 1 ]; then echo '{"importMs":900,"registered":{"serve":1}}'; else echo '{"importMs":40,"registered":{"serve":1}}'; fi`);
    const result = await probeScript({ path: "/x.js", startupLimitMs: 500, deno });
    assert.equal(result.importMs, 40);
    assert.deepEqual(result.errors, []);
  });

  it("reports a harness that printed nothing, with what it wrote to stderr", async () => {
    const deno = await fakeDeno(`echo "boom from deno" >&2`);
    const result = await probeScript({ path: "/x.js", startupLimitMs: 500, deno });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /printed nothing.*boom from deno/);
  });

  it("gives up on a harness that does not finish within the timeout", async () => {
    const deno = await fakeDeno("sleep 5");
    const result = await probeScript({ path: "/x.js", startupLimitMs: 500, deno, timeoutMs: 200 });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /did not finish within 0\.2 s/);
  });
});

async function hasDeno() {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => execFile("deno", ["--version"], (error) => resolve(!error)));
}
