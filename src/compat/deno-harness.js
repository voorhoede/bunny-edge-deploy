// Mimics the Bunny runtime entry point: a Bunny global whose v1 API records what the script registers.
let served = 0;
globalThis.Bunny = {
  v1: {
    serve() {
      served += 1;
    },
    registerMiddlewares() {},
    waitUntil() {},
  },
};
const started = performance.now();
try {
  await import(`file://${Deno.args[0]}`);
  console.log(JSON.stringify({ importMs: Math.round((performance.now() - started) * 10) / 10, registered: { serve: served } }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
