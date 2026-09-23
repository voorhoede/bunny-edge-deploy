import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./run.js";

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "bed-run-"));
  await mkdir(join(dir, "client/assets"), { recursive: true });
  await writeFile(join(dir, "client/index.html"), "<h1>");
  await writeFile(join(dir, "client/assets/app.abc12345.js"), "js");
  await writeFile(join(dir, "server.js"), `import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.12.1";\nBunnySDK.net.http.servePullZone().onOriginRequest(async (ctx) => ctx.request);\n`);
  return dir;
}

function harness({ inputs = {} } = {}) {
  const calls = [];
  const lines = [];
  const outputs = {};
  const actions = {
    mask: (v) => lines.push(`mask:${v}`), info: (m) => lines.push(m), warning: (m) => lines.push(`warning:${m}`), error: (m) => lines.push(`error:${m}`),
    group: async (name, fn) => { lines.push(`group:${name}`); return fn(); }, setOutput: async (k, v) => { outputs[k] = v; }, summary: async (md) => lines.push(`summary:${md.length}`),
  };
  const deps = {
    provision: async (args) => { calls.push(["provision", args.config]); return { storageZone: { Id: 1, Name: "n", Password: "pw", StorageHostname: "storage.bunnycdn.com" }, script: { Id: 2 }, pullZone: { Id: 3 }, hostname: "n.b-cdn.net", created: ["storage zone n"], drift: [], warnings: [] }; },
    deploy: async (args) => { calls.push(["deploy", { environment: args.environment, keepStaleDeploys: args.keepStaleDeploys, purge: args.purge }]); return { uploaded: ["index.html"], unchanged: [], stale: [], removed: [], release: "rel", environment: { variables: { added: ["A"], changed: [], unchanged: [] }, secrets: { added: ["S"], updated: [] }, notInInput: { variables: [], secrets: [] } }, smoke: { checks: [], errors: [], warnings: [] } }; },
    probeServerEntry: async () => ({ skipped: true, notice: "deno missing", errors: [] }),
    createBunnyApi: () => ({}),
    createStorageClient: () => ({}),
  };
  return { actions, deps, calls, lines, outputs };
}

describe("run", () => {
  it("masks secrets first, checks compatibility, provisions, deploys and sets outputs", async () => {
    const dir = await project();
    const { actions, deps, calls, lines, outputs } = harness();
    const inputs = { "client-dir": join(dir, "client"), "server-entry": join(dir, "server.js"), "bunny-api-key": "key", env: "A=1", secrets: "S=topsecret", name: "my-site" };
    await run({ inputs, actions, ...deps });
    assert.equal(lines[0], "mask:key");
    assert.equal(lines[1], "mask:topsecret");
    assert.equal(calls[0][0], "provision");
    assert.deepEqual(calls[0][1], { storageZoneName: "my-site", pullZoneName: "my-site", scriptName: "my-site", storageRegion: "DE", storageTier: "standard", replicationRegions: [], pricingTier: "standard", pricingRegions: ["EU"], staleWhileUpdating: false, monthlyBandwidthLimit: 0 });
    assert.equal(calls[1][0], "deploy");
    assert.deepEqual(calls[1][1].environment, { variables: [{ name: "A", value: "1" }], secrets: [{ name: "S", value: "topsecret" }] });
    assert.deepEqual(outputs, { hostname: "n.b-cdn.net", release: "rel", "pull-zone-id": "3", "storage-zone-id": "1", "script-id": "2" });
    assert.ok(!lines.filter((l) => !l.startsWith("mask:")).join("\n").includes("topsecret"));
  });

  it("fails before provisioning when the compatibility check finds errors, listing each problem", async () => {
    const dir = await project();
    await writeFile(join(dir, "server.js"), `import x from "./local.js";\n`);
    const { actions, deps, calls, lines } = harness();
    const inputs = { "client-dir": join(dir, "client"), "server-entry": join(dir, "server.js"), "bunny-api-key": "key", env: "A=1\nA=2" };
    await assert.rejects(run({ inputs, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*relative import/.test(l)));
    assert.ok(lines.some((l) => /error:.*"A" is defined more than once/.test(l)));
  });

  it("derives the resource name from the repository when no name is given", async () => {
    const dir = await project();
    const { actions, deps, calls } = harness();
    const inputs = { "client-dir": join(dir, "client"), "server-entry": join(dir, "server.js"), "bunny-api-key": "key" };
    await run({ inputs, actions, env: { GITHUB_REPOSITORY: "voorhoede/My_Site.v2" }, ...deps });
    assert.equal(calls[0][1].pullZoneName, "my-site-v2");
  });

  it("passes the size limit, retention, purge mode and overrides through", async () => {
    const dir = await project();
    const { actions, deps, calls } = harness();
    const inputs = { "client-dir": join(dir, "client"), "server-entry": join(dir, "server.js"), "bunny-api-key": "key", name: "s", "pull-zone-name": "cdn-s", "keep-stale-deploys": 5, purge: "targeted", "cache-tag": "ssr", "pricing-regions": ["EU", "US"], "replication-regions": ["UK"], "monthly-bandwidth-limit-gb": 100 };
    await run({ inputs, actions, ...deps });
    assert.equal(calls[0][1].pullZoneName, "cdn-s");
    assert.equal(calls[0][1].storageZoneName, "s");
    assert.deepEqual(calls[0][1].replicationRegions, ["UK"]);
    assert.equal(calls[0][1].monthlyBandwidthLimit, 100 * 1000 ** 3);
    assert.equal(calls[1][1].keepStaleDeploys, 5);
    assert.equal(calls[1][1].purge, "targeted");
  });
});
