// The variables a Bunny adapter can ask for in requires.env, and where the action gets their values.
const PLATFORM = [
  { name: "BUNNY_STORAGE_ZONE", value: ({ storageZone }) => storageZone.Name },
  { name: "BUNNY_STORAGE_HOST", value: ({ storageZone }) => storageZone.StorageHostname },
  { name: "BUNNY_STORAGE_KEY", secret: true, value: ({ storageZone }) => storageZone.ReadOnlyPassword },
  { name: "BUNNY_SESSION_ZONE", write: true, value: ({ storageZone }) => storageZone.Name },
  { name: "BUNNY_SESSION_KEY", write: true, secret: true, value: ({ storageZone }) => storageZone.Password },
  { name: "BUNNY_PULLZONE_ID", value: ({ pullZone }) => String(pullZone.Id) },
];

export const PLATFORM_NAMES = new Set(PLATFORM.map((entry) => entry.name));

export function platformEnvironment({ requires, storageZone, pullZone }) {
  const variables = [];
  const secrets = [];
  const missing = [];
  for (const { name, optional } of requires.env) {
    const known = PLATFORM.find((entry) => entry.name === name.toUpperCase());
    const value = known && !(known.write && !requires.storage.write) ? known.value({ storageZone, pullZone }) : undefined;
    if (value) (known.secret ? secrets : variables).push({ name: known.name, value });
    else if (!optional) missing.push(name);
  }
  return { variables, secrets, missing };
}
