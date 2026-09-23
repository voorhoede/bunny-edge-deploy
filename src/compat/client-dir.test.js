import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeClientDir } from "./client-dir.js";

async function dir(files) {
  const root = await mkdtemp(join(tmpdir(), "bed-client-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("analyzeClientDir", () => {
  it("lists files with posix paths and sizes", async () => {
    const root = await dir({ "index.html": "<h1>", "assets/app.abc123.js": "1234567" });
    const result = await analyzeClientDir({ path: root });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.files, [
      { path: "assets/app.abc123.js", size: 7 },
      { path: "index.html", size: 4 },
    ]);
  });

  it("errors when the directory is missing or empty", async () => {
    assert.match((await analyzeClientDir({ path: "/nope" })).errors[0], /not found/);
    assert.match((await analyzeClientDir({ path: await dir({}) })).errors[0], /empty/);
  });

  it("warns on paths over the documented 6000 character limit and names with leading or trailing spaces", async () => {
    const root = await dir({ " padded.txt": "x", "ok.txt": "x" });
    const result = await analyzeClientDir({ path: root, maxPathLength: 10 });
    assert.ok(result.warnings.some((w) => /" padded.txt".*space/.test(w)));
    assert.ok(result.warnings.some((w) => /padded\.txt.*exceeds 10/.test(w)));
  });
});
