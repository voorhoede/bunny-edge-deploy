# bunny-edge-deploy

GitHub Action that deploys a built website to [Bunny.net](https://bunny.net). It deploys what a Bunny framework adapter, such as [`@bunny.net/astro-adapter`](https://github.com/BunnyWay/bunny-adapters/tree/main/packages/astro), describes in `.bunny/build.json`:

- **A server build** puts its client files in a Bunny Storage folder per deploy and runs its server bundle as an Edge Script behind a Bunny CDN pull zone: as the zone's origin (standalone), or as middleware in front of the storage zone, so files come from the nearest storage replica.
- **A static build** is served straight from storage. Edge rules route to the current deploy and apply the build's `_headers` and `_redirects`.

The action only deploys. Build first, then run it. It creates the Bunny resources on first use, keeps the settings the build needs in check, and deletes only what it created itself: old deploy folders and its own edge rules.

## Setup

1. Create a `BUNNY_API_KEY` secret in your repository or environment with the account API key from the Bunny dashboard (Account > API). Bunny has one account key and it can do everything, so keep it in an environment with protection rules.
2. Add a deploy step after your build:

```yaml
- run: npm run build # writes dist/ and .bunny/build.json
- uses: voorhoede/bunny-edge-deploy@<commit-sha>
  with:
    bunny-api-key: ${{ secrets.BUNNY_API_KEY }}
    # Only for a server build: the app's own runtime variables and secrets.
    secrets: |
      CMS_TOKEN=${{ secrets.CMS_TOKEN }}
```

3. Give the job `deployments: write`, so each deploy is recorded in the repository's Environments tab with its commit and a link to the site. Without it the deploy logs a warning and goes ahead.
4. Push. The job summary shows the commit, the `<name>.b-cdn.net` hostname, the deploy and what changed.

[examples/deploy.yml](examples/deploy.yml) is a complete workflow with a concurrency group, minimal permissions and pinned actions. Every input is documented in [action.yml](action.yml).

## Docs

- [What the action reads from the build](docs/build-manifest.md): `.bunny/build.json`, the script checks, the variables the action sets, and how `_headers` and `_redirects` become edge rules.
- [How a deploy works](docs/how-it-works.md): the steps, caching, defaults and costs, rollback, and the limits the action enforces.
- [Managing the zone](docs/managing-the-zone.md): which settings and edge rules the action owns, and how to add a custom hostname.
- [Bunny findings](docs/bunny-findings.md): API facts verified against the docs and on a live account.

One rule worth knowing before the first server deploy: Bunny caches a response without a `Cache-Control` header for 30 days, and cookies are not part of the cache key. Bunny's Astro adapter sends `private, no-store` on rendered responses that set nothing themselves; any other server bundle has to mark personalized responses the same way.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Node 24, no dependencies, `npm test`.
