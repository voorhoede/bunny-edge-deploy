import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeClientDir } from "../compat/client-dir.js";
import { checkRuleBudget, publishStaticSite } from "../static-site/publish.js";
import { parseHeaders, parseRedirects } from "../static-site/parse.js";
import { notFoundSettings, servedDeploy, siteRules } from "../static-site/rules.js";
import { deployFolder, deployId, foldersToPrune, preamble } from "./deploy-folder.js";
import { syncEnvironment } from "./env-sync.js";
import { smokeTest } from "./smoke.js";
import { contentTypeFor, isHashedAsset, planUpload } from "./upload-plan.js";

// A publish takes a few seconds to reach every node, so the cache is purged again once the old release is gone.
const SETTLE_MS = 5000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deploy({
  api, storage, fetch, log = () => {}, sleep = defaultSleep,
  manifest, site, pullZone, hostname, scriptId,
  environment, concurrency = 8, keepDeploys = 3,
  serverRoute = "/", smokeStaticPath, smokeRetryForMs, note,
}) {
  const local = await readLocalFiles(manifest.assets.dir);
  const bundle = await readFile(manifest.script.entry, "utf8");
  const id = deployId({ files: local, bundle });
  const plan = await uploadToFolder({ storage, local, id, concurrency, sleep, log });

  const env = await syncEnvironment({ scripts: api.scripts, scriptId, desired: environment });
  log(`environment synced: ${summarize(env)}`);

  const previous = await liveRelease(api, scriptId);
  await api.scripts.uploadCode(scriptId, preamble({ id, site }) + bundle);
  await api.scripts.publish(scriptId, note ?? `bunny-edge-deploy ${new Date().toISOString()}`);
  const release = (await api.scripts.activeRelease(scriptId)).Uuid;
  log(`published release ${release}`);
  await purgeTwice({ api, pullZone, sleep });

  const staticPath = smokeStaticPath ?? defaultStaticPath(local);
  const smoke = await smokeTest({ hostname, staticPath, serverRoute, fetch, sleep, retryForMs: smokeRetryForMs });
  if (smoke.errors.length > 0) {
    const outcome = await rollBackRelease({ api, pullZone, sleep, scriptId, release, previous, id });
    throw new Error(`smoke test failed:\n${smoke.errors.join("\n")}\n${outcome}`);
  }

  const pruned = await pruneFolders({ storage, id, keepDeploys, log });
  return { deployId: id, uploaded: plan.upload.map((f) => f.path), unchanged: plan.unchanged, pruned, environment: env, release, smoke };
}

export async function deployStatic({
  api, storage, fetch, log = () => {}, sleep = defaultSleep, publish = publishStaticSite,
  manifest, storageZone, pullZone, hostname,
  concurrency = 8, keepDeploys = 3,
  serverRoute = "/", smokeStaticPath, smokeRetryForMs,
}) {
  const local = await readLocalFiles(manifest.assets.dir);
  const id = deployId({ files: local });
  const text = (path) => local.find((f) => f.path === path)?.bytes.toString("utf8");
  const files = local.map((f) => f.path);
  const rules = siteRules({ storageZone, deployId: id, files, headers: parseHeaders(text("_headers")), redirects: parseRedirects(text("_redirects")) });
  const { EdgeRules: current = [] } = await api.pullZones.get(pullZone.Id);
  checkRuleBudget(current, rules);
  const live = servedDeploy(current);
  const plan = await uploadToFolder({ storage, local, id, concurrency, sleep, log });

  const { confirmed, unchanged } = await publish({
    api, fetch, sleep, pullZone, storageZone, hostname, deployId: id, rules,
    notFound: notFoundSettings({ deployId: id, files }),
  });
  if (unchanged) log(`deploy ${id} is already live with the same rules and 404 page, so nothing was published or purged`);
  else log(confirmed ? `published deploy ${id}` : `published deploy ${id}, but the site did not report it within 20 s; the smoke test decides`);

  const staticPath = smokeStaticPath ?? defaultStaticPath(local);
  const smoke = await smokeTest({ hostname, staticPath, serverRoute, deployId: id, fetch, sleep, retryForMs: smokeRetryForMs });
  if (smoke.errors.length > 0) {
    const outcome = await rollBackFolder({ api, storage, fetch, sleep, publish, storageZone, pullZone, hostname, id, live });
    throw new Error(`smoke test failed:\n${smoke.errors.join("\n")}\n${outcome}`);
  }

  const pruned = await pruneFolders({ storage, id, keepDeploys, log });
  return { deployId: id, uploaded: plan.upload.map((f) => f.path), unchanged: plan.unchanged, pruned, confirmed, smoke };
}

const defaultStaticPath = (local) => (local.find((f) => isHashedAsset(f.path)) ?? local.find((f) => !["_headers", "_redirects"].includes(f.path))).path;

async function purgeTwice({ api, pullZone, sleep }) {
  await api.pullZones.purgeAll(pullZone.Id);
  await sleep(SETTLE_MS);
  await api.pullZones.purgeAll(pullZone.Id);
}

// A script that was never published answers 404 for its active release.
async function liveRelease(api, scriptId) {
  try {
    return (await api.scripts.activeRelease(scriptId)).Uuid;
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
}

// Variables and secrets belong to the script, not to a release, so a rollback leaves them as this deploy set them.
async function rollBackRelease({ api, pullZone, sleep, scriptId, release, previous, id }) {
  if (!previous) return `release ${release} stays live: there is no earlier release to roll back to`;
  try {
    await api.scripts.publishRelease(scriptId, previous, `bunny-edge-deploy rollback from deploy ${id}`);
    await purgeTwice({ api, pullZone, sleep });
    return `release ${release} was rolled back to release ${previous}; variables and secrets keep the values this deploy set`;
  } catch (error) {
    return `rolling back to release ${previous} failed: ${error.message}`;
  }
}

async function rollBackFolder({ api, storage, fetch, sleep, publish, storageZone, pullZone, hostname, id, live }) {
  if (!live) return `deploy ${id} stays live: there is no earlier deploy to roll back to`;
  try {
    const folder = deployFolder(live);
    const files = (await storage.listAll(folder)).map((file) => file.path.slice(folder.length + 1));
    const text = async (name) => (files.includes(name) ? (await storage.download(`${folder}/${name}`))?.toString("utf8") : undefined);
    const rules = siteRules({ storageZone, deployId: live, files, headers: parseHeaders(await text("_headers")), redirects: parseRedirects(await text("_redirects")) });
    await publish({ api, fetch, sleep, pullZone, storageZone, hostname, deployId: live, rules, notFound: notFoundSettings({ deployId: live, files }) });
    return `deploy ${id} was rolled back to deploy ${live}`;
  } catch (error) {
    return `rolling back to deploy ${live} failed: ${error.message}`;
  }
}

async function uploadToFolder({ storage, local, id, concurrency, sleep, log }) {
  const folder = deployFolder(id);
  const remote = (await listWhenReady(storage, folder, sleep)).map((file) => ({ ...file, path: file.path.slice(folder.length + 1) }));
  const plan = planUpload({ local, remote });
  log(`deploy ${id}: uploading ${plan.upload.length} files to ${folder}/, ${plan.unchanged.length} already there`);
  await inBatches(plan.upload, concurrency, (file) => storage.upload(`${folder}/${file.path}`, file.bytes, { contentType: contentTypeFor(file.path) }));
  return plan;
}

async function pruneFolders({ storage, id, keepDeploys, log }) {
  const pruned = foldersToPrune({ folders: await storage.listFolders("deploys"), current: id, keep: keepDeploys });
  for (const name of pruned) await storage.removeFolder(deployFolder(name));
  if (pruned.length > 0) log(`pruned ${pruned.length} old deploy folders: ${pruned.join(", ")}`);
  return pruned;
}

async function readLocalFiles(clientDir) {
  const { files, errors } = await analyzeClientDir({ path: clientDir });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return Promise.all(files.map(async ({ path }) => {
    const bytes = await readFile(join(clientDir, path));
    return { path, bytes, checksum: createHash("sha256").update(bytes).digest("hex").toUpperCase() };
  }));
}

// A storage zone rejects its own password for a few seconds after creation.
async function listWhenReady(storage, directory, sleep, attempts = 30) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await storage.listAll(directory);
    } catch (error) {
      if (error.status !== 401 || attempt >= attempts) throw error;
      await sleep(2000);
    }
  }
}

async function inBatches(items, size, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length > 0) await work(queue.shift());
  });
  await Promise.all(workers);
}

const summarize = (env) => `${env.variables.added.length} added, ${env.variables.changed.length} changed, ${env.secrets.added.length + env.secrets.updated.length} secrets set, ${env.notInInput.variables.length + env.notInInput.secrets.length} on the script only`;
