import { join } from "node:path";
import { createBunnyApi as defaultCreateBunnyApi } from "./bunny/api.js";
import { createStorageClient as defaultCreateStorageClient } from "./bunny/storage.js";
import { analyzeClientDir } from "./compat/client-dir.js";
import { parseEnvironment } from "./compat/environment.js";
import { analyzeServerEntry, probeServerEntry as defaultProbeServerEntry } from "./compat/server-entry.js";
import { deploy as defaultDeploy } from "./deploy/deploy.js";
import { provision as defaultProvision } from "./provision/provision.js";

export const INPUT_SCHEMA = {
  "client-dir": { required: true },
  "server-entry": { required: true },
  "bunny-api-key": { required: true },
  env: { type: "multiline", default: "" },
  secrets: { type: "multiline", default: "" },
  name: { default: "" },
  "storage-zone-name": { default: "" },
  "pull-zone-name": { default: "" },
  "script-name": { default: "" },
  "storage-region": { default: "DE" },
  "storage-tier": { choices: ["standard", "edge"], default: "standard" },
  "replication-regions": { type: "list", default: [] },
  "pricing-tier": { choices: ["standard", "volume"], default: "standard" },
  "pricing-regions": { type: "list", default: ["EU"] },
  "monthly-bandwidth-limit-gb": { type: "integer", default: 0 },
  "stale-while-updating": { type: "boolean", default: false },
  "script-size-limit-mb": { type: "integer", default: 8 },
  "startup-limit-ms": { type: "integer", default: 500 },
  "keep-stale-deploys": { type: "integer", default: 3 },
  purge: { choices: ["full", "targeted"], default: "full" },
  "cache-tag": { default: "" },
  "smoke-route": { default: "/" },
  "smoke-static-path": { default: "" },
  concurrency: { type: "integer", default: 8 },
  "release-note": { default: "" },
};

export async function run({
  inputs, actions, env = process.env,
  provision = defaultProvision, deploy = defaultDeploy, probeServerEntry = defaultProbeServerEntry,
  createBunnyApi = defaultCreateBunnyApi, createStorageClient = defaultCreateStorageClient,
}) {
  const options = { ...defaults(), ...inputs };
  actions.mask(options["bunny-api-key"]);
  const environment = parseEnvironment({ env: options.env, secrets: options.secrets });
  for (const secret of environment.secrets) actions.mask(secret.value);

  const compat = await actions.group("Compatibility check", () => checkCompatibility({ options, environment, actions, probeServerEntry }));
  if (compat.errors.length > 0) throw new Error(`compatibility check failed with ${compat.errors.length} problem(s)`);

  const baseName = options.name || nameFromRepository(env.GITHUB_REPOSITORY);
  const config = {
    storageZoneName: options["storage-zone-name"] || baseName,
    pullZoneName: options["pull-zone-name"] || baseName,
    scriptName: options["script-name"] || baseName,
    storageRegion: options["storage-region"],
    storageTier: options["storage-tier"],
    replicationRegions: options["replication-regions"],
    pricingTier: options["pricing-tier"],
    pricingRegions: options["pricing-regions"],
    staleWhileUpdating: options["stale-while-updating"],
    monthlyBandwidthLimit: options["monthly-bandwidth-limit-gb"] * 1000 ** 3,
  };
  const api = createBunnyApi({ apiKey: options["bunny-api-key"] });
  const provisioned = await actions.group("Provision", async () => {
    const result = await provision({ api, config });
    for (const item of result.created) actions.info(`created ${item}`);
    for (const warning of result.warnings) actions.warning(warning);
    for (const item of result.drift) actions.warning(`drift: ${item}`);
    return result;
  });
  actions.mask(provisioned.storageZone.Password);
  const storage = createStorageClient({ hostname: provisioned.storageZone.StorageHostname, zoneName: provisioned.storageZone.Name, password: provisioned.storageZone.Password });

  const result = await actions.group("Deploy", () => deploy({
    api, storage, log: actions.info,
    clientDir: options["client-dir"], serverEntry: options["server-entry"],
    pullZone: provisioned.pullZone, hostname: provisioned.hostname, scriptId: provisioned.script.Id,
    environment: { variables: environment.variables, secrets: environment.secrets },
    keepStaleDeploys: options["keep-stale-deploys"], concurrency: options.concurrency,
    purge: options.purge, cacheTag: options["cache-tag"] || undefined,
    serverRoute: options["smoke-route"], smokeStaticPath: options["smoke-static-path"] || undefined,
    note: options["release-note"] || `${env.GITHUB_REPOSITORY ?? "bunny-edge-deploy"}@${(env.GITHUB_SHA ?? "").slice(0, 7)} run ${env.GITHUB_RUN_NUMBER ?? ""}`.trim(),
  }));
  for (const warning of result.smoke.warnings) actions.warning(warning);
  const onlyOnScript = [...result.environment.notInInput.variables, ...result.environment.notInInput.secrets];
  if (onlyOnScript.length > 0) actions.info(`on the script but not in the workflow: ${onlyOnScript.join(", ")}`);

  await actions.setOutput("hostname", provisioned.hostname);
  await actions.setOutput("release", result.release);
  await actions.setOutput("pull-zone-id", String(provisioned.pullZone.Id));
  await actions.setOutput("storage-zone-id", String(provisioned.storageZone.Id));
  await actions.setOutput("script-id", String(provisioned.script.Id));
  await actions.summary(summary({ provisioned, result, compat }));
  return result;
}

async function checkCompatibility({ options, environment, actions, probeServerEntry }) {
  const server = await analyzeServerEntry({ path: options["server-entry"], sizeLimit: options["script-size-limit-mb"] * 1024 * 1024 });
  const probe = server.errors.length === 0 ? await probeServerEntry({ path: options["server-entry"], startupLimitMs: options["startup-limit-ms"] }) : { skipped: true, errors: [] };
  const client = await analyzeClientDir({ path: options["client-dir"] });
  const errors = [...server.errors, ...probe.errors, ...client.errors, ...environment.errors];
  const warnings = [...server.warnings, ...client.warnings];
  if (probe.skipped && probe.notice) actions.warning(probe.notice);
  for (const message of errors) actions.error(message);
  for (const message of warnings) actions.warning(message);
  actions.info(`server-entry: ${(server.size / 1024).toFixed(1)} KB${probe.skipped ? "" : `, imports in ${probe.importMs} ms, ${probe.registered.onOriginRequest} request and ${probe.registered.onOriginResponse} response middleware`}`);
  actions.info(`client-dir: ${client.files.length} files, env: ${environment.variables.length} variables and ${environment.secrets.length} secrets`);
  return { errors, warnings, server, probe, client };
}

function defaults() {
  return Object.fromEntries(Object.entries(INPUT_SCHEMA).map(([name, spec]) => [name, spec.default]));
}

export function nameFromRepository(repository = "") {
  return repository.split("/").pop().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

function summary({ provisioned, result, compat }) {
  const list = (items) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none");
  return [
    `## Deployed to https://${provisioned.hostname}`,
    "",
    `Release \`${result.release}\`. Roll back in the Bunny dashboard or with \`POST /compute/script/${provisioned.script.Id}/publish/<uuid>\`.`,
    "",
    `### Files\n- uploaded ${result.uploaded.length}, unchanged ${result.unchanged.length}, stale ${result.stale.length}, removed ${result.removed.length}`,
    "",
    `### Environment\n- variables: ${result.environment.variables.added.length} added, ${result.environment.variables.changed.length} changed\n- secrets: ${result.environment.secrets.added.length} added, ${result.environment.secrets.updated.length} updated\n- on the script but not in the workflow: ${[...result.environment.notInInput.variables, ...result.environment.notInInput.secrets].join(", ") || "none"}`,
    "",
    "### Smoke test",
    result.smoke.checks.map((c) => `- ${c.kind} \`${c.path}\`: ${c.status}, Cache-Control \`${c.cacheControl ?? "none"}\``).join("\n"),
    "",
    "### Provisioning",
    list([...provisioned.created.map((c) => `created ${c}`), ...provisioned.drift.map((d) => `drift: ${d}`)]),
    "",
    compat.warnings.length > 0 ? `### Warnings\n${list(compat.warnings)}\n` : "",
  ].join("\n");
}
