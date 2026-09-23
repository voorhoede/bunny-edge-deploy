import { diffEnvironment } from "../compat/environment.js";

// Additive on purpose: the dashboard is the source of truth, the workflow only adds or updates what it lists.
export async function syncEnvironment({ scripts, scriptId, desired }) {
  const remote = { variables: await scripts.variables.list(scriptId), secrets: await scripts.secrets.list(scriptId) };
  const diff = diffEnvironment(desired, remote);
  for (const { name, value } of desired.variables) {
    if (diff.variables.added.includes(name) || diff.variables.changed.includes(name)) await scripts.variables.upsert(scriptId, { name, value });
  }
  for (const { name, value } of desired.secrets) await scripts.secrets.upsert(scriptId, { name, value });
  return diff;
}
