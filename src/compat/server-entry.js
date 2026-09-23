import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { moduleRequests } from "./module-requests.js";

const run = promisify(execFile);

// Verified on the Bunny runtime (Deno 2.7, Node compat 24.2) by importing each module from a deployed script.
const SUPPORTED_NODE_MODULES = new Set(["assert", "async_hooks", "buffer", "console", "crypto", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "module", "net", "os", "path", "path/posix", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "stream", "stream/promises", "stream/web", "string_decoder", "timers", "timers/promises", "tls", "url", "util", "util/types", "zlib"].map((m) => `node:${m}`));
const UNSUPPORTED_NODE_MODULES = new Set(["child_process", "cluster", "constants", "dgram", "inspector", "repl", "sys", "trace_events", "tty", "v8", "vm", "wasi", "worker_threads"].map((m) => `node:${m}`));
const COMMONJS_PATTERNS = [/\brequire\s*\(/, /\bmodule\.exports\b/, /\b__dirname\b/, /\b__filename\b/];

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function analyzeServerEntry({ path, sizeLimit, coldStartWarnSize = 2 * 1024 * 1024 }) {
  const errors = [];
  const warnings = [];
  let info;
  try {
    info = await stat(path);
  } catch {
    return { errors: [`server-entry not found: ${path}`], warnings, size: 0 };
  }
  const size = info.size;
  if (size > sizeLimit) errors.push(`server-entry is ${megabytes(size)}, over the script size limit of ${megabytes(sizeLimit)}`);
  else if (size > coldStartWarnSize) warnings.push(`server-entry is ${megabytes(size)}; scripts over ${megabytes(coldStartWarnSize)} measured 0.5 s or more of cold start on Bunny`);

  const source = await readFile(path, "utf8");
  let requests = [];
  try {
    requests = await moduleRequests(path, source);
  } catch (error) {
    errors.push(`server-entry has a syntax error: ${error.message}`);
  }
  for (const specifier of requests) {
    if (/^\.{0,2}\//.test(specifier)) errors.push(`relative import "${specifier}" is not bundled into server-entry`);
    else if (specifier.startsWith("node:")) {
      if (UNSUPPORTED_NODE_MODULES.has(specifier)) errors.push(`"${specifier}" does not resolve on the Bunny runtime`);
      else if (!SUPPORTED_NODE_MODULES.has(specifier)) warnings.push(`"${specifier}" has not been verified on the Bunny runtime`);
    } else if (!/^(npm:|jsr:|https?:)/.test(specifier)) errors.push(`bare import "${specifier}" cannot be resolved by the Bunny runtime; bundle it or use an npm: specifier`);
  }
  for (const pattern of COMMONJS_PATTERNS) {
    if (pattern.test(source)) errors.push(`CommonJS construct ${pattern.source.replaceAll("\\b", "").replace("\\s*\\(", "(")} found; server-entry must be ESM`);
  }
  if (!(/servePullZone/.test(source) && /onOriginRequest/.test(source))) {
    errors.push("server-entry does not register a middleware: expected servePullZone(...).onOriginRequest(...) from @bunny.net/edgescript-sdk");
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
    return { skipped: false, errors: [`server-entry failed to import in the Deno harness: ${firstLine(error.stderr) || error.message}`] };
  }
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  const errors = [];
  if (result.error) errors.push(`server-entry failed to import in the Deno harness: ${result.error}`);
  else if (!(result.registered.onOriginRequest > 0)) errors.push("server-entry registered no onOriginRequest middleware when imported");
  if (result.importMs > startupLimitMs) errors.push(`server-entry took ${Math.round(result.importMs)} ms to import in a local Deno harness, over the ${startupLimitMs} ms startup limit (an approximation of the Bunny runtime)`);
  return { skipped: false, importMs: result.importMs, registered: result.registered, errors };
}

const firstLine = (text) => (text ?? "").trim().split("\n")[0];
