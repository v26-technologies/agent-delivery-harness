import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createCheckSnapshot, sweepRemovedTrees } from "./check-snapshot.ts";

const removal = vi.hoisted(() => ({ fail: "", renameRefused: "", renameMissing: "" }));
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
  }, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (args[0] === removal.fail || removal.renameRefused === args[0]) throw Object.assign(new Error("fixture move refused"), { code: "EXDEV" });
    if (removal.renameMissing === args[0]) throw Object.assign(new Error("fixture trash vanished"), { code: "ENOENT" });
    return actual.rename(...args);
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
it("finite physical source avoids whole-tree Git materialization commands",async()=>{
  const f=await fixture(),before=inventoryProbe.commands.length;
  const snapshot=await createCheckSnapshot({rootDir:f.root,candidate:f.candidate,gitContext:'none',outputs:[],environment:{},physicalSource:{version:'physical-source/1',files:['source.txt'],absentInputs:['startup.cjs']}});
  try{
    expect(await readFile(path.join(snapshot.rootDir,'source.txt'),'utf8')).toBe('prepared');
    await expect(readFile(path.join(snapshot.rootDir,'new.txt'))).rejects.toMatchObject({code:'ENOENT'});
    const commands=inventoryProbe.commands.slice(before).filter(command=>command.command==='git').map(command=>command.args[0]);
    expect(commands).toContain('ls-tree');expect(commands).toContain('cat-file');
    expect(commands.some(command=>['fetch','checkout-index','read-tree','init'].includes(command!))).toBe(false);
    await snapshot.verify();
  }finally{await snapshot.cleanup();}
});
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
    // The boundary is the candidate's own (V26-3284): no deeper than the source's.
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

/** Waits until `file` is gone, for a deletion this process does not wait on. */
async function gone(file: string, ms = 20000) {
  const { access } = await import("node:fs/promises");
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50)))
    if (await access(file).then(() => false, () => true)) return true;
  return false;
}
it("cleanup moves the tree out of its path at once and deletes it in a detached process", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  await writeFile(path.join(snapshot.rootDir, "marker"), "owned");
  const before = inventoryProbe.commands.length;
  await snapshot.cleanup();
  const { access } = await import("node:fs/promises");
  await expect(access(snapshot.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  // One detached removal of the trees moved into the trash, not an in-process walk of them.
  const removals = inventoryProbe.commands.slice(before).filter(c => c.command === "/bin/rm");
  expect(removals).toHaveLength(1);
  const moved = removals[0]!.args.slice(2);
  expect(moved.length).toBeGreaterThan(0);
  for (const target of moved) {
    expect(path.dirname(target)).toBe(path.join(tmpdir(), `delivery-harness-trash-${process.getuid!()}`));
    expect(await gone(target)).toBe(true);
  }
});
it("a tree that cannot be moved aside is removed in place", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  removal.renameRefused = snapshot.rootDir;
  try {
    await snapshot.cleanup();
    const { access } = await import("node:fs/promises");
    await expect(access(snapshot.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { removal.renameRefused = ""; }
});
it("the sweep deletes what ended sessions left in the trash and leaves a live owner's", async () => {
  const { mkdir: makeDir, access } = await import("node:fs/promises");
  const { spawn: start } = await import("node:child_process");
  const trashed = path.join(tmpdir(), `delivery-harness-trash-${process.getuid!()}`);
  // A finished process's pid is dead; a running sleep's is alive.
  const done = start("/bin/sh", ["-c", "exit 0"]); await new Promise(resolve => done.once("exit", resolve));
  const live = start("/bin/sleep", ["30"]);
  const tag = `${process.pid}${Date.now()}`;
  const dead = path.join(trashed, `${done.pid}-dead${tag}`), alive = path.join(trashed, `${live.pid}-live${tag}`), legacy = path.join(trashed, `legacy${tag}`);
  // pid 1 belongs to another user: signalling it is refused, and a refused owner is alive.
  const foreign = path.join(trashed, `1-foreign${tag}`);
  await makeDir(trashed, { recursive: true, mode: 0o700 });
  try {
    for (const left of [dead, alive, legacy, foreign]) { await makeDir(path.join(left, "node_modules"), { recursive: true }); await writeFile(path.join(left, "node_modules/dep"), "x"); }
    await sweepRemovedTrees();
    expect(await gone(dead)).toBe(true);
    expect(await gone(legacy)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    await expect(access(alive)).resolves.toBeUndefined();
    await expect(access(foreign)).resolves.toBeUndefined();
  } finally { live.kill("SIGKILL"); await Promise.all([alive, foreign].map(left => rm(left, { recursive: true, force: true }))); }
});
it("a move that finds the trash gone removes the tree in place rather than calling it removed", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  removal.renameMissing = snapshot.rootDir;
  try {
    await snapshot.cleanup();
    const { access } = await import("node:fs/promises");
    await expect(access(snapshot.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { removal.renameMissing = ""; }
});
it.each([
  ["a link to another directory", "link"],
  ["a directory others can write", "open"],
] as const)("a trash that is %s is neither swept nor moved into", async (_, planted) => {
  const { chmod: setMode, access, readdir: list } = await import("node:fs/promises");
  const temp = await mkdtemp(path.join(tmpdir(), "scoped-trash-test-")); roots.push(temp);
  const victim = path.join(temp, "victim"), shared = path.join(temp, "shared");
  const f = await fixture();
  const done = (await import("node:child_process")).spawn("/bin/sh", ["-c", "exit 0"]); await new Promise(resolve => done.once("exit", resolve));
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = shared;
  try {
    await mkdir(shared);
    const trashed = path.join(shared, `delivery-harness-trash-${process.getuid!()}`);
    if (planted === "link") { await mkdir(victim); await symlink(victim, trashed); }
    else { await mkdir(trashed); await setMode(trashed, 0o777); }
    const target = planted === "link" ? victim : trashed;
    await writeFile(path.join(target, "keep"), "x"); await mkdir(path.join(target, `${done.pid}-dead`));
    await sweepRemovedTrees();
    const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
    await snapshot.cleanup();
    await expect(access(snapshot.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await list(target)).sort()).toEqual([`${done.pid}-dead`, "keep"]);
  } finally { if (previous === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previous; }
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

it("rejects source executable-mode changes made by dependency setup", async () => {
  const f = await fixture();
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {},
    dependencies: { command: [process.execPath, "-e", "require('fs').chmodSync('source.txt',0o755)"], timeoutMs: 5000 },
  })).rejects.toMatchObject({ code: "check_snapshot_drift" });
});

it("excludes nested dependency segments but preserves similarly named source paths", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "node_modules-extra"));
  await writeFile(path.join(f.root, "node_modules-extra/source"), "source boundary");
  await f.git("add", "."); f.candidate.treeSha = await f.git("write-tree");
  const install = "const fs=require('fs');fs.mkdirSync('nested/node_modules',{recursive:true});fs.writeFileSync('nested/node_modules/dep','dependency')";
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {},
    dependencies: { command: [process.execPath, "-e", install], timeoutMs: 5000 } });
  try {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(snapshot.dependencyDigest).toBe(hash(JSON.stringify([
      ["nested/node_modules/dep", 0, hash("dependency")], ["new.txt", 0, hash("staged new source")],
      ["node_modules-extra/source", 0, hash("source boundary")], ["source.txt", 0, hash("prepared")],
    ])));
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await writeFile(path.join(snapshot.rootDir, "nested/node_modules/dep"), "dependency drift");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {},
    dependencies: { command: [process.execPath, "-e", install + ";fs.writeFileSync('node_modules-extra/source','changed')"], timeoutMs: 5000 },
  })).rejects.toMatchObject({ code: "check_snapshot_drift" });
});

/** A source with history older than the candidate's merge-base: a - b - c - m (merge-base) - d (base tip), and m - e - f (head).
 * The depth is the longest tip's distance (head: 2) plus one, so from d it reaches c; a and b lie past it. */
async function deepFixture() {
  const f = await fixture();
  const commit = async (file: string, text: string, message: string) => {
    await writeFile(path.join(f.root, file), text); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", message);
    return f.git("rev-parse", "HEAD");
  };
  const a = await commit("source.txt", "a", "a"), b = await commit("source.txt", "b", "b");
  await commit("source.txt", "c", "c");
  const c = await commit("source.txt", "m", "m");
  const d = await commit("base.txt", "d", "d");
  await f.git("checkout", "-q", c);
  await commit("branch.txt", "e", "e");
  const head = await commit("branch.txt", "f", "f");
  await writeFile(path.join(f.root, "branch.txt"), "staged"); await f.git("add", ".");
  return { ...f, older: [a, b], mergeBase: c, candidate: { headSha: head, treeSha: await f.git("write-tree"), base: { ref: "origin/main", tipSha: d, mergeBaseSha: c } } };
}

it("fetches only the history from the merge-base to each tip for a full Git context (V26-3284)", async () => {
  const f = await deepFixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, gitContext: "full", outputs: [], environment: {} });
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: snapshot.rootDir })).stdout.trim();
    expect(await git("rev-parse", "--is-shallow-repository")).toBe("true");
    for (const old of f.older) await expect(git("cat-file", "-e", `${old}^{commit}`)).rejects.toMatchObject({ code: 128 });
    // What checks read through the pinned refs answers exactly as in the full source.
    expect(await git("merge-base", "refs/delivery/base", "refs/delivery/origin-head")).toBe(f.mergeBase);
    expect(await git("diff", "--name-only", "refs/delivery/base...refs/delivery/origin-head")).toBe(await f.git("diff", "--name-only", `${f.candidate.base.tipSha}...${f.candidate.headSha}`));
    await expect(git("merge-base", "--is-ancestor", "refs/delivery/merge-base", "refs/delivery/base")).resolves.toBe("");
    expect(await git("rev-list", "--count", "refs/delivery/merge-base..refs/delivery/origin-head")).toBe("2");
    await expect(snapshot.verify()).resolves.toBeUndefined();
  } finally { await snapshot.cleanup(); }
}, 30000);

it("fetches only the pinned commits themselves when the check sees no Git", async () => {
  const f = await deepFixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, gitContext: "none", outputs: [], environment: {} });
  try {
    const control = path.join(path.dirname(snapshot.commandRoot), "repository");
    const git = async (...args: string[]) => (await exec("git", [`--git-dir=${control}`, `--work-tree=${snapshot.rootDir}`, ...args])).stdout.trim();
    expect(await git("rev-parse", "refs/delivery/origin-head", "refs/delivery/base", "refs/delivery/merge-base")).toBe([f.candidate.headSha, f.candidate.base.tipSha, f.mergeBase].join("\n"));
    // Depth 1: the pinned commits, never their parents (the base tip's parent is the pinned merge-base).
    for (const pinned of [f.candidate.headSha, f.mergeBase]) await expect(git("rev-parse", "--verify", "--quiet", `${pinned}^`)).rejects.toMatchObject({ code: 1 });
    await expect(snapshot.verify()).resolves.toBeUndefined();
  } finally { await snapshot.cleanup(); }
}, 30000);

it("falls back to the source's whole history when it cannot measure the merge-base distance", async () => {
  const f = await deepFixture();
  // Not an ancestor of the base tip: the distance cannot bound what checks read.
  const unrelated = (await exec("git", ["commit-tree", "-m", "unrelated", await f.git("rev-parse", `${f.older[0]}^{tree}`)], { cwd: f.root })).stdout.trim();
  const candidate = { ...f.candidate, base: { ...f.candidate.base, mergeBaseSha: unrelated } };
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate, gitContext: "full", outputs: [], environment: {} });
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: snapshot.rootDir })).stdout.trim();
    for (const old of f.older) await expect(git("cat-file", "-e", `${old}^{commit}`)).resolves.toBe("");
  } finally { await snapshot.cleanup(); }
}, 30000);

it.each(["head", "base", "both"] as const)("falls back to the source's whole history when a side branch forked below the merge-base is merged on the %s side", async (sides) => {
  const f = await deepFixture();
  const root = await f.git("rev-parse", `${f.older[0]}^`);
  // A branch cut from `root` reaches below the merge-base by itself; fetched to the bounded
  // depth it would arrive cut off from it, counted above it and read as a second merge-base.
  const commitTree = async (message: string, tree: string, ...parents: string[]) =>
    (await exec("git", ["commit-tree", ...parents.flatMap(p => ["-p", p]), "-m", message, tree], { cwd: f.root })).stdout.trim();
  const tree = async (commit: string) => f.git("rev-parse", `${commit}^{tree}`);
  const merge = async (tip: string, name: string) => commitTree(`merge ${name}`, await tree(tip), tip, await commitTree(name, await tree(root), root));
  const headSha = sides === "base" ? f.candidate.headSha : await merge(f.candidate.headSha, "side");
  const tipSha = sides === "head" ? f.candidate.base.tipSha : await merge(f.candidate.base.tipSha, "other");
  const candidate = { ...f.candidate, headSha, base: { ...f.candidate.base, tipSha } };
  const reads = async (git: (...args: string[]) => Promise<string>) => [
    await git("merge-base", "--all", headSha, tipSha),
    await git("rev-list", "--count", `${f.mergeBase}..${headSha}`),
    await git("rev-list", "--count", `${f.mergeBase}..${tipSha}`),
  ];
  expect((await reads(f.git))[0]).toBe(f.mergeBase);
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate, gitContext: "full", outputs: [], environment: {} });
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: snapshot.rootDir })).stdout.trim();
    expect(await reads(git)).toEqual(await reads(f.git));
  } finally { await snapshot.cleanup(); }
}, 30000);

it("bounds the fetch when the base tip is itself the merge-base", async () => {
  const f = await deepFixture();
  // The base tip's range is empty and stands on nothing; only the head side bounds the depth.
  const candidate = { ...f.candidate, base: { ...f.candidate.base, tipSha: f.mergeBase } };
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate, gitContext: "full", outputs: [], environment: {} });
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: snapshot.rootDir })).stdout.trim();
    expect(await git("merge-base", "HEAD", "refs/delivery/base")).toBe(f.mergeBase);
    // The base tip is fetched to the head side's depth too, so it reaches `b` but not `a`.
    await expect(git("cat-file", "-e", `${f.older[0]}^{commit}`)).rejects.toMatchObject({ code: 128 });
  } finally { await snapshot.cleanup(); }
}, 30000);

it("refuses a merge-base the source does not have", async () => {
  const f = await deepFixture();
  const candidate = { ...f.candidate, base: { ...f.candidate.base, mergeBaseSha: "0".repeat(40) } };
  await expect(createCheckSnapshot({ rootDir: f.root, candidate, gitContext: "full", outputs: [], environment: {} })).rejects.toThrow();
}, 30000);

it("keeps a shallow source's boundary when the whole-history fallback fetches from it", async () => {
  const f = await shallowFixture();
  // An unrelated merge-base cannot bound the fetch, so the whole available history is fetched
  // from a shallow source, whose grafts the snapshot must take on rather than reject.
  // The shallow clone carries no repository identity of its own.
  const unrelated = (await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", "-m", "unrelated", await f.git("rev-parse", `${f.candidate.headSha}^{tree}`)], { cwd: f.root })).stdout.trim();
  const candidate = { ...f.candidate, base: { ...f.candidate.base, mergeBaseSha: unrelated } };
  // Git may record one graft twice when several wants reach it; the set of grafts is what counts.
  const grafts = async (root: string) => [...new Set((await readFile(path.join(root, ".git/shallow"), "utf8")).trim().split("\n"))].sort();
  const shallow = await grafts(f.root);
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate, gitContext: "full", outputs: [], environment: {} });
  try {
    expect(await grafts(snapshot.rootDir)).toEqual(shallow);
    await expect(exec("git", ["cat-file", "-e", f.missingAncestor], { cwd: snapshot.rootDir })).rejects.toMatchObject({ code: 1 });
  } finally { await snapshot.cleanup(); }
}, 30000);
