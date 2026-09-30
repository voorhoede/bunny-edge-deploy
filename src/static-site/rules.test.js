import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notFoundSettings, siteRules } from "./rules.js";

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
