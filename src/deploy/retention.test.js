import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileRetention } from "./retention.js";

describe("reconcileRetention", () => {
  it("records newly stale files under the current deploy number and deletes nothing yet", () => {
    const result = reconcileRetention({ state: { deploy: 4, stale: {} }, stale: ["a.js"], keep: 3 });
    assert.deepEqual(result.state, { deploy: 5, stale: { "a.js": 5 } });
    assert.deepEqual(result.remove, []);
  });

  it("deletes files that have been stale for `keep` deploys and forgets files that came back", () => {
    const result = reconcileRetention({ state: { deploy: 7, stale: { "a.js": 5, "b.js": 7, "back.js": 6 } }, stale: ["a.js", "b.js"], keep: 3 });
    assert.deepEqual(result.remove, ["a.js"]);
    assert.deepEqual(result.state, { deploy: 8, stale: { "b.js": 7 } });
  });

  it("starts from an empty state when there is none", () => {
    assert.deepEqual(reconcileRetention({ state: undefined, stale: [], keep: 3 }).state, { deploy: 1, stale: {} });
  });

  it("deletes immediately when keep is 0", () => {
    assert.deepEqual(reconcileRetention({ state: undefined, stale: ["x"], keep: 0 }).remove, ["x"]);
  });
});
