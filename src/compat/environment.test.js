import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffEnvironment, parseEnvironment } from "./environment.js";

describe("parseEnvironment", () => {
  it("parses KEY=value lines, keeps everything after the first =, skips blanks and comments", () => {
    const result = parseEnvironment({ env: "A=1\n\n# note\nB=x=y\nC=\n", secrets: "S=shh" });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.variables, [{ name: "A", value: "1" }, { name: "B", value: "x=y" }, { name: "C", value: "" }]);
    assert.deepEqual(result.secrets, [{ name: "S", value: "shh" }]);
  });

  it("errors on malformed lines, invalid names and duplicates across env and secrets", () => {
    const result = parseEnvironment({ env: "no-equals\n1BAD=x\nA=1\nA=2", secrets: "A=3\nlower=ok" });
    assert.ok(result.errors.some((e) => /line 1.*KEY=value/.test(e)));
    assert.ok(result.errors.some((e) => /"1BAD"/.test(e)));
    assert.ok(result.errors.some((e) => /"A".*more than once/.test(e)));
    assert.ok(!result.errors.some((e) => /lower/.test(e)));
  });

  it("errors on values over 2048 bytes and more than 128 variables, counting secrets separately", () => {
    const env = Array.from({ length: 129 }, (_, i) => `V${i}=x`).join("\n");
    const result = parseEnvironment({ env, secrets: `S=${"é".repeat(1025)}` });
    assert.ok(result.errors.some((e) => /129 variables.*128/.test(e)));
    assert.ok(result.errors.some((e) => /"S".*2050 bytes.*2048/.test(e)));
    const fine = parseEnvironment({ env: Array.from({ length: 128 }, (_, i) => `V${i}=x`).join("\n"), secrets: "S1=a\nS2=b" });
    assert.deepEqual(fine.errors, []);
  });

  it("never puts secret values in errors", () => {
    const result = parseEnvironment({ env: "", secrets: `S=${"topsecret".repeat(300)}` });
    assert.ok(result.errors.length > 0);
    assert.ok(!result.errors.join("\n").includes("topsecret"));
  });
});

describe("diffEnvironment", () => {
  const desired = {
    variables: [{ name: "A", value: "1" }, { name: "B", value: "new" }, { name: "N", value: "x" }],
    secrets: [{ name: "S", value: "shh" }, { name: "T", value: "new" }],
  };
  const remote = {
    variables: [{ id: 1, name: "A", value: "1" }, { id: 2, name: "B", value: "old" }, { id: 3, name: "OLD", value: "y" }],
    secrets: [{ id: 10, name: "S" }, { id: 11, name: "GONE" }],
  };

  it("reports added, changed, unchanged and removed variables and added, updated and removed secrets by name only", () => {
    const diff = diffEnvironment(desired, remote);
    assert.deepEqual(diff.variables, { added: ["N"], changed: ["B"], unchanged: ["A"], removed: ["OLD"] });
    assert.deepEqual(diff.secrets, { added: ["T"], updated: ["S"], removed: ["GONE"] });
    assert.ok(!JSON.stringify(diff).includes("shh"));
  });
});
