import { expect, it, vi } from "vitest";
import { captureScopedCheckInputs } from "./checks.ts";

it("checks authenticated inventory membership without a linear search per selected input", async () => {
  const names = Array.from({ length: 64 }, (_, index) => `src/${String(index).padStart(3, "0")}.ts`);
  const includes = Array.prototype.includes;
  let inventorySearches = 0;
  const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (this: unknown[], value: unknown, fromIndex?: number) {
    if (this.length === names.length && this[0] === names[0] && this.at(-1) === names.at(-1)) inventorySearches++;
    return includes.call(this, value, fromIndex);
  });
  let result;
  try {
    result = await captureScopedCheckInputs({ version: "scoped-check/1", files: names, memberships: ["src/"], tests: [names[0]!], cwd: ".", profile: "fixture", environment: [] }, {
      listFiles: async () => [...names].reverse(),
      readFile: async name => Buffer.from(name),
      readMetadata: async () => ({ mode: "100644", links: [] }),
      command: ["fixture"], timeoutMs: 1000,
      runtimeDigest: "a".repeat(64), dependencyDigest: "b".repeat(64), policyDigest: "c".repeat(64), releaseDigest: "d".repeat(64),
      environment: {}, credentialIdentity: () => null,
    });
  } finally { spy.mockRestore(); }
  expect(result.files.map(file => file.path)).toEqual(names);
  expect(result.memberships).toEqual([{ prefix: "src/", paths: names }]);
  expect(inventorySearches).toBe(0);
});
