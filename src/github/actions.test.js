import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createActionsIo, readInputs } from "./actions.js";

describe("readInputs", () => {
  it("reads INPUT_ variables by dashed name and applies types and defaults", () => {
    const env = { "INPUT_BUNNY-API-KEY": "key", INPUT_ENV: "A=1\nB=2", "INPUT_STALE-WHILE-UPDATING": "true", "INPUT_KEEP-DEPLOYS": "5", "INPUT_PRICING-REGIONS": "EU, US" };
    const inputs = readInputs(env, {
      "bunny-api-key": { required: true },
      env: { default: "" },
      "stale-while-updating": { type: "boolean", default: false },
      "keep-deploys": { type: "integer", default: 3 },
      "pricing-regions": { type: "list", default: ["EU"] },
      "storage-region": { default: "DE" },
    });
    assert.deepEqual(inputs, { "bunny-api-key": "key", env: "A=1\nB=2", "stale-while-updating": true, "keep-deploys": 5, "pricing-regions": ["EU", "US"], "storage-region": "DE" });
  });

  it("throws a clear error for a missing required input, an invalid boolean or integer, and an unknown choice", () => {
    assert.throws(() => readInputs({}, { "bunny-api-key": { required: true } }), /input "bunny-api-key" is required/);
    assert.throws(() => readInputs({ INPUT_X: "yes" }, { x: { type: "boolean" } }), /"x" must be true or false/);
    assert.throws(() => readInputs({ INPUT_X: "many" }, { x: { type: "integer" } }), /"x" must be an integer/);
    assert.throws(() => readInputs({ INPUT_X: "tiny" }, { x: { choices: ["standard", "edge"] } }), /"x" must be one of standard, edge/);
  });
});

describe("createActionsIo", () => {
  async function io() {
    const dir = await mkdtemp(join(tmpdir(), "bed-gh-"));
    const lines = [];
    const env = { GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
    return { io: createActionsIo({ env, write: (line) => lines.push(line) }), lines, env };
  }

  it("masks every line of a secret value before anything else is written", async () => {
    const { io: actions, lines } = await io();
    actions.mask("line1\nline2");
    actions.info("hello");
    assert.deepEqual(lines, ["::add-mask::line1", "::add-mask::line2", "hello"]);
  });

  it("writes warnings, errors and groups as workflow commands", async () => {
    const { io: actions, lines } = await io();
    actions.warning("careful");
    actions.error("bad");
    await actions.group("Step", () => actions.info("inside"));
    assert.deepEqual(lines, ["::warning::careful", "::error::bad", "::group::Step", "inside", "::endgroup::"]);
  });

  it("appends outputs and the summary to the files GitHub provides", async () => {
    const { io: actions, env } = await io();
    await actions.setOutput("hostname", "site.b-cdn.net");
    await actions.setOutput("release", "abc");
    await actions.summary("# Deployed\n");
    assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "hostname=site.b-cdn.net\nrelease=abc\n");
    assert.equal(await readFile(env.GITHUB_STEP_SUMMARY, "utf8"), "# Deployed\n");
  });

  it("uses a heredoc delimiter for multi-line outputs", async () => {
    const { io: actions, env } = await io();
    await actions.setOutput("list", "a\nb");
    assert.match(await readFile(env.GITHUB_OUTPUT, "utf8"), /^list<<(\S+)\na\nb\n\1\n$/);
  });
});
