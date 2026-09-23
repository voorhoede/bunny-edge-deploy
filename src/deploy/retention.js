export function reconcileRetention({ state, stale, keep }) {
  const deploy = (state?.deploy ?? 0) + 1;
  const firstStale = new Map(Object.entries(state?.stale ?? {}).filter(([path]) => stale.includes(path)));
  for (const path of stale) if (!firstStale.has(path)) firstStale.set(path, deploy);
  const remove = [...firstStale].filter(([, since]) => deploy - since >= keep).map(([path]) => path);
  for (const path of remove) firstStale.delete(path);
  return { remove, state: { deploy, stale: Object.fromEntries(firstStale) } };
}
