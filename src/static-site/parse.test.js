import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHeaders, parseRedirects } from "./parse.js";

describe("parseHeaders", () => {
  it("reads the _headers file the Astro adapter writes: a path, then its indented headers", () => {
    const text = `# Written by @bunny.net/astro-adapter. Edit the Astro config, not this file.
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/about
  content-security-policy: script-src 'self' 'sha256-abc='; style-src 'self'
  referrer-policy: no-referrer
`;
    assert.deepEqual(parseHeaders(text), [
      { path: "/_astro/*", headers: [["Cache-Control", "public, max-age=31536000, immutable"]] },
      { path: "/about", headers: [["content-security-policy", "script-src 'self' 'sha256-abc='; style-src 'self'"], ["referrer-policy", "no-referrer"]] },
    ]);
  });

  it("reads nothing from an empty or missing file", () => {
    assert.deepEqual(parseHeaders(""), []);
    assert.deepEqual(parseHeaders(undefined), []);
  });
});

describe("parseRedirects", () => {
  it("reads each line as a path, a target and a status, where ! marks a forced rule", () => {
    const text = `# Written by @bunny.net/astro-adapter. Edit the Astro config, not this file.
/gone /about 302!
/old /about 301!
/away https://example.com/
`;
    assert.deepEqual(parseRedirects(text), [
      { from: "/gone", to: "/about", status: 302 },
      { from: "/old", to: "/about", status: 301 },
      { from: "/away", to: "https://example.com/", status: 301 },
    ]);
  });
});
