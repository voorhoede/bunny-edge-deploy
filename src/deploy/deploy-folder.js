import { createHash } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Same content hash as BunnyWay/cli#172 (lab/astro/upload.ts), so the same build always lands in the same folder.
export function deployId({ files, bundle }) {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}:${file.checksum.toLowerCase()}\n`)
    .join("");
  return sha256(`${lines}server:${sha256(bundle)}\n`).slice(0, 12);
}

export const deployFolder = (id) => `deploys/${id}`;

// The adapter reads this global at startup to find its files, so every release carries its own folder.
export const preamble = ({ id, site }) => `globalThis.__BUNNY_DEPLOY__ = ${JSON.stringify({ id, assetPrefix: deployFolder(id), site, environment: "production" })};\n`;
