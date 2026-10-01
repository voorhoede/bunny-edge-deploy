const DESCRIPTION_MAX = 140;

const cut = (text) => (text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`);

// Best effort: a deploy never fails because GitHub could not record it.
export async function openDeployment({ fetch = globalThis.fetch, env, token, environment, warn }) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha } = env;
  if (!repository || !sha || !token || !environment) return undefined;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const logUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;
  const commit = sha.slice(0, 7);

  const post = async (path, body) => {
    const response = await fetch(`${api}/repos/${repository}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "bunny-edge-deploy" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}: ${payload.message ?? "no message"}`);
    return payload;
  };

  let id;
  try {
    // This run is the decision to deploy, so waiting on the commit's own checks or merging would block it.
    const created = await post("/deployments", {
      ref: sha, environment, description: `Deploying ${commit} to Bunny`,
      auto_merge: false, required_contexts: [], production_environment: true, transient_environment: false,
    });
    id = created.id;
    if (id === undefined) {
      warn(`GitHub created no deployment record${created.message ? `: ${created.message}` : ""}; the deploy goes ahead without one`);
      return undefined;
    }
    await post(`/deployments/${id}/statuses`, { state: "in_progress", log_url: logUrl });
  } catch (error) {
    warn(`${error.message}; the deploy is not recorded in GitHub Environments. Does the job grant deployments: write?`);
    return undefined;
  }

  const close = async (status) => {
    try {
      await post(`/deployments/${id}/statuses`, { ...status, log_url: logUrl });
    } catch (error) {
      warn(`${error.message}; the deploy's record in GitHub Environments was not updated`);
    }
  };
  return {
    succeed: ({ url, deployId }) => close({ state: "success", description: cut(`Deploy ${deployId} of ${commit} is live`), environment_url: url, auto_inactive: true }),
    fail: (message) => close({ state: "failure", description: cut(message) }),
  };
}
