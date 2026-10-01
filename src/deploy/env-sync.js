import { MAX_VARIABLES, diffEnvironment } from "../compat/environment.js";

// Additive on purpose: the dashboard is the source of truth, the workflow only adds or updates what it lists.
export async function syncEnvironment({ scripts, scriptId, desired }) {
  const remote = { variables: await scripts.variables.list(scriptId), secrets: await scripts.secrets.list(scriptId) };
  const diff = diffEnvironment(desired, remote);
  const total = remote.variables.length + diff.variables.added.length;
  if (total > MAX_VARIABLES) {
    throw new Error(`the script would have ${total} variables, ${remote.variables.length} already on the script and ${diff.variables.added.length} new, but a script boots with at most ${MAX_VARIABLES}; remove variables in the Bunny dashboard or from env`);
  }
  for (const { name, value } of desired.variables) {
    if (diff.variables.added.includes(name) || diff.variables.changed.includes(name)) await scripts.variables.upsert(scriptId, { name, value });
  }
  for (const { name, value } of desired.secrets) await scripts.secrets.upsert(scriptId, { name, value });
  return diff;
}
