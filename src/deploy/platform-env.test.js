import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLATFORM_NAMES, platformEnvironment } from "./platform-env.js";

const storageZone = { Name: "site", StorageHostname: "uk.storage.bunnycdn.com", Password: "read-write", ReadOnlyPassword: "read-only" };
const pullZone = { Id: 33 };
const requiresAll = {
  storage: { write: true },
  env: ["BUNNY_STORAGE_ZONE", "BUNNY_STORAGE_HOST", "BUNNY_STORAGE_KEY", "BUNNY_SESSION_ZONE", "BUNNY_SESSION_KEY", "BUNNY_PULLZONE_ID"].map((name) => ({ name })),
};

describe("platformEnvironment", () => {
  it("fills what the manifest names from the zones: the read-only password as a secret, the rest as variables", () => {
    const result = platformEnvironment({ requires: { storage: { write: false }, env: requiresAll.env.slice(0, 3) }, storageZone, pullZone });
    assert.deepEqual(result.variables, [{ name: "BUNNY_STORAGE_ZONE", value: "site" }, { name: "BUNNY_STORAGE_HOST", value: "uk.storage.bunnycdn.com" }]);
    assert.deepEqual(result.secrets, [{ name: "BUNNY_STORAGE_KEY", value: "read-only" }]);
    assert.deepEqual(result.missing, []);
  });

  it("sets nothing the manifest does not name", () => {
    const result = platformEnvironment({ requires: { storage: { write: false }, env: [{ name: "BUNNY_PULLZONE_ID" }] }, storageZone, pullZone });
    assert.deepEqual(result.variables, [{ name: "BUNNY_PULLZONE_ID", value: "33" }]);
    assert.deepEqual(result.secrets, []);
  });

  it("hands out the password that can write only when the manifest asks for storage writes", () => {
    const writing = platformEnvironment({ requires: requiresAll, storageZone, pullZone });
    assert.deepEqual(writing.secrets, [{ name: "BUNNY_STORAGE_KEY", value: "read-only" }, { name: "BUNNY_SESSION_KEY", value: "read-write" }]);
    assert.ok(writing.variables.some((v) => v.name === "BUNNY_SESSION_ZONE" && v.value === "site"));
    const reading = platformEnvironment({ requires: { ...requiresAll, storage: { write: false } }, storageZone, pullZone });
    assert.ok(!reading.secrets.some((s) => s.name === "BUNNY_SESSION_KEY"));
    assert.ok(!reading.variables.some((v) => v.name === "BUNNY_SESSION_ZONE"));
  });

  it("reports a required entry it cannot fill, and passes over an optional one", () => {
    const result = platformEnvironment({ requires: { storage: { write: false }, env: [{ name: "BUNNY_API_KEY" }, { name: "CUSTOM", optional: true }] }, storageZone, pullZone });
    assert.deepEqual(result.missing, ["BUNNY_API_KEY"]);
    assert.deepEqual([...result.variables, ...result.secrets], []);
  });

  it("lists every name it can set, so workflow inputs cannot collide with them", () => {
    assert.deepEqual([...PLATFORM_NAMES].sort(), ["BUNNY_PULLZONE_ID", "BUNNY_SESSION_KEY", "BUNNY_SESSION_ZONE", "BUNNY_STORAGE_HOST", "BUNNY_STORAGE_KEY", "BUNNY_STORAGE_ZONE"]);
  });
});
