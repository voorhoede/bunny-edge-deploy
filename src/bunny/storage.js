import { createHash } from "node:crypto";
import { isTransientStatus, withRetry } from "./retry.js";

export class StorageError extends Error {
  constructor({ status, path, method }) {
    super(`Bunny Storage ${status} on ${method} ${path}`);
    this.name = "StorageError";
    this.status = status;
    this.path = path;
    this.transient = isTransientStatus(status);
  }
}

export function createStorageClient({ hostname, zoneName, password, fetch = globalThis.fetch, sleep }) {
  const urlFor = (path) => `https://${hostname}/${zoneName}/${path.split("/").map(encodeURIComponent).join("/")}`;

  const send = (method, path, { headers, body } = {}) =>
    withRetry(async () => {
      const response = await fetch(urlFor(path), { method, headers: { AccessKey: password, ...headers }, body });
      if (!response.ok) {
        await response.body?.cancel();
        throw new StorageError({ status: response.status, path, method });
      }
      return response;
    }, { sleep });

  async function listDirectory(directory) {
    const response = await send("GET", directory ? `${directory}/` : "", { headers: { Accept: "application/json" } });
    return response.json();
  }

  async function listFolders(directory) {
    try {
      return (await listDirectory(directory)).filter((e) => e.IsDirectory).map((e) => ({ name: e.ObjectName, created: e.DateCreated }));
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  // Only the folder asked for may not exist yet; a missing subfolder that was just listed is an error.
  async function listAll(directory = "") {
    let entries;
    try {
      entries = await listDirectory(directory);
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
    return filesIn(directory, entries);
  }

  async function filesIn(directory, entries) {
    const pathOf = (entry) => (directory ? `${directory}/${entry.ObjectName}` : entry.ObjectName);
    const files = entries.filter((e) => !e.IsDirectory).map((e) => ({ path: pathOf(e), size: e.Length, checksum: e.Checksum }));
    for (const entry of entries.filter((e) => e.IsDirectory)) files.push(...(await filesIn(pathOf(entry), await listDirectory(pathOf(entry)))));
    return files;
  }

  return {
    listAll,
    listFolders,
    upload: async (path, bytes, { contentType }) => {
      const checksum = createHash("sha256").update(bytes).digest("hex").toUpperCase();
      await send("PUT", path, { headers: { "Content-Type": contentType, Checksum: checksum }, body: bytes });
    },
    download: async (path) => {
      try {
        return Buffer.from(await (await send("GET", path)).arrayBuffer());
      } catch (error) {
        if (error.status === 404) return undefined;
        throw error;
      }
    },
    removeFolder: async (path) => {
      await send("DELETE", `${path}/`);
    },
  };
}
