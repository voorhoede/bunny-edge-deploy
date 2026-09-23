import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { SourceTextModule } from "node:vm";

const path = process.argv[2];
const raw = readFileSync(path, "utf8");
try {
  const source = /\.[cm]?ts$/.test(path) ? stripTypeScriptTypes(raw) : raw;
  const module = new SourceTextModule(source, { identifier: "server-entry" });
  process.stdout.write(JSON.stringify({ static: module.moduleRequests.map((request) => request.specifier) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ syntaxError: error.message }));
}
