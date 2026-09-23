import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { purgeUrls } from "./purge.js";

describe("purgeUrls", () => {
  it("expands an html file into the file, directory and extensionless urls", () => {
    assert.deepEqual(purgeUrls({ hostname: "site.b-cdn.net", paths: ["about/index.html"] }), [
      "https://site.b-cdn.net/about/index.html",
      "https://site.b-cdn.net/about/",
      "https://site.b-cdn.net/about",
    ]);
    assert.deepEqual(purgeUrls({ hostname: "site.b-cdn.net", paths: ["index.html"] }), ["https://site.b-cdn.net/index.html", "https://site.b-cdn.net/"]);
  });

  it("purges other unhashed files by their url only", () => {
    assert.deepEqual(purgeUrls({ hostname: "site.b-cdn.net", paths: ["robots.txt", "a b.txt"] }), ["https://site.b-cdn.net/robots.txt", "https://site.b-cdn.net/a%20b.txt"]);
  });
});
