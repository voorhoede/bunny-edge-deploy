import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Documented Bunny Storage limits: 6000-character paths, no leading or trailing spaces in names.
export async function analyzeClientDir({ path, maxPathLength = 6000 }) {
  const errors = [];
  const warnings = [];
  let entries;
  try {
    entries = await readdir(path, { recursive: true, withFileTypes: true });
  } catch {
    return { errors: [`client-dir not found: ${path}`], warnings, files: [] };
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = join(entry.parentPath, entry.name).slice(path.length + 1).split("\\").join("/");
    files.push({ path: relative, size: (await stat(join(entry.parentPath, entry.name))).size });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  if (files.length === 0) errors.push(`client-dir is empty: ${path}`);
  for (const file of files) {
    if (file.path.length > maxPathLength) warnings.push(`"${file.path}" exceeds ${maxPathLength} characters, the Bunny Storage path limit`);
    if (file.path.split("/").some((segment) => segment !== segment.trim())) warnings.push(`"${file.path}" has a name with a leading or trailing space, which Bunny Storage rejects`);
  }
  return { errors, warnings, files };
}
