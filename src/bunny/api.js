import { isTransientStatus, withRetry } from "./retry.js";

const BASE_URL = "https://api.bunny.net";

export class BunnyApiError extends Error {
  constructor({ status, path, body }) {
    const detail = body?.Message ?? body?.detail ?? body?.title ?? (typeof body === "string" ? body : "");
    super(`Bunny API ${status} on ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "BunnyApiError";
    this.status = status;
    this.path = path;
    this.errorKey = body?.ErrorKey;
    this.field = body?.Field;
    this.transient = isTransientStatus(status);
  }
}

export function createBunnyApi({ apiKey, fetch = globalThis.fetch, sleep } = {}) {
  async function request(method, path, { body, query } = {}) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    return withRetry(async () => {
      const response = await fetch(url, {
        method,
        headers: { AccessKey: apiKey, Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await parseBody(response);
      if (!response.ok) throw new BunnyApiError({ status: response.status, path, body: payload });
      return { status: response.status, payload };
    }, { sleep });
  }

  const get = (path, query) => request("GET", path, { query }).then((r) => r.payload);
  const post = (path, body) => request("POST", path, { body }).then((r) => r.payload);
  const put = (path, body) => request("PUT", path, { body });
  const del = (path, query) => request("DELETE", path, { query }).then((r) => r.payload);

  const findByName = (path) => async (name) => {
    const items = toItems(await get(path, { search: name, perPage: 1000 }));
    return items.find((item) => item.Name === name);
  };

  return {
    pullZones: {
      list: () => get("/pullzone").then(toItems),
      findByName: findByName("/pullzone"),
      get: (id) => get(`/pullzone/${id}`),
      create: (body) => post("/pullzone", body),
      update: (id, settings) => post(`/pullzone/${id}`, settings),
      setForceSsl: (id, hostname, forceSsl) => post(`/pullzone/${id}/setForceSSL`, { Hostname: hostname, ForceSSL: forceSsl }),
      addOrUpdateEdgeRule: (id, rule) => post(`/pullzone/${id}/edgerules/addOrUpdate`, rule),
      purgeAll: (id) => post(`/pullzone/${id}/purgeCache`, {}),
    },
    storageZones: {
      findByName: findByName("/storagezone"),
      get: (id) => get(`/storagezone/${id}`),
      create: (body) => post("/storagezone", body),
      update: (id, settings) => post(`/storagezone/${id}`, settings),
    },
    scripts: {
      findByName: findByName("/compute/script"),
      get: (id) => get(`/compute/script/${id}`),
      create: (body) => post("/compute/script", body),
      uploadCode: (id, code) => post(`/compute/script/${id}/code`, { Code: code }),
      publish: (id, note) => post(`/compute/script/${id}/publish`, { Note: note }),
      publishRelease: (id, uuid, note) => post(`/compute/script/${id}/publish/${uuid}`, { Note: note }),
      listReleases: (id) => get(`/compute/script/${id}/releases`).then(toItems),
      activeRelease: (id) => get(`/compute/script/${id}/releases/active`),
      variables: {
        list: async (id) => (await get(`/compute/script/${id}`)).EdgeScriptVariables.map((v) => ({ id: v.Id, name: v.Name, value: v.DefaultValue })),
        upsert: (id, { name, value }) => put(`/compute/script/${id}/variables`, { Name: name, DefaultValue: value, Required: false }).then(upsertResult),
        delete: (id, variableId) => del(`/compute/script/${id}/variables/${variableId}`),
      },
      secrets: {
        list: async (id) => (await get(`/compute/script/${id}/secrets`)).Secrets.map((s) => ({ id: s.Id, name: s.Name })),
        upsert: (id, { name, value }) => put(`/compute/script/${id}/secrets`, { Name: name, Secret: value }).then(upsertResult),
        delete: (id, secretId) => del(`/compute/script/${id}/secrets/${secretId}`),
      },
    },
    purgeUrl: (url) => post(`/purge?${new URLSearchParams({ url })}`),
  };
}

const upsertResult = ({ status }) => (status === 204 ? "updated" : "created");

const toItems = (payload) => (Array.isArray(payload) ? payload : payload?.Items ?? []);

async function parseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
