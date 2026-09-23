# How a deploy works

Reference for what the action does and why. Setup is in the [README](../README.md); what the server entry must look like is in [server-entry.md](server-entry.md).

## Steps

1. **Compatibility check**, before anything is uploaded. Fails with one message per problem. See [server-entry.md](server-entry.md) for the rules.
2. **Provision or verify** the storage zone, the middleware script and the pull zone by name. Missing resources are created with the defaults below. Existing resources are read as they are and never updated; see [managing-the-zone.md](managing-the-zone.md) for the few settings that are verified and the ones that only produce a warning.
3. **Upload** `client-dir` to storage, skipping files whose SHA-256 matches the one storage reports. Hashed assets go first, then HTML and other files, so new HTML never references a missing file.
4. **Set environment** before publishing: every key in `env` and `secrets` is set or updated on the script. Nothing is removed, so variables and secrets can also live in the dashboard; keys that exist only there are listed in the summary.
5. **Publish** the server entry as a new script release.
6. **Purge** the pull zone. Full purge by default, see below.
7. **Retention**: files that are no longer in `client-dir` stay in storage for `keep-stale-deploys` deploys, then get deleted. The bookkeeping lives in `.bunny-edge-deploy/state.json` in the storage zone; provisioning adds an edge rule that blocks that path on the CDN.
8. **Smoke test** one hashed asset and `smoke-route` through the pull zone. Non-2xx or a response that did not pass through Bunny fails the workflow. A rendered route that comes back with Bunny's 30-day default header gets a warning, because that means the app sent no Cache-Control.

## Caching

The pull zone follows the app's `Cache-Control` header. Verified on a live zone:

- `public, max-age=N` and `s-maxage=N` are cached for that long and passed through unchanged.
- `private`, `no-store`, `no-cache` and `max-age=0` are not cached.
- **No `Cache-Control` at all means Bunny caches the response for 30 days.** The app is fully responsible for marking personalized responses `private` or `no-store`. Cookies are never part of the cache key, so a personalized page without such a header is served to the next visitor.
- `stale-while-revalidate` in the header does not make Bunny revalidate in the background. The `stale-while-updating` input does, for every cached response, at the cost of serving the previous version once after each purge.
- Query strings are part of the cache key.
- Static files from storage carry no `Cache-Control` of their own, and Bunny then serves them with a 296-day header. The server entry sets headers for static files in `onOriginResponse`; see the contract.

### Why a full purge

Server-rendered pages are cached under URLs the action cannot enumerate, so after a new script version only a full purge guarantees no stale HTML. Hashed assets refill from storage, which is Bunny-internal. If the app tags every rendered response with a `CDN-Tag` header, `purge: targeted` with `cache-tag` purges that tag plus the changed unhashed files instead.

## Defaults and costs

These apply when the action creates a resource. Afterwards the dashboard is the source of truth.

Storage zone: Frankfurt (`DE`), standard HDD tier at $0.01/GB, no replication. Region and tier cannot be changed after creation, and replication regions cannot be removed.

Pull zone: standard tier, Europe only. Visitors elsewhere are served from the nearest European location. Smart Cache off, cache expiry follows the origin, cookies and `Set-Cookie` untouched, no CORS or canonical headers, no Vary variants, error responses not cached, stale served while the origin is offline, HTTPS forced on every hostname, TLS 1.0 and 1.1 off, log IP anonymization on, compression handled by Bunny for text responses.

Everything that costs extra is off at creation. Opt in by changing the zone in the dashboard:

| Add-on | Cost | Why off |
| --- | --- | --- |
| Bunny Optimizer | $9.50 per zone per month | Rewrites images and HTML. |
| Perma-Cache | Storage rates for the cache copy | Not available for storage origins. |
| Origin Shield | Free | Extra hop; the origin is already Bunny storage. |
| Permanent log storage | Storage rates | Logs are kept 3 days without it. |
| Replication regions | $0.01/GB (standard) or $0.02/GB (edge) per region | Irreversible. Set `replication-regions` to opt in. |
| Volume pricing tier | $0.005/GB instead of $0.01/GB | Ten locations worldwide, none in the Netherlands (Frankfurt is nearest). Set `pricing-tier: volume`. |
| Edge Scripting | $0.20 per million requests plus $0.02 per 1000 s CPU, $0.22 monthly minimum | Only cache misses reach the script. |

`monthly-bandwidth-limit-gb` is a cost guard: the zone stops serving when the limit is reached, so it is off by default.

## Rollback

Every deploy publishes a new release; the `release` output holds its UUID. To roll back, publish an earlier release in the Bunny dashboard (Script > Deployments > Publish) or with the API:

```
POST https://api.bunny.net/compute/script/<script-id>/publish/<release-uuid>
AccessKey: <account api key>
```

Environment variables and secrets are stored on the script, not on the release. A rollback keeps the current values, so a release that needs an old variable value needs that value set again, in the dashboard or through the `env` input. Changes take effect on new isolates within about ten seconds, without a republish. Static files are not versioned: rolling back the script does not restore removed files, but files stay in storage for `keep-stale-deploys` deploys, so a rollback within that window still finds its assets.

## Limits the action enforces

Verified on a live account, where the documented limits differ:

- Script size: the API accepts more than 10 MB, but 9.5 MB and larger failed to boot reliably. Default limit 8 MB, warning above 2 MB because cold starts then reach 0.5 s.
- Environment: at most 128 variables and 2048 bytes per value. Bunny accepts larger values, but the script then fails to boot and every request, including static files, returns 400. Secrets do not count toward the 128.
- Variable changes take effect without a republish, on new isolates, within about 10 seconds.
