const TIERS = { standard: 0, edge: 1 };
const PRICING_TIERS = { standard: 0, volume: 1 };
const GEO_ZONES = { EU: "EnableGeoZoneEU", US: "EnableGeoZoneUS", ASIA: "EnableGeoZoneASIA", SA: "EnableGeoZoneSA", AF: "EnableGeoZoneAF" };
const REQUIRED_SETTINGS = { disableCookies: "DisableCookies", enableSmartCache: "EnableSmartCache", enableCacheSlice: "EnableCacheSlice" };

export function desiredStorageZone({ name, region = "DE", tier = "standard", replicationRegions = [] }) {
  return { Name: name, Region: region, ZoneTier: TIERS[tier], ReplicationRegions: replicationRegions };
}

// -1 makes the zone follow the script's Cache-Control; any other value caches every response that long, private ones included.
export function requiredPullZoneSettings(requirements = {}) {
  const named = Object.entries(REQUIRED_SETTINGS).filter(([key]) => typeof requirements[key] === "boolean").map(([key, field]) => [field, requirements[key]]);
  return { CacheControlMaxAgeOverride: -1, ...Object.fromEntries(named) };
}

function commonPullZoneSettings({ pricingTier = "standard", pricingRegions = ["EU"], staleWhileUpdating = false, monthlyBandwidthLimit = 0 }) {
  const geoZones = Object.fromEntries(Object.entries(GEO_ZONES).map(([region, key]) => [key, pricingRegions.includes(region)]));
  return {
    Type: PRICING_TIERS[pricingTier],
    ...geoZones,
    EnableSmartCache: false,
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

export function desiredPullZoneSettings({ scriptId, requirements = {}, ...options }) {
  return {
    OriginType: 4,
    EdgeScriptId: scriptId,
    ...commonPullZoneSettings(options),
    CacheControlMaxAgeOverride: -1,
    CacheControlPublicMaxAgeOverride: -1,
    ...requiredPullZoneSettings(requirements),
  };
}

// Storage sends no Cache-Control, so the zone sets it: the edge keeps files until the next publish purges them, browsers revalidate.
export const STATIC_CACHE_SETTINGS = { CacheControlMaxAgeOverride: 2592000, CacheControlPublicMaxAgeOverride: 0 };

export function desiredStaticPullZoneSettings({ storageZoneId, ...options }) {
  return { OriginType: 2, StorageZoneId: storageZoneId, ...commonPullZoneSettings(options), ...STATIC_CACHE_SETTINGS };
}
