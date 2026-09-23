import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provision } from "./provision.js";

function fakeApi({ storageZone, pullZone, script } = {}) {
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result; };
  const created = { storageZone: { Id: 11, Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [], Password: "pw", StorageHostname: "storage.bunnycdn.com" }, pullZone: { Id: 33, Name: "site", Hostnames: [{ Value: "site.b-cdn.net", ForceSSL: false, IsSystemHostname: true }] }, script: { Id: 22, Name: "site", ScriptType: 2 } };
  const api = {
    storageZones: { findByName: record("storageZones.findByName", storageZone), create: record("storageZones.create", created.storageZone), update: record("storageZones.update") },
    scripts: { findByName: record("scripts.findByName", script), create: record("scripts.create", created.script) },
    pullZones: {
      findByName: record("pullZones.findByName", pullZone),
      create: record("pullZones.create", created.pullZone),
      update: record("pullZones.update"),
      get: record("pullZones.get", { ...(pullZone ?? created.pullZone), Hostnames: (pullZone ?? created.pullZone).Hostnames }),
      setForceSsl: record("pullZones.setForceSsl"),
      addOrUpdateEdgeRule: record("pullZones.addOrUpdateEdgeRule"),
    },
  };
  return { api, calls, names: (prefix) => calls.map((c) => c[0]).filter((n) => n.startsWith(prefix)) };
}

const config = { storageZoneName: "site", pullZoneName: "site", scriptName: "site" };

describe("provision on an empty account", () => {
  it("creates the storage zone, the middleware script and the pull zone in that order, attaches the script, and forces https", async () => {
    const { api, calls } = fakeApi();
    const result = await provision({ api, config });
    assert.deepEqual(calls.map((c) => c[0]).filter((n) => n.includes("create")), ["storageZones.create", "scripts.create", "pullZones.create"]);
    assert.deepEqual(calls.find((c) => c[0] === "scripts.create")[1], { Name: "site", ScriptType: 2, CreateLinkedPullZone: false });
    const pullZoneCreate = calls.find((c) => c[0] === "pullZones.create")[1];
    assert.equal(pullZoneCreate.Name, "site");
    assert.equal(pullZoneCreate.StorageZoneId, 11);
    assert.equal(pullZoneCreate.MiddlewareScriptId, 22);
    assert.equal(pullZoneCreate.CacheControlMaxAgeOverride, -1);
    assert.deepEqual(calls.find((c) => c[0] === "pullZones.setForceSsl").slice(1), [33, "site.b-cdn.net", true]);
    assert.deepEqual(result.created, ["storage zone site", "script site", "pull zone site"]);
    assert.equal(result.hostname, "site.b-cdn.net");
    assert.deepEqual(result.drift, []);
    const rule = calls.find((c) => c[0] === "pullZones.addOrUpdateEdgeRule");
    assert.equal(rule[2].ActionType, 4);
    assert.deepEqual(rule[2].Triggers[0].PatternMatches, ["*/.bunny-edge-deploy/*"]);
  });

  it("warns that replication regions cannot be removed when it creates a zone with them", async () => {
    const { api } = fakeApi();
    const result = await provision({ api, config: { ...config, replicationRegions: ["UK"] } });
    assert.ok(result.warnings.some((w) => /UK.*cannot be removed/.test(w)));
  });
});

describe("provision with existing resources", () => {
  const existing = {
    storageZone: { Id: 11, Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [], Password: "pw", StorageHostname: "storage.bunnycdn.com" },
    script: { Id: 22, Name: "site", ScriptType: 2 },
    pullZone: { Id: 33, Name: "site", OriginType: 2, StorageZoneId: 11, MiddlewareScriptId: 22, EdgeScriptExecutionPhase: 0, CacheControlMaxAgeOverride: -1, EnableSmartCache: false, DisableCookies: false, EdgeRules: [{ Description: "bunny-edge-deploy: block deploy state", Enabled: true }], Hostnames: [{ Value: "site.b-cdn.net", ForceSSL: true, IsSystemHostname: true }, { Value: "www.example.com", ForceSSL: false }] },
  };

  it("creates nothing, updates nothing, and forces https on hostnames that do not have it yet", async () => {
    const { api, calls, names } = fakeApi(existing);
    const result = await provision({ api, config });
    assert.deepEqual(names("storageZones.create").concat(names("scripts.create"), names("pullZones.create"), names("pullZones.update"), names("pullZones.addOrUpdateEdgeRule")), []);
    assert.deepEqual(calls.filter((c) => c[0] === "pullZones.setForceSsl").map((c) => c[2]), ["www.example.com"]);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.warnings, []);
  });

  it("attaches the script when the pull zone has no middleware yet, and fails when another script is attached", async () => {
    const { api, calls } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, MiddlewareScriptId: null } });
    await provision({ api, config });
    assert.deepEqual(calls.find((c) => c[0] === "pullZones.update").slice(1), [33, { MiddlewareScriptId: 22 }]);
    const { api: other } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, MiddlewareScriptId: 99 } });
    await assert.rejects(provision({ api: other, config }), /script 99/);
  });

  it("fails when the cache expiration override is not 'respect origin', since rendered responses would be cached regardless of their headers", async () => {
    const { api } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, CacheControlMaxAgeOverride: 2592000 } });
    await assert.rejects(provision({ api, config }), /Cache Expiration Time.*Respect origin/i);
  });

  it("warns, without changing anything, when Smart Cache is on, cookies are stripped, the script runs before cache, or the state block rule is missing", async () => {
    const { api, names } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, EnableSmartCache: true, DisableCookies: true, EdgeScriptExecutionPhase: 2, EdgeRules: [] } });
    const result = await provision({ api, config });
    assert.deepEqual(names("pullZones.update").concat(names("pullZones.addOrUpdateEdgeRule")), []);
    assert.equal(result.warnings.length, 4);
    assert.ok(result.warnings.some((w) => /Smart Cache/.test(w)));
    assert.ok(result.warnings.some((w) => /Set-Cookie/.test(w)));
    assert.ok(result.warnings.some((w) => /before cache/.test(w)));
    assert.ok(result.warnings.some((w) => /\.bunny-edge-deploy/.test(w)));
  });

  it("reports drift on the storage zone region, tier and replication regions and does not touch them", async () => {
    const { api, names } = fakeApi({ ...existing, storageZone: { ...existing.storageZone, Region: "NY", ZoneTier: 1, ReplicationRegions: ["UK"] } });
    const result = await provision({ api, config: { ...config, replicationRegions: ["SE"] } });
    assert.deepEqual(names("storageZones.update"), []);
    assert.ok(result.drift.some((d) => /region.*NY.*DE/.test(d)));
    assert.ok(result.drift.some((d) => /tier.*edge.*standard/i.test(d)));
    assert.ok(result.drift.some((d) => /replication.*UK.*SE/.test(d)));
  });

  it("fails when the script that carries the name is not a middleware script", async () => {
    const { api } = fakeApi({ ...existing, script: { ...existing.script, ScriptType: 1 } });
    await assert.rejects(provision({ api, config }), /"site" .*not a middleware script/);
  });

  it("fails when the pull zone origin points at another storage zone, instead of repointing it", async () => {
    const { api } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, StorageZoneId: 99 } });
    await assert.rejects(provision({ api, config }), /storage zone 99/);
  });
});
