// Verified on the account: the script fails to boot above 2048 bytes per value or 128 variables; secrets are not counted.
const MAX_VALUE_BYTES = 2048;
const MAX_VARIABLES = 128;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvironment({ env = "", secrets = "" }) {
  const errors = [];
  const variables = parseLines(env, "env", errors);
  const secretEntries = parseLines(secrets, "secrets", errors);
  const seen = new Map();
  for (const { name } of [...variables, ...secretEntries]) seen.set(name, (seen.get(name) ?? 0) + 1);
  for (const [name, count] of seen) if (count > 1) errors.push(`"${name}" is defined more than once across env and secrets`);
  if (variables.length > MAX_VARIABLES) errors.push(`${variables.length} variables in env, but a script boots with at most ${MAX_VARIABLES}`);
  return { errors, variables, secrets: secretEntries };
}

function parseLines(text, input, errors) {
  const entries = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const separator = line.indexOf("=");
    if (separator === -1) {
      errors.push(`${input} line ${index + 1} is not KEY=value`);
      return;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!NAME.test(name)) errors.push(`${input} line ${index + 1}: "${name}" is not a valid name (letters, digits and underscores, not starting with a digit)`);
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_VALUE_BYTES) errors.push(`${input} "${name}" is ${bytes} bytes, but a script boots with values of at most ${MAX_VALUE_BYTES} bytes`);
    entries.push({ name, value });
  });
  return entries;
}

export function diffEnvironment(desired, remote) {
  const remoteVariables = new Map(remote.variables.map((v) => [v.name, v]));
  const variables = { added: [], changed: [], unchanged: [] };
  for (const { name, value } of desired.variables) {
    const current = remoteVariables.get(name);
    if (!current) variables.added.push(name);
    else if (current.value !== value) variables.changed.push(name);
    else variables.unchanged.push(name);
  }
  const remoteSecretNames = new Set(remote.secrets.map((s) => s.name));
  const secrets = {
    added: desired.secrets.map((s) => s.name).filter((name) => !remoteSecretNames.has(name)),
    updated: desired.secrets.map((s) => s.name).filter((name) => remoteSecretNames.has(name)),
  };
  const desiredNames = new Set([...desired.variables, ...desired.secrets].map((entry) => entry.name));
  const notInInput = {
    variables: remote.variables.map((v) => v.name).filter((name) => !desiredNames.has(name)),
    secrets: remote.secrets.map((s) => s.name).filter((name) => !desiredNames.has(name)),
  };
  return { variables, secrets, notInInput };
}
