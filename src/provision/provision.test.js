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
  });
});

describe("provision with existing resources", () => {
  const existing = {
    storageZone: { Id: 11, Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [], Password: "pw", StorageHostname: "storage.bunnycdn.com" },
    script: { Id: 22, Name: "site", ScriptType: 2 },
    pullZone: { Id: 33, Name: "site", OriginType: 2, StorageZoneId: 11, MiddlewareScriptId: 22, EdgeScriptExecutionPhase: 0, Type: 0, EnableSmartCache: false, CacheControlMaxAgeOverride: 2592000, DisableCookies: true, Hostnames: [{ Value: "site.b-cdn.net", ForceSSL: true, IsSystemHostname: true }, { Value: "www.example.com", ForceSSL: false }] },
  };

  it("creates nothing and updates only the pull zone settings that differ", async () => {
    const { api, calls, names } = fakeApi(existing);
    const result = await provision({ api, config });
    assert.deepEqual(names("storageZones.create").concat(names("scripts.create"), names("pullZones.create")), []);
    const update = calls.find((c) => c[0] === "pullZones.update");
    assert.equal(update[1], 33);
    assert.equal(update[2].CacheControlMaxAgeOverride, -1);
    assert.equal(update[2].DisableCookies, false);
    assert.equal("StorageZoneId" in update[2], false);
    assert.deepEqual(result.created, []);
    assert.ok(result.updated.pullZone.includes("CacheControlMaxAgeOverride"));
  });

  it("forces https only on hostnames that do not have it yet", async () => {
    const { api, calls } = fakeApi(existing);
    await provision({ api, config });
    const forced = calls.filter((c) => c[0] === "pullZones.setForceSsl").map((c) => c[2]);
    assert.deepEqual(forced, ["www.example.com"]);
  });

  it("never updates when nothing differs", async () => {
    const { api, names } = fakeApi({ ...existing, pullZone: { ...existing.pullZone, ...fullyProvisioned() } });
    const result = await provision({ api, config });
    assert.deepEqual(names("pullZones.update"), []);
    assert.deepEqual(names("pullZones.addOrUpdateEdgeRule"), []);
    assert.deepEqual(result.updated.pullZone, []);
  });

  it("adds the edge rule that blocks the deploy state path when it is missing", async () => {
    const { api, calls } = fakeApi(existing);
    const result = await provision({ api, config });
    const rule = calls.find((c) => c[0] === "pullZones.addOrUpdateEdgeRule");
    assert.equal(rule[1], 33);
    assert.equal(rule[2].ActionType, 4);
    assert.deepEqual(rule[2].Triggers[0].PatternMatches, ["*/.bunny-edge-deploy/*"]);
    assert.ok(result.updated.pullZone.includes("edge rule: block deploy state"));
  });

  it("reports drift on the storage zone region and tier, since they cannot be changed, and does not touch them", async () => {
    const { api, names } = fakeApi({ ...existing, storageZone: { ...existing.storageZone, Region: "NY", ZoneTier: 1 } });
    const result = await provision({ api, config });
    assert.deepEqual(names("storageZones.update"), []);
    assert.ok(result.drift.some((d) => /region.*NY.*DE/.test(d)));
    assert.ok(result.drift.some((d) => /tier.*edge.*standard/i.test(d)));
  });

  it("reports replication regions on the zone that were not asked for, and adds requested ones with an irreversibility warning", async () => {
    const { api, calls } = fakeApi({ ...existing, storageZone: { ...existing.storageZone, ReplicationRegions: ["UK"] } });
    const result = await provision({ api, config: { ...config, replicationRegions: ["SE"] } });
    assert.ok(result.drift.some((d) => /replication.*UK/.test(d)));
    assert.deepEqual(calls.find((c) => c[0] === "storageZones.update").slice(1), [11, { ReplicationZones: ["UK", "SE"] }]);
    assert.ok(result.warnings.some((w) => /SE.*cannot be removed/.test(w)));
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

function fullyProvisioned() {
  return { EdgeRules: [{ Description: "bunny-edge-deploy: block deploy state", Enabled: true }], CacheControlMaxAgeOverride: -1, CacheControlPublicMaxAgeOverride: -1, DisableCookies: false, IgnoreQueryStrings: false, EnableGeoZoneEU: true, EnableGeoZoneUS: false, EnableGeoZoneASIA: false, EnableGeoZoneSA: false, EnableGeoZoneAF: false, EnableAccessControlOriginHeader: false, AddCanonicalHeader: false, EnableWebPVary: false, EnableAvifVary: false, EnableCountryCodeVary: false, EnableMobileVary: false, EnableHostnameVary: false, EnableCookieVary: false, CacheErrorResponses: false, UseStaleWhileOffline: true, UseStaleWhileUpdating: false, EnableTLS1: false, EnableTLS1_1: false, EnableOriginShield: false, OptimizerEnabled: false, PermaCacheStorageZoneId: 0, LoggingSaveToStorage: false, LoggingIPAnonymizationEnabled: true, MonthlyBandwidthLimit: 0 };
}
