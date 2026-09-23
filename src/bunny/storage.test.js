import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createStorageClient, StorageError } from "./storage.js";

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    const { status = 200, json, text } = next;
    return new Response(json !== undefined ? JSON.stringify(json) : text ?? null, { status });
  };
  return { fetch, calls };
}

function storage(responses) {
  const { fetch, calls } = fakeFetch(responses);
  const client = createStorageClient({ hostname: "storage.bunnycdn.com", zoneName: "site", password: "zone-pw", fetch, sleep: async () => {} });
  return { client, calls };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex").toUpperCase();

describe("storage upload", () => {
  it("PUTs raw bytes with the zone password, an uppercase sha256 checksum and the content type", async () => {
    const { client, calls } = storage([{ status: 201 }]);
    const body = Buffer.from("<h1>home</h1>");
    await client.upload("index.html", body, { contentType: "text/html" });
    assert.equal(calls[0].url, "https://storage.bunnycdn.com/site/index.html");
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].headers.get("accesskey"), "zone-pw");
    assert.equal(calls[0].headers.get("checksum"), sha256(body));
    assert.equal(calls[0].headers.get("content-type"), "text/html");
    assert.equal(calls[0].body, body);
  });

  it("encodes path segments but keeps slashes", async () => {
    const { client, calls } = storage([{ status: 201 }]);
    await client.upload("assets/a b/app.abc123.js", Buffer.from("x"), { contentType: "text/javascript" });
    assert.equal(calls[0].url, "https://storage.bunnycdn.com/site/assets/a%20b/app.abc123.js");
  });

  it("throws StorageError with status and path on failure", async () => {
    const { client } = storage([{ status: 400 }]);
    await assert.rejects(client.upload("index.html", Buffer.from("x"), { contentType: "text/html" }), (error) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.status, 400);
      assert.equal(error.path, "index.html");
      return true;
    });
  });

  it("retries a 5xx upload and then succeeds", async () => {
    const { client, calls } = storage([{ status: 500 }, { status: 201 }]);
    await client.upload("index.html", Buffer.from("x"), { contentType: "text/html" });
    assert.equal(calls.length, 2);
  });
});

describe("storage list", () => {
  it("walks directories and returns a flat list of files with posix paths, sizes and checksums", async () => {
    const { client, calls } = storage([
      { json: [
        { ObjectName: "assets", IsDirectory: true, Length: 0, Checksum: null, Path: "/site/" },
        { ObjectName: "index.html", IsDirectory: false, Length: 29, Checksum: "0AED", Path: "/site/" },
      ] },
      { json: [{ ObjectName: "app.abc123.js", IsDirectory: false, Length: 19, Checksum: "ABCD", Path: "/site/assets/" }] },
    ]);
    const files = await client.listAll();
    assert.deepEqual(files, [
      { path: "index.html", size: 29, checksum: "0AED" },
      { path: "assets/app.abc123.js", size: 19, checksum: "ABCD" },
    ]);
    assert.equal(calls[0].url, "https://storage.bunnycdn.com/site/");
    assert.equal(calls[1].url, "https://storage.bunnycdn.com/site/assets/");
  });

  it("treats a 404 on the root as an empty zone", async () => {
    const { client } = storage([{ status: 404, json: [{ HttpCode: 404, Message: "Not found" }] }]);
    assert.deepEqual(await client.listAll(), []);
  });
});

describe("storage download", () => {
  it("returns the bytes, or undefined when the file does not exist", async () => {
    const { client, calls } = storage([{ status: 200, text: "{}" }, { status: 404 }]);
    assert.equal((await client.download("state.json")).toString(), "{}");
    assert.equal(calls[0].method, "GET");
    assert.equal(await client.download("missing.json"), undefined);
  });
});

describe("storage remove", () => {
  it("DELETEs the file path", async () => {
    const { client, calls } = storage([{ status: 200 }]);
    await client.remove("assets/old.js");
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, "https://storage.bunnycdn.com/site/assets/old.js");
  });
});
