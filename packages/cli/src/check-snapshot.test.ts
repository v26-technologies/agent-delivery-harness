import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createCheckSnapshot } from "./check-snapshot.ts";

const removal = vi.hoisted(() => ({ fail: "" }));
const inventoryProbe = vi.hoisted(() => ({ preload: "", commands: [] as Array<{ command: string; args: string[] }> }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: object) =>
    (inventoryProbe.commands.push({ command, args }), actual.spawn(command, inventoryProbe.preload && command === process.execPath && args.includes("--eval") ? ["--import", inventoryProbe.preload, ...args] : args, options)) };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (args[0] === removal.fail) throw Object.assign(new Error("fixture removal refused"), { code: "EACCES" });
    return actual.rm(...args);
  } };
});
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { inventoryProbe.preload = ""; await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-snapshot-test-")); roots.push(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source.txt"), "base");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const headSha = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "source.txt"), "prepared");
  await writeFile(path.join(root, "new.txt"), "staged new source"); await git("add", ".");
  const treeSha = await git("write-tree");
  return { root, git, candidate: { headSha, treeSha, base: { ref: "origin/main", tipSha: headSha, mergeBaseSha: headSha } } };
}
async function shallowFixture() {
  const upstream = await fixture();
  await upstream.git("-c", "commit.gpgsign=false", "commit", "-qm", "boundary");
  await writeFile(path.join(upstream.root, "source.txt"), "head");
  await upstream.git("add", "."); await upstream.git("-c", "commit.gpgsign=false", "commit", "-qm", "head");
  const root = await mkdtemp(path.join(tmpdir(), "scoped-shallow-test-")); roots.push(root);
  await exec("git", ["clone", "--no-local", "--depth", "2", upstream.root, root]);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  const headSha = await git("rev-parse", "HEAD"), baseSha = await git("rev-parse", "HEAD~1");
  await writeFile(path.join(root, "source.txt"), "prepared shallow");
  await writeFile(path.join(root, "staged.txt"), "new shallow source"); await git("add", ".");
  return { root, git, missingAncestor: upstream.candidate.headSha,
    candidate: { headSha, treeSha: await git("write-tree"), base: { ref: "origin/main", tipSha: baseSha, mergeBaseSha: baseSha } } };
}
it.each([ ["none", "same"], ["full", "same"], ["none", "distinct"], ["full", "distinct"] ] as const)("preserves a shallow boundary and staged candidate with %s Git and %s base", async (gitContext, baseKind) => {
  const f = await shallowFixture();
  if (baseKind === "same") f.candidate.base = { ...f.candidate.base, tipSha: f.candidate.headSha, mergeBaseSha: f.candidate.headSha };
  const shallow = await readFile(path.join(f.root, ".git/shallow")), index = await readFile(path.join(f.root, ".git/index"));
  expect(await f.git("rev-parse", "--is-shallow-repository")).toBe("true");
  await expect(f.git("cat-file", "-e", f.missingAncestor)).rejects.toMatchObject({ code: 1 });
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, gitContext, outputs: [], environment: {} });
  try {
    expect(await readFile(path.join(snapshot.rootDir, "source.txt"), "utf8")).toBe("prepared shallow");
    expect(await readFile(path.join(snapshot.rootDir, "staged.txt"), "utf8")).toBe("new shallow source");
    const control = gitContext === "none" ? path.join(path.dirname(snapshot.commandRoot), "repository") : path.join(snapshot.rootDir, ".git");
    const git = async (...args: string[]) => (await exec("git", [`--git-dir=${control}`, `--work-tree=${snapshot.rootDir}`, ...args])).stdout.trim();
    expect(await git("rev-parse", "--is-shallow-repository")).toBe("true");
    expect(new Set((await readFile(path.join(control, "shallow"), "utf8")).trim().split("\n"))).toEqual(new Set(shallow.toString().trim().split("\n")));
    await expect(git("cat-file", "-e", f.missingAncestor)).rejects.toMatchObject({ code: 1 });
    expect(await git("write-tree")).toBe(f.candidate.treeSha);
    expect(await git("rev-parse", "HEAD^{tree}")).toBe(f.candidate.treeSha);
    expect(await git("rev-parse", "HEAD^", "refs/delivery/origin-head")).toBe(`${f.candidate.headSha}\n${f.candidate.headSha}`);
    expect(await git("rev-parse", "refs/delivery/base", "refs/delivery/merge-base")).toBe(`${f.candidate.base.tipSha}\n${f.candidate.base.mergeBaseSha}`);
    await expect(readFile(path.join(control, "objects/info/alternates"))).rejects.toMatchObject({ code: "ENOENT" });
    if (gitContext === "none") {
      await expect(readFile(path.join(snapshot.rootDir, ".git/HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(snapshot.environment["DELIVERY_CHECK_ORIGIN_HEAD"]).toBeUndefined();
    } else expect(snapshot.environment["DELIVERY_CHECK_ORIGIN_HEAD"]).toBe(f.candidate.headSha);
    await expect(snapshot.verify()).resolves.toBeUndefined();
  } finally { await snapshot.cleanup(); }
  expect(await readFile(path.join(f.root, ".git/shallow"))).toEqual(shallow);
  expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
  expect(await f.git("write-tree")).toBe(f.candidate.treeSha);
}, 30000);
it.each(["tree", "head", "base", "merge-base"])("refuses a missing required %s object in a shallow source", async member => {
  const f = await shallowFixture(), missing = "f".repeat(40);
  const candidate = { ...f.candidate, base: { ...f.candidate.base } };
  if (member === "tree") candidate.treeSha = missing;
  else if (member === "head") candidate.headSha = missing;
  else if (member === "base") candidate.base.tipSha = missing;
  else candidate.base.mergeBaseSha = missing;
  await expect(createCheckSnapshot({ rootDir: f.root, candidate, outputs: [], environment: {} })).rejects.toMatchObject({ code: "check_snapshot_unavailable" });
}, 30000);
it("materializes the exact staged tree with private Git and pinned diff context, surviving authoring edit-restore", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["out/"], environment: {} });
  try {
    await writeFile(path.join(f.root, "source.txt"), "concurrent edit");
    expect(await readFile(path.join(snapshot.rootDir, "source.txt"), "utf8")).toBe("prepared");
    expect(await readFile(path.join(snapshot.rootDir, "new.txt"), "utf8")).toBe("staged new source");
    const diff = await exec("git", ["diff", "--name-only", snapshot.environment["DELIVERY_CHECK_BASE_REF"]!, snapshot.environment["DELIVERY_CHECK_CANDIDATE_REF"]!], { cwd: snapshot.rootDir });
    expect(diff.stdout.trim().split("\n")).toEqual(["new.txt", "source.txt"]);
    const headDiff = await exec("git", ["diff", "--name-only", snapshot.environment["DELIVERY_CHECK_BASE_REF"]!, "HEAD"], { cwd: snapshot.rootDir });
    expect(headDiff.stdout).toBe(diff.stdout);
    await writeFile(path.join(f.root, "source.txt"), "prepared");
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await mkdir(path.join(snapshot.rootDir, "out")); await writeFile(path.join(snapshot.rootDir, "out/result"), "ok");
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await writeFile(path.join(snapshot.rootDir, "source.txt"), "drift");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
it("rejects source links escaping the private snapshot", async () => {
  const f = await fixture(); await symlink(f.root, path.join(f.root, "escape")); await f.git("add", "escape");
  f.candidate.treeSha = await f.git("write-tree");
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} })).rejects.toMatchObject({ code: "check_snapshot_escape" });
});
it("verifies safety and immutable bytes in one traversal without reading mutable file bytes", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["out/"], environment: {},
    dependencies: { command: [process.execPath, "-e", "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/dep','d'.repeat(128))"], timeoutMs: 5000 } });
  try {
    await mkdir(path.join(snapshot.rootDir, "out/nested"), { recursive: true });
    await writeFile(path.join(snapshot.rootDir, "out/nested/result"), "x".repeat(1024));
    await symlink("../../source.txt", path.join(snapshot.rootDir, "out/nested/link"));
    const log = path.join(f.root, "inventory.jsonl"), preload = path.join(f.root, "inventory-probe.mjs");
    // Instrument the actual worker's filesystem boundary, with no production diagnostics API.
    await writeFile(preload, `import fs from 'node:fs/promises';import {appendFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const counts={bytes:0,files:[],stats:[],directories:[]};
for(const [name,field] of [['readFile','files'],['lstat','stats'],['readdir','directories']]){const original=fs[name];fs[name]=async(...args)=>{const result=await original(...args);counts[field].push(args[0]);if(name==='readFile')counts.bytes+=result.length;return result;};}
syncBuiltinESMExports();process.on('exit',()=>appendFileSync(${JSON.stringify(log)},JSON.stringify(counts)+'\\n'));`);
    inventoryProbe.preload = preload;
    await snapshot.verify();
    const scans = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { bytes: number; files: string[]; stats: string[]; directories: string[] });
    const bytes = scans.reduce((sum, scan) => sum + scan.bytes, 0);
    const immutableBytes = Buffer.byteLength("preparedstaged new source") + 128;
    expect({ scans: scans.length, bytes }).toEqual({ scans: 1, bytes: immutableBytes });
    expect(scans[0]!.files.map(file => path.relative(snapshot.rootDir, file)).sort()).toEqual(["new.txt", "node_modules/dep", "source.txt"]);
    expect(scans[0]!.directories.filter(dir => dir === snapshot.rootDir)).toHaveLength(1);
    expect(scans[0]!.stats).toContain(path.join(snapshot.rootDir, "out/nested/link"));
  } finally { inventoryProbe.preload = ""; await snapshot.cleanup(); }
});
it.each([
  ["directory output itself", "out", "absolute"],
  ["nested output", "out/nested/escape", "absolute"],
  ["nested relative escape", "out/nested/escape", "relative"],
  ["resolved escape via excluded Git metadata", "out/link", "resolved"],
  ["exact output", "result", "absolute"],
  ["nested Git-named output", "out/.git/escape", "absolute"],
])("still checks unsafe links in %s", async (_name, relative, targetKind) => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["out/", "result"], environment: {} });
  try {
    const link = path.join(snapshot.rootDir, relative!);
    await mkdir(path.dirname(link), { recursive: true });
    const gitLink = path.join(snapshot.rootDir, ".git/outside");
    if (targetKind === "resolved") await symlink(f.root, gitLink);
    const target = targetKind === "resolved" ? path.relative(path.dirname(link), gitLink)
      : targetKind === "relative" ? path.relative(path.dirname(link), f.root) : f.root;
    await symlink(target, link);
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_escape" });
  } finally { await snapshot.cleanup(); }
});
it("checks narrowed output ownership and accepts safe dangling output links", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["own/", "sibling/"], environment: {} });
  try {
    await mkdir(path.join(snapshot.rootDir, "own"));
    await symlink("missing", path.join(snapshot.rootDir, "own/link"));
    await expect(snapshot.verify({ outputs: ["own/"] })).resolves.toBeUndefined();
    await mkdir(path.join(snapshot.rootDir, "sibling"));
    await writeFile(path.join(snapshot.rootDir, "sibling/result"), "not this profile's output");
    await expect(snapshot.verify({ outputs: ["own/"] })).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
it("excludes exact directory outputs recursively while checking descendant safety", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["result"], environment: {} });
  try {
    await mkdir(path.join(snapshot.rootDir, "result/nested"), { recursive: true });
    await writeFile(path.join(snapshot.rootDir, "result/nested/file"), "mutable bytes");
    await symlink("../../source.txt", path.join(snapshot.rootDir, "result/nested/link"));
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await writeFile(path.join(snapshot.rootDir, "result/nested/file"), "changed mutable bytes");
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await symlink(f.root, path.join(snapshot.rootDir, "result/nested/escape"));
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_escape" });
    await rm(path.join(snapshot.rootDir, "result/nested/escape"));
    await exec("mkfifo", [path.join(snapshot.rootDir, "result/nested/pipe")]);
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_escape" });
  } finally { await snapshot.cleanup(); }
});
it("installs private dependencies, excludes inherited flags, and detects dependency mutation", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: { DECLARED_FLAG: "bound" },
    dependencies: { command: [process.execPath, "-e", "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/dep','private')"], timeoutMs: 5000 } });
  try {
    expect(snapshot.environment["DECLARED_FLAG"]).toBe("bound");
    expect(snapshot.environment["NODE_OPTIONS"]).toBeUndefined();
    await writeFile(path.join(snapshot.rootDir, "node_modules/dep"), "drift");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
it("refuses failed dependency setup and source mutation by install", async () => {
  const f = await fixture();
  for (const script of ["process.exit(3)", "require('fs').writeFileSync('source.txt','bad')"]) {
    await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {}, dependencies: { command: [process.execPath, "-e", script], timeoutMs: 5000 } })).rejects.toMatchObject({ code: script.includes("exit") ? "check_dependency_failed" : "check_snapshot_drift" });
  }
});

it("reports cleanup failure without hiding ownership of the retained snapshot", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  removal.fail = snapshot.rootDir;
  try { await expect(snapshot.cleanup()).rejects.toMatchObject({ code: "check_snapshot_cleanup_failed" }); }
  finally { removal.fail = ""; await snapshot.cleanup(); }
});
it.each(["index", "HEAD", "candidate", "base"])("rejects independent %s drift with unchanged source bytes", async member => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: snapshot.rootDir })).stdout.trim();
    const head = await git("rev-parse", "HEAD");
    if (member === "index") await git("read-tree", f.candidate.headSha);
    else await git("update-ref", member === "candidate" ? "refs/delivery/candidate" : member === "base" ? "refs/delivery/base" : "HEAD", member === "base" ? head : f.candidate.headSha);
    expect(await readFile(path.join(snapshot.rootDir, "source.txt"), "utf8")).toBe("prepared");
    expect(await readFile(path.join(snapshot.rootDir, "new.txt"), "utf8")).toBe("staged new source");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
it("accepts internal source and private dependency-bin symlinks under the default temporary root", async () => {
  const f = await fixture(); await symlink("source.txt", path.join(f.root, "alias")); await f.git("add", "alias"); f.candidate.treeSha = await f.git("write-tree");
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {}, dependencies: { command: [process.execPath, "-e", "const fs=require('fs');fs.mkdirSync('node_modules/.bin',{recursive:true});fs.writeFileSync('node_modules/tool','tool');fs.symlinkSync('../tool','node_modules/.bin/tool')"], timeoutMs: 5000 } });
  try {
    expect(await readFile(path.join(snapshot.rootDir, "alias"), "utf8")).toBe("prepared");
    expect(await readFile(path.join(snapshot.rootDir, "node_modules/.bin/tool"), "utf8")).toBe("tool");
    await expect(snapshot.verify()).resolves.toBeUndefined();
  } finally { await snapshot.cleanup(); }
});
it("file-only snapshot excludes Git for setup and checks even under a parent repository", async () => {
 const f=await fixture(); const prior=process.env["TMPDIR"]; process.env["TMPDIR"]=f.root;
 let snapshot: Awaited<ReturnType<typeof createCheckSnapshot>> | undefined;
 try {
  snapshot=await createCheckSnapshot({rootDir:f.root,candidate:f.candidate,gitContext:"none",outputs:[],environment:{},dependencies:{command:[process.execPath,"-e","if(require('fs').existsSync('.git')||Object.keys(process.env).some(k=>k.startsWith('DELIVERY_CHECK_'))||require('child_process').spawnSync('git',['rev-parse','HEAD']).status===0)process.exit(7)"],timeoutMs:5000}});
  await expect(exec("git",["rev-parse","HEAD"],{cwd:snapshot.rootDir,env:snapshot.environment})).rejects.toMatchObject({code:128});
  await expect(snapshot.verify()).resolves.toBeUndefined();
  await mkdir(path.join(snapshot.rootDir,".git"));await expect(snapshot.verify()).rejects.toMatchObject({code:"check_snapshot_drift"});
  const control=path.dirname(snapshot.commandRoot);await snapshot.cleanup();snapshot=undefined;await expect(readFile(path.join(control,"repository/HEAD"))).rejects.toMatchObject({code:"ENOENT"});
 } finally {if(snapshot)await snapshot.cleanup();if(prior===undefined)delete process.env["TMPDIR"];else process.env["TMPDIR"]=prior;}
});

it("observes dependency status before failure cleanup removes the private workspace", async () => {
  const f = await fixture();
  const results: Array<{ code: number; stdout: string; durationMs: number }> = [];
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {},
    dependencies: { command: [process.execPath, "-e", "console.log(process.cwd());process.exit(7)"], timeoutMs: 5000 },
    onDependencyResult: (result, durationMs) => results.push({ code: result.code, stdout: result.stdout, durationMs }),
  })).rejects.toMatchObject({ code: "check_dependency_failed" });
  expect(results).toHaveLength(1);
  expect(results[0]!.code).toBe(7);
  expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
  const privateRoot = results[0]!.stdout.trim();
  expect(privateRoot).not.toBe(f.root);
  expect(path.basename(privateRoot)).toMatch(/^delivery-check-/);
  await expect(readFile(path.join(privateRoot, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([
  { name: "missing executable", command: ["/missing-dependency-command"] as [string, ...string[]], timeoutMs: 5000, errorCode: "ENOENT" },
  { name: "signal", command: [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"] as [string, ...string[]], timeoutMs: 5000, errorCode: "SIGTERM" },
  { name: "timeout", command: [process.execPath, "-e", "setInterval(()=>{},1000)"] as [string, ...string[]], timeoutMs: 100, errorCode: "SIGKILL" },
])("retains the actual dependency execution error for $name", async ({ command, timeoutMs, errorCode }) => {
  const f = await fixture(), observed: string[] = [];
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {}, dependencies: { command, timeoutMs },
    onDependencyResult: result => observed.push(result.errorCode ?? "missing"),
  })).rejects.toMatchObject({ code: "check_dependency_failed" });
  expect(observed).toEqual([errorCode]);
});

it.each([false, true])("consolidates setup scans and verification Git calls (dependencies=%s)", async dependencies => {
  const f = await fixture(); inventoryProbe.commands = [];
  const log = path.join(f.root, "setup-inventory.jsonl"), preload = path.join(f.root, "setup-probe.mjs");
  await writeFile(preload, `import fs from 'node:fs/promises';import {appendFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
let bytes=0;const read=fs.readFile;fs.readFile=async(...args)=>{const result=await read(...args);bytes+=result.length;return result;};syncBuiltinESMExports();process.on('exit',()=>appendFileSync(${JSON.stringify(log)},JSON.stringify({bytes})+'\\n'));`);
  inventoryProbe.preload = preload;
  const phases: Array<{ phase: string; durationMs: number }> = [];
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {},
    onPhase: (phase, durationMs) => { phases.push({ phase, durationMs }); throw new Error("ignored observation failure"); },
    ...(dependencies ? { dependencies: { command: [process.execPath, "-e", "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/dep','private')"] as [string, ...string[]], timeoutMs: 5000 } } : {}) });
  try {
    const workers = () => inventoryProbe.commands.filter(row => row.args.includes("--eval"));
    expect(workers()).toHaveLength(dependencies ? 2 : 1);
    const sourceBytes = Buffer.byteLength("preparedstaged new source");
    const scans = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { bytes: number });
    expect(scans.map(scan => scan.bytes)).toEqual(dependencies ? [sourceBytes, sourceBytes + 7] : [sourceBytes]);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const tuples = [["new.txt", 0, hash("staged new source")], ...(dependencies ? [["node_modules/dep", 0, hash("private")]] : []), ["source.txt", 0, hash("prepared")]];
    expect(snapshot.dependencyDigest).toBe(hash(JSON.stringify(tuples)));
    expect(phases.map(row => row.phase)).toEqual(["materialization", "baseline-inventory", ...(dependencies ? ["dependencies", "post-dependency-inventory"] : [])]);
    inventoryProbe.commands = [];
    await snapshot.verify();
    expect(workers()).toHaveLength(1);
    expect(inventoryProbe.commands.filter(row => row.command === "git")).toHaveLength(2);
    expect(phases.at(-1)?.phase).toBe("verification");
    expect(phases.every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0)).toBe(true);
    console.info(JSON.stringify({ snapshotMeasurement: { dependencies, setupWalks: scans.length, setupBytes: scans.reduce((sum, scan) => sum + scan.bytes, 0), verificationWalks: workers().length, verificationGitCalls: inventoryProbe.commands.filter(row => row.command === "git").length, phases } }));
  } finally { await snapshot.cleanup(); }
});

it("rejects tracked dependency paths before setup and unsafe setup output links", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "node_modules")); await writeFile(path.join(f.root, "node_modules/tracked"), "source");
  await f.git("add", "-f", "node_modules/tracked"); f.candidate.treeSha = await f.git("write-tree");
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} })).rejects.toMatchObject({ code: "check_dependency_source_overlap" });
  await f.git("rm", "--cached", "node_modules/tracked"); f.candidate.treeSha = await f.git("write-tree");
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["out/"], environment: {},
    dependencies: { command: [process.execPath, "-e", "const fs=require('fs');fs.mkdirSync('out');fs.symlinkSync('/tmp','out/link')"], timeoutMs: 5000 },
  })).rejects.toMatchObject({ code: "check_snapshot_escape" });
});
