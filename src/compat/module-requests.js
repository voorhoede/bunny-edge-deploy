import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const child = fileURLToPath(new URL("./module-requests-child.js", import.meta.url));

/** Static import specifiers as V8 parses them. Throws on a syntax error. */
export async function moduleRequests(path) {
  const { stdout } = await run(process.execPath, ["--experimental-vm-modules", "--no-warnings", child, path], { maxBuffer: 64 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (result.syntaxError) throw new SyntaxError(result.syntaxError);
  return result.static;
}
