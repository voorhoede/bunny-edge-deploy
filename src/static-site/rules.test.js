import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSiteConfig, notFoundSettings, siteRules } from "./rules.js";

const storageZone = { Id: 11, Name: "site" };
const byDescription = (rules) => Object.fromEntries(rules.map((rule) => [rule.Description, rule]));

describe("siteRules", () => {
  const rules = byDescription(siteRules({ storageZone, deployId: "689f0795086f" }));

  it("points the site at the deploy's folder and marks every response with the deploy id", () => {
    assert.deepEqual(rules["bunny-edge-deploy: serve the published deploy"], {
      Description: "bunny-edge-deploy: serve the published deploy",
      Enabled: true,
      ActionType: 17,
      ActionParameter1: "11",
      ActionParameter2: "site",
      ActionParameter3: "/deploys/689f0795086f/",
      ExtraActions: [{ ActionType: 5, ActionParameter1: "X-Bunny-Deploy", ActionParameter2: "689f0795086f" }],
      TriggerMatchingType: 0,
      Triggers: [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/deploys/.*$"], PatternMatchingType: 2 }],
    });
  });

  it("blocks the deploy folders and the _headers and _redirects files", () => {
    const deploys = rules["bunny-edge-deploy: block deploy folders"];
    assert.equal(deploys.ActionType, 4);
    assert.deepEqual(deploys.Triggers, [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/deploys/.*$"], PatternMatchingType: 0 }]);
    const config = rules["bunny-edge-deploy: block host config files"];
    assert.equal(config.ActionType, 4);
    assert.deepEqual(config.Triggers, [{ Type: 0, PatternMatches: ["*/_headers", "*/_redirects"], PatternMatchingType: 0 }]);
  });

  it("gives static assets a day of browser cache by extension, five extensions per rule", () => {
    const assets = Object.values(rules).filter((rule) => rule.ActionType === 16);
    assert.equal(assets.length, 3);
    for (const rule of assets) {
      assert.equal(rule.ActionParameter1, "86400");
      assert.equal(rule.Triggers[0].Type, 3);
      assert.ok(rule.Triggers[0].PatternMatches.length <= 5);
    }
    assert.ok(assets.flatMap((rule) => rule.Triggers[0].PatternMatches).includes("css"));
  });

  it("names every rule with the action's prefix, so it can find its own rules again", () => {
    assert.ok(Object.keys(rules).every((description) => description.startsWith("bunny-edge-deploy: ")));
  });
});

describe("notFoundSettings", () => {
  it("serves the deploy's 404.html for a missing path when the build has one", () => {
    assert.deepEqual(notFoundSettings({ deployId: "689f0795086f", files: ["index.html", "404.html"] }), { Custom404FilePath: "/deploys/689f0795086f/404.html", Rewrite404To200: false });
  });

  it("clears the 404 page when the build has none, since only an empty path clears it", () => {
    assert.deepEqual(notFoundSettings({ deployId: "689f0795086f", files: ["index.html"] }), { Custom404FilePath: "", Rewrite404To200: false });
  });
});

describe("siteRules from _headers", () => {
  const csp = (hash) => ["content-security-policy", `script-src 'self' 'sha256-${hash}='`];
  const shared = [["referrer-policy", "no-referrer"], ["x-shared", "yes"]];
  const headers = [
    { path: "/_astro/*", headers: [["Cache-Control", "public, max-age=31536000, immutable"]] },
    { path: "/", headers: [csp("a"), ...shared] },
    { path: "/about", headers: [csp("b"), ...shared] },
    { path: "/nested/page", headers: [csp("a"), ...shared] },
  ];
  const files = ["index.html", "about/index.html", "nested/page/index.html", "_astro/app.DFbA8egk.css"];
  const rules = siteRules({ storageZone, deployId: "689f0795086f", files, headers });
  const find = (predicate) => rules.filter(predicate);
  const everyPage = (all) => all.find((rule) => rule.Description === "bunny-edge-deploy: headers for every page");

  it("turns a Cache-Control max-age into a browser cache time for that path, in place of the default asset rules", () => {
    const cache = find((rule) => rule.ActionType === 16);
    assert.equal(cache.length, 1);
    assert.equal(cache[0].ActionParameter1, "31536000");
    assert.deepEqual(cache[0].Triggers, [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/_astro/.*$"], PatternMatchingType: 0 }]);
    assert.ok(!find((rule) => rule.ActionType === 5).some((rule) => rule.Triggers.some((t) => t.PatternMatches.includes("pattern:^https?://[^/]+/_astro/.*$"))));
  });

  it("sends the headers every page has on every URL, from one rule", () => {
    const all = everyPage(rules);
    assert.deepEqual([[all.ActionParameter1, all.ActionParameter2], ...all.ExtraActions.map((a) => [a.ActionParameter1, a.ActionParameter2])], shared);
    assert.deepEqual(all.Triggers, [{ Type: 0, PatternMatches: ["*"], PatternMatchingType: 0 }]);
  });

  it("gives pages their other headers, one rule per distinct set, matching each path with and without its slash", () => {
    const pages = find((rule) => rule.ActionType === 5 && rule.Description.startsWith("bunny-edge-deploy: page headers"));
    assert.equal(pages.length, 2);
    const patternsFor = (value) => pages.find((rule) => rule.ActionParameter2 === value).Triggers.flatMap((t) => t.PatternMatches);
    assert.deepEqual(patternsFor("script-src 'self' 'sha256-a='"), ["pattern:^https?://[^/]+/?$", "pattern:^https?://[^/]+/nested/page/?$"]);
    assert.deepEqual(patternsFor("script-src 'self' 'sha256-b='"), ["pattern:^https?://[^/]+/about/?$"]);
  });

  it("puts at most 25 pages in one rule: five triggers of five paths", () => {
    const many = [...Array.from({ length: 30 }, (_, i) => ({ path: `/p${i}`, headers: [csp("x")] })), { path: "/other", headers: [csp("y")] }];
    const pages = siteRules({ storageZone, deployId: "689f0795086f", headers: many }).filter((rule) => rule.ActionParameter2 === "script-src 'self' 'sha256-x='");
    assert.deepEqual(pages.map((rule) => rule.Triggers.flatMap((t) => t.PatternMatches).length), [25, 5]);
    assert.ok(pages.every((rule) => rule.Triggers.length <= 5 && rule.Triggers.every((t) => t.PatternMatches.length <= 5)));
  });

  it("escapes characters that mean something in a pattern", () => {
    const [page] = siteRules({ storageZone, deployId: "689f0795086f", headers: [{ path: "/a.b-c(d)", headers: [csp("x")] }, { path: "/e", headers: [] }] })
      .filter((rule) => rule.Description.startsWith("bunny-edge-deploy: page headers"));
    assert.deepEqual(page.Triggers[0].PatternMatches, ["pattern:^https?://[^/]+/a%.b%-c%(d%)/?$"]);
  });

  it("leaves out a Location header, which only a real redirect can carry", () => {
    const withLocation = [{ path: "/", headers: [["location", "/en/"], ["x-shared", "yes"]] }];
    const all = siteRules({ storageZone, deployId: "689f0795086f", files: ["index.html"], headers: withLocation });
    assert.ok(!JSON.stringify(all).includes('"location"'));
  });

  it("keeps headers that only some pages have on those pages, so one /admin block cannot reach the whole site", () => {
    const all = siteRules({ storageZone, deployId: "689f0795086f", files: ["index.html", "admin/index.html"], headers: [{ path: "/admin", headers: [["x-robots-tag", "noindex"]] }] });
    assert.equal(everyPage(all), undefined);
    const noindex = all.filter((rule) => rule.ActionType === 5 && rule.ActionParameter1 === "x-robots-tag");
    assert.deepEqual(noindex.flatMap((rule) => rule.Triggers.flatMap((t) => t.PatternMatches)), ["pattern:^https?://[^/]+/admin/?$"]);
  });

  it("counts a page as covered with or without its trailing slash, and does not expect headers on a redirect's page", () => {
    const all = siteRules({
      storageZone, deployId: "689f0795086f",
      files: ["index.html", "about/index.html", "old/index.html", "_astro/app.DFbA8egk.css"],
      headers: [{ path: "/", headers: shared }, { path: "/about/", headers: shared }],
      redirects: [{ from: "/old", to: "/about", status: 301 }],
    });
    assert.ok(everyPage(all));
  });

  it("applies a wildcard block's headers to every path under it, except Cache-Control, which becomes a browser cache time", () => {
    const all = siteRules({ storageZone, deployId: "689f0795086f", files: ["index.html"], headers: [
      { path: "/*", headers: [["x-frame-options", "DENY"]] },
      { path: "/api/*", headers: [["access-control-allow-origin", "*"], ["Cache-Control", "public, max-age=60"]] },
    ] });
    const byName = (name) => all.filter((rule) => rule.ActionType === 5 && rule.ActionParameter1 === name);
    assert.deepEqual(byName("x-frame-options").map((rule) => [rule.Description, rule.Triggers]), [["bunny-edge-deploy: headers /*", [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/.*$"], PatternMatchingType: 0 }]]]);
    const [api] = byName("access-control-allow-origin");
    assert.deepEqual(api.Triggers, [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/api/.*$"], PatternMatchingType: 0 }]);
    assert.deepEqual(api.ExtraActions, []);
  });

  it("makes no rule for a path a rule cannot match: a * before the end, or a :placeholder", () => {
    const all = siteRules({ storageZone, deployId: "689f0795086f", files: ["index.html"], headers: [
      { path: "/a/*/b", headers: [["x-a", "1"]] },
      { path: "/blog/:slug", headers: [["x-b", "1"]] },
    ] });
    assert.ok(!all.some((rule) => ["x-a", "x-b"].includes(rule.ActionParameter1)));
  });
});

describe("analyzeSiteConfig", () => {
  it("has nothing to say about the files the Astro adapter writes", () => {
    const headers = [
      { path: "/_astro/*", headers: [["Cache-Control", "public, max-age=31536000, immutable"]] },
      { path: "/about", headers: [["content-security-policy", "script-src 'self'"]] },
    ];
    assert.deepEqual(analyzeSiteConfig({ headers, redirects: [{ from: "/old", to: "/about", status: 301 }] }), { errors: [], warnings: [] });
  });

  it("refuses a redirect without a target, or with a status Bunny cannot redirect with", () => {
    const { errors } = analyzeSiteConfig({ headers: [], redirects: [{ from: "/a", to: undefined, status: 301 }, { from: "/b", to: "/c", status: 200 }] });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /_redirects.*\/a.*no target/);
    assert.match(errors[1], /_redirects.*\/b.*200.*301, 302, 307 or 308/);
  });

  it("warns about a Cache-Control without max-age, which a browser cache time cannot express", () => {
    const { warnings } = analyzeSiteConfig({ headers: [{ path: "/x", headers: [["Cache-Control", "no-store"]] }], redirects: [] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /_headers.*\/x.*Cache-Control: no-store/);
  });

  it("warns about a path a rule cannot match: a * before the end, or a :placeholder", () => {
    const { warnings } = analyzeSiteConfig({ headers: [{ path: "/a/*/b", headers: [["x-a", "1"]] }, { path: "/blog/:slug", headers: [["x-b", "1"]] }], redirects: [] });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /\/a\/\*\/b/);
    assert.match(warnings[1], /\/blog\/:slug/);
  });

  it("names the pages whose Location header only their own meta refresh can carry", () => {
    const { warnings } = analyzeSiteConfig({ headers: [{ path: "/", headers: [["location", "/en/"]] }], redirects: [] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not redirected.*\//);
  });
});

describe("siteRules from _redirects", () => {
  it("turns each redirect into a rule for its path, sending relative targets to the requested host", () => {
    const [rule] = siteRules({ storageZone, deployId: "689f0795086f", redirects: [{ from: "/old", to: "/about", status: 301 }] }).filter((r) => r.ActionType === 1);
    assert.equal(rule.Description, "bunny-edge-deploy: redirect /old");
    assert.equal(rule.ActionParameter1, "https://%{Url.Hostname}/about");
    assert.equal(rule.ActionParameter2, "301");
    assert.deepEqual(rule.Triggers, [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/old/?$"], PatternMatchingType: 0 }]);
  });

  it("keeps an absolute target as it is", () => {
    const [rule] = siteRules({ storageZone, deployId: "689f0795086f", redirects: [{ from: "/away", to: "https://example.com/", status: 302 }] }).filter((r) => r.ActionType === 1);
    assert.equal(rule.ActionParameter1, "https://example.com/");
    assert.equal(rule.ActionParameter2, "302");
  });

  it("refuses a status Bunny cannot redirect with", () => {
    assert.throws(() => siteRules({ storageZone, deployId: "689f0795086f", redirects: [{ from: "/x", to: "/y", status: 200 }] }), /\/x.*200.*301, 302, 307 or 308/);
  });
});
