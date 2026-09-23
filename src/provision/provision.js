import { desiredPullZoneSettings, desiredStorageZone } from "./desired-state.js";

const TIER_NAMES = ["standard", "edge"];

// The retention state file lives in the storage zone, which the pull zone serves; this rule keeps it private.
export const STATE_BLOCK_RULE = { Description: "bunny-edge-deploy: block deploy state", ActionType: 4, Enabled: true, TriggerMatchingType: 0, Triggers: [{ Type: 0, PatternMatches: ["*/.bunny-edge-deploy/*"], PatternMatchingType: 0 }] };

export async function provision({ api, config }) {
  const created = [];
  const drift = [];
  const warnings = [];

  const storageZone = await provisionStorageZone({ api, config, created, drift, warnings });
  const script = await provisionScript({ api, config, created });
  const pullZone = await provisionPullZone({ api, config, storageZone, script, created, warnings });
  const hostname = await forceHttps({ api, pullZone });

  return { storageZone, script, pullZone, hostname, created, drift, warnings };
}

async function provisionStorageZone({ api, config, created, drift, warnings }) {
  const desired = desiredStorageZone({ name: config.storageZoneName, region: config.storageRegion, tier: config.storageTier, replicationRegions: config.replicationRegions });
  let zone = await api.storageZones.findByName(desired.Name);
  if (!zone) {
    zone = await api.storageZones.create(desired);
    created.push(`storage zone ${desired.Name}`);
    if (desired.ReplicationRegions.length > 0) warnings.push(`storage zone ${desired.Name} replicates to ${desired.ReplicationRegions.join(", ")}; replication regions cannot be removed later`);
    return zone;
  }
  if (zone.Region !== desired.Region) drift.push(`storage zone ${zone.Name} is in region ${zone.Region}, configured ${desired.Region}; the region cannot be changed`);
  if (zone.ZoneTier !== desired.ZoneTier) drift.push(`storage zone ${zone.Name} tier is ${TIER_NAMES[zone.ZoneTier]}, configured ${TIER_NAMES[desired.ZoneTier]}; the tier cannot be changed`);
  const current = zone.ReplicationRegions ?? [];
  if ([...current].sort().join() !== [...desired.ReplicationRegions].sort().join()) {
    drift.push(`storage zone ${zone.Name} replication regions are ${current.join(", ") || "none"}, configured ${desired.ReplicationRegions.join(", ") || "none"}; change them in the dashboard, existing regions cannot be removed`);
  }
  return zone;
}

async function provisionScript({ api, config, created }) {
  let script = await api.scripts.findByName(config.scriptName);
  if (!script) {
    script = await api.scripts.create({ Name: config.scriptName, ScriptType: 2, CreateLinkedPullZone: false });
    created.push(`script ${config.scriptName}`);
  } else if (script.ScriptType !== 2) {
    throw new Error(`script "${config.scriptName}" exists but is not a middleware script (ScriptType ${script.ScriptType}); rename it or use another script-name`);
  }
  return script;
}

async function provisionPullZone({ api, config, storageZone, script, created, warnings }) {
  let pullZone = await api.pullZones.findByName(config.pullZoneName);
  if (!pullZone) {
    const desired = desiredPullZoneSettings({
      storageZoneId: storageZone.Id,
      scriptId: script.Id,
      pricingTier: config.pricingTier,
      pricingRegions: config.pricingRegions,
      staleWhileUpdating: config.staleWhileUpdating,
      monthlyBandwidthLimit: config.monthlyBandwidthLimit,
    });
    pullZone = await api.pullZones.create({ Name: config.pullZoneName, ...desired });
    await api.pullZones.addOrUpdateEdgeRule(pullZone.Id, STATE_BLOCK_RULE);
    created.push(`pull zone ${config.pullZoneName}`);
    return pullZone;
  }
  const name = `pull zone "${config.pullZoneName}"`;
  if (pullZone.StorageZoneId !== storageZone.Id && pullZone.StorageZoneId > 0) {
    throw new Error(`${name} uses storage zone ${pullZone.StorageZoneId} as origin, not ${storageZone.Id} (${storageZone.Name}); repointing an origin is not done automatically`);
  }
  if (pullZone.MiddlewareScriptId > 0 && pullZone.MiddlewareScriptId !== script.Id) {
    throw new Error(`${name} has middleware script ${pullZone.MiddlewareScriptId} attached, not ${script.Id} (${script.Name}); detach it in the dashboard first`);
  }
  if (pullZone.CacheControlMaxAgeOverride !== -1) {
    throw new Error(`${name} has Cache Expiration Time overridden to ${pullZone.CacheControlMaxAgeOverride} s; set it to "Respect origin Cache-Control" in the dashboard (Caching > General), otherwise rendered responses are cached regardless of their headers`);
  }
  if (!(pullZone.MiddlewareScriptId > 0)) await api.pullZones.update(pullZone.Id, { MiddlewareScriptId: script.Id });
  if (pullZone.EnableSmartCache) warnings.push(`${name} has Smart Cache on, so HTML and JSON responses are never cached`);
  if (pullZone.DisableCookies) warnings.push(`${name} strips Set-Cookie headers (Caching > Disable Cookies), so the app cannot set cookies`);
  if (pullZone.EdgeScriptExecutionPhase === 2) warnings.push(`${name} runs the script before cache, so it runs on every request including cache hits`);
  if (!(pullZone.EdgeRules ?? []).some((rule) => rule.Description === STATE_BLOCK_RULE.Description && rule.Enabled)) {
    warnings.push(`${name} no longer blocks /.bunny-edge-deploy/, so the deploy state file is public; re-add a Block Request edge rule for */.bunny-edge-deploy/*`);
  }
  return pullZone;
}

async function forceHttps({ api, pullZone }) {
  const { Hostnames: hostnames } = await api.pullZones.get(pullZone.Id);
  for (const hostname of hostnames) {
    if (!hostname.ForceSSL) await api.pullZones.setForceSsl(pullZone.Id, hostname.Value, true);
  }
  return hostnames.find((h) => h.IsSystemHostname)?.Value ?? hostnames[0]?.Value;
}
