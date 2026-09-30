import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeServerEntry, probeServerEntry } from "./server-entry.js";

async function entryFile(source) {
  const dir = await mkdtemp(join(tmpdir(), "bed-"));
  const path = join(dir, "server.js");
  await writeFile(path, source);
  return path;
}

const ok = `import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.12.1";
BunnySDK.net.http.serve(async () => new Response("ok"));
`;

describe("analyzeServerEntry static checks", () => {
  it("passes a self-contained standalone script", async () => {
    const result = await analyzeServerEntry({ path: await entryFile(ok), sizeLimit: 8 * 1024 * 1024 });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.size, Buffer.byteLength(ok));
  });

  it("errors when the file is missing", async () => {
    const result = await analyzeServerEntry({ path: "/nope/server.js", sizeLimit: 8 * 1024 * 1024 });
    assert.match(result.errors[0], /not found/);
  });

  it("errors on relative imports, since they are not bundled", async () => {
    const source = `import { render } from "./render.js";\nexport * from "./x.js";\n${ok}`;
    const { errors } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.filter((e) => /relative import/.test(e)).length, 2);
    assert.match(errors[0], /\.\/render\.js/);
  });

  it("does not read import() out of comments, as Astro's bundled code has them in JSDoc", async () => {
    const source = `/** The inverse of {@link import('./data-store-writer.js').ChunkedWriter}. */\n// import("./chunk.js")\n${ok}`;
    const { errors } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.deepEqual(errors, []);
  });

  it("errors on bare package imports, allows npm:, https: and node: modules verified on the runtime", async () => {
    const source = `import react from "react";\nimport fs from "node:fs/promises";\nimport { createHash } from "node:crypto";\nimport zlib from "node:zlib";\nimport sdk from "https://esm.sh/@bunny.net/edgescript-sdk@0.12.1";\n${ok}`;
    const { errors, warnings } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bare import "react"/);
    assert.deepEqual(warnings, []);
  });

  it("errors on node: modules that do not resolve on the runtime and warns on unverified ones", async () => {
    const source = `import { execSync } from "node:child_process";\nimport { DatabaseSync } from "node:sqlite";\n${ok}`;
    const { errors, warnings } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /node:child_process.*does not resolve/);
    assert.match(warnings[0], /node:sqlite.*not been verified/);
  });

  it("ignores import-like text inside strings and comments, and reports syntax errors", async () => {
    const source = `const s = 'import x from "fake"';\n/* import y from "./z.js" */\n${ok}`;
    const clean = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.deepEqual(clean.errors, []);
    const broken = await analyzeServerEntry({ path: await entryFile(`import { from "broken"`), sizeLimit: 1e7 });
    assert.match(broken.errors[0], /syntax error/i);
  });

  it("accepts a TypeScript entry by stripping types before parsing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bed-"));
    const path = join(dir, "server.ts");
    await writeFile(path, `const routes: Record<string, string> = {};\nexport type Ctx = { request: Request };\n${ok}`);
    const result = await analyzeServerEntry({ path, sizeLimit: 1e7 });
    assert.deepEqual(result.errors, []);
  });

  it("passes CommonJS dependencies that esbuild wrapped into the ES module", async () => {
    const source = `var __commonJS = (cb, mod) => () => (mod || cb[Object.keys(cb)[0]]((mod = { exports: {} }).exports, mod), mod.exports);\nvar require_extend = __commonJS({ "node_modules/extend/index.js"(exports, module) { module.exports = function extend() {}; } });\n${ok}`;
    const { errors } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.deepEqual(errors, []);
  });

  it("errors above the size limit and warns above the cold start threshold", async () => {
    const big = ok + "// " + "x".repeat(3 * 1024 * 1024) + "\n";
    const over = await analyzeServerEntry({ path: await entryFile(big), sizeLimit: 2 * 1024 * 1024 });
    assert.match(over.errors[0], /3\.0 MB.*limit.*2\.0 MB/);
    const warned = await analyzeServerEntry({ path: await entryFile(big), sizeLimit: 8 * 1024 * 1024, coldStartWarnSize: 2 * 1024 * 1024 });
    assert.deepEqual(warned.errors, []);
    assert.match(warned.warnings[0], /cold start/);
  });
});

const denoAvailable = await hasDeno();

describe("probeServerEntry runtime probe", () => {
  it("reports import time and the registered serve handler from the Deno harness", { skip: !denoAvailable }, async () => {
    const source = `globalThis.Bunny.v1.serve(() => new Response("hi"));`;
    const result = await probeServerEntry({ path: await entryFile(source), startupLimitMs: 500 });
    assert.equal(result.skipped, false);
    assert.ok(result.importMs >= 0 && result.importMs < 500);
    assert.deepEqual(result.registered, { serve: 1 });
    assert.deepEqual(result.errors, []);
  });

  it("resolves npm: specifiers, so the real SDK registers its handler", { skip: !denoAvailable }, async () => {
    const real = await probeServerEntry({ path: await entryFile(ok), startupLimitMs: 5000 });
    assert.deepEqual(real.errors, []);
    assert.equal(real.registered.serve, 1);
  });

  it("errors when the file throws on import or serves no requests, as a middleware script does", { skip: !denoAvailable }, async () => {
    const result = await probeServerEntry({ path: await entryFile(`throw new Error("boom")`), startupLimitMs: 500 });
    assert.match(result.errors[0], /boom/);
    const middleware = await probeServerEntry({ path: await entryFile(`globalThis.Bunny.v1.registerMiddlewares({ onOriginRequest: [async (ctx) => ctx.request], onOriginResponse: [] });`), startupLimitMs: 500 });
    assert.match(middleware.errors[0], /no request handler.*serve/);
  });

  it("errors when the script is CommonJS, which fails as soon as it is imported", { skip: !denoAvailable }, async () => {
    const result = await probeServerEntry({ path: await entryFile(`module.exports = function handler() {};`), startupLimitMs: 500 });
    assert.match(result.errors[0], /module is not defined/);
  });

  it("is skipped with a notice when deno is not installed", async () => {
    const result = await probeServerEntry({ path: "/x.js", startupLimitMs: 500, deno: "/definitely/not/deno" });
    assert.equal(result.skipped, true);
    assert.match(result.notice, /deno/i);
  });
});

async function hasDeno() {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => execFile("deno", ["--version"], (error) => resolve(!error)));
}
