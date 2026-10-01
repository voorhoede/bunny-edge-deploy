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
  it("uploads new and changed files and skips the ones already there", () => {
    const local = [
      { path: "index.html", checksum: "H1" },
      { path: "about/index.html", checksum: "H2" },
      { path: "_astro/app.DFbA8egk.css", checksum: "A1" },
    ];
    const remote = [
      { path: "index.html", checksum: "OLD" },
      { path: "about/index.html", checksum: "H2" },
    ];
    const plan = planUpload({ local, remote });
    assert.deepEqual(plan.upload.map((f) => f.path), ["index.html", "_astro/app.DFbA8egk.css"]);
    assert.deepEqual(plan.unchanged, ["about/index.html"]);
  });
});
