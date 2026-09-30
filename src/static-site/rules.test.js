import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notFoundSettings, redirectingPages, siteRules } from "./rules.js";

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
      Triggers: [{ Type: 0, PatternMatches: ["*/deploys/*"], PatternMatchingType: 2 }],
    });
  });

  it("blocks the deploy folders and the _headers and _redirects files", () => {
    const deploys = rules["bunny-edge-deploy: block deploy folders"];
    assert.equal(deploys.ActionType, 4);
    assert.deepEqual(deploys.Triggers, [{ Type: 0, PatternMatches: ["*/deploys/*"], PatternMatchingType: 0 }]);
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
  const rules = siteRules({ storageZone, deployId: "689f0795086f", headers });
  const find = (predicate) => rules.filter(predicate);

  it("turns a Cache-Control max-age into a browser cache time for that path, in place of the default asset rules", () => {
    const cache = find((rule) => rule.ActionType === 16);
    assert.equal(cache.length, 1);
    assert.equal(cache[0].ActionParameter1, "31536000");
    assert.deepEqual(cache[0].Triggers, [{ Type: 0, PatternMatches: ["pattern:^https?://[^/]+/_astro/.*$"], PatternMatchingType: 0 }]);
  });

  it("sends the headers every page has on every URL, from one rule", () => {
    const [all] = find((rule) => rule.Description === "bunny-edge-deploy: headers for every page");
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

  it("leaves out a Location header, which only a real redirect can carry, and names the pages that had one", () => {
    const withLocation = [{ path: "/", headers: [["location", "/en/"], ["x-shared", "yes"]] }];
    const all = siteRules({ storageZone, deployId: "689f0795086f", headers: withLocation });
    assert.ok(!JSON.stringify(all).includes('"location"'));
    assert.deepEqual(redirectingPages(withLocation), ["/"]);
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
