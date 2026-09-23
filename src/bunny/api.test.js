import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BunnyApiError, createBunnyApi } from "./api.js";

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    const { status = 200, json, text } = next;
    const body = json !== undefined ? JSON.stringify(json) : text ?? "";
    return new Response(body || null, { status, headers: json !== undefined ? { "content-type": "application/json" } : {} });
  };
  return { fetch, calls };
}

function api(responses, overrides = {}) {
  const { fetch, calls } = fakeFetch(responses);
  const sleeps = [];
  const client = createBunnyApi({ apiKey: "key-123", fetch, sleep: async (ms) => sleeps.push(ms), ...overrides });
  return { client, calls, sleeps };
}

describe("createBunnyApi request basics", () => {
  it("sends the account key, JSON headers and body, and returns parsed JSON", async () => {
    const { client, calls } = api([{ status: 201, json: { Id: 7, Name: "zone" } }]);
    const zone = await client.storageZones.create({ Name: "zone", Region: "DE", ZoneTier: 0, ReplicationRegions: [] });
    assert.deepEqual(zone, { Id: 7, Name: "zone" });
    assert.equal(calls[0].url, "https://api.bunny.net/storagezone");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("accesskey"), "key-123");
    assert.equal(calls[0].headers.get("accept"), "application/json");
    assert.equal(calls[0].headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0].body), { Name: "zone", Region: "DE", ZoneTier: 0, ReplicationRegions: [] });
  });

  it("returns undefined for an empty 204 response", async () => {
    const { client } = api([{ status: 204 }]);
    assert.equal(await client.scripts.uploadCode(1, "export {}"), undefined);
  });

  it("throws BunnyApiError with status, path and the API message on a 4xx, without retrying", async () => {
    const { client, calls } = api([{ status: 400, json: { ErrorKey: "model.invalid", Field: "DefaultValue", Message: "Model validation failed" } }]);
    await assert.rejects(client.scripts.variables.upsert(1, { name: "A", value: "x" }), (error) => {
      assert.ok(error instanceof BunnyApiError);
      assert.equal(error.status, 400);
      assert.equal(error.path, "/compute/script/1/variables");
      assert.equal(error.errorKey, "model.invalid");
      assert.equal(error.field, "DefaultValue");
      assert.match(error.message, /Model validation failed/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("retries 429 and 5xx responses and network errors with backoff, then succeeds", async () => {
    const { client, calls, sleeps } = api([
      { status: 429, text: "slow down" },
      new TypeError("fetch failed"),
      { status: 200, json: [] },
    ]);
    assert.deepEqual(await client.pullZones.list(), []);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it("retries a 5xx response too", async () => {
    const { client, calls } = api([{ status: 502, text: "bad gateway" }, { status: 200, json: [] }]);
    assert.deepEqual(await client.pullZones.list(), []);
    assert.equal(calls.length, 2);
  });

  it("gives up after the configured attempts and throws the last error", async () => {
    const { client, calls } = api([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await assert.rejects(client.pullZones.list(), (error) => error instanceof BunnyApiError && error.status === 503);
    assert.equal(calls.length, 3);
  });
});

describe("find by name", () => {
  it("searches by name and returns only the exact match", async () => {
    const { client, calls } = api([{ json: [{ Id: 1, Name: "site-staging" }, { Id: 2, Name: "site" }] }]);
    assert.deepEqual(await client.pullZones.findByName("site"), { Id: 2, Name: "site" });
    assert.equal(new URL(calls[0].url).searchParams.get("search"), "site");
  });

  it("returns undefined when nothing matches exactly", async () => {
    const { client } = api([{ json: [{ Id: 1, Name: "site-staging" }] }]);
    assert.equal(await client.pullZones.findByName("site"), undefined);
  });

  it("accepts the paginated object shape the compute API returns", async () => {
    const { client } = api([{ json: { Items: [{ Id: 9, Name: "site" }], HasMoreItems: false } }]);
    assert.deepEqual(await client.scripts.findByName("site"), { Id: 9, Name: "site" });
  });
});

describe("scripts", () => {
  it("publishes the current code and a previous release by uuid", async () => {
    const { client, calls } = api([{ status: 204 }, { status: 204 }]);
    await client.scripts.publish(5, "deploy 1");
    await client.scripts.publishRelease(5, "ge45sc2J", "rollback");
    assert.equal(calls[0].url, "https://api.bunny.net/compute/script/5/publish");
    assert.deepEqual(JSON.parse(calls[0].body), { Note: "deploy 1" });
    assert.equal(calls[1].url, "https://api.bunny.net/compute/script/5/publish/ge45sc2J");
  });

  it("upserts variables and secrets and reports created versus updated", async () => {
    const { client, calls } = api([{ status: 200, json: { Id: 1 } }, { status: 204 }, { status: 200, json: { Id: 2 } }, { status: 204 }]);
    assert.equal(await client.scripts.variables.upsert(5, { name: "A", value: "1" }), "created");
    assert.equal(await client.scripts.variables.upsert(5, { name: "A", value: "2" }), "updated");
    assert.equal(await client.scripts.secrets.upsert(5, { name: "S", value: "x" }), "created");
    assert.equal(await client.scripts.secrets.upsert(5, { name: "S", value: "y" }), "updated");
    assert.equal(calls[0].method, "PUT");
    assert.deepEqual(JSON.parse(calls[0].body), { Name: "A", DefaultValue: "1", Required: false });
    assert.deepEqual(JSON.parse(calls[2].body), { Name: "S", Secret: "x" });
  });

  it("lists variables from the script and secrets from the secrets endpoint", async () => {
    const { client } = api([
      { json: { Id: 5, EdgeScriptVariables: [{ Id: 10, Name: "A", DefaultValue: "1", Required: false }] } },
      { json: { Secrets: [{ Id: 20, Name: "S", LastModified: "2026-09-23T08:50:39" }] } },
    ]);
    assert.deepEqual(await client.scripts.variables.list(5), [{ id: 10, name: "A", value: "1" }]);
    assert.deepEqual(await client.scripts.secrets.list(5), [{ id: 20, name: "S" }]);
  });
});

describe("pull zones and purge", () => {
  it("purges a url through the purge endpoint with the url as a query parameter", async () => {
    const { client, calls } = api([{ status: 200 }]);
    await client.purgeUrl("https://site.b-cdn.net/assets/*");
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/purge");
    assert.equal(url.searchParams.get("url"), "https://site.b-cdn.net/assets/*");
    assert.equal(calls[0].method, "POST");
  });

  it("forces ssl per hostname", async () => {
    const { client, calls } = api([{ status: 204 }]);
    await client.pullZones.setForceSsl(3, "site.b-cdn.net", true);
    assert.equal(calls[0].url, "https://api.bunny.net/pullzone/3/setForceSSL");
    assert.deepEqual(JSON.parse(calls[0].body), { Hostname: "site.b-cdn.net", ForceSSL: true });
  });
});
