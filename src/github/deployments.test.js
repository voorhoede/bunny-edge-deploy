import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDeployment } from "./deployments.js";

const env = {
  GITHUB_REPOSITORY: "voorhoede/head-start",
  GITHUB_SHA: "f93a1cb62232316f878cad7c1814c24d9751b300",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_RUN_ID: "36721407363",
};
const logUrl = "https://github.com/voorhoede/head-start/actions/runs/36721407363";

function github(respond = () => undefined) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const path = new URL(url).pathname;
    const { status, json } = respond(path) ?? (path.endsWith("/deployments") ? { status: 201, json: { id: 42 } } : { status: 201, json: {} });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const open = (overrides = {}) => openDeployment({ env, token: "tok", environment: "production", warn: () => {}, ...overrides });

describe("openDeployment", () => {
  it("opens a deployment of the commit in the environment and marks it in progress, linking the run", async () => {
    const { fetch, calls } = github();
    assert.ok(await open({ fetch }));
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.github.com/repos/voorhoede/head-start/deployments");
    assert.equal(calls[0].headers.get("authorization"), "Bearer tok");
    assert.deepEqual(calls[0].body, {
      ref: env.GITHUB_SHA, environment: "production", description: "Deploying f93a1cb to Bunny",
      auto_merge: false, required_contexts: [], production_environment: true, transient_environment: false,
    });
    assert.equal(calls[1].url, "https://api.github.com/repos/voorhoede/head-start/deployments/42/statuses");
    assert.deepEqual(calls[1].body, { state: "in_progress", log_url: logUrl });
  });

  it("closes a live deploy as a success that links the site, names the deploy and the commit, and retires the previous one", async () => {
    const { fetch, calls } = github();
    const record = await open({ fetch });
    await record.succeed({ url: "https://head-start.b-cdn.net", deployId: "1fec5c71ed9d" });
    assert.deepEqual(calls[2].body, {
      state: "success", description: "Deploy 1fec5c71ed9d of f93a1cb is live", environment_url: "https://head-start.b-cdn.net", log_url: logUrl, auto_inactive: true,
    });
  });

  it("closes a failed deploy as a failure without a site link, cut to GitHub's 140 characters", async () => {
    const { fetch, calls } = github();
    const record = await open({ fetch });
    await record.fail(`smoke test failed: ${"x".repeat(200)}`);
    assert.equal(calls[2].body.state, "failure");
    assert.equal(calls[2].body.environment_url, undefined);
    assert.equal(calls[2].body.description.length, 140);
  });

  it("records nothing outside GitHub Actions, without a token, or with an empty environment", async () => {
    const { fetch, calls } = github();
    assert.equal(await open({ fetch, env: {} }), undefined);
    assert.equal(await open({ fetch, token: "" }), undefined);
    assert.equal(await open({ fetch, environment: "" }), undefined);
    assert.equal(calls.length, 0);
  });

  it("warns and records nothing when GitHub refuses, for example without deployments: write", async () => {
    const { fetch } = github(() => ({ status: 403, json: { message: "Resource not accessible by integration" } }));
    const warnings = [];
    assert.equal(await open({ fetch, warn: (m) => warnings.push(m) }), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /403.*Resource not accessible by integration.*deployments: write/);
  });

  it("records nothing when GitHub answers without a deployment", async () => {
    const { fetch } = github((path) => (path.endsWith("/deployments") ? { status: 202, json: { message: "Auto-merged main into topic branch." } } : undefined));
    const warnings = [];
    assert.equal(await open({ fetch, warn: (m) => warnings.push(m) }), undefined);
    assert.equal(warnings.length, 1);
  });

  it("warns instead of failing the deploy when a status update is refused", async () => {
    let statuses = 0;
    const { fetch } = github((path) => (path.endsWith("/statuses") && ++statuses > 1 ? { status: 500, json: { message: "boom" } } : undefined));
    const warnings = [];
    const record = await open({ fetch, warn: (m) => warnings.push(m) });
    await record.succeed({ url: "https://head-start.b-cdn.net", deployId: "1fec5c71ed9d" });
    assert.match(warnings[0], /500.*boom/);
  });
});
