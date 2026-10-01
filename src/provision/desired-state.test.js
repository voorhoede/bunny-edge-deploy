import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STATIC_CACHE_SETTINGS, desiredMiddlewarePullZoneSettings, desiredPullZoneSettings, desiredStaticPullZoneSettings, desiredStorageZone, requiredPullZoneSettings } from "./desired-state.js";

describe("desiredStorageZone", () => {
  it("defaults to Frankfurt, standard tier, no replication", () => {
    assert.deepEqual(desiredStorageZone({ name: "site" }), { Name: "site", Region: "DE", ZoneTier: 0, ReplicationRegions: [] });
  });

  it("takes region, tier and replication overrides", () => {
    assert.deepEqual(desiredStorageZone({ name: "site", region: "NY", tier: "edge", replicationRegions: ["UK", "SE"] }), { Name: "site", Region: "NY", ZoneTier: 1, ReplicationRegions: ["UK", "SE"] });
  });
});

describe("desiredPullZoneSettings", () => {
  const settings = desiredPullZoneSettings({ scriptId: 22 });

  it("uses the script as origin, with no storage zone or middleware", () => {
    assert.equal(settings.OriginType, 4);
    assert.equal(settings.EdgeScriptId, 22);
    for (const key of ["StorageZoneId", "MiddlewareScriptId", "EdgeScriptExecutionPhase"]) assert.equal(key in settings, false, key);
  });

  it("takes the settings a build requires over its own defaults", () => {
    const required = desiredPullZoneSettings({ scriptId: 22, requirements: { disableCookies: true, enableCacheSlice: true } });
    assert.equal(required.DisableCookies, true);
    assert.equal(required.EnableCacheSlice, true);
    assert.equal(required.CacheControlMaxAgeOverride, -1);
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
    assert.equal(desiredPullZoneSettings({ scriptId: 2, staleWhileUpdating: true }).UseStaleWhileUpdating, true);
  });

  it("keeps paid add-ons off, logging anonymized, and no bandwidth limit", () => {
    assert.equal(settings.OptimizerEnabled, false);
    assert.equal(settings.EnableOriginShield, false);
    assert.equal(settings.PermaCacheStorageZoneId, 0);
    assert.equal(settings.LoggingSaveToStorage, false);
    assert.equal(settings.LoggingIPAnonymizationEnabled, true);
    assert.equal(settings.MonthlyBandwidthLimit, 0);
    assert.equal(desiredPullZoneSettings({ scriptId: 2, monthlyBandwidthLimit: 5e9 }).MonthlyBandwidthLimit, 5e9);
  });

  it("enables only Europe on the standard tier by default, and maps pricing regions and tier inputs", () => {
    assert.equal(settings.Type, 0);
    assert.deepEqual([settings.EnableGeoZoneEU, settings.EnableGeoZoneUS, settings.EnableGeoZoneASIA, settings.EnableGeoZoneSA, settings.EnableGeoZoneAF], [true, false, false, false, false]);
    const custom = desiredPullZoneSettings({ scriptId: 2, pricingRegions: ["EU", "US"], pricingTier: "volume" });
    assert.equal(custom.Type, 1);
    assert.deepEqual([custom.EnableGeoZoneEU, custom.EnableGeoZoneUS, custom.EnableGeoZoneASIA], [true, true, false]);
  });

  it("disables TLS 1.0 and 1.1", () => {
    assert.equal(settings.EnableTLS1, false);
    assert.equal(settings.EnableTLS1_1, false);
  });
});

describe("requiredPullZoneSettings", () => {
  it("always turns the cache expiration override off, and maps only the settings a build names", () => {
    assert.deepEqual(requiredPullZoneSettings({}), { CacheControlMaxAgeOverride: -1 });
    assert.deepEqual(requiredPullZoneSettings({ disableCookies: false, enableSmartCache: false, enableCacheSlice: true }), { CacheControlMaxAgeOverride: -1, DisableCookies: false, EnableSmartCache: false, EnableCacheSlice: true });
  });
});

describe("desiredStaticPullZoneSettings", () => {
  const settings = desiredStaticPullZoneSettings({ storageZoneId: 11 });

  it("serves the storage zone, kept 30 days at the edge and revalidated by browsers", () => {
    assert.equal(settings.OriginType, 2);
    assert.equal(settings.StorageZoneId, 11);
    assert.equal("EdgeScriptId" in settings, false);
    assert.deepEqual(STATIC_CACHE_SETTINGS, { CacheControlMaxAgeOverride: 2592000, CacheControlPublicMaxAgeOverride: 0 });
    assert.equal(settings.CacheControlMaxAgeOverride, 2592000);
    assert.equal(settings.CacheControlPublicMaxAgeOverride, 0);
  });

  it("shares every other default with a zone that runs a script", () => {
    const script = desiredPullZoneSettings({ scriptId: 22, pricingRegions: ["EU", "US"] });
    const staticSite = desiredStaticPullZoneSettings({ storageZoneId: 11, pricingRegions: ["EU", "US"] });
    for (const key of ["OriginType", "EdgeScriptId", "StorageZoneId", "CacheControlMaxAgeOverride", "CacheControlPublicMaxAgeOverride"]) {
      delete script[key];
      delete staticSite[key];
    }
    assert.deepEqual(staticSite, script);
  });
});

describe("desiredMiddlewarePullZoneSettings", () => {
  const settings = desiredMiddlewarePullZoneSettings({ storageZoneId: 11, scriptId: 22, requirements: { disableCookies: false, enableCacheSlice: true } });

  it("serves the storage zone, with the script attached as middleware after the cache", () => {
    assert.equal(settings.OriginType, 2);
    assert.equal(settings.StorageZoneId, 11);
    assert.equal(settings.MiddlewareScriptId, 22);
    assert.equal(settings.EdgeScriptExecutionPhase, 0);
    assert.equal("EdgeScriptId" in settings, false);
  });

  it("follows the script's Cache-Control, and takes the settings the build requires", () => {
    assert.equal(settings.CacheControlMaxAgeOverride, -1);
    assert.equal(settings.CacheControlPublicMaxAgeOverride, -1);
    assert.equal(settings.DisableCookies, false);
    assert.equal(settings.EnableCacheSlice, true);
  });

  it("shares every other default with a zone that runs a standalone script", () => {
    const standalone = desiredPullZoneSettings({ scriptId: 22, pricingRegions: ["EU", "US"] });
    const middleware = desiredMiddlewarePullZoneSettings({ storageZoneId: 11, scriptId: 22, pricingRegions: ["EU", "US"] });
    for (const key of ["OriginType", "EdgeScriptId", "StorageZoneId", "MiddlewareScriptId", "EdgeScriptExecutionPhase"]) {
      delete standalone[key];
      delete middleware[key];
    }
    assert.deepEqual(middleware, standalone);
  });
});
