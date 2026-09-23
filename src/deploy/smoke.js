// Bunny adds this header to responses that carry no Cache-Control of their own.
const BUNNY_DEFAULT_CACHE_CONTROL = "public, max-age=2592000";
const RETRY_DELAY_MS = 3000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A freshly created pull zone answers 403 for its first seconds, so transient failures are retried until the deadline.
export async function smokeTest({ hostname, staticPath, serverRoute, fetch = globalThis.fetch, sleep = defaultSleep, retryForMs = 60_000, now = Date.now }) {
  const checks = [];
  const errors = [];
  const warnings = [];
  const targets = [
    { kind: "static file", path: `/${staticPath.split("/").map(encodeURIComponent).join("/")}` },
    { kind: "server route", path: serverRoute },
  ];
  const deadline = now() + retryForMs;
  for (const { kind, path } of targets) {
    const { response, retried } = await fetchUntilSettled({ hostname, path, fetch, sleep, deadline, now });
    if (!response) {
      errors.push(`${kind} ${path} kept failing (${retried}) after retrying for ${Math.round(retryForMs / 1000)} s`);
      continue;
    }
    const check = { kind, path, status: response.status, cdnCache: response.headers.get("cdn-cache"), cacheControl: response.headers.get("cache-control") };
    checks.push(check);
    if (!(response.status >= 200 && response.status < 300)) errors.push(`${kind} ${path} returned ${response.status}${retried ? ` after retrying (${retried})` : ""}`);
    else if (!check.cdnCache) errors.push(`${kind} ${path} has no cdn-cache header, so it was not served through the Bunny pull zone`);
    else if (kind === "server route" && check.cacheControl === BUNNY_DEFAULT_CACHE_CONTROL) warnings.push(`${kind} ${path} came back with "${check.cacheControl}": the app sent no Cache-Control, so Bunny caches it for 30 days`);
  }
  return { checks, errors, warnings };
}

async function fetchUntilSettled({ hostname, path, fetch, sleep, deadline, now }) {
  let last;
  let response;
  for (;;) {
    const url = new URL(path, `https://${hostname}`);
    url.searchParams.set("bunny-edge-deploy-smoke", now().toString(36));
    try {
      response = await fetch(url, { cache: "no-store", redirect: "manual" });
      if (!(response.status === 403 || response.status >= 500)) return { response, retried: last };
      last = `last status ${response.status}`;
    } catch (error) {
      last = `last error ${error.message}`;
    }
    if (now() >= deadline) return { response, retried: last };
    await sleep(RETRY_DELAY_MS);
  }
}
