import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeClientDir } from "../compat/client-dir.js";
import { syncEnvironment } from "./env-sync.js";
import { purgeUrls } from "./purge.js";
import { reconcileRetention } from "./retention.js";
import { smokeTest } from "./smoke.js";
import { contentTypeFor, isHashedAsset, planUpload } from "./upload-plan.js";

export const STATE_PATH = ".bunny-edge-deploy/state.json";

export async function deploy({
  api, storage, fetch, log = () => {},
  clientDir, serverEntry, pullZone, hostname, scriptId,
  environment,
  keepStaleDeploys = 3, concurrency = 8,
  purge = "full", cacheTag,
  serverRoute = "/", smokeStaticPath, smokeRetryForMs, note, sleep,
}) {
  const local = await readLocalFiles(clientDir);
  const remote = await listWhenReady(storage, sleep);
  const plan = planUpload({ local, remote, statePath: STATE_PATH });
  log(`uploading ${plan.upload.length} files, ${plan.unchanged.length} unchanged`);
  await inBatches(plan.upload.filter((f) => isHashedAsset(f.path)), concurrency, (file) => storage.upload(file.path, file.bytes, { contentType: contentTypeFor(file.path) }));
  await inBatches(plan.upload.filter((f) => !isHashedAsset(f.path)), concurrency, (file) => storage.upload(file.path, file.bytes, { contentType: contentTypeFor(file.path) }));

  const env = await syncEnvironment({ scripts: api.scripts, scriptId, desired: environment });
  log(`environment synced: ${summarize(env)}`);

  await api.scripts.uploadCode(scriptId, await readFile(serverEntry, "utf8"));
  await api.scripts.publish(scriptId, note ?? `bunny-edge-deploy ${new Date().toISOString()}`);
  const release = (await api.scripts.activeRelease(scriptId)).Uuid;
  log(`published release ${release}`);

  if (purge === "targeted") {
    for (const url of purgeUrls({ hostname, paths: plan.changedUnhashed })) await api.purgeUrl(url);
    if (cacheTag) await api.pullZones.purgeTag(pullZone.Id, cacheTag);
  } else await api.pullZones.purgeAll(pullZone.Id);

  const state = await readState(storage);
  const retention = reconcileRetention({ state, stale: plan.stale, keep: keepStaleDeploys });
  for (const path of retention.remove) await storage.remove(path);
  await storage.upload(STATE_PATH, Buffer.from(JSON.stringify(retention.state)), { contentType: "application/json" });

  const staticPath = smokeStaticPath ?? (local.find((f) => isHashedAsset(f.path)) ?? local[0]).path;
  const smoke = await smokeTest({ hostname, staticPath, serverRoute, fetch, sleep, retryForMs: smokeRetryForMs });
  if (smoke.errors.length > 0) throw new Error(`smoke test failed:\n${smoke.errors.join("\n")}`);

  return { uploaded: plan.upload.map((f) => f.path), unchanged: plan.unchanged, stale: plan.stale, removed: retention.remove, environment: env, release, smoke };
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
async function listWhenReady(storage, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 30) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await storage.listAll();
    } catch (error) {
      if (error.status !== 401 || attempt >= attempts) throw error;
      await sleep(2000);
    }
  }
}

async function readState(storage) {
  const bytes = await storage.download(STATE_PATH);
  return bytes ? JSON.parse(bytes.toString()) : undefined;
}

async function inBatches(items, size, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length > 0) await work(queue.shift());
  });
  await Promise.all(workers);
}

const summarize = (env) => `${env.variables.added.length} added, ${env.variables.changed.length} changed, ${env.secrets.added.length + env.secrets.updated.length} secrets set, ${env.notInInput.variables.length + env.notInInput.secrets.length} on the script only`;
