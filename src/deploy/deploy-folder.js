import { createHash } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// A content hash, so a re-run of the same build lands in the same folder and uploads nothing.
export function deployId({ files, bundle }) {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}:${file.checksum.toLowerCase()}\n`)
    .join("");
  return sha256(bundle === undefined ? lines : `${lines}server:${sha256(bundle)}\n`).slice(0, 12);
}

export const deployFolder = (id) => `deploys/${id}`;

// The adapter reads this global at startup to find its files, so every release carries its own folder.
export const preamble = ({ id, site }) => `globalThis.__BUNNY_DEPLOY__ = ${JSON.stringify({ id, assetPrefix: deployFolder(id), site, environment: "production" })};\n`;

// A build identical to an earlier one reuses that older folder, so the live deploy is kept by id, not by date.
export function foldersToPrune({ folders, current, keep }) {
  const newestFirst = [...folders].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const kept = new Set([current, ...newestFirst.slice(0, keep).map((folder) => folder.name)]);
  return newestFirst.filter((folder) => !kept.has(folder.name)).map((folder) => folder.name);
}
