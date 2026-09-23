// Mimics the Bunny runtime entry point: a Bunny global whose v1 API records what the script registers.
// The SDK registers its arrays first and pushes handlers afterwards, so lengths are read after the import.
let middlewares = {};
globalThis.Bunny = {
  v1: {
    registerMiddlewares(registered) {
      middlewares = registered;
    },
    serve() {},
    waitUntil() {},
  },
};
const started = performance.now();
try {
  await import(`file://${Deno.args[0]}`);
  const registered = { onOriginRequest: (middlewares.onOriginRequest ?? []).length, onOriginResponse: (middlewares.onOriginResponse ?? []).length };
  console.log(JSON.stringify({ importMs: Math.round((performance.now() - started) * 10) / 10, registered }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
