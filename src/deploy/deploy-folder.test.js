import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { deployFolder, deployId, foldersToPrune, preamble } from "./deploy-folder.js";

const checksum = (text) => createHash("sha256").update(text).digest("hex").toUpperCase();

describe("deployId", () => {
  const files = [{ path: "index.html", checksum: checksum("<h1>") }, { path: "_astro/a.css", checksum: checksum("css") }];

  it("hashes the files and the server bundle the way Bunny's CLI does", () => {
    assert.equal(deployId({ files, bundle: "export {}" }), "689f0795086f");
  });

  it("does not depend on the order the files are listed in", () => {
    assert.equal(deployId({ files: [...files].reverse(), bundle: "export {}" }), "689f0795086f");
  });

  it("changes when only the server bundle changes", () => {
    assert.notEqual(deployId({ files, bundle: "export { x }" }), "689f0795086f");
  });
});

describe("deployFolder", () => {
  it("is the id under deploys/", () => {
    assert.equal(deployFolder("689f0795086f"), "deploys/689f0795086f");
  });
});

describe("preamble", () => {
  it("is one line that tells the bundle which folder holds its files", () => {
    const line = preamble({ id: "689f0795086f", site: "my-site" });
    assert.equal(line, 'globalThis.__BUNNY_DEPLOY__ = {"id":"689f0795086f","assetPrefix":"deploys/689f0795086f","site":"my-site","environment":"production"};\n');
  });
});

describe("foldersToPrune", () => {
  const folders = [
    { name: "cccccccccccc", created: "2026-09-30T10:00:00.000" },
    { name: "aaaaaaaaaaaa", created: "2026-09-28T10:00:00.000" },
    { name: "dddddddddddd", created: "2026-09-30T11:00:00.000" },
    { name: "bbbbbbbbbbbb", created: "2026-09-29T10:00:00.000" },
  ];

  it("keeps the newest folders by creation date and prunes the rest, including ones from failed deploys", () => {
    assert.deepEqual(foldersToPrune({ folders, current: "dddddddddddd", keep: 3 }), ["aaaaaaaaaaaa"]);
    assert.deepEqual(foldersToPrune({ folders, current: "dddddddddddd", keep: 1 }).sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
  });

  it("never prunes the live deploy, even when it is older than every folder it keeps", () => {
    assert.deepEqual(foldersToPrune({ folders, current: "aaaaaaaaaaaa", keep: 2 }), ["bbbbbbbbbbbb"]);
  });

  it("prunes nothing while there are no more folders than it keeps", () => {
    assert.deepEqual(foldersToPrune({ folders: folders.slice(0, 2), current: "cccccccccccc", keep: 3 }), []);
  });
});
