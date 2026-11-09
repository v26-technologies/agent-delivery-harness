import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { INHERITED_DESCRIPTORS_ENV, providerRailStdio } from "./provider-rails.ts";

// V26-3314: a rail provider inherits a descriptor only when it declares it, the
// launcher vouches for it in the environment, and it is a pipe or socket.
describe("provider rail stdio", () => {
  const channel = () => true;
  const vouched = { [INHERITED_DESCRIPTORS_ENV]: "3,4" };
  it("gives a provider without a declaration plain stdio", () => {
    expect(providerRailStdio()).toEqual(["pipe", "pipe", "pipe"]);
    expect(providerRailStdio([], vouched, channel)).toEqual(["pipe", "pipe", "pipe"]);
  });
  it("passes exactly the declared and vouched descriptors", () => {
    expect(providerRailStdio([3, 4], vouched, channel)).toEqual(["pipe", "pipe", "pipe", 3, 4]);
    expect(providerRailStdio([4], vouched, channel)).toEqual(["pipe", "pipe", "pipe", "ignore", 4]);
    expect(providerRailStdio([3], vouched, channel)).toEqual(["pipe", "pipe", "pipe", 3]);
    expect(providerRailStdio([3, 4], { [INHERITED_DESCRIPTORS_ENV]: " 4 " }, channel)).toEqual(["pipe", "pipe", "pipe", "ignore", 4]);
  });
  it("never passes a descriptor the launcher did not vouch for, however open", () => {
    for (const env of [{}, { [INHERITED_DESCRIPTORS_ENV]: "" }, { [INHERITED_DESCRIPTORS_ENV]: "5,6" }, { [INHERITED_DESCRIPTORS_ENV]: "34" }])
      expect(providerRailStdio([3, 4], env, channel)).toEqual(["pipe", "pipe", "pipe", "ignore", "ignore"]);
  });
  it("never passes a vouched descriptor that is not a pipe or socket", () => {
    expect(providerRailStdio([3, 4], vouched, (fd) => fd === 4)).toEqual(["pipe", "pipe", "pipe", "ignore", 4]);
    expect(providerRailStdio([3, 4], vouched, () => false)).toEqual(["pipe", "pipe", "pipe", "ignore", "ignore"]);
  });
  it.skipIf(process.platform === "win32")("hands a real child the vouched pipe only when declared", async () => {
    // The parent holds a pipe on fd 3 carrying a marker. A shell child reads fd
    // 3 only if it was passed; sh opens no descriptor 3 of its own.
    const rails = pathToFileURL(fileURLToPath(new URL("./provider-rails.ts", import.meta.url))).href;
    const parent = `import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { providerRailStdio, INHERITED_DESCRIPTORS_ENV } from ${JSON.stringify(rails)};
const read = "cat <&3 2>/dev/null || printf closed";
const vouched = { [INHERITED_DESCRIPTORS_ENV]: "3" };
for (const [declared, env] of [[[], vouched], [[3], {}], [[3], vouched]]) {
  const result = spawnSync("/bin/sh", ["-c", read], { stdio: providerRailStdio(declared, env), encoding: "utf8" });
  console.log(JSON.stringify(result.stdout));
}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", parent], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { err += chunk; });
    (child.stdio[3] as NodeJS.WritableStream).end("marker");
    await new Promise((resolve) => child.once("close", resolve));
    expect(err).toBe("");
    const [plain, unvouched, passed] = out.trim().split("\n").map((line) => JSON.parse(line) as string);
    expect(plain).not.toBe("marker");
    expect(unvouched).not.toBe("marker");
    expect(passed).toBe("marker");
  });
});
