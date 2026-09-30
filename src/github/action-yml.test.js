import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// There is no YAML parser here, so this catches the plain values that GitHub fails to load the action over.
describe("action.yml", () => {
  it("quotes every value that YAML would read as a mapping or a comment when left plain", async () => {
    const text = await readFile(new URL("../../action.yml", import.meta.url), "utf8");
    const misread = text.split("\n").flatMap((line, index) => {
      const value = line.match(/^\s*[\w-]+: (.+)$/)?.[1];
      if (value === undefined || /^["'|>]/.test(value)) return [];
      return value.includes(": ") || value.includes(" #") ? [`line ${index + 1}: ${line.trim().slice(0, 60)}`] : [];
    });
    assert.deepEqual(misread, []);
  });
});
