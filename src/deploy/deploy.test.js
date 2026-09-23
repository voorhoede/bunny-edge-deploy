import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deploy } from "./deploy.js";

async function clientDir(files) {
  const root = await mkdtemp(join(tmpdir(), "bed-deploy-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function fakes({ remoteFiles = [], state } = {}) {
  const events = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const storage = {
    listAll: async () => remoteFiles,
    download: async (path) => (path === ".bunny-edge-deploy/state.json" && state ? Buffer.from(JSON.stringify(state)) : undefined),
    upload: async (path, bytes, { contentType }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      events.push(["upload", path, contentType]);
    },
    remove: async (path) => events.push(["remove", path]),
  };
  const api = {
    scripts: {
      uploadCode: async (id, code) => events.push(["uploadCode", code.length]),
      publish: async (id, note) => events.push(["publish", note]),
      activeRelease: async () => ({ Uuid: "rel-2", Id: 2 }),
      variables: { list: async () => [], upsert: async (id, v) => { events.push(["var", v.name]); return "created"; }, delete: async () => {} },
      secrets: { list: async () => [], upsert: async (id, s) => { events.push(["secret", s.name]); return "created"; }, delete: async () => {} },
    },
    pullZones: { purgeAll: async (id) => events.push(["purgeAll", id]) },
    purgeUrl: async (url) => events.push(["purgeUrl", url]),
  };
  const fetch = async (url) => { events.push(["smoke", new URL(url).pathname]); return new Response("ok", { headers: { "cdn-cache": "MISS", "cache-control": "public, max-age=60" } }); };
  return { storage, api, fetch, events, maxInFlight: () => maxInFlight };
}

const files = { "index.html": "<h1>", "assets/app.abc12345.js": "js", "assets/style.def67890.css": "css" };

describe("deploy", () => {
  it("runs in the agreed order: hashed assets, other files, env, code, publish, purge, retention state, smoke test", async () => {
    const dir = await clientDir(files);
    const { storage, api, fetch, events } = fakes({ remoteFiles: [{ path: "assets/old.11112222.js", checksum: "O" }] });
    const result = await deploy({ api, storage, fetch, clientDir: dir, serverEntry: join(dir, "index.html"), pullZone: { Id: 33 }, hostname: "site.b-cdn.net", scriptId: 22, environment: { variables: [{ name: "A", value: "1" }], secrets: [{ name: "S", value: "x" }] }, keepStaleDeploys: 3, serverRoute: "/", note: "deploy 1" });
    const kinds = events.map((e) => e[0]);
    const firstIndex = (kind) => kinds.indexOf(kind);
    const lastIndex = (kind) => kinds.lastIndexOf(kind);
    assert.deepEqual(events.filter((e) => e[0] === "upload").map((e) => e[1]).slice(0, 2).sort(), ["assets/app.abc12345.js", "assets/style.def67890.css"]);
    assert.ok(events.filter((e) => e[0] === "upload").map((e) => e[1]).indexOf("index.html") === 2);
    assert.ok(lastIndex("upload") < firstIndex("var") || events.filter((e) => e[0] === "upload").slice(-1)[0][1] === ".bunny-edge-deploy/state.json");
    assert.ok(firstIndex("var") < firstIndex("uploadCode") && firstIndex("secret") < firstIndex("uploadCode"));
    assert.ok(firstIndex("uploadCode") < firstIndex("publish") && firstIndex("publish") < firstIndex("purgeAll"));
    assert.ok(firstIndex("purgeAll") < firstIndex("smoke"));
    assert.equal(events.filter((e) => e[0] === "upload").at(-1)[1], ".bunny-edge-deploy/state.json");
    assert.deepEqual(result.uploaded, ["assets/app.abc12345.js", "assets/style.def67890.css", "index.html"]);
    assert.deepEqual(result.stale, ["assets/old.11112222.js"]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.release, "rel-2");
    assert.deepEqual(result.smoke.errors, []);
  });

  it("bounds upload concurrency", async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, "x"]));
    const dir = await clientDir(many);
    const { storage, api, fetch, maxInFlight } = fakes();
    await deploy({ api, storage, fetch, clientDir: dir, serverEntry: join(dir, "f0.txt"), pullZone: { Id: 33 }, hostname: "h", scriptId: 22, environment: { variables: [], secrets: [] }, keepStaleDeploys: 3, serverRoute: "/", concurrency: 4, smokeStaticPath: "f0.txt" });
    assert.ok(maxInFlight() <= 4 && maxInFlight() > 1, `max in flight ${maxInFlight()}`);
  });

  it("deletes files stale for enough deploys and keeps the state file out of the file list", async () => {
    const dir = await clientDir(files);
    const { storage, api, fetch, events, ...rest } = fakes({ remoteFiles: [{ path: "assets/old.11112222.js", checksum: "O" }, { path: ".bunny-edge-deploy/state.json", checksum: "S" }], state: { deploy: 9, stale: { "assets/old.11112222.js": 6 } } });
    const result = await deploy({ api, storage, fetch, clientDir: dir, serverEntry: join(dir, "index.html"), pullZone: { Id: 33 }, hostname: "h", scriptId: 22, environment: { variables: [], secrets: [] }, keepStaleDeploys: 3, serverRoute: "/" });
    assert.deepEqual(result.removed, ["assets/old.11112222.js"]);
    assert.ok(events.some((e) => e[0] === "remove" && e[1] === "assets/old.11112222.js"));
    assert.ok(!result.stale.includes(".bunny-edge-deploy/state.json"));
  });

  it("purges only changed unhashed paths plus the given cache tag in targeted mode", async () => {
    const dir = await clientDir(files);
    const { storage, api, fetch, events } = fakes({ remoteFiles: [{ path: "index.html", checksum: "OLD" }, { path: "assets/app.abc12345.js", checksum: "same" }] });
    api.pullZones.purgeTag = async (id, tag) => events.push(["purgeTag", tag]);
    storage.listAll = async () => [{ path: "index.html", checksum: "OLD" }];
    await deploy({ api, storage, fetch, clientDir: dir, serverEntry: join(dir, "index.html"), pullZone: { Id: 33 }, hostname: "site.b-cdn.net", scriptId: 22, environment: { variables: [], secrets: [] }, keepStaleDeploys: 3, serverRoute: "/", purge: "targeted", cacheTag: "ssr" });
    assert.ok(!events.some((e) => e[0] === "purgeAll"));
    assert.deepEqual(events.filter((e) => e[0] === "purgeUrl").map((e) => e[1]), ["https://site.b-cdn.net/index.html", "https://site.b-cdn.net/"]);
    assert.deepEqual(events.filter((e) => e[0] === "purgeTag").map((e) => e[1]), ["ssr"]);
  });

  it("waits for a freshly created storage zone to accept its password before listing", async () => {
    const dir = await clientDir(files);
    const { storage, api, fetch, events } = fakes();
    let rejections = 2;
    const listAll = storage.listAll;
    storage.listAll = async () => { if (rejections-- > 0) throw Object.assign(new Error("401"), { status: 401 }); return listAll(); };
    const sleeps = [];
    await deploy({ api, storage, fetch, sleep: async (ms) => sleeps.push(ms), clientDir: dir, serverEntry: join(dir, "index.html"), pullZone: { Id: 33 }, hostname: "h", scriptId: 22, environment: { variables: [], secrets: [] }, keepStaleDeploys: 3, serverRoute: "/", smokeRetryForMs: 0 });
    assert.equal(sleeps.length, 2);
    assert.ok(events.some((e) => e[0] === "upload"));
  });

  it("fails the deploy when the smoke test fails", async () => {
    const dir = await clientDir(files);
    const { storage, api } = fakes();
    const fetch = async () => new Response("nope", { status: 404, headers: { "cdn-cache": "MISS" } });
    await assert.rejects(deploy({ api, storage, fetch, clientDir: dir, serverEntry: join(dir, "index.html"), pullZone: { Id: 33 }, hostname: "h", scriptId: 22, environment: { variables: [], secrets: [] }, keepStaleDeploys: 3, serverRoute: "/" }), /smoke test failed/);
  });
});
