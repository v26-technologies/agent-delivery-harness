import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { providerRailStdio } from "./provider-rails.ts";

// V26-3314: a rail provider inherits exactly the descriptors it declares and
// the invocation holds open; every other provider gets plain stdio.
describe("provider rail stdio", () => {
  const open = () => true;
  it("gives a provider without a declaration plain stdio", () => {
    expect(providerRailStdio()).toEqual(["pipe", "pipe", "pipe"]);
    expect(providerRailStdio([], open)).toEqual(["pipe", "pipe", "pipe"]);
  });
  it("passes exactly the declared descriptors", () => {
    expect(providerRailStdio([3, 4], open)).toEqual(["pipe", "pipe", "pipe", 3, 4]);
    expect(providerRailStdio([4], open)).toEqual(["pipe", "pipe", "pipe", "ignore", 4]);
    expect(providerRailStdio([3], open)).toEqual(["pipe", "pipe", "pipe", 3]);
  });
  it("never passes a declared descriptor the invocation does not hold open", () => {
    expect(providerRailStdio([3, 4], fd => fd === 4)).toEqual(["pipe", "pipe", "pipe", "ignore", 4]);
    expect(providerRailStdio([3, 4], () => false)).toEqual(["pipe", "pipe", "pipe", "ignore", "ignore"]);
  });
  it.skipIf(process.platform === "win32")("hands a real child the declared descriptor and nothing else", async () => {
    // The parent holds a marker file on fd 3. A shell child reads fd 3 only if
    // it was passed; sh opens no descriptor 3 of its own.
    const root = mkdtempSync(path.join(tmpdir(), "rail-descriptors-"));
    try {
      const marker = path.join(root, "marker");
      writeFileSync(marker, "marker");
      const rails = pathToFileURL(fileURLToPath(new URL("./provider-rails.ts", import.meta.url))).href;
      const parent = `import { spawnSync } from "node:child_process";
import { providerRailStdio } from ${JSON.stringify(rails)};
for (const declared of [[], [3]]) {
  const result = spawnSync("/bin/sh", ["-c", "cat <&3 2>/dev/null || printf closed"], { stdio: providerRailStdio(declared), encoding: "utf8" });
  console.log(result.stdout);
}`;
      const fd = openSync(marker, "r");
      try {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", parent], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.stdout.trim().split("\n")).toEqual(["closed", "marker"]);
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
