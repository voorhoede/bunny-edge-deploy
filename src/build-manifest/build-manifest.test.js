import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readBuildManifest } from "./build-manifest.js";

// The manifest @bunny.net/astro-adapter 0.1.0 writes for a server build with sessions.
const astroManifest = {
  manifestVersion: 1,
  adapter: { package: "@bunny.net/astro-adapter", version: "0.1.0" },
  framework: { name: "astro", version: "7.3.5" },
  kind: "ssr",
  script: { entry: "dist/index.js", type: "standalone", bytes: 713604 },
  assets: { dir: "dist/client" },
  requires: {
    pullZone: { disableCookies: false, enableSmartCache: false },
    storage: { write: true, reason: "Astro.session" },
    env: [
      { name: "BUNNY_STORAGE_ZONE", reason: "the zone holding the client build" },
      { name: "BUNNY_STORAGE_KEY", reason: "that zone's read-only password", secret: true },
      { name: "BUNNY_API_KEY", reason: "Astro.cache.invalidate()", secret: true, optional: true },
    ],
  },
  dev: { command: "astro dev", preview: "astro preview" },
};

async function project(manifest, { entry = "dist/index.js", assets = "dist/client" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bed-manifest-"));
  await mkdir(join(root, ".bunny"));
  if (entry) {
    await mkdir(join(root, entry, ".."), { recursive: true });
    await writeFile(join(root, entry), "export {}");
  }
  if (assets) await mkdir(join(root, assets), { recursive: true });
  const path = join(root, ".bunny/build.json");
  await writeFile(path, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return { root, path };
}

describe("readBuildManifest", () => {
  it("reads the manifest the Astro adapter writes and resolves its paths against the project root", async () => {
    const { root, path } = await project(astroManifest);
    const { errors, manifest } = await readBuildManifest(path);
    assert.deepEqual(errors, []);
    assert.equal(manifest.root, root);
    assert.equal(manifest.kind, "ssr");
    assert.deepEqual(manifest.script, { entry: join(root, "dist/index.js"), type: "standalone" });
    assert.deepEqual(manifest.assets, { dir: join(root, "dist/client") });
    assert.deepEqual(manifest.requires.pullZone, { disableCookies: false, enableSmartCache: false });
    assert.equal(manifest.requires.storage.write, true);
    assert.deepEqual(manifest.requires.env.map((e) => e.name), ["BUNNY_STORAGE_ZONE", "BUNNY_STORAGE_KEY", "BUNNY_API_KEY"]);
    assert.equal(manifest.framework.name, "astro");
  });

  it("defaults what requires leaves out, and ignores fields it does not know", async () => {
    const { requires, ...rest } = astroManifest;
    const { path } = await project({ ...rest, futureField: { anything: true } });
    const { errors, manifest } = await readBuildManifest(path);
    assert.deepEqual(errors, []);
    assert.deepEqual(manifest.requires, { pullZone: {}, storage: { write: false }, env: [] });
  });

  it("errors when there is no manifest, pointing at the build", async () => {
    const { errors } = await readBuildManifest("/nope/.bunny/build.json");
    assert.match(errors[0], /\/nope\/\.bunny\/build\.json.*not found.*build/i);
  });

  it("errors on a manifest that is not JSON", async () => {
    const { path } = await project("{ not json");
    const { errors } = await readBuildManifest(path);
    assert.match(errors[0], /not valid JSON/);
  });

  it("refuses a manifest version newer than this action reads", async () => {
    const { path } = await project({ ...astroManifest, manifestVersion: 2 });
    const { errors } = await readBuildManifest(path);
    assert.match(errors[0], /manifestVersion 2.*reads 1/);
  });

  it("reads a static build, which has no script and needs only its assets dir", async () => {
    const { root, path } = await project({ manifestVersion: 1, adapter: { package: "@bunny.net/astro-adapter" }, framework: { name: "astro" }, kind: "static", assets: { dir: "dist/client" } }, { entry: null });
    const { errors, manifest } = await readBuildManifest(path);
    assert.deepEqual(errors, []);
    assert.equal(manifest.kind, "static");
    assert.equal(manifest.script, undefined);
    assert.deepEqual(manifest.assets, { dir: join(root, "dist/client") });
    assert.deepEqual(manifest.requires, { pullZone: {}, storage: { write: false }, env: [] });
  });

  it("refuses a server build without a script, and a script that is not standalone", async () => {
    const { script, ...rest } = astroManifest;
    const missing = await readBuildManifest((await project({ ...rest })).path);
    assert.match(missing.errors[0], /script/);
    const middleware = await readBuildManifest((await project({ ...astroManifest, script: { ...script, type: "middleware" } })).path);
    assert.match(middleware.errors[0], /middleware.*standalone/);
  });

  it("names every field that is missing or of the wrong type", async () => {
    const { path } = await project({ ...astroManifest, manifestVersion: "1", assets: {}, framework: { name: 7 } });
    const { errors } = await readBuildManifest(path);
    assert.ok(errors.some((e) => /manifestVersion/.test(e)), errors.join("\n"));
    assert.ok(errors.some((e) => /assets\.dir/.test(e)), errors.join("\n"));
    assert.ok(errors.some((e) => /framework\.name/.test(e)), errors.join("\n"));
  });

  it("errors when the script entry or the assets dir it names does not exist", async () => {
    const { path } = await project(astroManifest, { entry: null, assets: null });
    const { errors } = await readBuildManifest(path);
    assert.ok(errors.some((e) => /dist\/index\.js.*not found/.test(e)), errors.join("\n"));
    assert.ok(errors.some((e) => /dist\/client.*not found/.test(e)), errors.join("\n"));
  });
});
