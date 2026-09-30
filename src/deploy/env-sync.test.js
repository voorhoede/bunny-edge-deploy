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
  it("sets added and changed variables and every listed secret, removes nothing, and reports what is on the script but not in the input", async () => {
    const { scripts, calls } = fakeScripts(remote);
    const result = await syncEnvironment({ scripts, scriptId: 5, desired });
    assert.deepEqual(calls, [["var", "B"], ["secret", "S"]]);
    assert.deepEqual(result.variables, { added: [], changed: ["B"], unchanged: ["A"] });
    assert.deepEqual(result.secrets, { added: [], updated: ["S"] });
    assert.deepEqual(result.notInInput, { variables: ["OLD"], secrets: ["GONE"] });
  });

  it("refuses before setting anything when the script would end up with more than 128 variables", async () => {
    const full = { variables: Array.from({ length: 127 }, (_, i) => ({ id: i, name: `V${i}`, value: "x" })), secrets: [] };
    const { scripts, calls } = fakeScripts(full);
    const twoNew = { variables: [{ name: "A", value: "1" }, { name: "B", value: "2" }], secrets: [{ name: "S", value: "s" }] };
    await assert.rejects(syncEnvironment({ scripts, scriptId: 5, desired: twoNew }), /129 variables.*127 already on the script.*128/);
    assert.deepEqual(calls, []);
  });

  it("counts a variable the script already has once", async () => {
    const full = { variables: Array.from({ length: 127 }, (_, i) => ({ id: i, name: `V${i}`, value: "x" })), secrets: [] };
    const { scripts, calls } = fakeScripts(full);
    await syncEnvironment({ scripts, scriptId: 5, desired: { variables: [{ name: "V0", value: "changed" }, { name: "B", value: "2" }], secrets: [] } });
    assert.deepEqual(calls, [["var", "V0"], ["var", "B"]]);
  });

  it("only lists when the input is empty", async () => {
    const { scripts, calls } = fakeScripts(remote);
    const result = await syncEnvironment({ scripts, scriptId: 5, desired: { variables: [], secrets: [] } });
    assert.deepEqual(calls, []);
    assert.deepEqual(result.notInInput, { variables: ["A", "B", "OLD"], secrets: ["S", "GONE"] });
  });
});
