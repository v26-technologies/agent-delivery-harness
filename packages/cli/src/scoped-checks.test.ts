import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createArtifactsPort, defineHarnessConfig, type HarnessConfigInput } from "@agent-delivery-harness/kernel";
import base from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
const exec = promisify(execFile), dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "scoped-cli-")); dirs.push(dir);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(dir, "source.txt"), "source"); await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base"); await git("branch", "origin/main");
  const providers = ["a", "b"].map(id => ({ id: `check.${id}`, findingCodes: [], check: { command: [process.execPath, "-e", `if('${id}'==='b'&&process.env["FAIL"]==='1')process.exit(3);require('fs').writeFileSync('result-${id}.json',JSON.stringify({value:require('fs').readFileSync('source.txt','utf8')}))`], timeoutMs: 5000, outputs: [`result-${id}.json`], scope: { version: "scoped-check/1", files: ["source.txt"], memberships: [], tests: [], cwd: ".", profile: "fixture", environment: id === "b" ? [{ name: "FAIL", kind: "flag" }] : [] } } }));
  const input = { ...base, preparationWiringPaths: ["harness.config.ts"], preparationCommands: [], providers,
    obligations: providers.map(p => ({ ...base.obligations[0]!, id: `${p.id}.passed`, activation: { kind: "always" }, providers: [p.id], acceptedPayloadSpecs: ["checks.passed/1"], humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_evidence"] })),
    scopedExecution: { version: "scoped-execution/1", mechanicalProviders: [], profiles: [{ id: "fixture", gitContext: "none", dependencyInputs: [], mutableOutputs: ["result-a.json", "result-b.json"], credentialIdentities: {} }] } };
  let config = defineHarnessConfig(input as unknown as HarnessConfigInput);
  const artifacts = path.join(dir, ".git/artifacts"); await mkdir(artifacts);
  const out: string[] = [], err: string[] = [], env: Record<string, string> = { FAIL: "1" };
  const runtime: CliRuntime = { cwd: dir, env, stdinIsTTY: false, stdoutIsTTY: false, stdout: s => out.push(s), stderr: s => err.push(s), loadConfig: async () => config, artifacts: createArtifactsPort({ runRootBase: artifacts }) };
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; return runCli(args, runtime); };
  return { dir, git, run, out, err, env, get config() { return config; }, runtime, setConfig: (v: HarnessConfigInput) => { config = defineHarnessConfig(v); } };
}
it.each([1, 2])("forwards existing snapshot phase timings with the active check and attempt at concurrency %s", async concurrency => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, concurrency, mechanicalProviders: ["check.a", "check.b"], profiles: f.config.scopedExecution!.profiles.map(profile => ({ ...profile,
    dependencies: { command: [process.execPath, "-e", "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/fixture','dependency')"], timeoutMs: 5000 },
  })) } });
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  const observations: { phase: string; durationMs: number }[] = [];
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(input => create({ ...input, onPhase: (phase, durationMs) => {
    observations.push({ phase, durationMs: Math.round(durationMs) }); input.onPhase?.(phase, durationMs);
  } }));
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const timings = f.out.flatMap(line => line.split("\n")).filter(line => line.startsWith("snapshot check."));
    const parsed = timings.map(line => /^snapshot (check\.[ab]): attempt ([^;]+); ([a-z-]+) (\d+)ms$/.exec(line));
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every(match => match !== null)).toBe(true);
    expect(parsed.map(match => ({ phase: match![3], durationMs: Number(match![4]) }))).toEqual(observations);
    expect([...new Set(parsed.map(match => match![3]))].sort()).toEqual(["baseline-inventory", "dependencies", "materialization", "post-dependency-inventory", "verification"]);
    const { readScopedCheckObservations } = await import("./index.ts");
    const recorded = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    for (const provider of recorded.providers) {
      const own = parsed.filter(match => match![1] === provider.providerId);
      expect(own.filter(match => match![3] === "verification")).toHaveLength(2);
      expect([...new Set(own.map(match => match![2]))]).toEqual([provider.attempts[0]!.attemptId]);
    }
  } finally { spy.mockRestore(); }
});
it.each(["none", "full"] as const)("prepares and verifies portable evidence from a shallow source with %s Git context", async gitContext => {
  const f = await fixture(); f.env["FAIL"] = "0";
  await writeFile(path.join(f.dir, "source.txt"), "boundary"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "boundary");
  await writeFile(path.join(f.dir, "source.txt"), "head"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "head");
  const shallow = await mkdtemp(path.join(tmpdir(), "scoped-shallow-cli-")); dirs.push(shallow);
  await exec("git", ["clone", "--no-local", "--depth", "2", f.dir, shallow]);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: shallow })).stdout.trim();
  const boundary = await readFile(path.join(shallow, ".git/shallow"));
  await writeFile(path.join(shallow, "source.txt"), "staged shallow"); await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "source candidate");
  const head = await git("rev-parse", "HEAD"); await git("update-ref", "refs/remotes/origin/main", head);
  const staged = await git("write-tree");
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"], profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext })) } });
  const runtime = { ...f.runtime, cwd: shallow };
  for (const command of ["prepare", "gate", "record"]) expect(await runCli([command], runtime), f.err.join("\n")).toBe(0);
  await git("add", "."); expect(await runCli(["verify"], runtime), f.err.join("\n")).toBe(0);
  expect(await readFile(path.join(shallow, ".git/shallow"))).toEqual(boundary);
  expect(await git("rev-parse", "HEAD")).toBe(head);
  expect(await git("rev-parse", `${staged}:source.txt`)).toBe(await git("hash-object", "source.txt"));
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "record");
  const foreign = await mkdtemp(path.join(tmpdir(), "scoped-shallow-foreign-")); dirs.push(foreign);
  await exec("git", ["clone", "--no-local", shallow, foreign]);
  await exec("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: foreign });
  expect(await runCli(["verify"], { ...runtime, cwd: foreign }), f.err.join("\n")).toBe(0);
}, 60000);
it("bounds live snapshots across dependency setup changes while retaining same-setup reuse and durable outputs", async () => {
  const f = await fixture();
  const template = f.config.providers[0]!;
  const providers = ["a", "a2", "b", "a3"].map(id => ({ ...template, id: `check.${id}`, check: { ...template.check!,
    command: [process.execPath, "-e", `require('fs').writeFileSync('result-${id}.json','{}')`] as [string, ...string[]],
    outputs: [`result-${id}.json`], scope: { ...template.check!.scope!, profile: id === "b" ? "b" : "a" },
  } }));
  f.setConfig({ ...f.config, providers,
    obligations: providers.map(p => ({ ...f.config.obligations[0]!, id: `${p.id}.passed`, providers: [p.id] })),
    scopedExecution: { ...f.config.scopedExecution!, profiles: ["a", "b"].map(id => ({ ...f.config.scopedExecution!.profiles[0]!, id,
      mutableOutputs: providers.flatMap(p => p.check.outputs),
      dependencies: { command: [process.execPath, "-e", `const fs=require('fs');fs.mkdirSync('node_modules');fs.writeFileSync('node_modules/private-${id}.bin',Buffer.alloc(65536,1))`], timeoutMs: 5000 },
    })) },
  });
  const snapshots = await import("./check-snapshot.ts"), original = snapshots.createCheckSnapshot;
  const roots: string[] = [], liveBeforeAllocation: number[] = [];
  const { access } = await import("node:fs/promises");
  const exists = async (file: string) => access(file).then(() => true, () => false);
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    liveBeforeAllocation.push((await Promise.all(roots.map(exists))).filter(Boolean).length);
    const snapshot = await original(input); roots.push(snapshot.rootDir); return snapshot;
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate"), f.err.join("\n")).toBe(0);
    expect(liveBeforeAllocation).toEqual([0, 0, 0]); // A/A reuse, B switch, fresh A return.
    expect(await Promise.all(roots.map(exists))).toEqual([false, false, false]);
    expect(await f.run("record"), f.err.join("\n")).toBe(0);
    await f.git("add", ".");
    expect(await f.run("verify"), f.err.join("\n")).toBe(0);
    expect(spy).toHaveBeenCalledTimes(3); // Durable evidence survives all private trees.
  } finally { spy.mockRestore(); }
}, 30000);

it("refuses a new dependency setup when inactive snapshot cleanup fails and retries cleanup at gate exit", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, scope: { ...p.check!.scope!, profile: p.id } } })),
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.providers.map(p => ({ ...f.config.scopedExecution!.profiles[0]!, id: p.id,
      dependencies: { command: [process.execPath, "-e", `// setup for ${p.id}`] as [string, ...string[]], timeoutMs: 5000 } })) },
  });
  const snapshots = await import("./check-snapshot.ts"), original = snapshots.createCheckSnapshot;
  let cleanupCalls = 0; const roots: string[] = [];
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await original(input); roots.push(snapshot.rootDir);
    return { ...snapshot, cleanup: async () => {
      if (++cleanupCalls === 1) throw new snapshots.CheckSnapshotError("check_snapshot_cleanup_failed", "Injected removal failure.");
      await snapshot.cleanup();
    } };
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_snapshot_cleanup_failed");
    expect(f.out.join("\n")).not.toContain("checking check.b");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cleanupCalls).toBe(2);
    const { access } = await import("node:fs/promises");
    await expect(access(roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    const { readScopedCheckDiagnostics, readScopedCheckObservations } = await import("./index.ts");
    const observations = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    const attemptIds = observations.providers.flatMap(p => p.attempts.map(a => a.attemptId));
    const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds });
    expect(diagnostics.providers.find(p => p.providerId === "check.b")!.attempts[0]).toMatchObject({ status: "failed", diagnostic: {
      availability: "available", phase: "snapshot-setup", failure: { code: "check_snapshot_cleanup_failed" }, command: { unavailable: "not-started" },
    } });
  } finally { spy.mockRestore(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
}, 30000);

it("retains A across B failure, retry and report replan, then records portable evidence", async () => {
  const f = await fixture(); expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(1);
  expect(f.out.join("\n")).toContain("checking check.a");
  f.env["FAIL"] = "0";
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("reusing check.a");
  expect(f.out.join("\n")).not.toContain("checking check.a");
  await mkdir(path.join(f.dir, "docs/reports"), { recursive: true }); await writeFile(path.join(f.dir, "docs/reports/report.md"), "report"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "report");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("reusing check.a"); expect(f.out.join("\n")).toContain("reusing check.b");
  await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  await expect(readFile(path.join(f.dir, "result-a.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "record");
  const foreign = await mkdtemp(path.join(tmpdir(), "scoped-foreign-")); dirs.push(foreign);
  await exec("git", ["clone", "--no-local", f.dir, foreign]);
  await exec("git", ["update-ref", "refs/remotes/origin/main", await f.git("rev-parse", "origin/main")], { cwd: foreign });
  expect(await runCli(["verify"], { ...f.runtime, cwd: foreign }), f.err.join("\n")).toBe(0);
  const { readdir } = await import("node:fs/promises");
  const recordDir = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const recordFile = path.join(recordDir, (await readdir(recordDir))[0]!);
  const original = await readFile(recordFile, "utf8");
  const record = JSON.parse(original);
  const portable = record.claims[0].evidence.resolution.portable;
  portable.artifacts["scoped-inputs.json"] = Buffer.from("{}").toString("base64");
  await writeFile(recordFile, JSON.stringify(record)); await f.git("add", ".");
  expect(await f.run("verify")).toBe(1);
  expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
}, 60000);
it("keeps valid workflow release receipts bounded separately from scoped source inputs", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  await mkdir(path.join(f.dir, ".agent-skills"), { recursive: true });
  const release = { releaseId: "test-release", profile: "linear", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) };
  const receipt = path.join(f.dir, ".agent-skills/active.json");
  await writeFile(receipt, JSON.stringify({ release }));
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  await writeFile(receipt, JSON.stringify({ release, padding: "x".repeat(2 * 1024 * 1024) }));
  expect(await f.run("prepare"), f.err.join("\n")).toBe(1);
  expect(f.err.join("\n")).toContain("portable_tree_unreadable");
  await writeFile(receipt, JSON.stringify({ release }));
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
}, 60000);
it("hashes large source and dependency files through execution and foreign verification without transporting them", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const source = Buffer.alloc(14 * 1024 * 1024, 97);
  const dependency = Buffer.alloc(3 * 1024 * 1024, 98);
  await writeFile(path.join(f.dir, "source.txt"), source);
  await writeFile(path.join(f.dir, "large.lock"), dependency);
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, command: [process.execPath, "-e", `const fs=require('fs'),crypto=require('crypto');fs.writeFileSync('${p.check!.outputs![0]}',JSON.stringify({source:crypto.createHash('sha256').update(fs.readFileSync('source.txt')).digest('hex'),dependency:crypto.createHash('sha256').update(fs.readFileSync('large.lock')).digest('hex')}))`] } })),
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, dependencyInputs: ["large.lock"] })) } });
  await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "large inputs");
  for (const command of ["prepare", "gate", "record"]) expect(await f.run(command), f.err.join("\n")).toBe(0);
  await f.git("add", "."); expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "record");
  const foreign = await mkdtemp(path.join(tmpdir(), "scoped-large-foreign-")); dirs.push(foreign);
  await exec("git", ["clone", "--no-local", f.dir, foreign]);
  await exec("git", ["update-ref", "refs/remotes/origin/main", await f.git("rev-parse", "origin/main")], { cwd: foreign });
  expect(await runCli(["verify"], { ...f.runtime, cwd: foreign }), f.err.join("\n")).toBe(0);
  for (const [file, bytes] of [["source.txt", source], ["large.lock", dependency]] as const) {
    const changed = Buffer.from(bytes); changed[changed.length - 1] = 99;
    await writeFile(path.join(foreign, file), changed);
    await exec("git", ["add", file], { cwd: foreign });
    expect(await runCli(["verify"], { ...f.runtime, cwd: foreign }), file).toBe(1);
    expect(f.err.join("\n")).toContain("delivery_record_missing");
    await exec("git", ["restore", "--source=HEAD", "--staged", "--worktree", file], { cwd: foreign });
  }
  expect(await runCli(["verify"], { ...f.runtime, cwd: foreign }), f.err.join("\n")).toBe(0);
}, 60000);
it.each(["none", "full"] as const)("materializes directory links and verifies their scoped evidence with %s Git context", async gitContext => {
  const f = await fixture(); f.env["FAIL"] = "0";
  await mkdir(path.join(f.dir, "target/nested"), { recursive: true });
  await writeFile(path.join(f.dir, "target/nested/input"), "directory contents");
  await symlink("target", path.join(f.dir, "link"));
  await symlink("link", path.join(f.dir, "chain"));
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!,
    command: [process.execPath, "-e", `const fs=require('fs');if(!fs.lstatSync('link').isSymbolicLink()||fs.readlinkSync('chain')!=='link')process.exit(4);fs.writeFileSync('${p.check!.outputs![0]}',JSON.stringify({value:fs.readFileSync('chain/nested/input','utf8')}))`],
    scope: { ...p.check!.scope!, files: ["chain", "link"], memberships: ["target/"] },
  } })), scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext })) } });
  await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "directory inputs");
  for (const command of ["prepare", "gate", "record"]) expect(await f.run(command), f.err.join("\n")).toBe(0);
  await f.git("add", "."); expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "record");
  const foreign = await mkdtemp(path.join(tmpdir(), "scoped-directory-foreign-")); dirs.push(foreign);
  await exec("git", ["clone", "--no-local", f.dir, foreign]);
  await exec("git", ["update-ref", "refs/remotes/origin/main", await f.git("rev-parse", "origin/main")], { cwd: foreign });
  expect(await runCli(["verify"], { ...f.runtime, cwd: foreign }), f.err.join("\n")).toBe(0);
  await writeFile(path.join(foreign, "target/nested/input"), "changed");
  await exec("git", ["add", "."], { cwd: foreign });
  expect(await runCli(["verify"], { ...f.runtime, cwd: foreign })).toBe(1);
}, 60000);
it("captures untracked source without changing the author index", async () => {
  const f = await fixture();
  await writeFile(path.join(f.dir, "new-source.txt"), "untracked source");
  const before = await f.git("ls-files", "--stage");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.git("ls-files", "--stage")).toBe(before);
  expect(await f.git("status", "--porcelain")).toContain("?? new-source.txt");
}, 60000);
it("requires mechanical scoped success before publishing a preparation receipt", async () => {
  const f = await fixture();
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.b"] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(1);
  expect(await f.run("review-context"), f.err.join("\n")).toBe(1);
  f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.b");
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).not.toContain("checking check.b");
}, 60000);
it("runs secret-dependent checks fresh on the same candidate and retains no sentinel secret", async () => {
  const f = await fixture(); f.env["FAIL"] = "0"; f.env["API_TOKEN"] = "SENTINEL-private-credential-2065";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "console.log(process.env.API_TOKEN);require('fs').writeFileSync('result-a.json','{}')"], scope: { ...a.check!.scope!, environment: [{ name: "API_TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  for (let i = 0; i < 2; i++) { expect(await f.run("gate"), f.err.join("\n")).toBe(0); expect(f.out.join("\n")).toContain("checking check.a"); }
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  const { readdir } = await import("node:fs/promises");
  const inspect = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await inspect(file); else if (entry.isFile()) expect((await readFile(file)).includes(Buffer.from(f.env["API_TOKEN"]!)), file).toBe(false); } };
  await inspect(f.dir);
}, 60000);
it("unsupported scoped execution fails before expensive preparation", async () => {
  const f = await fixture();
  const { scopedExecution: _unused, ...withoutExecutor } = f.config;
  f.setConfig({ ...withoutExecutor, preparationCommands: [{ id: "expensive", command: [process.execPath, "-e", "require('fs').writeFileSync('.git/expensive','ran')"], timeoutMs: 5000 }] });
  expect(await f.run("prepare")).toBe(1);
  expect(f.err.join("\n")).toContain("scoped_executor_required");
  await expect(readFile(path.join(f.dir, ".git/expensive"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60000);
it.each([
  ["missing output", "", "check_output_missing"],
  ["source drift", "require('fs').writeFileSync('source.txt','drift');require('fs').writeFileSync('result-a.json','{}')", "check_snapshot_drift"],
  ["credential output", "require('fs').writeFileSync('result-a.json',process.env.API_TOKEN)", "check_output_missing"],
])("refuses %s and preserves the independent sibling", async (_label, command, code) => {
  const f = await fixture(); f.env["FAIL"] = "0"; f.env["API_TOKEN"] = "SECRET-output-sentinel";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", command], scope: { ...a.check!.scope!, environment: [{ name: "API_TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(1);
  expect(f.err.join("\n")).toContain(code);
  expect(f.out.join("\n")).toContain("passed check.b");
  expect(await readFile(path.join(f.dir, "source.txt"), "utf8")).toBe("source");
}, 60000);
it("retains cancellation as interrupted and retries without publishing success", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "setTimeout(()=>{},10000)"] } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const controller = new AbortController();
  const runtime = { ...f.runtime, signal: controller.signal, stdout: (s: string) => { f.out.push(s); if (s.includes("checking check.a")) controller.abort(); } };
  expect(await runCli(["gate"], runtime), f.err.join("\n")).toBe(130);
  const { resolveRecordStorage } = await import("@agent-delivery-harness/kernel");
  const { readdir } = await import("node:fs/promises");
  const storage = await resolveRecordStorage(f.dir, { storageNamespace: f.config.storageNamespace, leaf: "scoped-attempts" });
  const contents: string[] = [];
  const collect = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await collect(file); else contents.push(await readFile(file, "utf8")); } };
  await collect(storage.storageDir);
  expect(contents.join("\n")).toContain('"status":"interrupted"');
  expect(contents.join("\n")).not.toContain('"status":"passed"');
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)) });
  expect(diagnostics.providers.flatMap(p => p.attempts).some(a => a.status === "interrupted" && a.diagnostic.availability === "available" && "unavailable" in a.diagnostic.command)).toBe(true);
  expect(diagnostics.providers[0]!.attempts[0]).toMatchObject({ status: "interrupted", diagnostic: { availability: "available", phase: "command", failure: { code: "check_command_failed", executionErrorCode: "ABORT_ERR" }, command: { unavailable: "not-completed" } } });
}, 60000);

it('a missing sibling output cannot borrow a previous check output',async()=>{
 const f=await fixture();f.env["FAIL"]='0';
 const a=f.config.providers[0]!, b=f.config.providers[1]!;
 f.setConfig({...f.config, providers:[a,{...b,check:{...b.check!,command:[process.execPath,'-e',''],outputs:['result-a.json']}}]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);
 const gate=await f.run('gate');
 expect(gate).toBe(1);
},60000);
it('preparation cannot attest source mutated after its validator',async()=>{
 const f=await fixture();f.env["FAIL"]='0';
 f.setConfig({...f.config,preparationCommands:[{id:'validate',command:[process.execPath,'-e',"if(require('fs').readFileSync('source.txt','utf8')!=='source')process.exit(1)"],timeoutMs:5000},{id:'mutate',command:[process.execPath,'-e',"require('fs').writeFileSync('source.txt','unvalidated')"],timeoutMs:5000}]});
 const prepared=await f.run('prepare');
 expect(prepared).toBe(1);
},60000);
it('nonreusable credentials portable fresh clone',async()=>{
 const f=await fixture();f.env["FAIL"]='0';f.env["API_TOKEN"]='secret';const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,scope:{...a.check!.scope!,environment:[{name:'API_TOKEN',kind:'credential'}]}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);
 expect(await f.run('record'),f.err.join('\n')).toBe(0);
 await f.git('add','.');await f.git('-c','commit.gpgsign=false','commit','-qm','record');
 const foreign=await mkdtemp(path.join(tmpdir(),'scoped-oc-foreign-'));dirs.push(foreign);
 await exec('git',['clone','--no-local',f.dir,foreign]);await exec('git',['update-ref','refs/remotes/origin/main',await f.git('rev-parse','origin/main')],{cwd:foreign});
 const verified=await runCli(['verify'],{...f.runtime,cwd:foreign});expect(verified).toBe(0);
},60000);
it.each(['check', 'dependencies'])('rejects an absolute authoring executable in %s before setup', async kind => {
 const f=await fixture(); const script=path.join(f.dir,'check.cjs'); await writeFile(script,`#!${process.execPath}\nprocess.exit(7);\n`);
 const a=f.config.providers[0]!;
 f.setConfig(kind==='check' ? {...f.config,providers:[{...a,check:{...a.check!,command:[script]}},f.config.providers[1]!]} : {...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,dependencies:{command:[script],timeoutMs:5000}}]}});
 expect(await f.run('prepare')).toBe(1);expect(f.err.join('\n')).toContain('check_runtime_author_path');
},60000);
it('missing dependency input is a named preflight blocker',async()=>{
 const f=await fixture();f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,dependencyInputs:['missing.lock']}]}});
 expect(await f.run('prepare')).toBe(1);expect(f.err.join('\n')).toContain('check_dependency_input_missing');
},60000);
it('logical cwd resolves repository executable',async()=>{
 const f=await fixture();f.env["FAIL"]='0';await mkdir(path.join(f.dir,'scripts'));const script=path.join(f.dir,'scripts/check.cjs');await writeFile(script,`#!${process.execPath}\nrequire('fs').writeFileSync('../result-a.json','{}');\n`);(await import('node:fs')).chmodSync(script,0o755);
 const a=f.config.providers[0]!;f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:['./check.cjs'],scope:{...a.check!.scope!,cwd:'scripts',files:['scripts/check.cjs']}}},f.config.providers[1]!]});
 const code=await f.run('prepare');expect(code).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
},60000);
it('executable mode drift invalidates executable proof',async()=>{
 const f=await fixture();f.env["FAIL"]='0';const script=path.join(f.dir,'check.cjs');await writeFile(script,`#!${process.execPath}\nrequire('fs').writeFileSync('result-a.json','{}');\n`);const fs=await import('node:fs');fs.chmodSync(script,0o755);
 const a=f.config.providers[0]!;f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:['./check.cjs'],scope:{...a.check!.scope!,files:['source.txt']}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
 fs.chmodSync(script,0o644);expect(await f.run('prepare'),f.err.join('\n')).toBe(0);const gate=await f.run('gate');expect(gate).toBe(1);
},60000);
it('mutable output cannot hide a tracked source directory',async()=>{
 const f=await fixture();f.env["FAIL"]='0';await mkdir(path.join(f.dir,'src'));await writeFile(path.join(f.dir,'src/app.txt'),'source');
 const a=f.config.providers[0]!;f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,mutableOutputs:['src','result-a.json','result-b.json']}]},providers:[{...a,check:{...a.check!,command:[process.execPath,'-e',"require('fs').writeFileSync('src/app.txt','drift');require('fs').writeFileSync('result-a.json','{}')"],scope:{...a.check!.scope!,files:['src/app.txt']}}},f.config.providers[1]!]});
 const prepared=await f.run('prepare');const gate=prepared===0?await f.run('gate'):prepared;expect(gate).toBe(1);
},60000);
it("captures explicit repairs before validators and scoped mechanics", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, obligations: f.config.obligations.slice(0, 1), providers: f.config.providers.slice(0, 1), scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"], repairCommands: [{ id: "repair-source", command: [process.execPath, "-e", "require('fs').writeFileSync('source.txt','repaired')"], timeoutMs: 5000 }] }, preparationCommands: [{ id: "validate-source", command: [process.execPath, "-e", "if(require('fs').readFileSync('source.txt','utf8')!=='repaired')process.exit(1)"], timeoutMs: 5000 }] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a");
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
});
it("cannot accept output precreated by dependency setup", async () => {
  const f = await fixture(); const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, obligations: f.config.obligations.slice(0, 1), providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", ""] } }], scopedExecution: { ...f.config.scopedExecution!, profiles: [{ ...f.config.scopedExecution!.profiles[0]!, dependencies: { command: [process.execPath, "-e", "require('fs').writeFileSync('result-a.json','{}')"], timeoutMs: 5000 } }] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1); expect(f.err.join("\n")).toContain("check_output_missing");
});
it.each(["src", "src/"])("refuses output ancestor %s", async output => {
  const f = await fixture(); await mkdir(path.join(f.dir, "src")); await writeFile(path.join(f.dir, "src/file"), "source");
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: [{ ...f.config.scopedExecution!.profiles[0]!, mutableOutputs: [output, "result-a.json", "result-b.json"] }] } });
  expect(await f.run("prepare")).toBe(1); expect(f.err.join("\n")).toContain("check_output_overlaps_source");
});
it("injects declared flags and credentials while excluding an explicitly supplied undeclared variable", async () => {
  const f = await fixture(); f.env["FLAG"] = "yes"; f.env["TOKEN"] = "secret-sentinel"; f.env["UNDECLARED"] = "must-not-reach-command"; f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, obligations: f.config.obligations.slice(0, 1), providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "if(process.env.FLAG!=='yes'||process.env.TOKEN!=='secret-sentinel'||process.env.UNDECLARED!==undefined)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"], scope: { ...a.check!.scope!, environment: [{ name: "FLAG", kind: "flag" }, { name: "TOKEN", kind: "credential" }] } } }] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
});
it.each(["GIT_DIR", "DELIVERY_CHECK_ORIGIN_TREE", "PATH", "HOME", "TMPDIR", "TMP", "TEMP"])("refuses reserved environment input %s", async name => {
  const f = await fixture(), a = f.config.providers[0]!;
  expect(() => f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, scope: { ...a.check!.scope!, environment: [{ name, kind: "flag" }] } } }, f.config.providers[1]!] })).toThrow();
});
it("reruns only the dependency-affected profile and refuses stale portable dependency inputs", async () => {
  const f = await fixture(); f.env["FAIL"] = "0"; await writeFile(path.join(f.dir, "deps.lock"), "one");
  const a = f.config.providers[0]!, profile = f.config.scopedExecution!.profiles[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, scope: { ...a.check!.scope!, profile: "dependent" } } }, f.config.providers[1]!], scopedExecution: { ...f.config.scopedExecution!, profiles: [profile, { ...profile, id: "dependent", dependencyInputs: ["deps.lock"] }] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0); expect(f.out.join("\n")).toContain("reusing check.a");
  await writeFile(path.join(f.dir, "deps.lock"), "two"); await f.git("add", ".");
  expect(await f.run("verify")).toBe(1); expect(f.err.join("\n")).toContain("delivery_record_missing");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const { readdir } = await import("node:fs/promises");
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: "foreign-verifier", computeIdentity: withDeliverableIdentity() });
  expect(capture.ok).toBe(true); if (!capture.ok) throw new Error("capture failed");
  await expect(capturePortableVerificationInputs(f.dir, f.config, capture.candidate, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a"); expect(f.out.join("\n")).toContain("reusing check.b");
}, 60000);
it("fences an older completion after a newer execution publishes success", async () => {
  const { AttemptStore } = await import("./scoped-attempts.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const finish = AttemptStore.prototype.finish; let overlapped = false;
  const { ScopedChecks } = await import("./scoped-checks.ts");
  const execute = ScopedChecks.prototype.execute, failures: unknown[] = [];
  const executionSpy = vi.spyOn(ScopedChecks.prototype, "execute").mockImplementation(async function (this: import("./scoped-checks.ts").ScopedChecks, ...args) {
    try { return await execute.apply(this, args); } catch (error) { failures.push(error); throw error; }
  });
  const spy = vi.spyOn(AttemptStore.prototype, "finish").mockImplementation(async function (this: import("./scoped-attempts.ts").AttemptStore, attempt, status, payload) {
    await finish.call(this, attempt, status, payload);
    if (!overlapped && attempt.providerId === "check.a" && status === "passed") {
      overlapped = true;
      expect(await runCli(["gate"], f.runtime), f.err.join("\n")).toBe(0);
    }
  });
  try {
    expect(await f.run("gate"), f.err.join("\n")).toBe(0);
    expect(overlapped).toBe(true); expect(failures).toEqual([expect.objectContaining({ code: "check_attempt_superseded" })]);
    expect(f.out.filter(s => s.includes("passed check.a"))).toHaveLength(1);
  } finally { spy.mockRestore(); executionSpy.mockRestore(); }
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
}, 60000);
it.each(["failed", "interrupted"] as const)("newer %s completion blocks older publication and permits a valid retry", async status => {
  const { AttemptStore } = await import("./scoped-attempts.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const finish = AttemptStore.prototype.finish; let overlapped = false;
  const spy = vi.spyOn(AttemptStore.prototype, "finish").mockImplementation(async function (this: import("./scoped-attempts.ts").AttemptStore, attempt, result, payload) {
    await finish.call(this, attempt, result, payload);
    if (!overlapped && attempt.providerId === "check.a" && result === "passed") {
      overlapped = true;
      const newer = await this.allocate({ version: attempt.version, providerId: attempt.providerId, inputDigest: attempt.inputDigest, profileDigest: attempt.profileDigest, origin: { ...attempt.origin, runId: "newer-execution" } });
      await finish.call(this, newer, status, { outputs: [] });
    }
  });
  try {
    expect(await f.run("gate"), f.err.join("\n")).toBe(1);
    expect(f.err.join("\n")).toContain("check_attempt_superseded");
    expect(f.out.join("\n")).not.toContain("passed check.a");
  } finally { spy.mockRestore(); }
  expect(await f.run("gate"), f.err.join("\n")).toBe(0); expect(f.out.join("\n")).toContain("checking check.a");
}, 60000);
it("refuses retained output corruption independently of the attempt envelope checksum", async () => {
  const { ScopedChecks } = await import("./scoped-checks.ts");
  const { digestCanonical, resolveRecordStorage } = await import("@agent-delivery-harness/kernel");
  const { readdir } = await import("node:fs/promises");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const create = ScopedChecks.create; let session: import("./scoped-checks.ts").ScopedChecks | undefined;
  const spy = vi.spyOn(ScopedChecks, "create").mockImplementation(async (...args) => { session = await create(...args); return session; });
  try { expect(await f.run("gate"), f.err.join("\n")).toBe(0); } finally { spy.mockRestore(); }
  expect(Buffer.from(await session!.readOutput("result-a.json", "check.a")).toString()).toBe('{"value":"source"}');
  const storage = await resolveRecordStorage(f.dir, { storageNamespace: f.config.storageNamespace, leaf: "scoped-attempts" });
  const root = path.join(storage.storageDir, digestCanonical({ gate: f.config.gateId, provider: "check.a" }));
  const generation = (await readdir(root))[0]!;
  const file = path.join(root, generation, "terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.outputs[0].base64 = Buffer.from("corrupt").toString("base64"); row.digest = digestCanonical(row.entry);
  await writeFile(file, JSON.stringify(row));
  await expect(session!.readOutput("result-a.json", "check.a")).rejects.toMatchObject({ code: "check_output_missing" });
}, 60000);
it.each(["command", "wiring"])("refuses %s repair failure before validators and revokes preparation", async kind => {
  const f = await fixture();
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, repairCommands: [{ id: "repair-source", command: [process.execPath, "-e", kind === "command" ? "process.exit(7)" : "require('fs').writeFileSync('harness.config.ts','changed')"], timeoutMs: 5000 }] }, preparationCommands: [{ id: "validator", command: [process.execPath, "-e", "require('fs').writeFileSync('.git/validator','ran')"], timeoutMs: 5000 }] });
  expect(await f.run("prepare")).toBe(1);
  expect(f.err.join("\n")).toContain(kind === "command" ? "preparation_repair_failed" : "preparation_candidate_changed");
  await expect(readFile(path.join(f.dir, ".git/validator"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.run("review-context")).toBe(1);
});

it.each(['files', 'tests', 'memberships', 'dependencyInputs'])('a declared helper executable mode is a scoped input via %s',async selected=>{
 const f=await fixture();f.env["FAIL"]='0';const fs=await import('node:fs');
 await mkdir(path.join(f.dir,'helpers'));await writeFile(path.join(f.dir,'helpers/helper.cjs'),`#!${process.execPath}\nprocess.exit(0);\n`);fs.chmodSync(path.join(f.dir,'helpers/helper.cjs'),0o755);
 const a=f.config.providers[0]!;f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,dependencyInputs:selected==='dependencyInputs'?['helpers/helper.cjs']:[]}]},providers:[{...a,check:{...a.check!,command:[process.execPath,'-e',"if(require('child_process').spawnSync('./helpers/helper.cjs').status!==0)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"],scope:{...a.check!.scope!,files:selected==='files'?['helpers/helper.cjs']:['source.txt'],tests:selected==='tests'?['helpers/helper.cjs']:[],memberships:selected==='memberships'?['helpers/']:[]}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
 fs.chmodSync(path.join(f.dir,'helpers/helper.cjs'),0o644);await expect(exec(process.execPath,f.config.providers[0]!.check!.command.slice(1),{cwd:f.dir})).rejects.toMatchObject({code:7});expect(await f.run('prepare'),f.err.join('\n')).toBe(0);const gate=await f.run('gate');expect(gate).toBe(1);
},60000);
it('repair cancellation preserves interrupted CLI outcome',async()=>{
 const f=await fixture();f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,repairCommands:[{id:'repair-wait',command:[process.execPath,'-e','setTimeout(()=>{},10000)'],timeoutMs:20000}]}});
 const controller=new AbortController();const code=await runCli(['prepare'],{...f.runtime,signal:controller.signal,stdout:(s:string)=>{f.out.push(s);if(s.includes('repairing repair-wait'))controller.abort();}});
 expect(code).toBe(130);
},60000);
it('a declared symlink target is a scoped input',async()=>{
 const f=await fixture();f.env["FAIL"]='0';const fs=await import('node:fs');await writeFile(path.join(f.dir,'other.txt'),'source');fs.symlinkSync('source.txt',path.join(f.dir,'alias'));
 const a=f.config.providers[0]!;f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:[process.execPath,'-e',"if(require('fs').readlinkSync('alias')!=='source.txt')process.exit(7);require('fs').writeFileSync('result-a.json','{}')"],scope:{...a.check!.scope!,files:['alias']}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
 fs.unlinkSync(path.join(f.dir,'alias'));fs.symlinkSync('other.txt',path.join(f.dir,'alias'));await expect(exec(process.execPath,f.config.providers[0]!.check!.command.slice(1),{cwd:f.dir})).rejects.toMatchObject({code:7});expect(await f.run('prepare'),f.err.join('\n')).toBe(0);const gate=await f.run('gate');expect(gate).toBe(1);
},60000);


it("historical workspace refuses non-record-neutral narration drift", async () => {
 const f=await fixture(); f.env["FAIL"]="0"; f.env["API_TOKEN"]="secret"; const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,scope:{...a.check!.scope!,environment:[{name:"API_TOKEN",kind:"credential"}]}}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);
 expect(await f.run("record"),f.err.join("\n")).toBe(0);
 await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","record");
 const foreign=await mkdtemp(path.join(tmpdir(),"scoped-probe-foreign-"));dirs.push(foreign);
 await exec("git",["clone","--no-local",f.dir,foreign]);await exec("git",["update-ref","refs/remotes/origin/main",await f.git("rev-parse","origin/main")],{cwd:foreign});
 await mkdir(path.join(foreign,"docs/reports"),{recursive:true});await writeFile(path.join(foreign,"docs/reports/later.md"),"later narration");await exec("git",["add","."],{cwd:foreign});
 expect(await runCli(["verify"],{...f.runtime,cwd:foreign}),f.err.join("\n")).toBe(1);
},60000);
it.each(["mode", "link"])("portable verification recomputes declared %s metadata", async kind => {
  const { chmod, symlink, unlink, readdir } = await import("node:fs/promises");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  await writeFile(path.join(f.dir, "other.txt"), "source");
  await symlink("source.txt", path.join(f.dir, "bridge"));
  await symlink("bridge", path.join(f.dir, "alias"));
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, scope: { ...a.check!.scope!, files: ["alias"] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  if (kind === "mode") await chmod(path.join(f.dir, "source.txt"), 0o755);
  else { await unlink(path.join(f.dir, "bridge")); await symlink("other.txt", path.join(f.dir, "bridge")); }
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: "foreign-verifier", computeIdentity: withDeliverableIdentity() });
  expect(capture.ok).toBe(true); if (!capture.ok) throw new Error("capture failed");
  await expect(capturePortableVerificationInputs(f.dir, f.config, capture.candidate, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
}, 60000);

it("binds changed injected base context", async () => {
 const f=await fixture(); f.env["FAIL"]="0"; const old=await f.git("rev-parse","origin/main"); f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(p=>({...p,gitContext:"full"}))}}); const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:[process.execPath,"-e",`if(require('child_process').execFileSync('git',['rev-parse',process.env.DELIVERY_CHECK_BASE_REF],{encoding:'utf8'}).trim()!==${JSON.stringify(old)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
 const moved=await f.git("-c","commit.gpgsign=false","commit-tree",await f.git("rev-parse","origin/main^{tree}"),"-p",old,"-m","advance base");await f.git("update-ref","refs/heads/origin/main",moved);
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);
 expect(await f.run("gate"),f.err.join("\n")+f.out.join("\n")).toBe(1);
},60000);

it.each(["ref", "tipSha", "mergeBaseSha"] as const)("portable scoped identity binds selected base %s", async member => {
  const { readdir } = await import("node:fs/promises");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: "foreign-verifier", computeIdentity: withDeliverableIdentity() });
  expect(capture.ok).toBe(true); if (!capture.ok) throw new Error("capture failed");
  await expect(capturePortableVerificationInputs(f.dir, f.config, capture.candidate, record)).resolves.toBeDefined();
  const changed = { ...capture.candidate, base: { ...capture.candidate.base, [member]: member === "ref" ? "origin/other" : "f".repeat(40) } };
  await expect(capturePortableVerificationInputs(f.dir, f.config, changed, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
}, 60000);

it("full Git context binds original HEAD independently of source and base", async () => {
 const f=await fixture();f.env["FAIL"]="0"; const old=await f.git("rev-parse","HEAD"); const a=f.config.providers[0]!;
 f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(p=>({...p,gitContext:"full"}))},providers:[{...a,check:{...a.check!,command:[process.execPath,"-e",`if(process.env.DELIVERY_CHECK_ORIGIN_HEAD!==${JSON.stringify(old)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
 const tree=await f.git("rev-parse","HEAD^{tree}"); await f.git("-c","commit.gpgsign=false","commit","--allow-empty","-qm","advance HEAD only");expect(await f.git("rev-parse","HEAD^{tree}")).toBe(tree);
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.out.join("\n")+f.err.join("\n")).toBe(1);
},60000);
it("file-only checks cannot discover repository metadata or injected Git coordinates", async () => {
 const f=await fixture(); f.env["FAIL"]="0"; const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:[process.execPath,"-e","if(require('fs').existsSync('.git')||Object.keys(process.env).some(k=>k.startsWith('DELIVERY_CHECK_'))||require('child_process').spawnSync('git',['rev-parse','HEAD']).status===0)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
},60000);
it("full context verifies record-only transport but reruns on report changes", async () => {
 const f=await fixture(); f.env["FAIL"]="0";
 f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(({gitContext,...p})=>p)}});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("record"),f.err.join("\n")).toBe(0);
 await f.git("add",".");expect(await f.run("verify"),f.err.join("\n")).toBe(0);
 await f.git("-c","commit.gpgsign=false","commit","-qm","record");expect(await f.run("verify"),f.err.join("\n")).toBe(0);
 const foreign=await mkdtemp(path.join(tmpdir(),"scoped-full-foreign-"));dirs.push(foreign);
 await exec("git",["clone","--no-local",f.dir,foreign]);await exec("git",["update-ref","refs/remotes/origin/main",await f.git("rev-parse","origin/main")],{cwd:foreign});
 expect(await runCli(["verify"],{...f.runtime,cwd:foreign}),f.err.join("\n")).toBe(0);
 const transportHead=await f.git("rev-parse","HEAD");await f.git("-c","commit.gpgsign=false","commit","--allow-empty","-qm","arbitrary HEAD movement");
 expect(await f.run("verify"),f.err.join("\n")).toBe(1);expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
 await f.git("update-ref","HEAD",transportHead);
 await mkdir(path.join(f.dir,"docs/reports"),{recursive:true});await writeFile(path.join(f.dir,"docs/reports/new.md"),"report");await f.git("add",".");
 expect(await f.run("verify"),f.err.join("\n")).toBe(1);expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);expect(f.out.join("\n")).toContain("checking check.a");expect(f.out.join("\n")).not.toContain("reusing check.a");
},60000);
it("refuses an unknown Git context before expensive preparation", () => {
 const profile={id:"fixture",gitContext:"partial",dependencyInputs:[],mutableOutputs:[],credentialIdentities:{}};
 expect(()=>defineHarnessConfig({...base,scopedExecution:{version:"scoped-execution/1",mechanicalProviders:[],profiles:[profile]}} as unknown as HarnessConfigInput)).toThrow();
});

it("full Git context binds staged raw-tree changes with fixed HEAD and base", async()=>{
 const f=await fixture();f.env["FAIL"]="0";const old=await f.git("rev-parse","HEAD^{tree}");const head=await f.git("rev-parse","HEAD");const a=f.config.providers[0]!;
 f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(({gitContext,...p})=>p)},providers:[{...a,check:{...a.check!,command:[process.execPath,"-e",`if(process.env.DELIVERY_CHECK_ORIGIN_TREE!==${JSON.stringify(old)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
 await mkdir(path.join(f.dir,"docs/reports"),{recursive:true});await writeFile(path.join(f.dir,"docs/reports/new.md"),"report");await f.git("add",".");expect(await f.git("rev-parse","HEAD")).toBe(head);
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.out.join("\n")+f.err.join("\n")).toBe(1);
},60000);
it.each(["nonneutral","merge","bound"])("full-context transport rejects %s history",async(kind)=>{
 const f=await fixture();f.env["FAIL"]="0";f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(({gitContext,...p})=>p)}});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("record"),f.err.join("\n")).toBe(0);await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","record");expect(await f.run("verify"),f.err.join("\n")).toBe(0);
 const transport=await f.git("rev-parse","HEAD");const tree=await f.git("rev-parse","HEAD^{tree}");
 if(kind==="nonneutral"){
  await writeFile(path.join(f.dir,"source.txt"),"changed");await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","nonneutral");
  await writeFile(path.join(f.dir,"source.txt"),"source");await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","restore");
 }else if(kind==="merge"){
  const side=await f.git("-c","commit.gpgsign=false","commit-tree",tree,"-p",transport,"-m","side");
  const merge=await f.git("-c","commit.gpgsign=false","commit-tree",tree,"-p",transport,"-p",side,"-m","merge");await f.git("update-ref","HEAD",merge);
 }else{
  const bump=path.join(f.dir,"delivery/records/transport.txt");
  for(let i=0;i<63;i++){await writeFile(bump,String(i));await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm",`transport ${i}`);}
  expect(await f.run("verify"),f.err.join("\n")).toBe(0);
  await writeFile(bump,"64");await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","transport 64");
 }
 if(kind!=="bound")expect(await f.git("rev-parse","HEAD^{tree}")).toBe(tree);
 expect(await f.run("verify"),f.err.join("\n")).toBe(1);expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
},120000);

// Dynamic adopters derive the selection from immutable Git objects, then put
// this native snapshot guard first in the mandatory mechanical provider list.
it.each(["candidate", "base", "head", "guard", "merge-base"])("a mandatory snapshot selection guard rejects the %s derivation race before selected checks", async (race) => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const selected = { tree: await f.git("write-tree"), head: await f.git("rev-parse", "HEAD"), base: await f.git("rev-parse", "origin/main"), mergeBase: await f.git("merge-base", "HEAD", "origin/main") };
  Object.assign(f.env, { SELECTION_TREE: selected.tree, SELECTION_HEAD: selected.head, SELECTION_BASE: selected.base, SELECTION_MERGE_BASE: selected.mergeBase });
  const guard = {
    id: "check.selection", findingCodes: [], check: {
      command: [process.execPath, "-e", `const {execFileSync}=require('node:child_process');const expected={tree:process.env.SELECTION_TREE,head:process.env.SELECTION_HEAD,base:process.env.SELECTION_BASE,mergeBase:process.env.SELECTION_MERGE_BASE};const actual={tree:process.env.DELIVERY_CHECK_ORIGIN_TREE,head:process.env.DELIVERY_CHECK_ORIGIN_HEAD,base:execFileSync('git',['rev-parse',process.env.DELIVERY_CHECK_BASE_REF],{encoding:'utf8'}).trim(),mergeBase:process.env.DELIVERY_CHECK_MERGE_BASE};if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('selection_snapshot_mismatch');`],
      timeoutMs: 5000, scope: { version: "scoped-check/1", files: [], memberships: [], tests: [], cwd: ".", profile: "selection", environment: ["SELECTION_TREE", "SELECTION_HEAD", "SELECTION_BASE", "SELECTION_MERGE_BASE"].map(name => ({ name, kind: "flag" })) },
    },
  };
  f.setConfig({ ...f.config, providers: [guard, ...f.config.providers],
    obligations: [{ ...f.config.obligations[0]!, id: "selection.passed", providers: [guard.id] }, ...f.config.obligations],
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: [guard.id, "check.a"], profiles: [{ id: "selection", gitContext: "full", dependencyInputs: [], mutableOutputs: [], credentialIdentities: {} }, ...f.config.scopedExecution!.profiles] },
  } as unknown as HarnessConfigInput);
  // Clean positive control: the expected immutable objects are precisely the
  // captured snapshot, and downstream checks really execute.
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a");
  if (race === "candidate") await writeFile(path.join(f.dir, "new-consumer.ts"), "export const consumer = true;\n");
  if (race === "head") await f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "head advanced");
  if (race === "base") {
    const moved = await f.git("-c", "commit.gpgsign=false", "commit-tree", selected.tree, "-p", selected.base, "-m", "base advanced");
    await f.git("update-ref", "refs/heads/origin/main", moved);
  }
  if (race === "merge-base") f.env["SELECTION_MERGE_BASE"] = await f.git("-c", "commit.gpgsign=false", "commit-tree", selected.tree, "-p", selected.head, "-m", "different immutable selection merge base");
  if (race === "guard") f.setConfig({ ...f.config, providers: f.config.providers.map(p => p.id === guard.id ? { ...p, check: { ...p.check!, command: [process.execPath, "-e", "process.exit(1)"] } } : p) });
  // Bypassing preparation cannot reuse the old successful guard or receipt.
  expect(await f.run("gate")).toBe(1);
  expect(f.out.join("\n")).not.toContain("checking check.a");
  expect(await f.run("record")).toBe(1);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(1);
  expect(f.err.join("\n")).toContain("check_command_failed");
  expect(f.err.join("\n")).toContain("check.selection");
  expect(f.out.join("\n")).not.toContain("checking check.a");
  expect(await f.run("review-context")).toBe(1);
  expect(await f.run("gate")).toBe(1);
  expect(await f.run("record")).toBe(1);
}, 60000);

it("retains a typed failed terminal without outputs when post-command snapshot verification times out", async () => {
  const { readScopedCheckDiagnostics } = await import("./index.ts");
  const snapshots = await import("./check-snapshot.ts");
  const original = snapshots.createCheckSnapshot;
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, command: [p.check!.command[0], p.check!.command[1]!, `${p.check!.command[2]};console.log('raw-command-success')`] as [string,...string[]] } })) });
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await original(input); let calls = 0;
    return { ...snapshot, verify: async () => {
      if (++calls === 2) throw new snapshots.CheckSnapshotError("check_snapshot_timeout", "Snapshot deadline exceeded.");
      await snapshot.verify();
    } };
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_snapshot_timeout");
    const { resolveRecordStorage } = await import("@agent-delivery-harness/kernel");
    const { AttemptStore } = await import("./scoped-attempts.ts");
    const storage = await resolveRecordStorage(f.dir, { storageNamespace: f.config.storageNamespace, leaf: "scoped-attempts" });
    const { readdir } = await import("node:fs/promises");
    const rows = (await Promise.all((await readdir(storage.storageDir)).map(name => new AttemptStore(path.join(storage.storageDir,name)).read()))).flat();
    const failed = rows.filter(row => row.attempt.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some(row => row.payload?.log?.includes("raw-command-success"))).toBe(true);
    expect(failed.every(row => row.payload?.log?.includes("check_snapshot_timeout"))).toBe(true);
    expect(rows.some(row => row.attempt.status === "passed")).toBe(false);
    expect(failed.every(row => row.payload?.outputs.length === 0)).toBe(true);
    const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: failed.map(row => row.attempt.attemptId) });
    for (const attempt of diagnostics.providers.flatMap(p => p.attempts)) expect(attempt).toMatchObject({ status: "failed", diagnostic: { availability: "available", phase: "post-command-verification", failure: { code: "check_snapshot_timeout" }, command: { exitCode: 0, outputTail: expect.stringContaining("raw-command-success") } } });
  } finally { spy.mockRestore(); }
},30000);

it("exports bounded redacted diagnostics after a real failing command without changing observations", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.env["API_TOKEN"] = `SENTINEL-${"Q".repeat(6000)}-END`;
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "process.stdout.write('x'.repeat(5000)+process.env.API_TOKEN.slice(0,7));process.stderr.write(process.env.API_TOKEN+' assertion failed');process.exitCode=7"], scope: { ...a.check!.scope!, environment: [{ name: "API_TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1);
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const observations = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  expect(JSON.stringify(observations)).not.toMatch(/diagnostic|assertion failed|SENTINEL/);
  const attempt = observations.providers[0]!.attempts[0]!;
  const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: [attempt.attemptId] });
  const row = diagnostics.providers[0]!.attempts[0]!;
  expect(row).toMatchObject({ ...attempt, diagnostic: { availability: "available", phase: "command", failure: { code: "check_command_failed" }, command: { exitCode: 7, truncated: true } } });
  if (row.diagnostic.availability !== "available" || "unavailable" in row.diagnostic.command) throw Error("missing captured command");
  expect(row.diagnostic.command.outputTail).toHaveLength(4000);
  // stdout ends inside the credential, below the interrupted-prefix length, and stderr carries it whole:
  // only redacting each stream before the join keeps the prefix out of the diagnostic and the retained log.
  expect(row.diagnostic.command.outputTail).toMatch(/x\[REDACTED\]\n\[REDACTED\] assertion failed$/);
  expect(JSON.stringify(diagnostics)).not.toMatch(/SENTINE|QQQ|outputs|payload/);
  const { resolveRecordStorage } = await import("@agent-delivery-harness/kernel");
  const { AttemptStore } = await import("./scoped-attempts.ts");
  const storage = await resolveRecordStorage(f.dir, { storageNamespace: f.config.storageNamespace, leaf: "scoped-attempts" });
  const { readdir } = await import("node:fs/promises");
  const stored = (await Promise.all((await readdir(storage.storageDir)).map(name => new AttemptStore(path.join(storage.storageDir, name)).read()))).flat().find(r => r.attempt.attemptId === attempt.attemptId)!;
  expect(stored.payload?.log).toMatch(/x\[REDACTED\]\n\[REDACTED\] assertion failed\ncheck_command_failed$/);
  expect(JSON.stringify(stored.payload)).not.toMatch(/SENTINE|QQQ/);
  const passed = observations.providers[1]!.attempts[0]!;
  expect((await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: [passed.attemptId] })).providers[1]!.attempts[0]).toMatchObject({ status: "passed", diagnostic: { availability: "available", phase: "complete", failure: { unavailable: "not-failed" }, command: { exitCode: 0 } } });
}, 30000);

it.each(["typed", "unknown"])("retains a precommand %s failure without invented raw output", async kind => {
  const f = await fixture(); const snapshots = await import("./check-snapshot.ts");
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockRejectedValue(kind === "typed"
    ? new snapshots.CheckSnapshotError("check_snapshot_unavailable", "private exception message") : new Error("private exception message"));
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0); expect(await f.run("gate")).toBe(1);
    const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
    const observations = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    const ids = observations.providers.flatMap(p => p.attempts.map(a => a.attemptId)); expect(ids.length).toBeGreaterThan(0);
    const result = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: ids });
    for (const attempt of result.providers.flatMap(p => p.attempts)) expect(attempt).toMatchObject({ status: "failed", diagnostic: { availability: "available", phase: "snapshot-setup", failure: kind === "typed" ? { code: "check_snapshot_unavailable" } : { unavailable: "unclassified" }, command: { unavailable: "not-started" } } });
    expect(JSON.stringify(result)).not.toContain("private exception message");
  } finally { spy.mockRestore(); }
}, 30000);

it("retains first verification failure as pre-command-verification without a command result", async () => {
  const f = await fixture(); const snapshots = await import("./check-snapshot.ts");
  const original = snapshots.createCheckSnapshot;
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await original(input);
    return { ...snapshot, verify: async () => { throw new snapshots.CheckSnapshotError("check_snapshot_drift", "private verification details"); } };
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0); expect(await f.run("gate")).toBe(1);
    const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
    const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    const ids = observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)); expect(ids.length).toBeGreaterThan(0);
    const result = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: ids });
    for (const attempt of result.providers.flatMap(p => p.attempts)) expect(attempt).toMatchObject({ status: "failed", diagnostic: { availability: "available", phase: "pre-command-verification", failure: { code: "check_snapshot_drift" }, command: { unavailable: "not-started" } } });
    expect(JSON.stringify(result)).not.toContain("private verification details");
  } finally { spy.mockRestore(); }
}, 30000);

it("retains output-capture failure separately from successful command execution", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "console.log('capture-output-sentinel')"] } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0); expect(await f.run("gate")).toBe(1);
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const attempt = observed.providers[0]!.attempts[0]!;
  const result = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]).toMatchObject({ status: "failed", diagnostic: { availability: "available", phase: "output-capture", failure: { code: "check_output_missing" }, command: { exitCode: 0, outputTail: expect.stringContaining("capture-output-sentinel") } } });
}, 30000);

it.each(["stdout", "stderr"])("exports unavailable diagnostics for a real %s buffer overflow", async stream => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const secret = "CAPTURE_BOUNDARY_" + "0123456789".repeat(6) + "_END", prefix = secret.slice(0, -4);
  f.env["API_TOKEN"] = secret;
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", `require('fs').writeSync(${stream === "stdout" ? 1 : 2},'x'.repeat(${1024 * 1024 - prefix.length})+process.env.API_TOKEN+'z'.repeat(100));`], scope: { ...a.check!.scope!, environment: [{ name: "API_TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0); expect(await f.run("gate")).toBe(1);
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const attempt = observed.providers[0]!.attempts[0]!;
  const result = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]).toMatchObject({ status: "failed", diagnostic: { availability: "available", phase: "command", failure: { code: "check_command_failed", executionErrorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, command: { unavailable: "not-completed" } } });
  expect(JSON.stringify(result)).not.toContain(prefix);
}, 30000);

it("retains dependency failure diagnostics after cleanup without claiming the main command ran", async () => {
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const f = await fixture(); const secret = "dependency-credential-sentinel"; f.env["TOKEN"] = secret;
  const install = `console.log("DEPENDENCY_STAGE:install " + ${JSON.stringify(secret)});console.error("dependency stderr " + ${JSON.stringify(secret)});process.exit(7)`;
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, scope: { ...p.check!.scope!, environment: [...p.check!.scope!.environment, { name: "TOKEN", kind: "credential" }] } } })), scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, credentialIdentities: { TOKEN: "dependency-token/v1" },
    dependencies: { command: [process.execPath, "-e", install], timeoutMs: 5000 },
  })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(1);
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const ids = observed.providers.flatMap(p => p.attempts.map(a => a.attemptId));
  expect(ids).toHaveLength(2);
  const result = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: ids });
  for (const row of result.providers.flatMap(p => p.attempts)) {
    // "dependency" is the credential's first ten characters, interrupted by later output: masked as a possible clipped prefix.
    expect(row).toMatchObject({ status: "failed", diagnostic: { availability: "available", phase: "snapshot-setup",
      failure: { code: "check_dependency_failed" }, command: { unavailable: "not-started" },
      dependency: { durationMs: expect.any(Number), command: { exitCode: 7, outputTail: "DEPENDENCY_STAGE:install [REDACTED]\n\n[REDACTED] stderr [REDACTED]\n", truncated: false } },
    } });
  }
  expect(JSON.stringify(result)).not.toContain(secret);
  const out = f.out.join("\n");
  expect(out).not.toContain("checking check.");
  // The failure report names the install that ran, not the check that never started.
  const argv = `command (cwd .): ${process.execPath} -e ${JSON.stringify(install)}`;
  expect(out).toContain(argv);
  expect(out).toContain("exit 7");
  expect(out).toContain("    DEPENDENCY_STAGE:install [REDACTED]");
  // This fixture spells the sentinel into its own declared argv; the printed output tail stays redacted.
  expect(out.replaceAll(argv, "")).not.toContain(secret);
}, 30000);
it("does not attribute reused snapshot setup to a sibling check attempt", async () => {
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p,
    dependencies: { command: [process.execPath, "-e", "console.log('dependency setup executed once')"], timeoutMs: 5000 },
  })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const result = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)) });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toMatchObject({ dependency: { command: { exitCode: 0 } }, phase: "complete" });
  expect(result.providers[1]!.attempts[0]!.diagnostic).not.toHaveProperty("dependency");
}, 30000);

/** Three mechanical checks declared a, b, c whose profiles pa and pc share one dependency setup and pb has its own. */
async function sharedSetupFixture(commandFor: (id: string) => string) {
  const f = await fixture(); f.env["FAIL"] = "0";
  const logDir = await mkdtemp(path.join(tmpdir(), "scoped-installs-")); dirs.push(logDir);
  const log = path.join(logDir, "installs.log");
  const setup = (key: string) => ({ command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(log)},'${key}')`] as [string, ...string[]], timeoutMs: 5000 });
  const template = f.config.providers[0]!;
  const providers = ["a", "b", "c"].map(id => ({ ...template, id: `check.${id}`, check: { ...template.check!,
    command: [process.execPath, "-e", commandFor(id)] as [string, ...string[]],
    outputs: [`result-${id}.json`], scope: { ...template.check!.scope!, environment: [], profile: `p${id}` } } }));
  f.setConfig({ ...f.config, providers,
    obligations: providers.map(p => ({ ...f.config.obligations[0]!, id: `${p.id}.passed`, providers: [p.id] })),
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: providers.map(p => p.id),
      profiles: ["a", "b", "c"].map(id => ({ ...f.config.scopedExecution!.profiles[0]!, id: `p${id}`, mutableOutputs: [`result-${id}.json`], dependencies: setup(id === "b" ? "2" : "1") })) } });
  return { ...f, installs: () => readFile(log, "utf8") };
}
it("installs each shared dependency setup once per prepare and removes other profiles' outputs before a check", async () => {
  // Each check refuses to start beside any result file, so an output left by a sibling profile would fail it.
  const f = await sharedSetupFixture(id => `const fs=require('fs');if(fs.readdirSync('.').some(n=>n.startsWith('result-')))process.exit(4);fs.writeFileSync('result-${id}.json','{}')`);
  expect(await f.run("prepare"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect(await f.installs()).toBe("12");
  expect(f.out.join("\n").match(/checking check\.\w/g)).toEqual(["checking check.a", "checking check.c", "checking check.b"]);
}, 60000);
it("refuses a check that writes another profile's output in a shared snapshot", async () => {
  const f = await sharedSetupFixture(id => `const fs=require('fs');fs.writeFileSync('result-${id}.json','{}');${id === "a" ? "fs.writeFileSync('result-c.json','{}')" : ""}`);
  expect(await f.run("prepare")).toBe(1);
  expect(f.err.join("\n")).toContain("check_snapshot_drift");
  expect(f.out.join("\n")).not.toContain("checking check.c");
}, 60000);
it.each(["prepare", "gate"] as const)("%s prints a failed check's command, output tail and retained attempt", async command => {
  const f = await fixture();
  const b = f.config.providers[1]!;
  f.setConfig({ ...f.config, providers: [f.config.providers[0]!, { ...b, check: { ...b.check!, command: [process.execPath, "-e", "for(let i=0;i<100;i++)console.log('line-'+i);process.exit(3)"] } }],
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: command === "prepare" ? ["check.b"] : [] } });
  if (command === "gate") expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run(command)).toBe(1);
  const out = f.out.join("\n");
  expect(f.err.join("\n")).toContain("check_command_failed");
  expect(out).toContain(`command (cwd .): ${process.execPath} -e "for(let i=0;i<100;i++)console.log('line-'+i);process.exit(3)"`);
  expect(out).toContain("exit 3");
  expect(out).toContain("line-60"); expect(out).toContain("line-99"); expect(out).not.toContain("line-59");
  const retained = /failed check\.b: check_command_failed; attempt (\S+) retained at (\S+terminal\.json)/.exec(out);
  expect(retained, out).not.toBeNull();
  expect(JSON.parse(await readFile(retained![2]!, "utf8")).entry.attempt).toMatchObject({ attemptId: retained![1], providerId: "check.b", status: "failed" });
}, 60000);
it("prepare runs the first declared mechanical check first, the rest cheapest first by recorded duration, and stops at the first failure", async () => {
  const f = await fixture(); f.env["FAIL"] = "0"; f.env["TOKEN"] = "nonreusable-credential";
  const sleep = (ms: number) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms});`;
  const template = f.config.providers[0]!;
  // c is cheap when it passes and slow when it fails; b carries a credential without an identity, so it never reuses an attempt.
  const providers = [["a", 1500], ["b", 700], ["c", 0], ["d", 0]].map(([id, ms]) => ({ ...template, id: `check.${id}`, check: { ...template.check!,
    command: [process.execPath, "-e", `if('${id}'==='c'&&process.env.FAIL==='1'){${sleep(1500)}process.exit(3)}${sleep(ms as number)}require('fs').writeFileSync('result-${id}.json','{}')`] as [string, ...string[]],
    outputs: [`result-${id}.json`], scope: { ...template.check!.scope!, profile: id === "a" ? "pinned" : "installed",
      environment: [{ name: "FAIL", kind: "flag" as const }, ...id === "b" ? [{ name: "TOKEN", kind: "credential" as const }] : []] } } }));
  // Only the first check to run in "installed" pays its slow dependency setup, so b, c and d cost what their own commands take.
  const profile = f.config.scopedExecution!.profiles[0]!;
  f.setConfig({ ...f.config, providers,
    obligations: providers.map(p => ({ ...f.config.obligations[0]!, id: `${p.id}.passed`, providers: [p.id] })),
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a", "check.b", "check.c"],
      profiles: [{ ...profile, id: "pinned", mutableOutputs: ["result-a.json"] },
        { ...profile, id: "installed", mutableOutputs: ["result-b.json", "result-c.json", "result-d.json"], dependencies: { command: [process.execPath, "-e", sleep(1500)], timeoutMs: 5000 } }] } });
  const order = () => f.out.join("\n").match(/checking check\.\w/g);
  const change = async (text: string) => { await writeFile(path.join(f.dir, "source.txt"), text); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", text); };
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(order()).toEqual(["checking check.a", "checking check.b", "checking check.c"]); // Never timed: declaration order.
  await change("second");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(order()).toEqual(["checking check.a", "checking check.c", "checking check.b"]);
  // c set up the shared tree last time, so it is cheapest only once that setup is taken off; the newly declared d has never run.
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a", "check.b", "check.c", "check.d"] } });
  await change("third"); f.env["FAIL"] = "1";
  expect(await f.run("prepare")).toBe(1);
  expect(order()).toEqual(["checking check.a", "checking check.c"]);
  // c's slow failure is now its most recent cost; b's attempt fenced by the stopped run never finished, so b still
  // costs its last finished attempt; d stays behind every timed check.
  await change("fourth"); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(order()).toEqual(["checking check.a", "checking check.b", "checking check.c", "checking check.d"]);
}, 90000);
it("does not let an unreferenced profile sharing a setup remove tracked source", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "if(!require('fs').existsSync('source.txt'))process.exit(5);require('fs').writeFileSync('result-a.json','{}')"] } }],
    obligations: [f.config.obligations[0]!],
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"],
      profiles: [...f.config.scopedExecution!.profiles, { ...f.config.scopedExecution!.profiles[0]!, id: "unreferenced", mutableOutputs: ["source.txt"] }] } });
  expect(await f.run("prepare"), f.err.join("\n") + f.out.join("\n")).toBe(0);
}, 30000);
it("does not share a full-Git snapshot with a file-only profile of the same dependency setup", async () => {
  // Declared full first, so the full tree exists when the file-only check would otherwise borrow it.
  const f = await sharedSetupFixture(id => `const fs=require('fs');if('${id}'==='c'&&fs.existsSync('.git'))process.exit(6);fs.writeFileSync('result-${id}.json','{}')`);
  f.setConfig({ ...f.config, providers: f.config.providers.filter(p => p.id !== "check.b"), obligations: f.config.obligations.filter(o => !o.providers.includes("check.b")),
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a", "check.c"],
      profiles: f.config.scopedExecution!.profiles.filter(p => p.id !== "pb").map(p => ({ ...p, gitContext: p.id === "pa" ? "full" as const : "none" as const })) } });
  expect(await f.run("prepare"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect(await f.installs()).toBe("11");
}, 60000);

/** Checks c1..cN on their own profiles; profiles whose `keys` entry matches share one dependency setup, which logs its key. */
async function poolFixture(keys: readonly string[], concurrency: number | undefined, commandFor: (id: string, shared: string) => string, mechanical = false) {
  const f = await fixture(); f.env["FAIL"] = "0";
  const shared = await mkdtemp(path.join(tmpdir(), "scoped-pool-")); dirs.push(shared);
  const log = path.join(shared, "installs.log");
  const template = f.config.providers[0]!, profile = f.config.scopedExecution!.profiles[0]!;
  const providers = keys.map((_, i) => ({ ...template, id: `check.c${i + 1}`, check: { ...template.check!, timeoutMs: 30000,
    command: [process.execPath, "-e", `${commandFor(`c${i + 1}`, shared)};require('fs').writeFileSync('result-c${i + 1}.json','{}')`] as [string, ...string[]],
    outputs: [`result-c${i + 1}.json`], scope: { ...template.check!.scope!, environment: [], profile: `pc${i + 1}` } } }));
  f.setConfig({ ...f.config, providers,
    obligations: providers.map(p => ({ ...f.config.obligations[0]!, id: `${p.id}.passed`, providers: [p.id] })),
    scopedExecution: { ...f.config.scopedExecution!, ...(concurrency === undefined ? {} : { concurrency }), mechanicalProviders: mechanical ? providers.map(p => p.id) : [],
      profiles: keys.map((key, i) => ({ ...profile, id: `pc${i + 1}`, mutableOutputs: [`result-c${i + 1}.json`],
        dependencies: { command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(log)},'${key}')`] as [string, ...string[]], timeoutMs: 5000 } })) } });
  const installs = async (key: string) => [...await readFile(log, "utf8").catch(() => "")].filter(k => k === key).length;
  return { ...f, shared, installs };
}
/** Exits 7 unless `count` checks are inside this rendezvous at once; a serial run can never get there. */
const barrier = (shared: string, count: number) => `const fs=require('fs'),d=${JSON.stringify(path.join(shared, "arrived"))};fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/'+process.pid,'');` +
  `const end=Date.now()+10000;while(fs.readdirSync(d).length<${count}){if(Date.now()>end)process.exit(7);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}`;
const normalized = (f: { dir: string; shared: string }, text: string) => text.replaceAll(f.dir, "<dir>").replaceAll(f.shared, "<shared>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d+ms/g, "<ms>");
it("accepts only a positive integer scoped concurrency", () => {
  const profile = { id: "fixture", dependencyInputs: [], mutableOutputs: [], credentialIdentities: {} };
  const define = (concurrency: unknown) => defineHarnessConfig({ ...base, scopedExecution: { version: "scoped-execution/1", mechanicalProviders: [], profiles: [profile], concurrency } } as unknown as HarnessConfigInput);
  for (const invalid of [0, -1, 1.5, "2", null]) expect(() => define(invalid)).toThrow();
  expect(define(4).scopedExecution?.concurrency).toBe(4);
});
it("gate overlaps independent checks and installs each setup at most once per worker", async () => {
  // Two workers; setup "1" has four checks and setup "2" one, so they install at most min(2, 4) and min(2, 1) times.
  const f = await poolFixture(["1", "1", "1", "1", "2"], 2, (_, shared) => barrier(shared, 2));
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect(f.out.join("\n").match(/passed check\.c\d/g)?.sort()).toEqual(["passed check.c1", "passed check.c2", "passed check.c3", "passed check.c4", "passed check.c5"]);
  expect(await f.installs("1")).toBeLessThanOrEqual(2);
  expect(await f.installs("2")).toBe(1);
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
}, 90000);
it("prepare finishes the first declared mechanical check before overlapping the rest", async () => {
  const f = await poolFixture(["1", "1", "1", "1"], 3, (id, shared) => id === "c1"
    ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);require('fs').writeFileSync(${JSON.stringify(path.join(shared, "guard"))},'')`
    : `if(!require('fs').existsSync(${JSON.stringify(path.join(shared, "guard"))}))process.exit(8);${barrier(shared, 3)}`, true);
  expect(await f.run("prepare"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect(f.out.join("\n").match(/checking check\.c\d/)?.[0]).toBe("checking check.c1");
  expect(await f.installs("1")).toBeLessThanOrEqual(3);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
}, 90000);
it("concurrency 1 keeps serial output and one live snapshot exactly as when unset", async () => {
  const runs: { out: string[]; setups: number }[] = [];
  for (const concurrency of [undefined, 1]) {
    const f = await poolFixture(["1", "2", "1", "2"], concurrency, () => "");
    const snapshots = await import("./check-snapshot.ts"), original = snapshots.createCheckSnapshot;
    const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(input => original(input));
    try {
      expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
      expect(await f.run("gate"), f.err.join("\n")).toBe(0);
      runs.push({ out: f.out.map(line => normalized(f, line)), setups: spy.mock.calls.length });
    } finally { spy.mockRestore(); }
  }
  expect(runs[0]!.setups).toBe(4); // The serial path alternates setups and keeps only one live.
  expect(runs[1]).toEqual(runs[0]);
}, 90000);
it("failures, diagnostics, retained attempts, reuse and evidence under concurrency match serial", async () => {
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const runs: unknown[] = [];
  for (const concurrency of [1, 3]) {
    // c1 is slow, so a pool finishes c2's failure and c3 while c1 still runs.
    // c2 fails while a marker outside the tree exists, so fixing it changes no check input.
    const f = await poolFixture(["1", "1", "1"], concurrency, (id, shared) => id === "c1" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)"
      : id === "c2" ? `if(require('fs').existsSync(${JSON.stringify(path.join(shared, "fail"))})){console.log('c2 broke');process.exit(3)}` : "");
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    await writeFile(path.join(f.shared, "fail"), "");
    expect(await f.run("gate")).toBe(1);
    // Each check's lines arrive together: nothing else is printed between a check starting and its result.
    const out = f.out.map(line => normalized(f, line));
    for (const [index, line] of out.entries()) if (line.startsWith("checking ")) expect(out[index + 1], out.join("\n")).toMatch(new RegExp(`^(passed|failed) ${line.split(" ")[1]!.replace(":", "")}:`));
    const failedGate = { out: [...out].sort(), err: f.err.map(line => normalized(f, line)) };
    const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)) });
    const attempts = diagnostics.providers.map(p => ({ providerId: p.providerId, attempts: p.attempts.map(a => ({ status: a.status, generation: a.generation,
      diagnostic: a.diagnostic.availability === "available" ? { phase: a.diagnostic.phase, failure: a.diagnostic.failure, dependency: a.diagnostic.dependency !== undefined,
        command: "unavailable" in a.diagnostic.command ? a.diagnostic.command : { exitCode: a.diagnostic.command.exitCode, outputTail: a.diagnostic.command.outputTail } } : a.diagnostic })) }));
    await rm(path.join(f.shared, "fail"));
    expect(await f.run("gate"), f.err.join("\n")).toBe(0);
    const passedGate = f.out.map(line => normalized(f, line)).sort();
    expect(await f.run("record"), f.err.join("\n")).toBe(0);
    await f.git("add", ".");
    expect(await f.run("verify"), f.err.join("\n")).toBe(0);
    runs.push({ failedGate, attempts: attempts.map(p => ({ ...p, attempts: p.attempts.map(a => ({ ...a, diagnostic: { ...a.diagnostic, dependency: undefined } })) })), passedGate });
  }
  expect(runs[1]).toEqual(runs[0]);
  expect(JSON.stringify(runs[0])).toContain("reusing check.c1: matching inputs/profile");
  expect(JSON.stringify(runs[0])).toContain("c2 broke");
}, 120000);
it("an abort stops every worker and cleans up every pooled snapshot", async () => {
  // c1 holds the first worker; the second passes c2, keeps its idle setup-2 snapshot, and holds c3.
  const f = await poolFixture(["1", "2", "3"], 2, (id, shared) => id === "c2" ? "" : `require('fs').writeFileSync(${JSON.stringify(shared)}+'/started-${id}','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)`);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const snapshots = await import("./check-snapshot.ts"), original = snapshots.createCheckSnapshot, roots: string[] = [];
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => { const snapshot = await original(input); roots.push(snapshot.rootDir); return snapshot; });
  const { access, readdir } = await import("node:fs/promises");
  try {
    const controller = new AbortController();
    const gate = runCli(["gate"], { ...f.runtime, signal: controller.signal });
    for (const end = Date.now() + 20000; (await readdir(f.shared)).filter(n => n.startsWith("started-")).length < 2;) {
      if (Date.now() > end) throw new Error("checks never started together");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort();
    expect(await gate).toBe(130);
    expect(roots).toHaveLength(3);
    for (const root of roots) await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    const { readScopedCheckObservations } = await import("./index.ts");
    const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    expect(observed.providers.map(p => p.attempts.at(-1)?.status)).toEqual(["interrupted", "passed", "interrupted"]);
  } finally { spy.mockRestore(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
}, 60000);
it("records an unscoped declared check's evidence during gate alongside scoped providers", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const plain = { id: "check.plain", findingCodes: [], check: { command: [process.execPath, "-e", ""] as [string, ...string[]], timeoutMs: 5000 } };
  f.setConfig({ ...f.config, providers: [...f.config.providers, plain],
    obligations: [...f.config.obligations, { ...f.config.obligations[0]!, id: "check.plain.passed", providers: [plain.id] }] } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.plain");
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
}, 30000);

it("record-neutral refresh and record reuse full-Git checks and repairs", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const repairCounter = path.join(f.dir, ".git", "repair-count");
  f.setConfig({ ...f.config, recordNeutral: [...f.config.recordNeutral, { prefix: "telemetry/delivery-runs/" }], scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"],
    profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "full" })),
    repairCommands: [{ id: "repair", command: [process.execPath, "-e", `const fs=require('fs');fs.appendFileSync(${JSON.stringify(repairCounter)},'x')`], timeoutMs: 5000 }] } });
  const { readScopedCheckObservations } = await import("./scoped-observations.ts");
  const attempts = async () => (await readScopedCheckObservations({ rootDir: f.dir, config: f.config })).providers.map(p => p.attempts.length);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(await attempts()).toEqual([1, 1]);
  await mkdir(path.join(f.dir, "telemetry/delivery-runs"), { recursive: true });
  await writeFile(path.join(f.dir, "telemetry/delivery-runs/neutral.json"), "{}"); await f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(await readFile(repairCounter, "utf8")).toBe("x");
  expect(await attempts()).toEqual([1, 1]);
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  expect(await attempts()).toEqual([1, 1]);
  await f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  expect(await attempts()).toEqual([1, 1]);
  expect(await readFile(repairCounter, "utf8")).toBe("x");
}, 30000);

it.each(["files", "membership", "both", "mixed"])("verifies its own staged record when dynamic scopes enumerate %s", async mode => {
  const f = await fixture(); f.env["FAIL"] = "0";
  if (mode === "mixed") {
    const plain = { id: "check.plain", findingCodes: [], check: { command: [process.execPath, "-e", ""] as [string, ...string[]], timeoutMs: 5000 } };
    f.setConfig({ ...f.config, providers: [...f.config.providers, plain],
      obligations: [...f.config.obligations, { ...f.config.obligations[0]!, id: "check.plain.passed", providers: [plain.id] }],
    });
  }
  const { readScopedCheckObservations } = await import("./scoped-observations.ts");
  const sibling = `${path.posix.dirname(f.config.deliveryRecordPath)}/record--${"f".repeat(64)}.json`;
  await mkdir(path.dirname(path.join(f.dir, sibling)), { recursive: true });
  await writeFile(path.join(f.dir, sibling), "validated artifact");
  await f.git("add", ".");
  const refreshDefinition = async () => {
    const inventory = (await f.git("ls-files")).split("\n");
    f.setConfig({ ...f.config,
      providers: f.config.providers.map(p => !p.check?.scope ? p : ({ ...p, check: { ...p.check!, scope: { ...p.check!.scope!,
        files: mode === "membership" ? ["source.txt"] : inventory,
        memberships: mode === "files" ? [] : [`${path.posix.dirname(f.config.deliveryRecordPath)}/`],
      } } })),
      scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"],
        profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "full" })),
      },
    });
  };
  const attempts = async () => (await readScopedCheckObservations({ rootDir: f.dir, config: f.config })).providers.map(p => p.attempts.length);
  await refreshDefinition();
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(await attempts()).toEqual([1, 1]);
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  await f.git("add", ".");
  await refreshDefinition();
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("reusing preparation checks");
  expect(await attempts()).toEqual([1, 1]);
  if (mode === "both") {
    const ownRecord = (await f.git("ls-files", path.posix.dirname(f.config.deliveryRecordPath))).split("\n").find(file => file !== sibling)!;
    const original = await readFile(path.join(f.dir, ownRecord), "utf8");
    await writeFile(path.join(f.dir, ownRecord), JSON.stringify({ ...JSON.parse(original), integrityDigest: "0".repeat(64) }));
    await f.git("add", ".");
    expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
    expect(f.out.join("\n")).toContain("reusing preparation checks");
    expect(await f.run("verify")).toBe(1);
    expect(f.err.join("\n")).toContain("portable_record_integrity");
    await writeFile(path.join(f.dir, ownRecord), original); await f.git("add", ".");
    expect(await f.run("verify"), f.err.join("\n")).toBe(0);
    expect(await attempts()).toEqual([1, 1]);
  }
  await writeFile(path.join(f.dir, sibling), "tampered artifact"); await f.git("add", ".");
  expect(await f.run("verify")).toBe(1);
  expect(f.err.join("\n")).toContain("Provider check.a: inputDigest");
  await writeFile(path.join(f.dir, sibling), "validated artifact"); await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!,
    profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "none" })),
  } });
  expect(await f.run("verify")).toBe(1);
  expect(f.err.join("\n")).toContain("Provider check.a: inputDigest, profileDigest");
}, 30000);

it.each(["source", "base", "wiring", "release"])("record-neutral refresh invalidates %s movement", async kind => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const repairCounter = path.join(f.dir, ".git", "repair-count");
  f.setConfig({ ...f.config, recordNeutral: [...f.config.recordNeutral, { prefix: "telemetry/delivery-runs/" }], scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"],
    profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "full" })),
    repairCommands: [{ id: "repair", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(repairCounter)},'x')`], timeoutMs: 5000 }] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  if (kind === "source") await writeFile(path.join(f.dir, "source.txt"), "changed");
  if (kind === "wiring") await writeFile(path.join(f.dir, "harness.config.ts"), "// changed wiring\nexport default {};\n");
  if (kind === "release") {
    await mkdir(path.join(f.dir, ".agent-skills"), { recursive: true });
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), JSON.stringify({ release: { releaseId: "changed", profile: "core", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) } }));
  }
  if (kind === "base") {
    await f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "new base");
    await f.git("branch", "-f", "origin/main", "HEAD");
  }
  await f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(await readFile(repairCounter, "utf8")).toBe("xx");
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  const { readScopedCheckObservations } = await import("./scoped-observations.ts");
  expect((await readScopedCheckObservations({ rootDir: f.dir, config: f.config })).providers.map(p => p.attempts.length)).toEqual([2, 2]);
}, 30000);

it("failed full-Git check retry after neutral staging stays verifiable", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const failOnce = path.join(f.dir, ".git", "fail-once");
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config,
    recordNeutral: [...f.config.recordNeutral, { prefix: "telemetry/delivery-runs/" }],
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "full" })) },
    providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(failOnce)})){fs.writeFileSync(${JSON.stringify(failOnce)},'x');process.exit(3)};fs.writeFileSync('result-a.json','{}')`] } }, f.config.providers[1]!],
  });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.out.join("\n")+f.err.join("\n")).toBe(1);
  await mkdir(path.join(f.dir, "telemetry/delivery-runs"), { recursive: true });
  await writeFile(path.join(f.dir, "telemetry/delivery-runs/neutral.json"), "{}"); await f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.out.join("\n")+f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.out.join("\n")+f.err.join("\n")).toBe(0);
  await f.git("add", ".");
  expect(await f.run("verify"), f.out.join("\n")+f.err.join("\n")).toBe(0);
}, 30000);

it("current full-Git failed attempt fences older neutral-tree success", async () => {
  const { AttemptStore } = await import("./scoped-attempts.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  const initialTree = await f.git("write-tree");
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, recordNeutral: [...f.config.recordNeutral, { prefix: "telemetry/delivery-runs/" }],
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "full" })) },
    providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", `if(process.env.DELIVERY_CHECK_ORIGIN_TREE!==${JSON.stringify(initialTree)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`] } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  await mkdir(path.join(f.dir, "telemetry/delivery-runs"), { recursive: true });
  await writeFile(path.join(f.dir, "telemetry/delivery-runs/neutral.json"), "{}"); await f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  // Retain an independently executed attempt on the current raw tree. Hide the
  // older history only while that invocation chooses its execution identity.
  const read = AttemptStore.prototype.read;
  const spy = vi.spyOn(AttemptStore.prototype, "read").mockImplementation(async function(this: import("./scoped-attempts.ts").AttemptStore) {
    return (await read.call(this)).filter(row => row.attempt.origin.candidate.treeSha !== initialTree);
  });
  try {
    expect(await f.run("gate"), f.out.join("\n") + f.err.join("\n")).toBe(1);
    expect(f.out.join("\n")).toContain("checking check.a");
  } finally { spy.mockRestore(); }
  expect(await f.run("gate"), f.out.join("\n") + f.err.join("\n")).toBe(1);
  expect(f.out.join("\n")).toContain("checking check.a");
  expect(f.out.join("\n")).not.toContain("reusing check.a");
}, 30000);

it("portable origin-tree transport rejects undeclared nonneutral drift", async () => {
  const { readdir } = await import("node:fs/promises");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, recordNeutral: [...f.config.recordNeutral, { prefix: "telemetry/delivery-runs/" }],
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, gitContext: "full" })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  await mkdir(path.join(f.dir, "telemetry/delivery-runs"), { recursive: true });
  await writeFile(path.join(f.dir, "telemetry/delivery-runs/neutral.json"), "{}"); await f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = async () => {
    const value = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: record.candidateBinding.workspaceId, computeIdentity: withDeliverableIdentity() });
    if (!value.ok) throw new Error("capture failed");
    return value.candidate;
  };
  await expect(capturePortableVerificationInputs(f.dir, f.config, await capture(), record)).resolves.toBeDefined();
  await mkdir(path.join(f.dir, "docs/reports"), { recursive: true });
  await writeFile(path.join(f.dir, "docs/reports/not-record-neutral.md"), "unvalidated raw-tree change"); await f.git("add", ".");
  const changed = await capture();
  // A record claiming this newer tree must still independently prove the tree
  // of its historical full-Git attempt. Declared source files have not changed.
  record.candidateBinding.treeSha = changed.treeSha;
  await expect(capturePortableVerificationInputs(f.dir, f.config, changed, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
}, 30000);
