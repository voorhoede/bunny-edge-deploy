# bunny-edge-deploy

GitHub Action that deploys a built website to [Bunny.net](https://bunny.net). Static files go to a Bunny Storage zone served by a Bunny CDN pull zone; one server file runs as a Bunny Edge Scripting middleware that renders everything else.

The action only deploys. Build first, then point it at the output. It creates the three Bunny resources on first use and keeps their settings in check on every run, without ever deleting anything.

## Setup

1. Create a `BUNNY_API_KEY` secret in your repository or environment with the account API key from the Bunny dashboard (Account > API). Bunny has one account key and it can do everything, so keep it in an environment with protection rules.
2. Add a deploy job after your build:

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

3. Push. The job summary shows the `<name>.b-cdn.net` hostname, the published release and what changed.

[examples/deploy.yml](examples/deploy.yml) is a complete workflow with a concurrency group, minimal permissions and pinned actions. Every input is documented in [action.yml](action.yml).

## Docs

- [What the server entry must look like](docs/server-entry.md): the contract for the file you pass as `server-entry`, usually produced by a framework adapter.
- [How a deploy works](docs/how-it-works.md): the steps, caching behavior, defaults and costs, rollback, and the limits the action enforces.
- [Bunny findings](docs/bunny-findings.md): API facts verified against the docs and on a live account.

One rule worth knowing before the first deploy: Bunny caches a rendered response without a `Cache-Control` header for 30 days and cookies are not part of the cache key, so the app must mark personalized responses `private` or `no-store`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Node 24, no dependencies, `npm test`.
