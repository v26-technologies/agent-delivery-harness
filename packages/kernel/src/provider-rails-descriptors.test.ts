import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { channelIdentity, INHERITED_DESCRIPTORS_ENV, providerRailLaunch } from "./provider-rails.ts";

// V26-3314: a rail provider inherits a descriptor only when it declares it and
// the launcher vouched for that very pipe or socket; its environment then says
// exactly what it received.
describe("provider rail launch", () => {
  const identify = (fd: number) => ({ 3: "1:30", 4: "1:40" } as Record<number, string>)[fd];
  const vouched = { [INHERITED_DESCRIPTORS_ENV]: "3:1:30,4:1:40" };
  const slots = (declared: (3 | 4)[], env: NodeJS.ProcessEnv, id = identify) => providerRailLaunch(declared, env, id).stdio.slice(3);
  it("gives a provider without a declaration plain stdio and no inherited statement", () => {
    expect(providerRailLaunch(undefined, vouched, identify)).toEqual({ stdio: ["pipe", "pipe", "pipe"], env: {} });
    expect(providerRailLaunch([], { PATH: "/bin" }, identify)).toEqual({ stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/bin" } });
  });
  it("passes exactly the declared descriptors whose identity was vouched for", () => {
    expect(providerRailLaunch([3, 4], { ...vouched, PATH: "/bin" }, identify)).toEqual({
      stdio: ["pipe", "pipe", "pipe", 3, 4], env: { PATH: "/bin", [INHERITED_DESCRIPTORS_ENV]: "3:1:30,4:1:40" } });
    expect(slots([4], vouched)).toEqual(["ignore", 4]);
    expect(slots([3], vouched)).toEqual([3]);
    expect(providerRailLaunch([4], vouched, identify).env[INHERITED_DESCRIPTORS_ENV]).toBe("4:1:40");
  });
  it("never passes a descriptor whose identity differs from the one vouched for", () => {
    expect(slots([3, 4], { [INHERITED_DESCRIPTORS_ENV]: "3:1:31,4:1:40" })).toEqual(["ignore", 4]);
    expect(slots([3, 4], vouched, () => undefined)).toEqual(["ignore", "ignore"]);
    expect(providerRailLaunch([3, 4], vouched, () => "9:9").env).toEqual({});
  });
  it("reads the vouch strictly: an exact fd field, the whole entry, the device as well as the inode, and the first entry per fd", () => {
    for (const entry of ["13:1:30", "3:1:30:9", "03:1:30", "x3:1:30", "3:2:30", "3:1:3"])
      expect(slots([3], { [INHERITED_DESCRIPTORS_ENV]: entry }), entry).toEqual(["ignore"]);
    expect(slots([3], { [INHERITED_DESCRIPTORS_ENV]: "3:1:30,3:1:31" })).toEqual([3]);
    expect(slots([3], { [INHERITED_DESCRIPTORS_ENV]: "3:1:31,3:1:30" })).toEqual(["ignore"]);
  });
  it("gives only a pipe or socket an identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rail-identity-"));
    const file = path.join(root, "plain");
    writeFileSync(file, "x");
    const fd = openSync(file, "r");
    try {
      expect(channelIdentity(fd)).toBeUndefined();
      expect(channelIdentity(987654)).toBeUndefined();
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("never passes a descriptor nobody vouched for", () => {
    for (const env of [{}, { [INHERITED_DESCRIPTORS_ENV]: "" }, { [INHERITED_DESCRIPTORS_ENV]: "3,4" }, { [INHERITED_DESCRIPTORS_ENV]: "5:1:50" }, { [INHERITED_DESCRIPTORS_ENV]: "3:x:y" }])
      expect(slots([3, 4], env)).toEqual(["ignore", "ignore"]);
  });
  it.skipIf(process.platform === "win32")("opens a real provider with the vouched pipe only when it declares it, and states only what it passed", async () => {
    // Through openProviderRailProcess itself: the parent holds a pipe on fd 3
    // carrying a marker, and each provider reports what fd 3 held and what its
    // environment says it inherited.
    const rails = pathToFileURL(fileURLToPath(new URL("./provider-rails.ts", import.meta.url))).href;
    const provider = "const fs=require('fs');let held=null;try{held=fs.readFileSync(3,'utf8')}catch{}" +
      `process.stdout.write(JSON.stringify({held,stated:process.env.${INHERITED_DESCRIPTORS_ENV}??null})+'\\n');process.stdin.resume();`;
    const parent = `import { openProviderRailProcess, channelIdentity, INHERITED_DESCRIPTORS_ENV } from ${JSON.stringify(rails)};
const own = { ...process.env, [INHERITED_DESCRIPTORS_ENV]: "3:" + channelIdentity(3) };
const stale = { ...process.env, [INHERITED_DESCRIPTORS_ENV]: "3:0:1" };
for (const [declared, env] of [[undefined, own], [[3], stale], [[3], own]]) {
  const session = await openProviderRailProcess({ command: [process.execPath, "-e", ${JSON.stringify(provider)}], cwd: process.cwd(), env,
    ...(declared ? { inheritDescriptors: declared } : {}) });
  console.log(JSON.stringify(await session.receive()));
  await session.close();
}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", parent], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { err += chunk; });
    (child.stdio[3] as NodeJS.WritableStream).end("marker");
    await new Promise((resolve) => child.once("close", resolve));
    expect(err).toBe("");
    const [undeclared, stale, declared] = out.trim().split("\n").map((line) => JSON.parse(line) as { held: string | null; stated: string | null });
    expect(undeclared).toEqual({ held: null, stated: null });
    expect(stale).toEqual({ held: null, stated: null });
    expect(declared!.held).toBe("marker");
    expect(declared!.stated).toMatch(/^3:\d+:\d+$/);
  });
  it.skipIf(process.platform === "win32")("hands a real child the vouched pipe only when declared and only for its own identity", async () => {
    // The parent holds a pipe on fd 3 carrying a marker. A shell child reads fd
    // 3 only if it was passed; sh opens no descriptor 3 of its own.
    const rails = pathToFileURL(fileURLToPath(new URL("./provider-rails.ts", import.meta.url))).href;
    const parent = `import { spawnSync } from "node:child_process";
import { providerRailLaunch, channelIdentity, INHERITED_DESCRIPTORS_ENV } from ${JSON.stringify(rails)};
const read = "cat <&3 2>/dev/null || printf closed";
const own = { [INHERITED_DESCRIPTORS_ENV]: "3:" + channelIdentity(3) };
const stale = { [INHERITED_DESCRIPTORS_ENV]: "3:0:1" };
for (const [declared, env] of [[[], own], [[3], stale], [[3], own]]) {
  const launch = providerRailLaunch(declared, env);
  const result = spawnSync("/bin/sh", ["-c", read], { stdio: launch.stdio, env: launch.env, encoding: "utf8" });
  console.log(JSON.stringify(result.stdout));
}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", parent], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { err += chunk; });
    (child.stdio[3] as NodeJS.WritableStream).end("marker");
    await new Promise((resolve) => child.once("close", resolve));
    expect(err).toBe("");
    const [plain, stale, passed] = out.trim().split("\n").map((line) => JSON.parse(line) as string);
    expect(plain).not.toBe("marker");
    expect(stale).not.toBe("marker");
    expect(passed).toBe("marker");
  });
});
