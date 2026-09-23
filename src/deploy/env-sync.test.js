import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncEnvironment } from "./env-sync.js";

function fakeScripts(remote) {
  const calls = [];
  const scripts = {
    variables: { list: async () => remote.variables, upsert: async (id, v) => { calls.push(["var", v.name]); return "updated"; }, delete: async (id, vid) => calls.push(["delvar", vid]) },
    secrets: { list: async () => remote.secrets, upsert: async (id, s) => { calls.push(["secret", s.name]); return "created"; }, delete: async (id, sid) => calls.push(["delsecret", sid]) },
  };
  return { scripts, calls };
}

const desired = { variables: [{ name: "A", value: "1" }, { name: "B", value: "new" }], secrets: [{ name: "S", value: "shh" }] };
const remote = { variables: [{ id: 1, name: "A", value: "1" }, { id: 2, name: "B", value: "old" }, { id: 3, name: "OLD", value: "x" }], secrets: [{ id: 10, name: "S" }, { id: 11, name: "GONE" }] };

describe("syncEnvironment", () => {
  it("upserts added and changed variables, removes variables not in the input, and upserts every secret", async () => {
    const { scripts, calls } = fakeScripts(remote);
    const result = await syncEnvironment({ scripts, scriptId: 5, desired });
    assert.deepEqual(calls, [["var", "B"], ["delvar", 3], ["secret", "S"]]);
    assert.deepEqual(result.variables, { added: [], changed: ["B"], unchanged: ["A"], removed: ["OLD"] });
    assert.deepEqual(result.secrets, { added: [], updated: ["S"], removed: [] });
    assert.deepEqual(result.secretsLeft, ["GONE"]);
  });

  it("removes secrets not in the input only when pruneSecrets is set", async () => {
    const { scripts, calls } = fakeScripts(remote);
    const result = await syncEnvironment({ scripts, scriptId: 5, desired, pruneSecrets: true });
    assert.ok(calls.some((c) => c[0] === "delsecret" && c[1] === 11));
    assert.deepEqual(result.secrets.removed, ["GONE"]);
    assert.deepEqual(result.secretsLeft, []);
  });
});
