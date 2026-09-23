import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export function readInputs(env, schema) {
  const inputs = {};
  for (const [name, spec] of Object.entries(schema)) {
    const raw = env[`INPUT_${name.toUpperCase()}`];
    if (raw === undefined || raw === "") {
      if (spec.required) throw new Error(`input "${name}" is required`);
      inputs[name] = spec.default;
      continue;
    }
    inputs[name] = parseInput(name, raw, spec);
  }
  return inputs;
}

function parseInput(name, raw, spec) {
  const value = raw.trim();
  if (spec.type === "boolean") {
    if (!["true", "false"].includes(value)) throw new Error(`input "${name}" must be true or false`);
    return value === "true";
  }
  if (spec.type === "integer") {
    if (!/^-?\d+$/.test(value)) throw new Error(`input "${name}" must be an integer`);
    return Number(value);
  }
  if (spec.type === "list") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (spec.choices && !spec.choices.includes(value)) throw new Error(`input "${name}" must be one of ${spec.choices.join(", ")}`);
  return spec.type === "multiline" ? raw : value;
}

export function createActionsIo({ env = process.env, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  return {
    mask: (value) => { for (const line of String(value).split("\n")) if (line) write(`::add-mask::${line}`); },
    info: (message) => write(message),
    warning: (message) => write(`::warning::${escapeData(message)}`),
    error: (message) => write(`::error::${escapeData(message)}`),
    group: async (name, fn) => {
      write(`::group::${name}`);
      try {
        return await fn();
      } finally {
        write("::endgroup::");
      }
    },
    setOutput: async (name, value) => {
      const text = String(value);
      const delimiter = `EOF_${randomUUID()}`;
      await appendFile(env.GITHUB_OUTPUT, text.includes("\n") ? `${name}<<${delimiter}\n${text}\n${delimiter}\n` : `${name}=${text}\n`);
    },
    summary: async (markdown) => appendFile(env.GITHUB_STEP_SUMMARY, markdown),
  };
}

const escapeData = (text) => String(text).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
