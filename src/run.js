import { resolve } from "node:path";
import { createBunnyApi as defaultCreateBunnyApi } from "./bunny/api.js";
import { createStorageClient as defaultCreateStorageClient } from "./bunny/storage.js";
import { readBuildManifest } from "./build-manifest/build-manifest.js";
import { analyzeClientDir } from "./compat/client-dir.js";
import { parseEnvironment } from "./compat/environment.js";
import { analyzeServerEntry, probeServerEntry as defaultProbeServerEntry } from "./compat/server-entry.js";
import { deploy as defaultDeploy } from "./deploy/deploy.js";
import { PLATFORM_NAMES, platformEnvironment } from "./deploy/platform-env.js";
import { provision as defaultProvision } from "./provision/provision.js";

export const INPUT_SCHEMA = {
  "build-manifest": { default: ".bunny/build.json" },
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
  const { manifest } = compat;

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
    const result = await provision({ api, config, pullZoneRequirements: manifest.requires.pullZone });
    for (const item of result.created) actions.info(`created ${item}`);
    for (const item of result.updated) actions.info(`updated ${item}`);
    for (const warning of result.warnings) actions.warning(warning);
    for (const item of result.drift) actions.warning(`drift: ${item}`);
    return result;
  });
  actions.mask(provisioned.storageZone.Password);
  actions.mask(provisioned.storageZone.ReadOnlyPassword);
  const storage = createStorageClient({ hostname: provisioned.storageZone.StorageHostname, zoneName: provisioned.storageZone.Name, password: provisioned.storageZone.Password });
  const platform = platformEnvironment({ requires: manifest.requires, storageZone: provisioned.storageZone, pullZone: provisioned.pullZone });

  const result = await actions.group("Deploy", () => deploy({
    api, storage, log: actions.info,
    manifest, site: config.pullZoneName,
    pullZone: provisioned.pullZone, hostname: provisioned.hostname, scriptId: provisioned.script.Id,
    environment: { variables: [...platform.variables, ...environment.variables], secrets: [...platform.secrets, ...environment.secrets] },
    concurrency: options.concurrency,
    serverRoute: options["smoke-route"], smokeStaticPath: options["smoke-static-path"] || undefined,
    note: options["release-note"] || `${env.GITHUB_REPOSITORY ?? "bunny-edge-deploy"}@${(env.GITHUB_SHA ?? "").slice(0, 7)} run ${env.GITHUB_RUN_NUMBER ?? ""}`.trim(),
  }));
  for (const warning of result.smoke.warnings) actions.warning(warning);
  const onlyOnScript = [...result.environment.notInInput.variables, ...result.environment.notInInput.secrets];
  if (onlyOnScript.length > 0) actions.info(`on the script but not in the workflow: ${onlyOnScript.join(", ")}`);
  const supplied = new Set([...environment.variables, ...environment.secrets].map((e) => e.name).concat(onlyOnScript));
  for (const name of platform.missing.filter((n) => !supplied.has(n))) actions.warning(`the build requires ${name}, which neither the action nor the workflow sets; add it to secrets or env, or set it on the script in the dashboard`);

  await actions.setOutput("hostname", provisioned.hostname);
  await actions.setOutput("release", result.release);
  await actions.setOutput("deploy-id", result.deployId);
  await actions.setOutput("pull-zone-id", String(provisioned.pullZone.Id));
  await actions.setOutput("storage-zone-id", String(provisioned.storageZone.Id));
  await actions.setOutput("script-id", String(provisioned.script.Id));
  await actions.summary(summary({ provisioned, result, compat }));
  return result;
}

async function checkCompatibility({ options, environment, actions, probeServerEntry }) {
  const read = await readBuildManifest(resolve(options["build-manifest"]));
  const collisions = [...environment.variables, ...environment.secrets].filter((e) => PLATFORM_NAMES.has(e.name)).map((e) => `"${e.name}" is set by the action from the storage and pull zone; remove it from env and secrets`);
  const errors = [...read.errors, ...environment.errors, ...collisions];
  const warnings = [];
  if (read.errors.length === 0) {
    const { manifest } = read;
    const script = await analyzeServerEntry({ path: manifest.script.entry, sizeLimit: options["script-size-limit-mb"] * 1024 * 1024 });
    const probe = script.errors.length === 0 ? await probeServerEntry({ path: manifest.script.entry, startupLimitMs: options["startup-limit-ms"] }) : { skipped: true, errors: [] };
    const client = await analyzeClientDir({ path: manifest.assets.dir });
    errors.push(...script.errors, ...probe.errors, ...client.errors);
    warnings.push(...script.warnings, ...client.warnings);
    if (probe.skipped && probe.notice) actions.warning(probe.notice);
    actions.info(`${manifest.framework.name} build by ${manifest.adapter.package}`);
    actions.info(`script: ${(script.size / 1024).toFixed(1)} KB${probe.skipped ? "" : `, imports in ${probe.importMs} ms`}`);
    actions.info(`client files: ${client.files.length}, env: ${environment.variables.length} variables and ${environment.secrets.length} secrets`);
  }
  for (const message of errors) actions.error(message);
  for (const message of warnings) actions.warning(message);
  return { errors, warnings, manifest: read.manifest };
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
    `Release \`${result.release}\`, deploy \`${result.deployId}\`. Roll back by publishing an earlier release in the Bunny dashboard or with \`POST /compute/script/${provisioned.script.Id}/publish/<release id>\`; each release reads its own deploy folder, so its files come back with it while that folder is kept.`,
    "",
    `### Files\n- uploaded ${result.uploaded.length} to \`deploys/${result.deployId}/\`, ${result.unchanged.length} already there`,
    "",
    `### Environment\n- variables: ${result.environment.variables.added.length} added, ${result.environment.variables.changed.length} changed\n- secrets: ${result.environment.secrets.added.length} added, ${result.environment.secrets.updated.length} updated\n- on the script but not in the workflow: ${[...result.environment.notInInput.variables, ...result.environment.notInInput.secrets].join(", ") || "none"}`,
    "",
    "### Smoke test",
    result.smoke.checks.map((c) => `- ${c.kind} \`${c.path}\`: ${c.status}, Cache-Control \`${c.cacheControl ?? "none"}\``).join("\n"),
    "",
    "### Provisioning",
    list([...provisioned.created.map((c) => `created ${c}`), ...provisioned.updated.map((u) => `updated ${u}`), ...provisioned.drift.map((d) => `drift: ${d}`)]),
    "",
    compat.warnings.length > 0 ? `### Warnings\n${list(compat.warnings)}\n` : "",
  ].join("\n");
}
