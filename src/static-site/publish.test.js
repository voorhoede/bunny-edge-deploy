import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishStaticSite } from "./publish.js";

const rule = (description, extra = {}) => ({ Description: description, Enabled: true, ActionType: 4, TriggerMatchingType: 0, Triggers: [], ...extra });

function fakes({ edgeRules = [], storageZoneSettings = { Custom404FilePath: null, Rewrite404To200: false }, deployHeader = () => "689f0795086f" } = {}) {
  const events = [];
  let clock = 0;
  const api = {
    pullZones: {
      get: async () => ({ Id: 33, EdgeRules: edgeRules }),
      addOrUpdateEdgeRule: async (id, body) => events.push(["rule", body.Description, body.Guid]),
      purgeAll: async () => events.push(["purge"]),
    },
    storageZones: {
      get: async () => storageZoneSettings,
      update: async (id, settings) => events.push(["404", settings]),
    },
  };
  const fetch = async (url) => { events.push(["probe", clock]); return new Response("", { headers: { "x-bunny-deploy": deployHeader(clock) } }); };
  const sleep = async (ms) => { clock += ms; };
  return { api, fetch, sleep, now: () => clock, events };
}

const desired = [rule("bunny-edge-deploy: serve the published deploy"), rule("bunny-edge-deploy: block deploy folders")];
const common = { pullZone: { Id: 33 }, storageZone: { Id: 11 }, hostname: "site.b-cdn.net", deployId: "689f0795086f", notFound: { Custom404FilePath: "/deploys/689f0795086f/404.html", Rewrite404To200: false } };

describe("publishStaticSite", () => {
  it("updates rules it already has in place by passing their Guid, and adds the rest", async () => {
    const f = fakes({ edgeRules: [{ ...rule("bunny-edge-deploy: serve the published deploy"), Guid: "g-serve" }] });
    await publishStaticSite({ ...f, ...common, rules: desired });
    assert.deepEqual(f.events.filter((e) => e[0] === "rule"), [
      ["rule", "bunny-edge-deploy: serve the published deploy", "g-serve"],
      ["rule", "bunny-edge-deploy: block deploy folders", undefined],
    ]);
  });

  it("leaves rules it did not create alone", async () => {
    const f = fakes({ edgeRules: [{ ...rule("force www"), Guid: "g-mine" }] });
    await publishStaticSite({ ...f, ...common, rules: desired });
    assert.ok(!f.events.some((e) => e[0] === "rule" && e[1] === "force www"));
  });

  it("sets the storage zone's 404 page, and only when it differs", async () => {
    const changed = fakes();
    await publishStaticSite({ ...changed, ...common, rules: desired });
    assert.deepEqual(changed.events.find((e) => e[0] === "404")[1], common.notFound);
    const same = fakes({ storageZoneSettings: common.notFound });
    await publishStaticSite({ ...same, ...common, rules: desired });
    assert.ok(!same.events.some((e) => e[0] === "404"));
  });

  it("purges, waits until the site answers with the new deploy, at least 7.5 s, and purges again", async () => {
    const f = fakes({ deployHeader: (clock) => (clock >= 3000 ? "689f0795086f" : "000000000001") });
    const result = await publishStaticSite({ ...f, ...common, rules: desired });
    const kinds = f.events.map((e) => e[0]);
    assert.ok(kinds.lastIndexOf("rule") < kinds.indexOf("purge"));
    assert.ok(kinds.indexOf("purge") < kinds.indexOf("probe"));
    assert.equal(kinds.lastIndexOf("purge"), kinds.length - 1);
    assert.equal(kinds.filter((k) => k === "purge").length, 2);
    assert.ok(f.now() >= 7500, `waited ${f.now()} ms`);
    assert.equal(result.confirmed, true);
  });

  it("stops waiting after 20 s without failing, and reports the deploy as unconfirmed", async () => {
    const f = fakes({ deployHeader: () => "000000000001" });
    const result = await publishStaticSite({ ...f, ...common, rules: desired });
    assert.ok(f.now() >= 20000 && f.now() < 22000, `waited ${f.now()} ms`);
    assert.equal(result.confirmed, false);
    assert.equal(f.events.filter((e) => e[0] === "purge").length, 2);
  });
});
