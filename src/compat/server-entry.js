import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { moduleRequests } from "./module-requests.js";

const run = promisify(execFile);

// Verified on the Bunny runtime (Deno 2.7, Node compat 24.2) by importing each module from a deployed script.
const SUPPORTED_NODE_MODULES = new Set(["assert", "async_hooks", "buffer", "console", "crypto", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "module", "net", "os", "path", "path/posix", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "stream", "stream/promises", "stream/web", "string_decoder", "timers", "timers/promises", "tls", "url", "util", "util/types", "zlib"].map((m) => `node:${m}`));
const UNSUPPORTED_NODE_MODULES = new Set(["child_process", "cluster", "constants", "dgram", "inspector", "repl", "sys", "trace_events", "tty", "v8", "vm", "wasi", "worker_threads"].map((m) => `node:${m}`));

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function analyzeServerEntry({ path, sizeLimit, coldStartWarnSize = 2 * 1024 * 1024 }) {
  const errors = [];
  const warnings = [];
  let info;
  try {
    info = await stat(path);
  } catch {
    return { errors: [`script not found: ${path}`], warnings, size: 0 };
  }
  const size = info.size;
  if (size > sizeLimit) errors.push(`script is ${megabytes(size)}, over the script size limit of ${megabytes(sizeLimit)}`);
  else if (size > coldStartWarnSize) warnings.push(`script is ${megabytes(size)}; scripts over ${megabytes(coldStartWarnSize)} measured 0.5 s or more of cold start on Bunny`);

  let requests = [];
  try {
    requests = await moduleRequests(path);
  } catch (error) {
    errors.push(`script has a syntax error: ${error.message}`);
  }
  for (const specifier of requests) {
    if (/^\.{0,2}\//.test(specifier)) errors.push(`relative import "${specifier}" is not bundled into the script`);
    else if (specifier.startsWith("node:")) {
      if (UNSUPPORTED_NODE_MODULES.has(specifier)) errors.push(`"${specifier}" does not resolve on the Bunny runtime`);
      else if (!SUPPORTED_NODE_MODULES.has(specifier)) warnings.push(`"${specifier}" has not been verified on the Bunny runtime`);
    } else if (!/^(npm:|jsr:|https?:)/.test(specifier)) errors.push(`bare import "${specifier}" cannot be resolved by the Bunny runtime; bundle it or use an npm: specifier`);
  }
  return { errors, warnings, size };
}

export async function probeServerEntry({ path, startupLimitMs, deno = "deno" }) {
  const harness = fileURLToPath(new URL("./deno-harness.js", import.meta.url));
  let stdout;
  try {
    ({ stdout } = await run(deno, ["run", "--quiet", "--allow-all", "--node-modules-dir=none", "--no-lock", harness, path], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }));
  } catch (error) {
    if (error.code === "ENOENT") return { skipped: true, notice: `startup probe skipped: deno not found at "${deno}"`, errors: [] };
    return { skipped: false, errors: [`script failed to import in the Deno harness: ${firstLine(error.stderr) || error.message}`] };
  }
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  const errors = [];
  if (result.error) errors.push(`script failed to import in the Deno harness: ${result.error}`);
  else if (!(result.registered.serve > 0)) errors.push("script registered no request handler when imported: expected a standalone script that calls serve() from @bunny.net/edgescript-sdk");
  if (result.importMs > startupLimitMs) errors.push(`script took ${Math.round(result.importMs)} ms to import in a local Deno harness, over the ${startupLimitMs} ms startup limit (an approximation of the Bunny runtime)`);
  return { skipped: false, importMs: result.importMs, registered: result.registered, errors };
}

const firstLine = (text) => (text ?? "").trim().split("\n")[0];
