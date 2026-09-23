# Managing the zone

The action creates the storage zone, the pull zone and the script when they are missing, with the defaults in [how-it-works.md](how-it-works.md). After that it reads them as they are: the dashboard is the source of truth, and the action never changes a setting behind your back.

## What the action checks on every deploy

Three settings the deploy depends on. If one is off, the run fails with a message naming the dashboard setting, because deploying onto that zone would serve wrong content:

- the pull zone origin is the storage zone the action deploys to;
- no other script is attached as middleware (a zone without any middleware gets the script attached, once);
- Cache Expiration Time is "Respect origin Cache-Control". Any override caches rendered responses for that long regardless of their headers, including personalized ones.

Four settings that only produce a warning, since they degrade rather than break: Smart Cache on, Disable Cookies on, "Run script before cache" on, and a missing block rule for `/.bunny-edge-deploy/*`.

The action also turns Force SSL on for every hostname on the zone, including ones you add.

## Environment variables and secrets

Runtime configuration for the script lives on the script: in the dashboard under the script's Environment variables, or through the `env` and `secrets` inputs. The inputs only add or update the keys they list and never remove anything, so both can be used together. Variables can be read back; secrets cannot, Bunny returns only their names. A change reaches new isolates within about ten seconds, no deploy needed. Set a new variable before pushing code that reads it.

Limits verified on the runtime: 128 variables, 2048 bytes per value. Bunny accepts more, but the script then fails to boot and every request returns 400.

## Everything else

Pricing tier and regions, TLS versions, Vary features, CORS, logging, Bunny Shield, Optimizer, add-ons, edge rules, hostnames and certificates are yours to change in the dashboard. The action sets sensible values at creation and leaves them alone afterwards. Storage zone region, tier and replication regions cannot be changed at all after creation; a difference from the inputs shows up as a drift line in the summary.

## Adding a custom hostname

Bunny routes a request by its hostname, and a hostname that is not attached to a pull zone gets a Bunny error page and no TLS certificate. So a CNAME alone is not enough; the hostname has to be on the zone as well. Both steps, from [Bunny's custom hostname guide](https://bunny.net/docs/cdn/custom-hostname):

1. In the dashboard, open the pull zone, find the **Hostnames** panel under General, enter the hostname (for example `www.example.com`) and click **Add hostname**.
2. At your DNS provider, create a CNAME from that hostname to `<name>.b-cdn.net`, the system hostname shown in the job summary. TTL 3600 or lower. On Cloudflare, turn the proxy (orange cloud) off for this record.
3. Back in the hostname list, click **Verify & Activate SSL** once the CNAME resolves. Bunny issues a free certificate, validated over HTTP, so this works with any DNS provider.
4. Leave Force SSL on. The next deploy turns it on anyway.

Apex domains (`example.com` without `www`) cannot carry a CNAME under DNS rules. Bunny DNS flattens CNAMEs at the apex, as do Cloudflare, DNSimple and Route 53 alias records. With a provider that cannot, point `www` at Bunny and redirect the apex to it.

Two things that are unique across all of Bunny, not just your account: a hostname can be attached to one pull zone, and a domain can be a Bunny DNS zone in one account. The DNS zone and the pull zone do not have to be in the same account; the CNAME just points at the other account's `<name>.b-cdn.net`.
