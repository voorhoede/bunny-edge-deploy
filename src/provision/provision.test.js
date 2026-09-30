import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provision } from "./provision.js";

function fakeApi({ storageZone, pullZone, script, storageZoneById } = {}) {
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result; };
  const created = { storageZone: { Id: 11, Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [], Password: "pw", ReadOnlyPassword: "ro", StorageHostname: "storage.bunnycdn.com" }, pullZone: { Id: 33, Name: "site", Hostnames: [{ Value: "site.b-cdn.net", ForceSSL: false, IsSystemHostname: true }] }, script: { Id: 22, Name: "site", ScriptType: 1 } };
  const api = {
    storageZones: { findByName: record("storageZones.findByName", storageZone), get: record("storageZones.get", storageZoneById), create: record("storageZones.create", created.storageZone), update: record("storageZones.update") },
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
const pullZoneRequirements = { disableCookies: false, enableSmartCache: false };

describe("provision on an empty account", () => {
  it("creates the storage zone, a standalone script and a pull zone with the script as origin, and forces https", async () => {
    const { api, calls, names } = fakeApi();
    const result = await provision({ api, config, pullZoneRequirements });
    assert.deepEqual(names("").filter((n) => n.includes("create")), ["storageZones.create", "scripts.create", "pullZones.create"]);
    assert.deepEqual(calls.find((c) => c[0] === "scripts.create")[1], { Name: "site", ScriptType: 1, CreateLinkedPullZone: false });
    const pullZoneCreate = calls.find((c) => c[0] === "pullZones.create")[1];
    assert.equal(pullZoneCreate.Name, "site");
    assert.equal(pullZoneCreate.OriginType, 4);
    assert.equal(pullZoneCreate.EdgeScriptId, 22);
    assert.equal(pullZoneCreate.DisableCookies, false);
    assert.equal(pullZoneCreate.EnableSmartCache, false);
    assert.equal(pullZoneCreate.CacheControlMaxAgeOverride, -1);
    assert.deepEqual(calls.find((c) => c[0] === "pullZones.setForceSsl").slice(1), [33, "site.b-cdn.net", true]);
    assert.deepEqual(names("pullZones.addOrUpdateEdgeRule").concat(names("pullZones.update")), []);
    assert.deepEqual(result.created, ["storage zone site", "script site", "pull zone site"]);
    assert.deepEqual(result.updated, []);
    assert.equal(result.hostname, "site.b-cdn.net");
    assert.equal(result.storageZone.ReadOnlyPassword, "ro");
  });

  it("warns that replication regions cannot be removed when it creates a zone with them", async () => {
    const { api } = fakeApi();
    const result = await provision({ api, config: { ...config, replicationRegions: ["UK"] }, pullZoneRequirements });
    assert.ok(result.warnings.some((w) => /UK.*cannot be removed/.test(w)));
  });
});

describe("provision with existing resources", () => {
  const existing = {
    storageZone: { Id: 11, Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [], Password: "pw", ReadOnlyPassword: "ro", StorageHostname: "storage.bunnycdn.com" },
    script: { Id: 22, Name: "site", ScriptType: 1 },
    pullZone: { Id: 33, Name: "site", OriginType: 4, EdgeScriptId: 22, StorageZoneId: -1, CacheControlMaxAgeOverride: -1, EnableSmartCache: false, DisableCookies: false, EnableCacheSlice: false, Hostnames: [{ Value: "site.b-cdn.net", ForceSSL: true, IsSystemHostname: true }, { Value: "www.example.com", ForceSSL: false }] },
  };

  it("creates nothing, updates nothing, and forces https on hostnames that do not have it yet", async () => {
    const { api, calls, names } = fakeApi(existing);
    const result = await provision({ api, config, pullZoneRequirements });
    assert.deepEqual(names("storageZones.create").concat(names("scripts.create"), names("pullZones.create"), names("pullZones.update")), []);
    assert.deepEqual(calls.filter((c) => c[0] === "pullZones.setForceSsl").map((c) => c[2]), ["www.example.com"]);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.warnings, []);
  });

  it("sets the settings the build requires in one update, and says which ones it changed", async () => {
    const { api, calls } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, DisableCookies: true, EnableSmartCache: true, CacheControlMaxAgeOverride: 2592000 } });
    const result = await provision({ api, config, pullZoneRequirements });
    const updates = calls.filter((c) => c[0] === "pullZones.update");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].slice(1), [33, { CacheControlMaxAgeOverride: -1, DisableCookies: false, EnableSmartCache: false }]);
    assert.equal(result.updated.length, 3);
    assert.ok(result.updated.some((u) => /DisableCookies.*true.*false/.test(u)));
    assert.ok(result.updated.some((u) => /CacheControlMaxAgeOverride.*2592000.*-1/.test(u)));
  });

  it("leaves a setting alone when the build does not name it", async () => {
    const { api, names } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, EnableCacheSlice: true } });
    await provision({ api, config, pullZoneRequirements });
    assert.deepEqual(names("pullZones.update"), []);
  });

  it("reads the storage zone by id when the listing leaves out the read-only password", async () => {
    const { ReadOnlyPassword, ...listed } = existing.storageZone;
    const { api } = fakeApi({ ...existing, storageZone: listed, storageZoneById: existing.storageZone });
    const result = await provision({ api, config, pullZoneRequirements });
    assert.equal(result.storageZone.ReadOnlyPassword, "ro");
  });

  it("reports drift on the storage zone region, tier and replication regions and does not touch them", async () => {
    const { api, names } = fakeApi({ ...existing, storageZone: { ...existing.storageZone, Region: "NY", ZoneTier: 1, ReplicationRegions: ["UK"] } });
    const result = await provision({ api, config: { ...config, replicationRegions: ["SE"] }, pullZoneRequirements });
    assert.deepEqual(names("storageZones.update"), []);
    assert.ok(result.drift.some((d) => /region.*NY.*DE/.test(d)));
    assert.ok(result.drift.some((d) => /tier.*edge.*standard/i.test(d)));
    assert.ok(result.drift.some((d) => /replication.*UK.*SE/.test(d)));
  });

  it("fails when the script that carries the name is not standalone, since a script's type is fixed", async () => {
    const { api } = fakeApi({ ...existing, script: { ...existing.script, ScriptType: 2 } });
    await assert.rejects(provision({ api, config, pullZoneRequirements }), /"site" .*not a standalone script/);
  });

  it("fails when the pull zone's origin is not this script, instead of repointing it", async () => {
    const { api } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, OriginType: 2, EdgeScriptId: 0, StorageZoneId: 11 } });
    await assert.rejects(provision({ api, config, pullZoneRequirements }), /origin.*not script 22/);
    const { api: other } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, EdgeScriptId: 99 } });
    await assert.rejects(provision({ api: other, config, pullZoneRequirements }), /script 99/);
  });
});
