import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createCheckSnapshot, snapshotCloneMethod, type CheckSnapshot } from "./check-snapshot.ts";

const spawned = vi.hoisted(() => ({ commands: [] as Array<{ command: string; args: string[] }> }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: object) => (spawned.commands.push({ command, args }), actual.spawn(command, args, options)) };
});
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const method = await snapshotCloneMethod();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-reuse-test-")); roots.push(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/source.txt"), "source"); await writeFile(path.join(root, ".gitignore"), "out/\ncache/\nnode_modules/\n");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const headSha = await git("rev-parse", "HEAD"), treeSha = await git("write-tree");
  const installs = path.join(root, ".git", "installs.log");
  const snapshot = (gitContext: "none" | "full", outputs: readonly string[]) => createCheckSnapshot({ rootDir: root, candidate: { headSha, treeSha, base: { ref: "origin/main", tipSha: headSha, mergeBaseSha: headSha } }, outputs, gitContext, environment: {},
    dependencies: { command: [process.execPath, "-e", `const fs=require('fs');fs.appendFileSync(${JSON.stringify(installs)},'1');fs.mkdirSync('node_modules/pkg',{recursive:true});fs.writeFileSync('node_modules/pkg/index.js','dependency')`], timeoutMs: 60000 } });
  return { root, headSha, treeSha, snapshot, installs: async () => (await readFile(installs, "utf8").catch(() => "")).length };
}
const write = async (snapshot: CheckSnapshot, file: string, text: string) => { await mkdir(path.dirname(path.join(snapshot.rootDir, file)), { recursive: true }); await writeFile(path.join(snapshot.rootDir, file), text); };
const drift = { code: "check_snapshot_drift" };

it.runIf(method)("names the copy-on-write method the temporary directory supports", () => {
  expect(method).toBe(process.platform === "darwin" ? "clonefile" : "reflink");
});
it.runIf(method).each(["none", "full"] as const)("two concurrent clones of one warm base see only their own writes (%s Git)", async gitContext => {
  const f = await fixture();
  const base = await f.snapshot(gitContext, ["out/"]);
  try {
    const [a, b] = await Promise.all([base.clone(method!), base.clone(method!)]);
    try {
      expect(await f.installs()).toBe(1);
      expect(new Set([base.rootDir, a.rootDir, b.rootDir]).size).toBe(3);
      for (const clone of [a, b]) {
        expect(clone.environment["HOME"]!.startsWith(gitContext === "full" ? clone.rootDir : path.dirname(clone.rootDir))).toBe(true);
        expect(clone.environment["PATH"]!.split(path.delimiter)[0]).toBe(path.join(clone.rootDir, "node_modules/.bin"));
        expect(clone.dependencyDigest).toBe(base.dependencyDigest);
        expect(await readFile(path.join(clone.rootDir, "node_modules/pkg/index.js"), "utf8")).toBe("dependency");
      }
      // Both commands write the same output path, and each reads it back only once both have written.
      const ready = (id: string) => JSON.stringify(path.join(f.root, `.git/ready-${id}`));
      const command = (id: string) => exec(process.execPath, ["-e", `const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/result',${JSON.stringify(id)});fs.writeFileSync(${ready(id)},'');` +
        `const end=Date.now()+20000;while(!(fs.existsSync(${ready("a")})&&fs.existsSync(${ready("b")}))){if(Date.now()>end)process.exit(7)}` +
        `process.stdout.write(fs.readFileSync('out/result','utf8'))`], { cwd: id === "a" ? a.rootDir : b.rootDir });
      const [seenA, seenB] = await Promise.all([command("a"), command("b")]);
      expect([seenA.stdout, seenB.stdout]).toEqual(["a", "b"]);
      await expect(readFile(path.join(base.rootDir, "out/result"))).rejects.toMatchObject({ code: "ENOENT" });
      for (const clone of [a, b]) { await clone.verify({ outputs: ["out/"] }); await clone.verify({ outputs: ["out/"], unchanged: { allowed: ["out/"] } }); }
      // A dependency write in one clone reaches neither the base nor its sibling.
      await writeFile(path.join(a.rootDir, "node_modules/pkg/index.js"), "tampered");
      await expect(a.verify({ outputs: ["out/"] })).rejects.toMatchObject(drift);
      await b.verify({ outputs: ["out/"] }); await base.verify({ outputs: ["out/"] });
      await a.cleanup();
      await expect(readFile(path.join(a.rootDir, "src/source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(b.rootDir, "src/source.txt"), "utf8")).toBe("source");
    } finally { await a.cleanup(); await b.cleanup(); }
  } finally { await base.cleanup(); }
}, 120000);

it.each(["none", "full"] as const)("verifies a reused %s-Git tree from the index: allowed outputs stay, every other change is refused", async gitContext => {
  const f = await fixture();
  // "other.json" is a sibling profile's output in the same setup; the running profile owns out/ and one cache file.
  const snapshot = await f.snapshot(gitContext, ["out/", "cache/tsbuildinfo", "build", "other.json"]);
  // "build" has no trailing slash but is a directory; as in the inventory, it covers what is inside it.
  const allowed = ["out/", "cache/tsbuildinfo", "build"];
  const reused = () => snapshot.verify({ outputs: allowed, unchanged: { allowed } });
  try {
    expect(snapshot.reusedVerification).toBe("index");
    spawned.commands = [];
    await reused();
    // No inventory worker: the index path never hashes the tree.
    expect(spawned.commands.filter(row => row.args.includes("--eval"))).toHaveLength(0);
    // Allowed: writes inside the running profile's outputs, including a file output inside an untracked directory.
    await write(snapshot, "out/nested/result.json", "{}"); await write(snapshot, "cache/tsbuildinfo", "warm"); await write(snapshot, "build/bundle.js", "bundle");
    await reused();
    expect(await readFile(path.join(snapshot.rootDir, "cache/tsbuildinfo"), "utf8")).toBe("warm");
    expect(await readFile(path.join(snapshot.rootDir, "out/nested/result.json"), "utf8")).toBe("{}");
    const refused: Array<[string, () => Promise<void>, () => Promise<void>]> = [
      ["a new untracked file no profile declares", () => write(snapshot, "stray.txt", "x"), () => unlink(path.join(snapshot.rootDir, "stray.txt"))],
      ["a new file beside an allowed output in its directory", () => write(snapshot, "cache/other", "x"), () => unlink(path.join(snapshot.rootDir, "cache/other"))],
      ["a path that only shares an allowed output's prefix", () => write(snapshot, "build-extra/x", "x"), () => rm(path.join(snapshot.rootDir, "build-extra"), { recursive: true })],
      ["a write to another profile's output", () => write(snapshot, "other.json", "{}"), () => unlink(path.join(snapshot.rootDir, "other.json"))],
      ["an unstaged edit to a tracked file", () => writeFile(path.join(snapshot.rootDir, "src/source.txt"), "edited"), () => writeFile(path.join(snapshot.rootDir, "src/source.txt"), "source")],
      ["a tracked file's mode change", () => chmod(path.join(snapshot.rootDir, "src/source.txt"), 0o755), () => chmod(path.join(snapshot.rootDir, "src/source.txt"), 0o644)],
      ["a deleted tracked file", () => unlink(path.join(snapshot.rootDir, "src/source.txt")), () => writeFile(path.join(snapshot.rootDir, "src/source.txt"), "source")],
      ["an untracked file hidden by its own new .gitignore", async () => { await write(snapshot, "hidden/.gitignore", "*\n"); await write(snapshot, "hidden/file", "x"); }, () => rm(path.join(snapshot.rootDir, "hidden"), { recursive: true })],
      ["an untracked file under an ignored but undeclared path", () => write(snapshot, "out-of-scope/node_modules/x", "x"), () => rm(path.join(snapshot.rootDir, "out-of-scope"), { recursive: true })],
      ...gitContext === "full"
        ? [["an untracked file listed in the repository's own exclude file", async () => { await appendFile(path.join(snapshot.rootDir, ".git/info/exclude"), "stray.txt\n"); await write(snapshot, "stray.txt", "x"); }, () => unlink(path.join(snapshot.rootDir, "stray.txt"))] as [string, () => Promise<void>, () => Promise<void>]]
        : [["Git metadata in a file-only tree", () => mkdir(path.join(snapshot.rootDir, ".git")), () => rm(path.join(snapshot.rootDir, ".git"), { recursive: true })] as [string, () => Promise<void>, () => Promise<void>]],
    ];
    for (const [name, change, restore] of refused) {
      await change();
      await expect(reused(), name).rejects.toMatchObject(drift);
      await restore();
      await reused();
    }
  } finally { await snapshot.cleanup(); }
}, 120000);

it("verifies a reused finite tree by its full inventory", async () => {
  const { root, headSha, treeSha } = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: root, candidate: { headSha, treeSha, base: { ref: "origin/main", tipSha: headSha, mergeBaseSha: headSha } }, outputs: ["out/"], gitContext: "none", environment: {},
    physicalSource: { version: "physical-source/1", files: ["src/source.txt"], absentInputs: [] } });
  try {
    expect(snapshot.reusedVerification).toBe("inventory");
    spawned.commands = [];
    await snapshot.verify({ outputs: ["out/"], unchanged: { allowed: ["out/"] } });
    expect(spawned.commands.filter(row => row.args.includes("--eval"))).toHaveLength(1);
    await writeFile(path.join(snapshot.rootDir, "src/source.txt"), "edited");
    await expect(snapshot.verify({ outputs: ["out/"], unchanged: { allowed: ["out/"] } })).rejects.toMatchObject(drift);
  } finally { await snapshot.cleanup(); }
}, 60000);
