import { desiredPullZoneSettings, desiredStorageZone, settingsDiff } from "./desired-state.js";

const TIER_NAMES = ["standard", "edge"];

// The pull zone API reports the request field EnableWebpVary as EnableWebPVary.
const RESPONSE_ALIASES = { EnableWebpVary: "EnableWebPVary" };

export async function provision({ api, config }) {
  const created = [];
  const drift = [];
  const warnings = [];

  const storageZone = await provisionStorageZone({ api, config, created, drift, warnings });
  const script = await provisionScript({ api, config, created });
  const { pullZone, updated } = await provisionPullZone({ api, config, storageZone, script, created });
  const hostname = await forceHttps({ api, pullZone });

  return { storageZone, script, pullZone, hostname, created, updated: { pullZone: updated }, drift, warnings };
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
  const extra = current.filter((region) => !desired.ReplicationRegions.includes(region));
  const missing = desired.ReplicationRegions.filter((region) => !current.includes(region));
  if (extra.length > 0) drift.push(`storage zone ${zone.Name} also has replication regions ${extra.join(", ")}, which cannot be removed`);
  if (missing.length > 0) {
    await api.storageZones.update(zone.Id, { ReplicationZones: [...current, ...missing] });
    warnings.push(`added replication regions ${missing.join(", ")} to storage zone ${zone.Name}; they cannot be removed later`);
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

async function provisionPullZone({ api, config, storageZone, script, created }) {
  const desired = desiredPullZoneSettings({
    storageZoneId: storageZone.Id,
    scriptId: script.Id,
    pricingTier: config.pricingTier,
    pricingRegions: config.pricingRegions,
    staleWhileUpdating: config.staleWhileUpdating,
    monthlyBandwidthLimit: config.monthlyBandwidthLimit,
  });
  let pullZone = await api.pullZones.findByName(config.pullZoneName);
  if (!pullZone) {
    pullZone = await api.pullZones.create({ Name: config.pullZoneName, ...desired });
    created.push(`pull zone ${config.pullZoneName}`);
    return { pullZone, updated: [] };
  }
  if (pullZone.StorageZoneId !== storageZone.Id && pullZone.StorageZoneId > 0) {
    throw new Error(`pull zone "${config.pullZoneName}" uses storage zone ${pullZone.StorageZoneId} as origin, not ${storageZone.Id} (${storageZone.Name}); repointing an origin is not done automatically`);
  }
  const current = Object.fromEntries(Object.keys(desired).map((key) => [key, pullZone[RESPONSE_ALIASES[key] ?? key]]));
  const changes = settingsDiff(current, desired);
  const updated = Object.keys(changes);
  if (updated.length > 0) await api.pullZones.update(pullZone.Id, changes);
  return { pullZone, updated };
}

async function forceHttps({ api, pullZone }) {
  const { Hostnames: hostnames } = await api.pullZones.get(pullZone.Id);
  for (const hostname of hostnames) {
    if (!hostname.ForceSSL) await api.pullZones.setForceSsl(pullZone.Id, hostname.Value, true);
  }
  return hostnames.find((h) => h.IsSystemHostname)?.Value ?? hostnames[0]?.Value;
}
