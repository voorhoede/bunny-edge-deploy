import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deploy, deployStatic } from "./deploy.js";

const BUNDLE = "export default {}\n";

async function build(files) {
  const root = await mkdtemp(join(tmpdir(), "bed-deploy-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, "dist/client", path, ".."), { recursive: true });
    await writeFile(join(root, "dist/client", path), content);
  }
  await writeFile(join(root, "dist/index.js"), BUNDLE);
  return { script: { entry: join(root, "dist/index.js"), type: "standalone" }, assets: { dir: join(root, "dist/client") } };
}

const checksum = (text) => createHash("sha256").update(text).digest("hex").toUpperCase();

function fakes({ remote = () => [], folders = [], edgeRules = [] } = {}) {
  const events = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const storage = {
    listAll: async (directory) => { events.push(["list", directory]); return remote(directory); },
    listFolders: async (directory) => { events.push(["listFolders", directory]); return folders; },
    removeFolder: async (path) => events.push(["removeFolder", path]),
    upload: async (path, bytes, { contentType }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      events.push(["upload", path, contentType]);
    },
  };
  const api = {
    scripts: {
      uploadCode: async (id, code) => events.push(["uploadCode", code]),
      publish: async (id, note) => events.push(["publish", note]),
      activeRelease: async () => ({ Uuid: "sjSMbTEz" }),
      variables: { list: async () => [], upsert: async (id, v) => { events.push(["var", v.name]); return "created"; } },
      secrets: { list: async () => [], upsert: async (id, s) => { events.push(["secret", s.name]); return "created"; } },
    },
    pullZones: { get: async () => ({ EdgeRules: edgeRules }), purgeAll: async (id) => events.push(["purgeAll", id]) },
  };
  const fetch = async (url) => { events.push(["smoke", new URL(url).pathname]); return new Response("ok", { headers: { "cdn-cache": "MISS", "cache-control": "public, max-age=60" } }); };
  const sleep = async (ms) => events.push(["sleep", ms]);
  return { storage, api, fetch, sleep, events, maxInFlight: () => maxInFlight };
}

const files = { "about/index.html": "<h1>", "_astro/about.DFbA8egk.css": "css" };
const common = { site: "site", pullZone: { Id: 33 }, hostname: "site.b-cdn.net", scriptId: 22, serverRoute: "/", note: "deploy 1" };

describe("deploy", () => {
  it("uploads the build into its own folder before touching the script, then publishes, purges twice with a pause, and smoke tests", async () => {
    const manifest = await build(files);
    const { storage, api, fetch, sleep, events } = fakes();
    const environment = { variables: [{ name: "BUNNY_STORAGE_ZONE", value: "site" }], secrets: [{ name: "BUNNY_STORAGE_KEY", value: "ro" }] };
    const result = await deploy({ api, storage, fetch, sleep, manifest, environment, ...common });
    const folder = `deploys/${result.deployId}`;
    assert.match(result.deployId, /^[0-9a-f]{12}$/);
    assert.deepEqual(events.filter((e) => e[0] === "list").map((e) => e[1]), [folder]);
    assert.deepEqual(events.filter((e) => e[0] === "upload").map((e) => [e[1], e[2]]).sort(), [[`${folder}/_astro/about.DFbA8egk.css`, "text/css; charset=utf-8"], [`${folder}/about/index.html`, "text/html; charset=utf-8"]]);
    const order = events.map((e) => (e[0] === "sleep" ? `sleep ${e[1]}` : e[0])).filter((k, i, all) => k !== all[i - 1]);
    assert.deepEqual(order.slice(order.indexOf("upload")), ["upload", "var", "secret", "uploadCode", "publish", "purgeAll", "sleep 5000", "purgeAll", "smoke", "listFolders"]);
    assert.equal(events.find((e) => e[0] === "publish")[1], "deploy 1");
    assert.equal(result.release, "sjSMbTEz");
    assert.deepEqual(result.uploaded.sort(), ["_astro/about.DFbA8egk.css", "about/index.html"]);
    assert.deepEqual(result.smoke.errors, []);
  });

  it("publishes the bundle unchanged behind one line that names its deploy folder", async () => {
    const manifest = await build(files);
    const { storage, api, fetch, sleep, events } = fakes();
    const result = await deploy({ api, storage, fetch, sleep, manifest, environment: { variables: [], secrets: [] }, ...common });
    const code = events.find((e) => e[0] === "uploadCode")[1];
    const [first, ...rest] = code.split("\n");
    assert.equal(first, `globalThis.__BUNNY_DEPLOY__ = {"id":"${result.deployId}","assetPrefix":"deploys/${result.deployId}","site":"site","environment":"production"};`);
    assert.equal(rest.join("\n"), BUNDLE);
  });

  it("uploads only what the deploy folder is missing, so a re-run of the same build uploads nothing", async () => {
    const manifest = await build(files);
    const first = fakes();
    const { deployId } = await deploy({ ...first, manifest, environment: { variables: [], secrets: [] }, ...common });
    const partial = fakes({ remote: (dir) => [{ path: `${dir}/about/index.html`, checksum: checksum("<h1>") }] });
    const resumed = await deploy({ ...partial, manifest, environment: { variables: [], secrets: [] }, ...common });
    assert.equal(resumed.deployId, deployId);
    assert.deepEqual(resumed.uploaded, ["_astro/about.DFbA8egk.css"]);
    const complete = fakes({ remote: (dir) => Object.entries(files).map(([path, content]) => ({ path: `${dir}/${path}`, checksum: checksum(content) })) });
    const rerun = await deploy({ ...complete, manifest, environment: { variables: [], secrets: [] }, ...common });
    assert.deepEqual(rerun.uploaded, []);
    assert.ok(complete.events.some((e) => e[0] === "publish"));
  });

  it("prunes old deploy folders once the smoke test has passed, keeping the live one", async () => {
    const manifest = await build(files);
    const old = [{ name: "000000000001", created: "2026-09-01T00:00:00" }, { name: "000000000002", created: "2026-09-02T00:00:00" }, { name: "000000000003", created: "2026-09-03T00:00:00" }];
    const probe = fakes();
    const { deployId } = await deploy({ ...probe, manifest, environment: { variables: [], secrets: [] }, ...common });
    const { storage, api, fetch, sleep, events } = fakes({ folders: [...old, { name: deployId, created: "2026-08-01T00:00:00" }] });
    const result = await deploy({ api, storage, fetch, sleep, manifest, environment: { variables: [], secrets: [] }, ...common, keepDeploys: 2 });
    const kinds = events.map((e) => e[0]);
    assert.ok(kinds.lastIndexOf("smoke") < kinds.indexOf("listFolders"));
    assert.deepEqual(events.filter((e) => e[0] === "listFolders").map((e) => e[1]), ["deploys"]);
    assert.deepEqual(events.filter((e) => e[0] === "removeFolder").map((e) => e[1]).sort(), ["deploys/000000000001"]);
    assert.deepEqual(result.pruned, ["000000000001"]);
  });

  it("prunes nothing when the smoke test fails, so the previous deploy stays available", async () => {
    const manifest = await build(files);
    const { storage, api, sleep, events } = fakes({ folders: [{ name: "000000000001", created: "2026-09-01T00:00:00" }] });
    const fetch = async () => new Response("nope", { status: 500, headers: { "cdn-cache": "MISS" } });
    await assert.rejects(deploy({ api, storage, fetch, sleep, manifest, environment: { variables: [], secrets: [] }, ...common, keepDeploys: 1, smokeRetryForMs: 0 }), /smoke test failed/);
    assert.ok(!events.some((e) => e[0] === "listFolders" || e[0] === "removeFolder"));
  });

  it("bounds upload concurrency", async () => {
    const manifest = await build(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, `x${i}`])));
    const { storage, api, fetch, sleep, maxInFlight } = fakes();
    await deploy({ api, storage, fetch, sleep, manifest, environment: { variables: [], secrets: [] }, ...common, concurrency: 4, smokeStaticPath: "f0.txt" });
    assert.ok(maxInFlight() <= 4 && maxInFlight() > 1, `max in flight ${maxInFlight()}`);
  });

  it("waits for a freshly created storage zone to accept its password before listing", async () => {
    const manifest = await build(files);
    const { storage, api, fetch, events } = fakes();
    let rejections = 2;
    const listAll = storage.listAll;
    storage.listAll = async (dir) => { if (rejections-- > 0) throw Object.assign(new Error("401"), { status: 401 }); return listAll(dir); };
    const sleeps = [];
    await deploy({ api, storage, fetch, sleep: async (ms) => sleeps.push(ms), manifest, environment: { variables: [], secrets: [] }, ...common, smokeRetryForMs: 0 });
    assert.deepEqual(sleeps.slice(0, 2), [2000, 2000]);
    assert.ok(events.some((e) => e[0] === "upload"));
  });

  it("fails the deploy when the smoke test fails", async () => {
    const manifest = await build(files);
    const { storage, api, sleep } = fakes();
    const fetch = async () => new Response("nope", { status: 404, headers: { "cdn-cache": "MISS" } });
    await assert.rejects(deploy({ api, storage, fetch, sleep, manifest, environment: { variables: [], secrets: [] }, ...common }), /smoke test failed/);
  });
});

describe("deployStatic", () => {
  async function staticBuild(files) {
    const root = await mkdtemp(join(tmpdir(), "bed-static-"));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, "dist/client", path, ".."), { recursive: true });
      await writeFile(join(root, "dist/client", path), content);
    }
    return { kind: "static", assets: { dir: join(root, "dist/client") } };
  }
  const site = { "index.html": "<h1>", "404.html": "<h1>404", "_astro/app.DFbA8egk.css": "css", "_headers": "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n" };
  const staticCommon = { storageZone: { Id: 11, Name: "site" }, pullZone: { Id: 33 }, hostname: "site.b-cdn.net", serverRoute: "/" };

  it("uploads the build into its folder, publishes that folder, smoke tests, then prunes, and never touches a script", async () => {
    const manifest = await staticBuild(site);
    const probe = fakes();
    const { deployId } = await deployStatic({ ...probe, publish: async () => ({ confirmed: true }), manifest, ...staticCommon });
    const { storage, api, fetch, sleep, events } = fakes({ folders: [{ name: "000000000001", created: "2026-09-01T00:00:00" }, { name: deployId, created: "2026-09-30T00:00:00" }] });
    const publishes = [];
    const publish = async (args) => { events.push(["publish"]); publishes.push(args); return { confirmed: true }; };
    const result = await deployStatic({ api, storage, fetch, sleep, publish, manifest, ...staticCommon, keepDeploys: 1 });
    const order = events.map((e) => e[0]).filter((k, i, all) => k !== all[i - 1]);
    assert.deepEqual(order, ["list", "upload", "publish", "smoke", "listFolders", "removeFolder"]);
    assert.ok(!events.some((e) => ["uploadCode", "publish-script", "var", "secret"].includes(e[0])));
    assert.ok(events.filter((e) => e[0] === "upload").some((e) => e[1] === `deploys/${result.deployId}/_headers`));
    assert.equal(publishes[0].deployId, result.deployId);
    assert.ok(publishes[0].rules.some((rule) => rule.ActionParameter3 === `/deploys/${result.deployId}/`));
    assert.deepEqual(publishes[0].notFound, { Custom404FilePath: `/deploys/${result.deployId}/404.html`, Rewrite404To200: false });
    assert.deepEqual(result.pruned, ["000000000001"]);
  });

  it("publishes the build's _headers and _redirects as rules", async () => {
    const manifest = await staticBuild({ ...site, "_redirects": "/old /about 301!\n" });
    const { storage, api, fetch, sleep } = fakes();
    const publishes = [];
    await deployStatic({ api, storage, fetch, sleep, publish: async (args) => { publishes.push(args); return { confirmed: true }; }, manifest, ...staticCommon });
    assert.ok(publishes[0].rules.some((rule) => rule.Description === "bunny-edge-deploy: redirect /old"));
  });

  it("refuses before uploading anything when its rules and the zone's other rules would pass Bunny's limit of 50", async () => {
    const manifest = await staticBuild(site);
    const others = Array.from({ length: 50 }, (_, i) => ({ Guid: `g${i}`, Description: `someone else's rule ${i}` }));
    const { storage, api, fetch, sleep, events } = fakes({ edgeRules: others });
    await assert.rejects(deployStatic({ api, storage, fetch, sleep, publish: async () => ({ confirmed: true }), manifest, ...staticCommon }), /edge rules.*50/);
    assert.ok(!events.some((e) => e[0] === "upload"));
  });

  it("fails and prunes nothing when the smoke test fails", async () => {
    const manifest = await staticBuild(site);
    const { storage, api, sleep, events } = fakes({ folders: [{ name: "000000000001", created: "2026-09-01T00:00:00" }] });
    const fetch = async () => new Response("nope", { status: 500, headers: { "cdn-cache": "MISS" } });
    await assert.rejects(deployStatic({ api, storage, fetch, sleep, publish: async () => ({ confirmed: true }), manifest, ...staticCommon, smokeRetryForMs: 0 }), /smoke test failed/);
    assert.ok(!events.some((e) => e[0] === "removeFolder"));
  });
});
