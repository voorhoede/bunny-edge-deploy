# Managing the zone

The action creates the storage zone, the pull zone and, for a server build, the script when they are missing, with the defaults in [how-it-works.md](how-it-works.md). After that the dashboard is the source of truth, except for the few things below that the build depends on.

## What the action checks and sets on every deploy

**The origin.** A server build's pull zone must have its script as origin; a static build's pull zone must have its storage zone as origin. The origin is fixed when the zone is created, so a mismatch fails the run before anything is uploaded. Deploy a different kind of build under another `name` or `pull-zone-name`.

**Settings the build needs.** If one differs, the action changes it back and logs the change:

- Server build: Cache Expiration Time "Respect origin Cache-Control" (`CacheControlMaxAgeOverride` -1), plus whatever the manifest asks for in `requires.pullZone`. For Bunny's Astro adapter that is Disable Cookies off and Smart Cache off.
- Static build: the CDN keeps files for 30 days (`CacheControlMaxAgeOverride` 2592000) and browsers revalidate (`CacheControlPublicMaxAgeOverride` 0).

**The 404 page** (static build). The storage zone's custom 404 path points at the live deploy's `404.html`, or is cleared when the build has none. It changes with every publish, and `Rewrite404To200` is set to false, so a missing path answers 404 even when the dashboard had a single-page fallback.

The action also turns Force SSL on for every hostname on the zone, including ones you add.

## Edge rules the action owns (static builds)

A static site is served by edge rules. The action owns every rule whose description starts with `bunny-edge-deploy:` and rewrites them on each publish:

- serving the live deploy folder, with an `X-Bunny-Deploy` header naming the deploy;
- blocking `/deploys/*`, `/_headers` and `/_redirects`;
- browser cache times, from `_headers` or for common asset extensions;
- the build's headers and redirects.

Rules of its own that the new build no longer has are deleted. Rules with any other description are never touched, so you can add your own, as long as the zone stays within Bunny's 50 rules.

## Environment variables and secrets (server builds)

Runtime configuration lives on the script: in the dashboard under the script's Environment variables, or through the `env` and `secrets` inputs. The inputs only add or update the keys they list and never remove anything, so both can be used together. The platform variables in [build-manifest.md](build-manifest.md) are rewritten from the zones on every deploy. Variables can be read back; secrets cannot, Bunny returns only their names. A change reaches new isolates within about ten seconds, no deploy needed. Set a new variable before pushing code that reads it.

Limits verified on the runtime: 128 variables, 2048 bytes per value. Bunny accepts more, but the script then fails to boot and every request returns 400.

## Everything else

Pricing tier and regions, TLS versions, Vary features, CORS, logging, Bunny Shield, Optimizer, add-ons, your own edge rules, hostnames and certificates are yours to change in the dashboard. The action sets sensible values at creation and leaves them alone afterwards. Storage zone region, tier and replication regions cannot be changed at all after creation; a difference from the inputs shows up as a drift line in the summary.

## Adding a custom hostname

Bunny routes a request by its hostname, and a hostname that is not attached to a pull zone gets a Bunny error page and no TLS certificate. So a CNAME alone is not enough; the hostname has to be on the zone as well. Both steps, from [Bunny's custom hostname guide](https://bunny.net/docs/cdn/custom-hostname):

1. In the dashboard, open the pull zone, find the **Hostnames** panel under General, enter the hostname (for example `www.example.com`) and click **Add hostname**.
2. At your DNS provider, create a CNAME from that hostname to `<name>.b-cdn.net`, the system hostname shown in the job summary. TTL 3600 or lower. On Cloudflare, turn the proxy (orange cloud) off for this record.
3. Back in the hostname list, click **Verify & Activate SSL** once the CNAME resolves. Bunny issues a free certificate, validated over HTTP, so this works with any DNS provider.
4. Leave Force SSL on. The next deploy turns it on anyway.

Apex domains (`example.com` without `www`) cannot carry a CNAME under DNS rules. Bunny DNS flattens CNAMEs at the apex, as do Cloudflare, DNSimple and Route 53 alias records. With a provider that cannot, point `www` at Bunny and redirect the apex to it.

Two things that are unique across all of Bunny, not just your account: a hostname can be attached to one pull zone, and a domain can be a Bunny DNS zone in one account. The DNS zone and the pull zone do not have to be in the same account; the CNAME just points at the other account's `<name>.b-cdn.net`.
