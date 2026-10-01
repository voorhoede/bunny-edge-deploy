import { readFile } from "node:fs/promises";
import { join } from "node:path";

const contentLines = (text) => text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

export function parseHeaders(text = "") {
  const blocks = [];
  for (const line of contentLines(text)) {
    if (!/^\s/.test(line)) {
      blocks.push({ path: line.trim(), headers: [] });
      continue;
    }
    const separator = line.indexOf(":");
    if (separator > 0 && blocks.length > 0) blocks.at(-1).headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  return blocks;
}

export function parseRedirects(text = "") {
  return contentLines(text).map((line) => {
    const [from, to, status = "301"] = line.trim().split(/\s+/);
    return { from, to, status: Number.parseInt(status, 10) };
  });
}

export async function readSiteConfig(dir) {
  const read = (name) => readFile(join(dir, name), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { headers: parseHeaders(await read("_headers")), redirects: parseRedirects(await read("_redirects")) };
}
