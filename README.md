# bunny-edge-deploy

GitHub Action that deploys a built website to [Bunny.net](https://bunny.net): static files go to a Bunny Storage zone served by a Bunny CDN pull zone, and one server file runs as a Bunny Edge Scripting middleware that renders everything that is not a static file.

The action only deploys. Build first, then point it at the output. It provisions the three resources on first use, verifies their settings on every run, and never deletes or recreates a resource.

## Usage

```yaml
- uses: voorhoede/bunny-edge-deploy@<commit-sha>
  with:
    client-dir: dist/client
    server-entry: dist/server/entry.js
    bunny-api-key: ${{ secrets.BUNNY_API_KEY }}
    env: |
      PUBLIC_SITE_URL=https://www.example.com
    secrets: |
      CMS_TOKEN=${{ secrets.CMS_TOKEN }}
```

See [examples/deploy.yml](examples/deploy.yml) for a complete workflow with a concurrency group, minimal permissions and pinned actions. All inputs are documented in [action.yml](action.yml). What the server entry must look like is in [docs/server-entry.md](docs/server-entry.md).

## Secrets

| Secret | What it is | What it can do |
| --- | --- | --- |
| `BUNNY_API_KEY` | The account API key from the Bunny dashboard under Account > API. | Everything on the account: create and change zones, scripts, DNS, billing settings. Bunny has one account key and no scoped keys. The action fetches the storage zone password with it at run time, so no second secret is needed. |
| Values in `secrets` | Your own runtime secrets for the edge script. | Stored encrypted on the script. The action masks them in logs and Bunny never returns them, so they cannot leak through the API afterwards. |

Store both as GitHub environment secrets on the environment the deploy job uses.

## What a deploy does

1. **Compatibility check**, before anything is uploaded. Fails with one message per problem. See [docs/server-entry.md](docs/server-entry.md) for the rules.
2. **Provision or verify** the storage zone, the middleware script and the pull zone by name. Settings that differ are updated. Settings that cannot be changed (storage region, tier, existing replication regions) are reported as drift. A pull zone pointing at a different storage zone fails the run instead of being repointed.
3. **Upload** `client-dir` to storage, skipping files whose SHA-256 matches the one storage reports. Hashed assets go first, then HTML and other files, so new HTML never references a missing file.
4. **Sync environment** before publishing: variables not in `env` are removed, every secret in `secrets` is set. Secrets on the script that are not in the input are reported and only removed with `prune-secrets: true`.
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

Storage zone: Frankfurt (`DE`), standard HDD tier at $0.01/GB, no replication. Region and tier cannot be changed after creation, and replication regions cannot be removed, so those are inputs you set once.

Pull zone: standard tier, Europe only. Visitors elsewhere are served from the nearest European location. Smart Cache off, cache expiry follows the origin, cookies and `Set-Cookie` untouched, no CORS or canonical headers, no Vary variants, error responses not cached, stale served while the origin is offline, HTTPS forced on every hostname, TLS 1.0 and 1.1 off, log IP anonymization on, compression handled by Bunny for text responses.

Everything that costs extra is off. Opt in by changing the zone in the dashboard; the action does not turn these off again but does not manage them either:

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

Environment variables and secrets are stored on the script, not on the release. A rollback keeps the current values, so a release that needs an old variable value needs that value set again. Static files are not versioned: rolling back the script does not restore removed files, but files stay in storage for `keep-stale-deploys` deploys, so a rollback within that window still finds its assets.

## Limits the action enforces

Verified on a live account, where the documented limits differ:

- Script size: the API accepts more than 10 MB, but 9.5 MB and larger failed to boot reliably. Default limit 8 MB, warning above 2 MB because cold starts then reach 0.5 s.
- Environment: at most 128 variables and 2048 bytes per value. Bunny accepts larger values, but the script then fails to boot and every request, including static files, returns 400. Secrets do not count toward the 128.
- Variable changes take effect without a republish, on new isolates, within about 10 seconds.

## Development

Node 24 (`.node-version`), no dependencies, `npm test`. Deno on the PATH enables the startup probe tests. Facts about the Bunny API that shaped the code are in [docs/bunny-findings.md](docs/bunny-findings.md).
