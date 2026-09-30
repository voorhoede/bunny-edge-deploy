import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./run.js";

const requiredEnv = [
  { name: "BUNNY_STORAGE_ZONE" },
  { name: "BUNNY_STORAGE_HOST" },
  { name: "BUNNY_STORAGE_KEY", secret: true },
  { name: "BUNNY_API_KEY", secret: true, optional: true },
];

async function staticProject(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bed-run-static-"));
  await mkdir(join(dir, ".bunny"));
  await mkdir(join(dir, "dist/client"), { recursive: true });
  await writeFile(join(dir, "dist/client/index.html"), "<h1>");
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, "dist/client", path), content);
  await writeFile(join(dir, ".bunny/build.json"), JSON.stringify({ manifestVersion: 1, adapter: { package: "@bunny.net/astro-adapter" }, framework: { name: "astro" }, kind: "static", assets: { dir: "dist/client" } }));
  return join(dir, ".bunny/build.json");
}

async function project({ env = requiredEnv, script = `import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.12.1";\nBunnySDK.net.http.serve(async () => new Response("ok"));\n` } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bed-run-"));
  await mkdir(join(dir, ".bunny"));
  await mkdir(join(dir, "dist/client/_astro"), { recursive: true });
  await writeFile(join(dir, "dist/client/index.html"), "<h1>");
  await writeFile(join(dir, "dist/client/_astro/app.DFbA8egk.css"), "css");
  await writeFile(join(dir, "dist/index.js"), script);
  const manifest = { manifestVersion: 1, adapter: { package: "@bunny.net/astro-adapter" }, framework: { name: "astro" }, kind: "ssr", script: { entry: "dist/index.js", type: "standalone" }, assets: { dir: "dist/client" }, requires: { pullZone: { disableCookies: false, enableSmartCache: false }, env } };
  await writeFile(join(dir, ".bunny/build.json"), JSON.stringify(manifest));
  return join(dir, ".bunny/build.json");
}

function harness() {
  const calls = [];
  const lines = [];
  const outputs = {};
  const actions = {
    mask: (v) => lines.push(`mask:${v}`), info: (m) => lines.push(m), warning: (m) => lines.push(`warning:${m}`), error: (m) => lines.push(`error:${m}`),
    group: async (name, fn) => { lines.push(`group:${name}`); return fn(); }, setOutput: async (k, v) => { outputs[k] = v; }, summary: async (md) => lines.push(`summary:${md.length}`),
  };
  const deps = {
    provision: async (args) => {
      calls.push(["provision", { config: args.config, pullZoneRequirements: args.pullZoneRequirements }]);
      return { storageZone: { Id: 1, Name: "n", Password: "rw-pw", ReadOnlyPassword: "ro-pw", StorageHostname: "storage.bunnycdn.com" }, script: { Id: 2 }, pullZone: { Id: 3 }, hostname: "n.b-cdn.net", created: ["storage zone n"], updated: ["pull zone n: DisableCookies true -> false"], drift: [], warnings: [] };
    },
    deploy: async (args) => {
      calls.push(["deploy", { environment: args.environment, site: args.site, manifest: args.manifest, keepDeploys: args.keepDeploys }]);
      return { deployId: "689f0795086f", uploaded: ["index.html"], unchanged: [], pruned: [], release: "sjSMbTEz", environment: { variables: { added: ["A"], changed: [], unchanged: [] }, secrets: { added: ["S"], updated: [] }, notInInput: { variables: [], secrets: [] } }, smoke: { checks: [], errors: [], warnings: [] } };
    },
    provisionStatic: async (args) => {
      calls.push(["provisionStatic", { config: args.config }]);
      return { storageZone: { Id: 1, Name: "n", Password: "rw-pw", ReadOnlyPassword: "ro-pw", StorageHostname: "storage.bunnycdn.com" }, pullZone: { Id: 3 }, hostname: "n.b-cdn.net", created: [], updated: [], drift: [], warnings: [] };
    },
    deployStatic: async (args) => {
      calls.push(["deployStatic", { manifest: args.manifest, storageZone: args.storageZone, keepDeploys: args.keepDeploys }]);
      return { deployId: "5e11111e1824", uploaded: ["index.html"], unchanged: [], pruned: [], confirmed: true, smoke: { checks: [], errors: [], warnings: [] } };
    },
    probeServerEntry: async () => ({ skipped: true, notice: "deno missing", errors: [] }),
    createBunnyApi: () => ({}),
    createStorageClient: () => ({}),
  };
  return { actions, deps, calls, lines, outputs };
}

describe("run", () => {
  it("masks secrets, reads the manifest, provisions with the build's pull zone requirements, deploys with platform and workflow variables, and sets outputs", async () => {
    const path = await project();
    const { actions, deps, calls, lines, outputs } = harness();
    const inputs = { "build-manifest": path, "bunny-api-key": "key", env: "A=1", secrets: "S=topsecret", name: "my-site" };
    await run({ inputs, actions, ...deps });
    assert.deepEqual(lines.slice(0, 2), ["mask:key", "mask:topsecret"]);
    assert.ok(lines.includes("mask:rw-pw") && lines.includes("mask:ro-pw"));
    assert.equal(calls[0][0], "provision");
    assert.deepEqual(calls[0][1].config, { storageZoneName: "my-site", pullZoneName: "my-site", scriptName: "my-site", storageRegion: "DE", storageTier: "standard", replicationRegions: [], pricingTier: "standard", pricingRegions: ["EU"], staleWhileUpdating: false, monthlyBandwidthLimit: 0 });
    assert.deepEqual(calls[0][1].pullZoneRequirements, { disableCookies: false, enableSmartCache: false });
    assert.ok(lines.some((l) => /updated pull zone n: DisableCookies true -> false/.test(l)));
    assert.equal(calls[1][0], "deploy");
    assert.equal(calls[1][1].site, "my-site");
    assert.equal(calls[1][1].keepDeploys, 3);
    assert.equal(calls[1][1].manifest.kind, "ssr");
    assert.deepEqual(calls[1][1].environment, {
      variables: [{ name: "BUNNY_STORAGE_ZONE", value: "n" }, { name: "BUNNY_STORAGE_HOST", value: "storage.bunnycdn.com" }, { name: "A", value: "1" }],
      secrets: [{ name: "BUNNY_STORAGE_KEY", value: "ro-pw" }, { name: "S", value: "topsecret" }],
    });
    assert.deepEqual(outputs, { hostname: "n.b-cdn.net", release: "sjSMbTEz", "deploy-id": "689f0795086f", "pull-zone-id": "3", "storage-zone-id": "1", "script-id": "2" });
    assert.ok(!lines.filter((l) => !l.startsWith("mask:")).join("\n").includes("topsecret"));
    assert.ok(!lines.filter((l) => !l.startsWith("mask:")).join("\n").includes("ro-pw"));
  });

  it("fails before provisioning when the manifest cannot be read", async () => {
    const { actions, deps, calls, lines } = harness();
    await assert.rejects(run({ inputs: { "build-manifest": "/nope/.bunny/build.json", "bunny-api-key": "key" }, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*\/nope\/\.bunny\/build\.json.*not found/.test(l)));
  });

  it("fails before provisioning when the compatibility check finds errors, listing each problem", async () => {
    const path = await project({ script: `import x from "./local.js";\n` });
    const { actions, deps, calls, lines } = harness();
    await assert.rejects(run({ inputs: { "build-manifest": path, "bunny-api-key": "key", env: "A=1\nA=2" }, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*relative import/.test(l)));
    assert.ok(lines.some((l) => /error:.*"A" is defined more than once/.test(l)));
  });

  it("refuses a workflow variable or secret with a name the action sets itself", async () => {
    const path = await project();
    const { actions, deps, calls, lines } = harness();
    await assert.rejects(run({ inputs: { "build-manifest": path, "bunny-api-key": "key", secrets: "BUNNY_STORAGE_KEY=mine" }, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*BUNNY_STORAGE_KEY.*set by the action/.test(l)));
  });

  it("warns about a variable the build requires that neither the action nor the workflow sets", async () => {
    const path = await project({ env: [...requiredEnv.slice(0, 3), { name: "BUNNY_API_KEY", secret: true }] });
    const unset = harness();
    await run({ inputs: { "build-manifest": path, "bunny-api-key": "key" }, actions: unset.actions, ...unset.deps });
    assert.ok(unset.lines.some((l) => /warning:.*BUNNY_API_KEY/.test(l)));
    const supplied = harness();
    await run({ inputs: { "build-manifest": path, "bunny-api-key": "key", secrets: "BUNNY_API_KEY=k" }, actions: supplied.actions, ...supplied.deps });
    assert.ok(!supplied.lines.some((l) => /warning:.*BUNNY_API_KEY/.test(l)));
  });

  it("refuses to keep fewer than one deploy folder", async () => {
    const path = await project();
    const { actions, deps, calls, lines } = harness();
    await assert.rejects(run({ inputs: { "build-manifest": path, "bunny-api-key": "key", "keep-deploys": 0 }, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*keep-deploys.*at least 1/.test(l)));
  });

  it("deploys a static build without a script: no script checks, no script, no release", async () => {
    const path = await staticProject();
    const { actions, deps, calls, outputs } = harness();
    await run({ inputs: { "build-manifest": path, "bunny-api-key": "key", name: "s" }, actions, ...deps });
    assert.deepEqual(calls.map((c) => c[0]), ["provisionStatic", "deployStatic"]);
    assert.equal(calls[1][1].manifest.kind, "static");
    assert.deepEqual(outputs, { hostname: "n.b-cdn.net", "deploy-id": "5e11111e1824", "pull-zone-id": "3", "storage-zone-id": "1" });
  });

  it("refuses env and secrets for a static build, which has no script to set them on", async () => {
    const path = await staticProject();
    const { actions, deps, calls, lines } = harness();
    await assert.rejects(run({ inputs: { "build-manifest": path, "bunny-api-key": "key", env: "A=1" }, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*static build.*no script/.test(l)));
  });

  it("refuses a static build whose _redirects Bunny cannot apply, before provisioning", async () => {
    const path = await staticProject({ "_redirects": "/x /y 200\n" });
    const { actions, deps, calls, lines } = harness();
    await assert.rejects(run({ inputs: { "build-manifest": path, "bunny-api-key": "key" }, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /error:.*_redirects.*\/x.*200/.test(l)));
  });

  it("warns about _headers that no rule can express, and still deploys", async () => {
    const path = await staticProject({ "_headers": "/x\n  Cache-Control: no-store\n" });
    const { actions, deps, calls, lines } = harness();
    await run({ inputs: { "build-manifest": path, "bunny-api-key": "key" }, actions, ...deps });
    assert.ok(lines.some((l) => /warning:.*_headers.*\/x.*no-store/.test(l)));
    assert.equal(calls[0][0], "provisionStatic");
  });

  it("refuses a concurrency below 1 and negative limits, before provisioning", async () => {
    const path = await project();
    const { actions, deps, calls, lines } = harness();
    const inputs = { "build-manifest": path, "bunny-api-key": "key", concurrency: "0", "script-size-limit-mb": "-1", "startup-limit-ms": "-1", "monthly-bandwidth-limit-gb": "-1" };
    await assert.rejects(run({ inputs, actions, ...deps }), /compatibility check failed/);
    assert.deepEqual(calls, []);
    for (const name of ["concurrency", "script-size-limit-mb", "startup-limit-ms", "monthly-bandwidth-limit-gb"]) assert.ok(lines.some((l) => l.startsWith("error:") && l.includes(name)), name);
  });

  it("derives the resource name from the repository when no name is given", async () => {
    const path = await project();
    const { actions, deps, calls } = harness();
    await run({ inputs: { "build-manifest": path, "bunny-api-key": "key" }, actions, env: { GITHUB_REPOSITORY: "voorhoede/My_Site.v2" }, ...deps });
    assert.equal(calls[0][1].config.pullZoneName, "my-site-v2");
  });

  it("passes the name and zone overrides through", async () => {
    const path = await project();
    const { actions, deps, calls } = harness();
    const inputs = { "build-manifest": path, "bunny-api-key": "key", name: "s", "pull-zone-name": "cdn-s", "pricing-regions": ["EU", "US"], "replication-regions": ["UK"], "monthly-bandwidth-limit-gb": 100, "keep-deploys": 5 };
    await run({ inputs, actions, ...deps });
    assert.equal(calls[1][1].keepDeploys, 5);
    assert.equal(calls[0][1].config.pullZoneName, "cdn-s");
    assert.equal(calls[0][1].config.storageZoneName, "s");
    assert.deepEqual(calls[0][1].config.replicationRegions, ["UK"]);
    assert.equal(calls[0][1].config.monthlyBandwidthLimit, 100 * 1000 ** 3);
    assert.equal(calls[1][1].site, "cdn-s");
  });
});
