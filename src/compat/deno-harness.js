// Mimics the Bunny runtime entry point and counts what the script registers when imported.
let served = 0;
const middlewares = [];
globalThis.Bunny = {
  v1: {
    serve() {
      served += 1;
    },
    registerMiddlewares(hooks) {
      middlewares.push(hooks ?? {});
    },
    waitUntil() {},
  },
};
// The SDK's servePullZone registers its hook arrays first and pushes into them afterwards, so they are counted after the import.
const hooks = (name) => middlewares.reduce((count, registered) => count + (registered[name]?.length ?? 0), 0);
const started = performance.now();
try {
  await import(`file://${Deno.args[0]}`);
  const importMs = Math.round((performance.now() - started) * 10) / 10;
  console.log(JSON.stringify({ importMs, registered: { serve: served, onOriginRequest: hooks("onOriginRequest"), onOriginResponse: hooks("onOriginResponse") } }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
