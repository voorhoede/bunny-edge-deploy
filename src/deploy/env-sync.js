import { diffEnvironment } from "../compat/environment.js";

export async function syncEnvironment({ scripts, scriptId, desired, pruneSecrets = false }) {
  const remote = { variables: await scripts.variables.list(scriptId), secrets: await scripts.secrets.list(scriptId) };
  const diff = diffEnvironment(desired, remote);
  const remoteVariableIds = new Map(remote.variables.map((v) => [v.name, v.id]));
  const remoteSecretIds = new Map(remote.secrets.map((s) => [s.name, s.id]));

  for (const { name, value } of desired.variables) {
    if (diff.variables.added.includes(name) || diff.variables.changed.includes(name)) await scripts.variables.upsert(scriptId, { name, value });
  }
  for (const name of diff.variables.removed) await scripts.variables.delete(scriptId, remoteVariableIds.get(name));
  for (const { name, value } of desired.secrets) await scripts.secrets.upsert(scriptId, { name, value });

  const secretsLeft = diff.secrets.removed;
  if (pruneSecrets) {
    for (const name of secretsLeft) await scripts.secrets.delete(scriptId, remoteSecretIds.get(name));
    return { ...diff, secretsLeft: [] };
  }
  return { variables: diff.variables, secrets: { ...diff.secrets, removed: [] }, secretsLeft };
}
