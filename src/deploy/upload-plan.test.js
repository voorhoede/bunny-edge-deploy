import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentTypeFor, isHashedAsset, planUpload } from "./upload-plan.js";

describe("isHashedAsset", () => {
  it("recognizes common bundler hash patterns", () => {
    for (const path of ["assets/app.abc12345.js", "assets/index-DkXq2f3a.js", "_astro/index.Bx3kQ9pL.css", "chunks/chunk.6f1a2b3c4d.mjs", "fonts/inter-v13-latin-4f2c1a9b.woff2"]) assert.equal(isHashedAsset(path), true, path);
  });
  it("leaves unhashed files alone", () => {
    for (const path of ["index.html", "about/index.html", "main.bundle.js", "chunk.polyfills.js", "vendor.min.js", "robots.txt", "favicon.ico", "sitemap-index.xml"]) assert.equal(isHashedAsset(path), false, path);
  });
});

describe("contentTypeFor", () => {
  it("maps web file extensions and returns undefined for unknown ones so storage can sniff", () => {
    assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("a/b.mjs"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("x.webmanifest"), "application/manifest+json");
    assert.equal(contentTypeFor("x.wasm"), "application/wasm");
    assert.equal(contentTypeFor("x.avif"), "image/avif");
    assert.equal(contentTypeFor("x.unknownext"), undefined);
  });
});

describe("planUpload", () => {
  const local = [
    { path: "index.html", checksum: "H1" },
    { path: "about/index.html", checksum: "H2" },
    { path: "assets/app.abc12345.js", checksum: "A1" },
    { path: "assets/style.def67890.css", checksum: "S1" },
  ];
  const remote = [
    { path: "index.html", checksum: "OLD" },
    { path: "about/index.html", checksum: "H2" },
    { path: "assets/app.abc12345.js", checksum: "A1" },
    { path: "assets/old.11112222.js", checksum: "O1" },
    { path: ".bunny-edge-deploy/state.json", checksum: "X" },
  ];

  it("uploads new and changed files, hashed assets first, skips unchanged, and lists stale remote files", () => {
    const plan = planUpload({ local, remote, statePath: ".bunny-edge-deploy/state.json" });
    assert.deepEqual(plan.upload.map((f) => f.path), ["assets/style.def67890.css", "index.html"]);
    assert.deepEqual(plan.unchanged, ["about/index.html", "assets/app.abc12345.js"]);
    assert.deepEqual(plan.stale, ["assets/old.11112222.js"]);
  });

  it("marks which uploaded and stale paths are unhashed, for targeted purges", () => {
    const plan = planUpload({ local, remote, statePath: ".bunny-edge-deploy/state.json" });
    assert.deepEqual(plan.changedUnhashed, ["index.html"]);
  });
});
