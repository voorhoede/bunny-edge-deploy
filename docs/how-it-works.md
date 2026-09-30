# How a deploy works

Reference for what the action does and why. Setup is in the [README](../README.md); what it reads from the build is in [build-manifest.md](build-manifest.md).

## Steps

Both kinds of build:

1. **Compatibility check**, before anything is uploaded. Fails with one message per problem. See [build-manifest.md](build-manifest.md) for the rules.
2. **Provision or verify** the storage zone and the pull zone by name, plus the script for a server build. Missing resources are created with the defaults below. On existing ones the action only enforces the few settings the build needs; see [managing-the-zone.md](managing-the-zone.md).
3. **Upload** the client files to `deploys/<deploy id>/` in the storage zone. The deploy id is a hash of the files, and of the script for a server build, so the same build always lands in the same folder: a re-run uploads only what is missing, and an unchanged build uploads nothing.

Then, for a **server build**:

4. **Set variables** on the script: the platform variables the manifest asks for, then the `env` and `secrets` inputs. Nothing is removed, so the app's variables can also live in the dashboard; keys that exist only there are listed in the summary.
5. **Publish** the script, with a line in front that names its deploy folder.
6. **Purge** the pull zone, wait 5 s for the release to reach every node, and purge again.

For a **static build**:

4. **Publish** by pointing the zone's edge rules at the new folder, applying `_headers` and `_redirects`, setting the build's `404.html` as the 404 page, and deleting the action's rules the build no longer has.
5. **Purge** the pull zone, wait until the site answers with the new deploy's `X-Bunny-Deploy` header (at least 7.5 s, at most 20 s), and purge again. A re-run of a build that is already live, with the same rules and 404 page, changes nothing and skips the purge.

Last, for both:

- **Smoke test** one static file and `smoke-route` through the pull zone. The file must answer 2xx and the route 2xx or 3xx, both through Bunny; a static build must also answer for the new deploy in `X-Bunny-Deploy`. When the smoke test fails, the deploy that was live before is published again and the workflow fails ([Rollback](#rollback)).
- **Prune**: delete every deploy folder except the newest `keep-deploys` (default 3) and the live one. This only happens after the smoke test passes.

## Caching

**Server builds.** The pull zone follows the `Cache-Control` the script sends. On a script-origin zone, `public, max-age=60` and one year immutable were cached and `private, no-store` was not; the other rules below were verified when the action still ran the script as middleware, with the same zone cache settings, and have not been re-checked on a script-origin zone:

- `public, max-age=N` and `s-maxage=N` are cached for that long and passed through unchanged.
- `private`, `no-store`, `no-cache` and `max-age=0` are not cached.
- **No `Cache-Control` at all means Bunny caches the response for 30 days.** Cookies are never part of the cache key, so a personalized response without `private` or `no-store` is served to the next visitor. Bunny's Astro adapter sends `private, no-store` on rendered responses that set nothing, `public, max-age=60` on prerendered pages and one year, immutable, on other files.
- `stale-while-revalidate` in the header does not make Bunny revalidate in the background. The `stale-while-updating` input does, for every cached response, at the cost of serving the previous version once after each purge.
- Query strings are part of the cache key.

**Static builds.** Storage sends no `Cache-Control`, so the zone sets it: the CDN keeps every file for up to 30 days and every publish purges it, while browsers get `public, max-age=0` and revalidate. Paths with a `Cache-Control` in `_headers` get that `max-age` in the browser instead, and without one, common asset extensions get one day.

## Defaults and costs

These apply when the action creates a resource. Afterwards only the settings in [managing-the-zone.md](managing-the-zone.md) are enforced; the dashboard owns the rest.

Storage zone: Frankfurt (`DE`), standard HDD tier at $0.01/GB, no replication. Region and tier cannot be changed after creation, and replication regions cannot be removed.

Pull zone: standard tier, Europe only. Visitors elsewhere are served from the nearest European location. Smart Cache off, cookies and `Set-Cookie` untouched, query strings in the cache key, no CORS or canonical headers, no Vary variants, error responses not cached, stale served while the origin is offline, HTTPS forced on every hostname, TLS 1.0 and 1.1 off, log IP anonymization on, compression handled by Bunny for text responses. A server build's zone follows the script's cache headers; a static build's zone uses the cache times above.

Everything that costs extra is off at creation. Opt in by changing the zone in the dashboard:

| Add-on | Cost | Why off |
| --- | --- | --- |
| Bunny Optimizer | $9.50 per zone per month | Rewrites images and HTML. |
| Perma-Cache | Storage rates for the cache copy | Not available for storage origins. |
| Origin Shield | Free | Extra hop; the origin is already Bunny. |
| Permanent log storage | Storage rates | Logs are kept 3 days without it. |
| Replication regions | $0.01/GB (standard) or $0.02/GB (edge) per region | Irreversible. Set `replication-regions` to opt in. |
| Volume pricing tier | $0.005/GB instead of $0.01/GB | Ten locations worldwide, none in the Netherlands (Frankfurt is nearest). Set `pricing-tier: volume`. |

A server build also pays for Edge Scripting: $0.20 per million requests plus $0.02 per 1000 s CPU, $0.22 monthly minimum. Only cache misses reach the script.

`monthly-bandwidth-limit-gb` is a cost guard: the zone stops serving when the limit is reached, so it is off by default.

## Rollback

A deploy that fails its smoke test is rolled back automatically: a server build publishes the release that was live before it, and a static build points the edge rules at the folder that was live, with that folder's own `_headers`, `_redirects` and `404.html`. The workflow then fails and names both deploys. On a zone's first deploy there is nothing to roll back to, so the failed deploy stays live.

To roll back by hand:

**Server build.** Every deploy publishes a new release; the `release` output holds its id. To roll back, publish an earlier release in the Bunny dashboard (Script > Deployments > Publish) or with the API:

```
POST https://api.bunny.net/compute/script/<script-id>/publish/<release id>
AccessKey: <account api key>
```

The release names its own deploy folder, so its files come back with it, as long as that folder is still among the ones kept. Variables and secrets are stored on the script, not on the release: a rollback keeps the current values.

**Static build.** Run the deploy of the earlier commit again, for example with "Re-run jobs" in GitHub Actions. The same build reuses its folder when it is still kept, so nothing is uploaded; the edge rules, redirects and headers switch back with it.

## Limits the action enforces

Verified on a live account, where the documented limits differ:

- Script size: the API accepts more than 10 MB, but 9.5 MB and larger failed to boot reliably. Default limit 8 MB, warning above 2 MB because cold starts then reach 0.5 s.
- Environment: at most 128 variables and 2048 bytes per value. Bunny accepts more, but the script then fails to boot and every request, including static files, returns 400. The 128 counts the variables already on the script plus the new ones, and is checked before any is set. Secrets do not count toward it.
- Edge rules: 50 per zone, including rules added in the dashboard. A static deploy that would need more fails before changing anything.
- Variable changes take effect without a republish, on new isolates, within about 10 seconds.
