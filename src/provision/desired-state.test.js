import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredPullZoneSettings, desiredStorageZone, settingsDiff } from "./desired-state.js";

describe("desiredStorageZone", () => {
  it("defaults to Frankfurt, standard tier, no replication", () => {
    assert.deepEqual(desiredStorageZone({ name: "site" }), { Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [] });
  });

  it("takes region, tier and replication overrides", () => {
    assert.deepEqual(desiredStorageZone({ name: "site", region: "NY", tier: "edge", replicationRegions: ["UK", "SE"] }), { Name: "site", Region: "NY", ZoneTier: 1, ReplicationRegions: ["UK", "SE"] });
  });
});

describe("desiredPullZoneSettings", () => {
  const settings = desiredPullZoneSettings({ storageZoneId: 11, scriptId: 22 });

  it("uses the storage zone as origin with the script as post-cache middleware", () => {
    assert.equal(settings.OriginType, 2);
    assert.equal(settings.StorageZoneId, 11);
    assert.equal(settings.MiddlewareScriptId, 22);
    assert.equal(settings.EdgeScriptExecutionPhase, 0);
  });

  it("follows origin cache headers and keeps the app's cookies and query strings", () => {
    assert.equal(settings.EnableSmartCache, false);
    assert.equal(settings.CacheControlMaxAgeOverride, -1);
    assert.equal(settings.CacheControlPublicMaxAgeOverride, -1);
    assert.equal(settings.DisableCookies, false);
    assert.equal(settings.IgnoreQueryStrings, false);
    assert.equal(settings.CacheErrorResponses, false);
  });

  it("adds no headers or cache variants of its own", () => {
    for (const key of ["EnableAccessControlOriginHeader", "AddCanonicalHeader", "EnableWebpVary", "EnableAvifVary", "EnableCountryCodeVary", "EnableMobileVary", "EnableHostnameVary", "EnableCookieVary"]) {
      assert.equal(settings[key], false, key);
    }
  });

  it("serves stale while the origin is offline but not while updating, unless asked", () => {
    assert.equal(settings.UseStaleWhileOffline, true);
    assert.equal(settings.UseStaleWhileUpdating, false);
    assert.equal(desiredPullZoneSettings({ storageZoneId: 1, scriptId: 2, staleWhileUpdating: true }).UseStaleWhileUpdating, true);
  });

  it("keeps paid add-ons off, logging anonymized, and no bandwidth limit", () => {
    assert.equal(settings.OptimizerEnabled, false);
    assert.equal(settings.EnableOriginShield, false);
    assert.equal(settings.PermaCacheStorageZoneId, 0);
    assert.equal(settings.LoggingSaveToStorage, false);
    assert.equal(settings.LoggingIPAnonymizationEnabled, true);
    assert.equal(settings.MonthlyBandwidthLimit, 0);
    assert.equal(desiredPullZoneSettings({ storageZoneId: 1, scriptId: 2, monthlyBandwidthLimit: 5e9 }).MonthlyBandwidthLimit, 5e9);
  });

  it("enables only Europe on the standard tier by default, and maps pricing regions and tier inputs", () => {
    assert.equal(settings.Type, 0);
    assert.deepEqual([settings.EnableGeoZoneEU, settings.EnableGeoZoneUS, settings.EnableGeoZoneASIA, settings.EnableGeoZoneSA, settings.EnableGeoZoneAF], [true, false, false, false, false]);
    const custom = desiredPullZoneSettings({ storageZoneId: 1, scriptId: 2, pricingRegions: ["EU", "US"], pricingTier: "volume" });
    assert.equal(custom.Type, 1);
    assert.deepEqual([custom.EnableGeoZoneEU, custom.EnableGeoZoneUS, custom.EnableGeoZoneASIA], [true, true, false]);
  });

  it("disables TLS 1.0 and 1.1", () => {
    assert.equal(settings.EnableTLS1, false);
    assert.equal(settings.EnableTLS1_1, false);
  });
});

describe("settingsDiff", () => {
  it("returns only the keys whose current value differs", () => {
    const current = { A: 1, B: "x", C: true, D: 5 };
    assert.deepEqual(settingsDiff(current, { A: 1, B: "y", C: false, D: 5 }), { B: "y", C: false });
  });
});
