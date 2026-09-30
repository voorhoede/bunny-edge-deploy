import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// Mirrors BuildManifestSchema in BunnyWay/cli#172 (packages/config/src/build-manifest.ts); unknown fields are ignored like zod does.
const MANIFEST_VERSION = 1;
const PULL_ZONE_SETTINGS = ["disableCookies", "enableSmartCache", "enableCacheSlice"];

export async function readBuildManifest(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { errors: [`build manifest ${path} not found; build the project with a Bunny adapter first, it writes .bunny/build.json`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { errors: [`build manifest ${path} is not valid JSON: ${error.message}`] };
  }

  if (Number.isInteger(raw.manifestVersion) && raw.manifestVersion > MANIFEST_VERSION) {
    return { errors: [`build manifest has manifestVersion ${raw.manifestVersion}, but this action reads ${MANIFEST_VERSION}; update the action or pin the adapter`] };
  }
  const errors = validate(raw);
  if (errors.length > 0) return { errors };

  const root = dirname(dirname(path));
  const manifest = {
    root,
    kind: raw.kind,
    adapter: raw.adapter,
    framework: raw.framework,
    script: raw.kind === "ssr" ? { entry: join(root, raw.script.entry), type: raw.script.type } : undefined,
    assets: { dir: join(root, raw.assets.dir) },
    requires: {
      pullZone: Object.fromEntries(PULL_ZONE_SETTINGS.filter((key) => typeof raw.requires?.pullZone?.[key] === "boolean").map((key) => [key, raw.requires.pullZone[key]])),
      storage: { write: raw.requires?.storage?.write === true },
      env: (raw.requires?.env ?? []).map(({ name, secret, optional }) => ({ name, secret: secret === true, optional: optional === true })),
    },
  };
  if (manifest.script && !(await isFile(manifest.script.entry))) errors.push(`script entry ${raw.script.entry} not found at ${manifest.script.entry}`);
  if (!(await isDirectory(manifest.assets.dir))) errors.push(`assets dir ${raw.assets.dir} not found at ${manifest.assets.dir}`);
  return { errors, manifest };
}

function validate(raw) {
  const errors = [];
  const expect = (ok, field, what) => ok || errors.push(`build manifest field ${field} must be ${what}`);
  const isString = (value) => typeof value === "string" && value !== "";
  const isBoolean = (value) => value === undefined || typeof value === "boolean";

  expect(Number.isInteger(raw.manifestVersion) && raw.manifestVersion > 0, "manifestVersion", "a positive integer");
  expect(isString(raw.adapter?.package), "adapter.package", "a string");
  expect(isString(raw.framework?.name), "framework.name", "a string");
  expect(raw.kind === "ssr" || raw.kind === "static", "kind", '"ssr" or "static"');
  expect(isString(raw.assets?.dir), "assets.dir", "a string");
  if (raw.kind === "ssr" && raw.script === undefined) errors.push("build manifest has kind \"ssr\" but no script to run it");
  else if (raw.kind === "ssr") {
    expect(isString(raw.script.entry), "script.entry", "a string");
    if (raw.script.type === "middleware") errors.push('build manifest script.type is "middleware", but this action deploys a "standalone" script');
    else expect(raw.script.type === "standalone", "script.type", '"standalone"');
  }
  const requires = raw.requires ?? {};
  for (const key of PULL_ZONE_SETTINGS) expect(isBoolean(requires.pullZone?.[key]), `requires.pullZone.${key}`, "a boolean");
  expect(isBoolean(requires.storage?.write), "requires.storage.write", "a boolean");
  expect(requires.env === undefined || Array.isArray(requires.env), "requires.env", "a list");
  (Array.isArray(requires.env) ? requires.env : []).forEach((entry, index) => expect(isString(entry?.name), `requires.env[${index}].name`, "a string"));
  return errors;
}

const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);
const isDirectory = (path) => stat(path).then((s) => s.isDirectory(), () => false);
