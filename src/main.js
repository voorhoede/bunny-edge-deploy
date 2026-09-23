import { createActionsIo, readInputs } from "./github/actions.js";
import { INPUT_SCHEMA, run } from "./run.js";

const actions = createActionsIo();
try {
  await run({ inputs: readInputs(process.env, INPUT_SCHEMA), actions });
} catch (error) {
  actions.error(error.message);
  process.exitCode = 1;
}
