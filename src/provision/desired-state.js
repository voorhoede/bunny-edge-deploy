const TIERS = { standard: 0, edge: 1 };
const PRICING_TIERS = { standard: 0, volume: 1 };
const GEO_ZONES = { EU: "EnableGeoZoneEU", US: "EnableGeoZoneUS", ASIA: "EnableGeoZoneASIA", SA: "EnableGeoZoneSA", AF: "EnableGeoZoneAF" };

export function desiredStorageZone({ name, region = "DE", tier = "standard", replicationRegions = [] }) {
  return { Name: name, Region: region, ZoneTier: TIERS[tier], ReplicationRegions: replicationRegions };
}

export function desiredPullZoneSettings({ storageZoneId, scriptId, pricingTier = "standard", pricingRegions = ["EU"], staleWhileUpdating = false, monthlyBandwidthLimit = 0 }) {
  const geoZones = Object.fromEntries(Object.entries(GEO_ZONES).map(([region, key]) => [key, pricingRegions.includes(region)]));
  return {
    OriginType: 2,
    StorageZoneId: storageZoneId,
    MiddlewareScriptId: scriptId,
    EdgeScriptExecutionPhase: 0,
    Type: PRICING_TIERS[pricingTier],
    ...geoZones,
    EnableSmartCache: false,
    CacheControlMaxAgeOverride: -1,
    CacheControlPublicMaxAgeOverride: -1,
    DisableCookies: false,
    IgnoreQueryStrings: false,
    CacheErrorResponses: false,
    EnableAccessControlOriginHeader: false,
    AddCanonicalHeader: false,
    EnableWebpVary: false,
    EnableAvifVary: false,
    EnableCountryCodeVary: false,
    EnableMobileVary: false,
    EnableHostnameVary: false,
    EnableCookieVary: false,
    UseStaleWhileOffline: true,
    UseStaleWhileUpdating: staleWhileUpdating,
    EnableTLS1: false,
    EnableTLS1_1: false,
    EnableOriginShield: false,
    OptimizerEnabled: false,
    PermaCacheStorageZoneId: 0,
    LoggingSaveToStorage: false,
    LoggingIPAnonymizationEnabled: true,
    MonthlyBandwidthLimit: monthlyBandwidthLimit,
  };
}
