// The `_headers` and `_redirects` formats that static hosts read and Bunny's Astro adapter writes.

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
