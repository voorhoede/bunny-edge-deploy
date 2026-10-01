import { MIDDLEWARE_SETTINGS, STATIC_CACHE_SETTINGS, desiredMiddlewarePullZoneSettings, desiredPullZoneSettings, desiredStaticPullZoneSettings, desiredStorageZone, requiredPullZoneSettings } from "./desired-state.js";

const TIER_NAMES = ["standard", "edge"];
const STANDALONE = 1;
const MIDDLEWARE = 2;
const SCRIPT_TYPE_NAMES = { [STANDALONE]: "standalone", [MIDDLEWARE]: "middleware" };
const EDGE_SCRIPT_ORIGIN = 4;
const STORAGE_ORIGIN = 2;

export async function provision({ api, config, pullZoneRequirements = {} }) {
  const created = [];
  const updated = [];
  const drift = [];
  const warnings = [];

  const storageZone = await provisionStorageZone({ api, config, created, drift, warnings });
  const script = await provisionScript({ api, config, scriptType: STANDALONE, created });
  const pullZone = await provisionPullZone({ api, config, script, pullZoneRequirements, created, updated });
  const hostname = await forceHttps({ api, pullZone });

  return { storageZone, script, pullZone, hostname, created, updated, drift, warnings };
}

export async function provisionMiddleware({ api, config, pullZoneRequirements = {} }) {
  const created = [];
  const updated = [];
  const drift = [];
  const warnings = [];

  const storageZone = await provisionStorageZone({ api, config, created, drift, warnings });
  const script = await provisionScript({ api, config, scriptType: MIDDLEWARE, created });
  const pullZone = await provisionMiddlewarePullZone({ api, config, storageZone, script, pullZoneRequirements, created, updated });
  const hostname = await forceHttps({ api, pullZone });

  return { storageZone, script, pullZone, hostname, created, updated, drift, warnings };
}

export async function provisionStatic({ api, config }) {
  const created = [];
  const updated = [];
  const drift = [];
  const warnings = [];

  const storageZone = await provisionStorageZone({ api, config, created, drift, warnings });
  const pullZone = await provisionStaticPullZone({ api, config, storageZone, created, updated });
  const hostname = await forceHttps({ api, pullZone });

  return { storageZone, pullZone, hostname, created, updated, drift, warnings };
}

async function provisionStorageZone({ api, config, created, drift, warnings }) {
  const desired = desiredStorageZone({ name: config.storageZoneName, region: config.storageRegion, tier: config.storageTier, replicationRegions: config.replicationRegions });
  const zone = await api.storageZones.findByName(desired.Name);
  if (!zone) {
    const createdZone = await api.storageZones.create(desired);
    created.push(`storage zone ${desired.Name}`);
    if (desired.ReplicationRegions.length > 0) warnings.push(`storage zone ${desired.Name} replicates to ${desired.ReplicationRegions.join(", ")}; replication regions cannot be removed later`);
    return createdZone;
  }
  if (zone.Region !== desired.Region) drift.push(`storage zone ${zone.Name} is in region ${zone.Region}, configured ${desired.Region}; the region cannot be changed`);
  if (zone.ZoneTier !== desired.ZoneTier) drift.push(`storage zone ${zone.Name} tier is ${TIER_NAMES[zone.ZoneTier]}, configured ${TIER_NAMES[desired.ZoneTier]}; the tier cannot be changed`);
  const current = zone.ReplicationRegions ?? [];
  if ([...current].sort().join() !== [...desired.ReplicationRegions].sort().join()) {
    drift.push(`storage zone ${zone.Name} replication regions are ${current.join(", ") || "none"}, configured ${desired.ReplicationRegions.join(", ") || "none"}; change them in the dashboard, existing regions cannot be removed`);
  }
  return zone.ReadOnlyPassword ? zone : api.storageZones.get(zone.Id);
}

async function provisionScript({ api, config, scriptType, created }) {
  let script = await api.scripts.findByName(config.scriptName);
  if (!script) {
    script = await api.scripts.create({ Name: config.scriptName, ScriptType: scriptType, CreateLinkedPullZone: false });
    created.push(`script ${config.scriptName}`);
  } else if (script.ScriptType !== scriptType) {
    throw new Error(`script "${config.scriptName}" exists but is not a ${SCRIPT_TYPE_NAMES[scriptType]} script (ScriptType ${script.ScriptType}), and a script's type cannot be changed; rename it or use another script-name`);
  }
  return script;
}

async function provisionPullZone({ api, config, script, pullZoneRequirements, created, updated }) {
  const pullZone = await api.pullZones.findByName(config.pullZoneName);
  if (!pullZone) {
    const desired = desiredPullZoneSettings({
      scriptId: script.Id,
      requirements: pullZoneRequirements,
      pricingTier: config.pricingTier,
      pricingRegions: config.pricingRegions,
      staleWhileUpdating: config.staleWhileUpdating,
      monthlyBandwidthLimit: config.monthlyBandwidthLimit,
    });
    const createdZone = await api.pullZones.create({ Name: config.pullZoneName, ...desired });
    created.push(`pull zone ${config.pullZoneName}`);
    return createdZone;
  }
  const name = `pull zone "${config.pullZoneName}"`;
  if (pullZone.OriginType !== EDGE_SCRIPT_ORIGIN) {
    throw new Error(`${name} has another origin (OriginType ${pullZone.OriginType}), not script ${script.Id} (${script.Name}); an origin is not repointed automatically, use another pull-zone-name`);
  }
  if (pullZone.EdgeScriptId !== script.Id) {
    throw new Error(`${name} runs script ${pullZone.EdgeScriptId} as its origin, not script ${script.Id} (${script.Name}); an origin is not repointed automatically, use another pull-zone-name`);
  }
  return applySettings({ api, config, pullZone, settings: requiredPullZoneSettings(pullZoneRequirements), updated });
}

async function provisionMiddlewarePullZone({ api, config, storageZone, script, pullZoneRequirements, created, updated }) {
  const pullZone = await api.pullZones.findByName(config.pullZoneName);
  if (!pullZone) {
    const desired = desiredMiddlewarePullZoneSettings({
      storageZoneId: storageZone.Id,
      scriptId: script.Id,
      requirements: pullZoneRequirements,
      pricingTier: config.pricingTier,
      pricingRegions: config.pricingRegions,
      staleWhileUpdating: config.staleWhileUpdating,
      monthlyBandwidthLimit: config.monthlyBandwidthLimit,
    });
    const createdZone = await api.pullZones.create({ Name: config.pullZoneName, ...desired });
    created.push(`pull zone ${config.pullZoneName}`);
    return createdZone;
  }
  const name = `pull zone "${config.pullZoneName}"`;
  if (pullZone.OriginType !== STORAGE_ORIGIN) {
    throw new Error(`${name} has another origin (OriginType ${pullZone.OriginType}), not storage zone ${storageZone.Id} (${storageZone.Name}); an origin is not repointed automatically, use another pull-zone-name`);
  }
  if (pullZone.StorageZoneId !== storageZone.Id) {
    throw new Error(`${name} serves storage zone ${pullZone.StorageZoneId}, not ${storageZone.Id} (${storageZone.Name}); an origin is not repointed automatically, use another pull-zone-name`);
  }
  if (!pullZone.MiddlewareScriptId) {
    throw new Error(`${name} has no middleware script, so it serves the storage zone as files; attach script ${script.Id} (${script.Name}) in the Bunny dashboard or use another pull-zone-name`);
  }
  if (pullZone.MiddlewareScriptId !== script.Id) {
    throw new Error(`${name} runs middleware script ${pullZone.MiddlewareScriptId}, not script ${script.Id} (${script.Name}); a middleware is not swapped automatically, use another pull-zone-name`);
  }
  return applySettings({ api, config, pullZone, settings: { ...requiredPullZoneSettings(pullZoneRequirements), ...MIDDLEWARE_SETTINGS }, updated });
}

async function provisionStaticPullZone({ api, config, storageZone, created, updated }) {
  const pullZone = await api.pullZones.findByName(config.pullZoneName);
  if (!pullZone) {
    const desired = desiredStaticPullZoneSettings({
      storageZoneId: storageZone.Id,
      pricingTier: config.pricingTier,
      pricingRegions: config.pricingRegions,
      staleWhileUpdating: config.staleWhileUpdating,
      monthlyBandwidthLimit: config.monthlyBandwidthLimit,
    });
    const createdZone = await api.pullZones.create({ Name: config.pullZoneName, ...desired });
    created.push(`pull zone ${config.pullZoneName}`);
    return createdZone;
  }
  const name = `pull zone "${config.pullZoneName}"`;
  if (pullZone.OriginType !== STORAGE_ORIGIN) {
    throw new Error(`${name} has another origin (OriginType ${pullZone.OriginType}), not storage zone ${storageZone.Id} (${storageZone.Name}); an origin is not repointed automatically, use another pull-zone-name`);
  }
  if (pullZone.StorageZoneId !== storageZone.Id) {
    throw new Error(`${name} serves storage zone ${pullZone.StorageZoneId}, not ${storageZone.Id} (${storageZone.Name}); an origin is not repointed automatically, use another pull-zone-name`);
  }
  if (pullZone.MiddlewareScriptId) {
    throw new Error(`${name} still runs middleware script ${pullZone.MiddlewareScriptId} from an earlier setup, which would run on every request of the static site; detach it in the Bunny dashboard or use another pull-zone-name`);
  }
  return applySettings({ api, config, pullZone, settings: STATIC_CACHE_SETTINGS, updated });
}

async function applySettings({ api, config, pullZone, settings, updated }) {
  const changes = Object.fromEntries(Object.entries(settings).filter(([field, value]) => pullZone[field] !== value));
  if (Object.keys(changes).length === 0) return pullZone;
  await api.pullZones.update(pullZone.Id, changes);
  for (const [field, value] of Object.entries(changes)) updated.push(`pull zone ${config.pullZoneName}: ${field} ${pullZone[field]} -> ${value}`);
  return { ...pullZone, ...changes };
}

async function forceHttps({ api, pullZone }) {
  const { Hostnames: hostnames } = await api.pullZones.get(pullZone.Id);
  for (const hostname of hostnames) {
    if (!hostname.ForceSSL) await api.pullZones.setForceSsl(pullZone.Id, hostname.Value, true);
  }
  return hostnames.find((h) => h.IsSystemHostname)?.Value ?? hostnames[0]?.Value;
}
