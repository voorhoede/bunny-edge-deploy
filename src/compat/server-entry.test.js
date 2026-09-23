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
BunnySDK.net.http.servePullZone().onOriginRequest(async (ctx) => ctx.request);
`;

describe("analyzeServerEntry static checks", () => {
  it("passes a self-contained middleware file", async () => {
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
    const source = `import { render } from "./render.js";\nimport("../chunk.js");\nexport * from "./x.js";\n${ok}`;
    const { errors } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.filter((e) => /relative import/.test(e)).length, 3);
    assert.match(errors[0], /\.\/render\.js/);
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

  it("errors on CommonJS constructs", async () => {
    const source = `const x = require("x");\nconsole.log(__dirname, __filename);\nmodule.exports = 1;\n${ok}`;
    const { errors } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.equal(errors.filter((e) => /CommonJS/.test(e)).length, 4);
  });

  it("errors when no middleware registration is visible in the source", async () => {
    const source = `import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.12.1";\nBunnySDK.net.http.serve(() => new Response("hi"));\n`;
    const { errors } = await analyzeServerEntry({ path: await entryFile(source), sizeLimit: 1e7 });
    assert.match(errors[0], /servePullZone.*onOriginRequest/);
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
  it("reports import time and registered hooks from the Deno harness", { skip: !denoAvailable }, async () => {
    const source = `globalThis.Bunny.v1.registerMiddlewares({ onOriginRequest: [async (ctx) => ctx.request], onOriginResponse: [] });`;
    const result = await probeServerEntry({ path: await entryFile(source), startupLimitMs: 500 });
    assert.equal(result.skipped, false);
    assert.ok(result.importMs >= 0 && result.importMs < 500);
    assert.deepEqual(result.registered, { onOriginRequest: 1, onOriginResponse: 0 });
    assert.deepEqual(result.errors, []);
  });

  it("counts handlers the SDK pushes after registering its arrays, and resolves npm: specifiers", { skip: !denoAvailable }, async () => {
    const sdkLike = `const requests = []; globalThis.Bunny.v1.registerMiddlewares({ onOriginRequest: requests, onOriginResponse: [] }); requests.push(async (ctx) => ctx.request);`;
    const result = await probeServerEntry({ path: await entryFile(sdkLike), startupLimitMs: 500 });
    assert.deepEqual(result.registered, { onOriginRequest: 1, onOriginResponse: 0 });
    const real = await probeServerEntry({ path: await entryFile(ok), startupLimitMs: 5000 });
    assert.deepEqual(real.errors, []);
    assert.equal(real.registered.onOriginRequest, 1);
  });

  it("errors when the file throws on import or registers no request hook", { skip: !denoAvailable }, async () => {
    const result = await probeServerEntry({ path: await entryFile(`throw new Error("boom")`), startupLimitMs: 500 });
    assert.match(result.errors[0], /boom/);
    const none = await probeServerEntry({ path: await entryFile(`globalThis.Bunny.v1.serve(() => new Response(""))`), startupLimitMs: 500 });
    assert.match(none.errors[0], /onOriginRequest/);
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
