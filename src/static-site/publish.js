import { DEPLOY_HEADER } from "./rules.js";

const PROBE_INTERVAL_MS = 1500;
const PROBE_DEADLINE_MS = 20_000;
// Bunny's CLI waits at least this long before the second purge: configuration reaches the nodes in batches of about 5 s.
const SETTLE_FLOOR_MS = 7500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function publishStaticSite({ api, fetch = globalThis.fetch, sleep = defaultSleep, now = Date.now, pullZone, storageZone, hostname, deployId, rules, notFound }) {
  const { EdgeRules: current = [] } = await api.pullZones.get(pullZone.Id);
  for (const rule of rules) {
    const existing = current.find((candidate) => candidate.Description === rule.Description);
    await api.pullZones.addOrUpdateEdgeRule(pullZone.Id, existing ? { ...rule, Guid: existing.Guid } : rule);
  }

  const zone = await api.storageZones.get(storageZone.Id);
  if ((zone.Custom404FilePath ?? "") !== notFound.Custom404FilePath || zone.Rewrite404To200 !== notFound.Rewrite404To200) {
    await api.storageZones.update(storageZone.Id, notFound);
  }

  await api.pullZones.purgeAll(pullZone.Id);
  const confirmed = await waitForDeploy({ fetch, sleep, now, hostname, deployId });
  await api.pullZones.purgeAll(pullZone.Id);
  return { confirmed };
}

async function waitForDeploy({ fetch, sleep, now, hostname, deployId }) {
  const started = now();
  let confirmed = false;
  for (let attempt = 1; now() - started < PROBE_DEADLINE_MS; attempt += 1) {
    try {
      const response = await fetch(`https://${hostname}/?bunny-edge-deploy-publish=${deployId}-${attempt}`, { cache: "no-store", redirect: "manual" });
      await response.body?.cancel();
      if (response.headers.get(DEPLOY_HEADER) === deployId) {
        confirmed = true;
        break;
      }
    } catch {
      // A failed probe counts as not switched yet.
    }
    await sleep(PROBE_INTERVAL_MS);
  }
  const waited = now() - started;
  if (waited < SETTLE_FLOOR_MS) await sleep(SETTLE_FLOOR_MS - waited);
  return confirmed;
}
