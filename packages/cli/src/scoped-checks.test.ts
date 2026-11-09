import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createArtifactsPort, defineHarnessConfig, type HarnessConfigInput } from "@agent-delivery-harness/kernel";
import base from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
const exec = promisify(execFile), dirs: string[] = [];
/** With `kill`, each detached tree deletion is killed as it starts, as a machine stopping mid-deletion would. */
const deletion = vi.hoisted(() => ({ kill: false, killed: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (deletion.kill && args[0] === "/bin/rm") { child.kill("SIGKILL"); deletion.killed++; }
    return child;
  } };
});
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
it.each([1,2])("finite physical source separates same-setup envelopes and private outputs at concurrency %s",async concurrency=>{
  const f=await fixture();f.env['FAIL']='0';
  await writeFile(path.join(f.dir,'a.txt'),'alpha');await writeFile(path.join(f.dir,'b.txt'),'beta');
  await f.git('add','.');await f.git('-c','commit.gpgsign=false','commit','-qm','two finite sources');
  const providers=f.config.providers.map((provider,index)=>{
    const own=index===0?'a.txt':'b.txt',other=index===0?'b.txt':'a.txt',output=`result-${index===0?'a':'b'}.json`;
    return {...provider,check:{...provider.check!,physicalSource:{version:'physical-source/1' as const,files:[own],absentInputs:['startup.cjs']},
      command:[process.execPath,'-e',`const fs=require('fs');if(fs.existsSync(${JSON.stringify(other)})||fs.existsSync('source.txt')||fs.existsSync('.git'))throw Error('wrong shared projection');fs.writeFileSync(${JSON.stringify(output)},fs.readFileSync(${JSON.stringify(own)}));`] as [string,...string[]],
      scope:{...provider.check!.scope!,files:[own]}}};
  });
  f.setConfig({...f.config,providers,scopedExecution:{...f.config.scopedExecution!,concurrency,mechanicalProviders:['check.a','check.b']}});
  const snapshots=await import('./check-snapshot.ts'),create=snapshots.createCheckSnapshot,roots:string[]=[];
  const observer=vi.spyOn(snapshots,'createCheckSnapshot').mockImplementation(async input=>{const snapshot=await create(input);roots.push(snapshot.rootDir);return snapshot;});
  try{
    expect(await f.run('prepare'),f.err.join('\n')).toBe(0);
    expect(roots).toHaveLength(2);expect(new Set(roots).size).toBe(2);
    expect(await f.run('gate'),f.err.join('\n')).toBe(0);
    expect(await f.run('record'),f.err.join('\n')).toBe(0);
    expect(await f.run('verify'),f.err.join('\n')).toBe(0);
  }finally{observer.mockRestore();}
},60000);
// Runs at about the 5 s default on its own; bun runners have timed it out.
it.each([1, 2])("forwards existing snapshot phase timings with the active check and attempt at concurrency %s", async concurrency => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, concurrency, mechanicalProviders: ["check.a", "check.b"], profiles: f.config.scopedExecution!.profiles.map(profile => ({ ...profile,
    dependencies: { command: [process.execPath, "-e", "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/fixture','dependency')"], timeoutMs: 5000 },
  })) } });
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  const observations: { phase: string; durationMs: number }[] = [];
  const tee = <P extends string>(forward?: (phase: P, durationMs: number) => void) => (phase: P, durationMs: number) => { observations.push({ phase, durationMs: Math.round(durationMs) }); forward?.(phase, durationMs); };
  // A clone reports its own phases (clone, verification) to the worker that took it.
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await create({ ...input, onPhase: tee(input.onPhase) });
    return { ...snapshot, clone: (method, onPhase) => snapshot.clone(method, tee(onPhase)) };
  });
  const cloned = concurrency > 1 && await snapshots.snapshotCloneMethod() !== undefined;
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const lines = f.out.flatMap(line => line.split("\n"));
    const timings = lines.filter(line => line.startsWith("snapshot check."));
    const parsed = timings.map(line => /^snapshot (check\.[ab]): attempt ([^;]+); ([a-z-]+) (\d+)ms$/.exec(line));
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every(match => match !== null)).toBe(true);
    // With cloning the setup runs once, ahead of the checks, and no attempt owns it: its phases are prewarm lines.
    const prewarm = lines.filter(line => line.startsWith("prewarm ")).map(line => /^prewarm (fixture): ([a-z-]+) (\d+)ms$/.exec(line));
    expect(prewarm.every(match => match !== null)).toBe(true);
    // The wait for a settled base is the worker's own observation, not the snapshot's; a clone's line also counts its queue.
    const shown = [...parsed.filter(match => match![3] !== "warm-base-wait").map(match => ({ phase: match![3]!, durationMs: Number(match![4]) })),
      ...prewarm.map(match => ({ phase: match![2]!, durationMs: Number(match![3]) }))];
    const sorted = (rows: readonly { phase: string; durationMs: number }[]) => [...rows].sort((a, b) => a.phase.localeCompare(b.phase) || a.durationMs - b.durationMs);
    expect(sorted(shown).map(row => row.phase)).toEqual(sorted(observations).map(row => row.phase));
    for (const [index, row] of sorted(shown).entries()) {
      const observed = sorted(observations)[index]!;
      if (row.phase === "clone") expect(row.durationMs).toBeGreaterThanOrEqual(observed.durationMs);
      else expect(row.durationMs).toBe(observed.durationMs);
    }
    expect([...new Set(parsed.map(match => match![3]))].filter(phase => phase !== "warm-base-wait").sort()).toEqual(cloned ? ["clone", "verification"] : ["baseline-inventory", "dependencies", "materialization", "post-dependency-inventory", "verification"]);
    expect([...new Set(prewarm.map(match => match![2]))].sort()).toEqual(cloned ? ["baseline-inventory", "dependencies", "materialization", "post-dependency-inventory"] : []);
    if (!cloned) expect(parsed.map(match => match![3])).not.toContain("warm-base-wait");
    const { readScopedCheckObservations } = await import("./index.ts");
    const recorded = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    for (const provider of recorded.providers) {
      const own = parsed.filter(match => match![1] === provider.providerId);
      expect(own.filter(match => match![3] === "verification")).toHaveLength(2);
      expect([...new Set(own.map(match => match![2]))]).toEqual([provider.attempts[0]!.attemptId]);
    }
  } finally { spy.mockRestore(); }
}, 30000);
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
// Zero mechanical preparation defers source identity to the gate (V26-2347),
// so the oversized receipt is refused at prepare only when the check is mechanical.
it.each([true, false])("keeps valid workflow release receipts bounded separately from scoped source inputs (mechanical: %s)", async mechanical => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: mechanical ? ["check.a"] : [] } });
  await mkdir(path.join(f.dir, ".agent-skills"), { recursive: true });
  const release = { releaseId: "test-release", profile: "linear", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) };
  const receipt = path.join(f.dir, ".agent-skills/active.json");
  await writeFile(receipt, JSON.stringify({ release }));
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  await writeFile(receipt, JSON.stringify({ release, padding: "x".repeat(2 * 1024 * 1024) }));
  if (mechanical) expect(await f.run("prepare"), f.err.join("\n")).toBe(1);
  else { expect(await f.run("prepare"), f.err.join("\n")).toBe(0); expect(await f.run("gate"), f.err.join("\n")).toBe(1); }
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
// Zero mechanical preparation defers runtime identities to the gate (V26-2347),
// so the refusal lands in prepare only when the check is mechanical.
it.each([['check', true], ['dependencies', true], ['check', false], ['dependencies', false]] as const)('rejects an absolute authoring executable in %s before setup (mechanical: %s)', async (kind, mechanical) => {
 const f=await fixture(); const script=path.join(f.dir,'check.cjs'); await writeFile(script,`#!${process.execPath}\nprocess.exit(7);\n`);
 const a=f.config.providers[0]!;
 const scopedExecution={...f.config.scopedExecution!,mechanicalProviders:mechanical?['check.a']:[]};
 f.setConfig(kind==='check' ? {...f.config,scopedExecution,providers:[{...a,check:{...a.check!,command:[script]}},f.config.providers[1]!]} : {...f.config,scopedExecution:{...scopedExecution,profiles:[{...scopedExecution.profiles[0]!,dependencies:{command:[script],timeoutMs:5000}}]}});
 const snapshots=await import('./check-snapshot.ts'),created=vi.spyOn(snapshots,'createCheckSnapshot');
 try {
  if (mechanical) expect(await f.run('prepare')).toBe(1);
  else { expect(await f.run('prepare'),f.err.join('\n')).toBe(0); expect(await f.run('gate')).toBe(1); }
  expect(f.err.join('\n')).toContain('check_runtime_author_path');
  expect(created).not.toHaveBeenCalled();
 } finally { created.mockRestore(); }
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
// Runs about 185 git and node subprocesses in series, so its time follows host spawn latency: 3.6 to 4.8 s on an
// idle machine, 5.0 to 5.2 s on loaded CI runners and up to about 8 s on a loaded laptop, past the 5 s default.
it("captures explicit repairs before validators and scoped mechanics", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, obligations: f.config.obligations.slice(0, 1), providers: f.config.providers.slice(0, 1), scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"], repairCommands: [{ id: "repair-source", command: [process.execPath, "-e", "require('fs').writeFileSync('source.txt','repaired')"], timeoutMs: 5000 }] }, preparationCommands: [{ id: "validate-source", command: [process.execPath, "-e", "if(require('fs').readFileSync('source.txt','utf8')!=='repaired')process.exit(1)"], timeoutMs: 5000 }] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a");
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
}, 30000);
// Runs at about the 5 s default on its own; bun runners have timed it out.
it("cannot accept output precreated by dependency setup", async () => {
  const f = await fixture(); const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, obligations: f.config.obligations.slice(0, 1), providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", ""] } }], scopedExecution: { ...f.config.scopedExecution!, profiles: [{ ...f.config.scopedExecution!.profiles[0]!, dependencies: { command: [process.execPath, "-e", "require('fs').writeFileSync('result-a.json','{}')"], timeoutMs: 5000 } }] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1); expect(f.err.join("\n")).toContain("check_output_missing");
}, 30000);
it.each(["src", "src/"])("refuses output ancestor %s", async output => {
  const f = await fixture(); await mkdir(path.join(f.dir, "src")); await writeFile(path.join(f.dir, "src/file"), "source");
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: [{ ...f.config.scopedExecution!.profiles[0]!, mutableOutputs: [output, "result-a.json", "result-b.json"] }] } });
  expect(await f.run("prepare")).toBe(1); expect(f.err.join("\n")).toContain("check_output_overlaps_source");
});
// Runs about 185 git and node subprocesses in series, so its time follows host spawn latency: 3.6 to 4.8 s on an
// idle machine, 5.0 to 5.2 s on loaded CI runners and up to about 8 s on a loaded laptop, past the 5 s default.
it("injects declared flags and credentials while excluding an explicitly supplied undeclared variable", async () => {
  const f = await fixture(); f.env["FLAG"] = "yes"; f.env["TOKEN"] = "secret-sentinel"; f.env["UNDECLARED"] = "must-not-reach-command"; f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, obligations: f.config.obligations.slice(0, 1), providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "if(process.env.FLAG!=='yes'||process.env.TOKEN!=='secret-sentinel'||process.env.UNDECLARED!==undefined)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"], scope: { ...a.check!.scope!, environment: [{ name: "FLAG", kind: "flag" }, { name: "TOKEN", kind: "credential" }] } } }] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
}, 30000);
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
  // A live view of the config, so each setConfig builds on the one before.
  return { ...f, get config() { return f.config; }, shared, installs };
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
it("simultaneous workers phase attribution", async () => {
 const f = await poolFixture(["1", "1"], 2, (_id, shared) => barrier(shared, 2));
 expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
 expect(await f.run("gate"), f.err.join("\n")).toBe(0);
 const {readScopedCheckObservations} = await import("./index.ts");
 const recorded = await readScopedCheckObservations({rootDir:f.dir,config:f.config});
 const lines=f.out.flatMap(line=>line.split("\n"));
 for (const provider of recorded.providers) {
   const own=lines.filter(line=>line.startsWith(`snapshot ${provider.providerId}:`)&&line.includes("; verification "));
   expect(own,lines.join("\n")).toHaveLength(2);
   for(const line of own) expect(line).toContain(`attempt ${provider.attempts[0]!.attemptId};`);
 }
},30000);

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
    // A check's phase observations stay in its group until its result, with no other check interleaved.
    const lines = f.out.flatMap(line => line.trimEnd().split("\n"));
    for (const [index, line] of lines.entries()) if (line.startsWith("checking ")) {
      const provider = line.split(" ")[1]!.replace(":", "");
      let next = index + 1;
      while (lines[next]?.startsWith("snapshot ")) {
        expect(lines[next], lines.join("\n")).toMatch(new RegExp(`^snapshot ${provider}: attempt [^;]+; verification \\d+ms$`));
        next++;
      }
      expect(lines[next], lines.join("\n")).toMatch(new RegExp(`^(passed|failed) ${provider}:`));
    }
    // Setup counts differ with worker reuse; phase values are checked by the dedicated forwarding rows.
    // So do how each check got its tree and what that cost, and a pool's prewarm; the dedicated setup rows pin those.
    const setupLine = (line: string) => line.startsWith("snapshot ") || line.startsWith("setup ") || line.startsWith("prewarm ");
    const out = f.out.filter(line => !setupLine(line)).map(line => normalized(f, line));
    const failedGate = { out: [...out].sort(), err: f.err.map(line => normalized(f, line)) };
    const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)) });
    const attempts = diagnostics.providers.map(p => ({ providerId: p.providerId, attempts: p.attempts.map(a => ({ status: a.status, generation: a.generation,
      diagnostic: a.diagnostic.availability === "available" ? { phase: a.diagnostic.phase, failure: a.diagnostic.failure, dependency: a.diagnostic.dependency !== undefined,
        command: "unavailable" in a.diagnostic.command ? a.diagnostic.command : { exitCode: a.diagnostic.command.exitCode, outputTail: a.diagnostic.command.outputTail } } : a.diagnostic })) }));
    await rm(path.join(f.shared, "fail"));
    expect(await f.run("gate"), f.err.join("\n")).toBe(0);
    const passedGate = f.out.filter(line => !setupLine(line)).map(line => normalized(f, line)).sort();
    expect(await f.run("record"), f.err.join("\n")).toBe(0);
    await f.git("add", ".");
    expect(await f.run("verify"), f.err.join("\n")).toBe(0);
    runs.push({ failedGate, attempts: attempts.map(p => ({ ...p, attempts: p.attempts.map(a => ({ ...a, diagnostic: { ...a.diagnostic, dependency: undefined } })) })), passedGate });
  }
  expect(runs[1]).toEqual(runs[0]);
  expect(JSON.stringify(runs[0])).toContain("reusing check.c1: matching inputs/profile");
  expect(JSON.stringify(runs[0])).toContain("c2 broke");
}, 120000);
/** Makes the named profiles' setups take `ms` longer, so with prewarmed bases the others' settle first and their checks are taken first. */
function slowSetups(f: { config: ReturnType<typeof defineHarnessConfig>; setConfig: (v: HarnessConfigInput) => void }, ids: readonly string[], ms: number) {
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => !ids.includes(p.id) ? p : { ...p,
    dependencies: { command: [process.execPath, "-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms});${p.dependencies!.command[2]}`] as [string, ...string[]], timeoutMs: 60000 } }) } } as unknown as HarnessConfigInput);
}
it("an abort stops every worker and cleans up every pooled snapshot", async () => {
  // c1 holds the first worker; the second passes c2, keeps its idle setup-2 snapshot, and holds c3.
  const f = await poolFixture(["1", "2", "3"], 2, (id, shared) => id === "c2" ? "" : `require('fs').writeFileSync(${JSON.stringify(shared)}+'/started-${id}','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)`);
  // Setup 2 settles first, so the second worker takes c2 before c3, as declared.
  slowSetups(f, ["pc1", "pc3"], 1000);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const snapshots = await import("./check-snapshot.ts"), original = snapshots.createCheckSnapshot, roots: string[] = [];
  const clones: string[] = [];
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await original(input); roots.push(snapshot.rootDir);
    return { ...snapshot, clone: async (method, onPhase) => { const clone = await snapshot.clone(method, onPhase); clones.push(clone.rootDir); return clone; } };
  });
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
    // Every warm base and every worker's clone of one is removed.
    if (await snapshots.snapshotCloneMethod()) expect(clones).toHaveLength(3);
    for (const root of [...roots, ...clones]) await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    const { readScopedCheckObservations } = await import("./index.ts");
    const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    expect(observed.providers.map(p => p.attempts.at(-1)?.status)).toEqual(["interrupted", "passed", "interrupted"]);
  } finally { spy.mockRestore(); await Promise.all([...roots, ...clones].map(root => rm(root, { recursive: true, force: true }))); }
}, 60000);
/** Every process, read-only: a test proves a group is its own before anything signals it. */
async function processTable() {
  return (await exec("ps", ["-A", "-o", "pid=,pgid=,command="])).stdout.split("\n").map(line => line.trim().split(/\s+/)).filter(row => row.length > 2)
    .map(row => ({ pid: Number(row[0]), pgid: Number(row[1]), command: row.slice(2).join(" ") }));
}
/**
 * c1 fails once c2's grandchild is beating; c2 leads its own process group, starts that grandchild (tagged
 * with a token unique to this test) and sleeps `sleepMs`; c3 is trivial and starts only when a worker frees.
 */
async function heartbeatFixture(concurrency: number, sleepMs: number, failFast?: boolean) {
  const token = `scoped-failfast-heartbeat-${process.pid}-${Date.now()}`;
  const f = await poolFixture(["1", "2", "3"], concurrency, (id, shared) => {
    const beat = path.join(shared, "heartbeat"), leader = path.join(shared, "leader");
    // c2's snapshot setup alone can take tens of seconds on a loaded machine, so c1 waits long for its beat.
    if (id === "c1") return `const fs=require('fs'),end=Date.now()+90000;while(!fs.existsSync(${JSON.stringify(`${beat}.pid`)})){if(Date.now()>end)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}` +
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);fs.writeFileSync(${JSON.stringify(path.join(shared, "failed-at"))},String(Date.now()));console.log('c1 broke');process.exit(3)`;
    if (id === "c2") return `const fs=require('fs'),cp=require('child_process');fs.writeFileSync(${JSON.stringify(leader)},String(process.pid));` +
      `cp.spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(`${beat}.pid`)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},Date.now()+'\\n'),25)`)},${JSON.stringify(token)}],{stdio:'ignore'}).unref();` +
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${sleepMs})`;
    return "";
  });
  if (failFast !== undefined) f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast } } as unknown as HarnessConfigInput);
  // c3 starts only when a worker frees: its prewarmed setup settles last, so no worker takes it ahead of c2.
  slowSetups(f, ["pc3"], 2000);
  const beats = async () => (await readFile(path.join(f.shared, "heartbeat"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  const failedAt = async () => Number(await readFile(path.join(f.shared, "failed-at"), "utf8"));
  const leader = async () => Number(await readFile(path.join(f.shared, "leader"), "utf8"));
  /** Only a pid this test's grandchild wrote, still carrying this test's token, is ever signalled. */
  const reap = async () => {
    const pid = Number(await readFile(path.join(f.shared, "heartbeat.pid"), "utf8").catch(() => "0"));
    if (pid > 0 && (await processTable()).some(row => row.pid === pid && row.command.includes(token))) process.kill(pid, "SIGKILL");
  };
  return { ...f, get config() { return f.config; }, token, beats, failedAt, leader, reap };
}
const lastStatuses = async (f: { dir: string; config: Parameters<typeof import("./index.ts")["readScopedCheckObservations"]>[0]["config"] }) => {
  const { readScopedCheckObservations } = await import("./index.ts");
  return (await readScopedCheckObservations({ rootDir: f.dir, config: f.config })).providers.map(p => [p.providerId, p.attempts.map(a => a.status)]);
};
/** How long the sibling sleeps, and the most a fail-fast cancellation may take to silence its grandchild. */
const SIBLING_MS = 4000, KILL_BOUND_MS = 1500;
it.each([undefined, false])("characterization: with failFast %s, gate runs every check to completion after the first failure", async failFast => {
  const f = await heartbeatFixture(2, SIBLING_MS, failFast);
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate")).toBe(1);
    const out = f.out.join("\n");
    expect(out).toMatch(/failed check\.c1: check_command_failed/);
    expect(out).toMatch(/passed check\.c2:/);
    expect(out).toMatch(/passed check\.c3:/);
    expect(out).not.toMatch(/interrupted/);
    expect(await lastStatuses(f)).toEqual([["check.c1", ["failed"]], ["check.c2", ["passed"]], ["check.c3", ["passed"]]]);
    // The sibling's grandchild kept beating for the sibling's whole run, then died with its group.
    expect((await f.beats()).at(-1)! - await f.failedAt()).toBeGreaterThan(KILL_BOUND_MS);
    const leader = await f.leader();
    expect((await processTable()).filter(row => row.pgid === leader)).toEqual([]);
    expect(f.err.join("\n").match(/check_command_failed/g)).toHaveLength(1);
  } finally { await f.reap(); }
}, 240000);
it("with failFast, gate's first failure signals the running sibling's group and never starts the rest", async () => {
  const f = await heartbeatFixture(2, SIBLING_MS, true);
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate")).toBe(1);
    const out = f.out.join("\n");
    expect(out).toMatch(/failed check\.c1: check_command_failed/);
    expect(out).toMatch(/interrupted check\.c2: check_cancelled; attempt/);
    expect(out).toMatch(/interrupted check\.c3: check_cancelled before it started, after check\.c1 failed/);
    expect(out).not.toMatch(/checking check\.c3/);
    expect(out).not.toMatch(/passed check\./);
    expect(await lastStatuses(f)).toEqual([["check.c1", ["failed"]], ["check.c2", ["interrupted"]], ["check.c3", ["interrupted"]]]);
    // The grandchild was beating when c1 failed, stopped within the bound, and nothing of its group survives.
    const beats = await f.beats(), failedAt = await f.failedAt();
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.at(-1)! - failedAt).toBeLessThan(KILL_BOUND_MS);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await f.beats()).toEqual(beats);
    const leader = await f.leader();
    expect(leader).not.toBe(process.pid);
    expect((await processTable()).filter(row => row.pgid === leader)).toEqual([]);
    // The gate is blocked by the one failure; the cancellations are not failures of their own.
    const err = f.err.join("\n");
    expect(err.match(/check_command_failed/g)).toHaveLength(1);
    expect(err).not.toMatch(/check_cancelled/);
    const { readScopedCheckDiagnostics, readScopedCheckObservations } = await import("./index.ts");
    const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
    const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)) });
    const recorded = Object.fromEntries(diagnostics.providers.map(p => [p.providerId, p.attempts[0]!.diagnostic]));
    expect(recorded["check.c2"]).toMatchObject({ availability: "available", phase: "command", failure: { code: "check_cancelled", executionErrorCode: "ABORT_ERR" } });
    expect(recorded["check.c3"]).toMatchObject({ availability: "available", phase: "snapshot-setup", failure: { code: "check_cancelled" }, command: { unavailable: "not-started" } });
  } finally { await f.reap(); }
}, 240000);
it("with failFast, a sibling still in its dependency setup when the failure lands stops before its command", async () => {
  // Without cloning there is no prewarm: each worker sets up its own tree inside the check.
  const probe = vi.spyOn(await import("./check-snapshot.ts"), "snapshotCloneMethod").mockResolvedValue(undefined);
  try { await siblingInSetup(); } finally { probe.mockRestore(); }
}, 240000);
async function siblingInSetup() {
  // c2's own setup holds until c1 has failed, so c1's failure always lands while c2 is in setup.
  const f = await poolFixture(["1", "2"], 2, (id, shared) => id === "c1"
    ? `const fs=require('fs'),end=Date.now()+90000;while(!fs.existsSync(${JSON.stringify(path.join(shared, "c2-setup"))})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);fs.writeFileSync(${JSON.stringify(path.join(shared, "failed-at"))},'');process.exit(3)`
    : "");
  const setup = `const fs=require('fs'),end=Date.now()+90000;fs.writeFileSync(${JSON.stringify(path.join(f.shared, "c2-setup"))},'');` +
    `while(!fs.existsSync(${JSON.stringify(path.join(f.shared, "failed-at"))})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)`;
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast: true,
    profiles: f.config.scopedExecution!.profiles.map(p => p.id === "pc2" ? { ...p, dependencies: { command: [process.execPath, "-e", setup] as [string, ...string[]], timeoutMs: 120000 } } : p) } } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1);
  const out = f.out.join("\n");
  expect(out).toMatch(/failed check\.c1: check_command_failed/);
  expect(out).toMatch(/interrupted check\.c2: check_cancelled; attempt/);
  expect(out).not.toMatch(/checking check\.c2/);
  expect(await lastStatuses(f)).toEqual([["check.c1", ["failed"]], ["check.c2", ["interrupted"]]]);
  const { readScopedCheckDiagnostics, readScopedCheckObservations } = await import("./index.ts");
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.map(a => a.attemptId)) });
  expect(diagnostics.providers.find(p => p.providerId === "check.c2")!.attempts[0]!.diagnostic).toMatchObject({ availability: "available", phase: "pre-command-verification", failure: { code: "check_cancelled" }, command: { unavailable: "not-started" } });
}
it("with failFast, a sibling whose base is still prewarming when the failure lands never starts, and the prewarm is stopped", async () => {
  const method = await (await import("./check-snapshot.ts")).snapshotCloneMethod();
  const f = await poolFixture(["1", "2"], 2, id => id === "c1" ? "process.exit(3)" : "");
  // Setup 2 would take a minute; nothing may wait for it once c1 has failed.
  const marker = JSON.stringify(path.join(f.shared, "slow-setup"));
  const slow = `require('fs').writeFileSync(${marker},JSON.stringify({pid:process.pid,cwd:process.cwd()}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);require('fs').appendFileSync(${JSON.stringify(path.join(f.shared, "installs.log"))},'2')`;
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast: true,
    profiles: f.config.scopedExecution!.profiles.map(p => p.id === "pc2" ? { ...p, dependencies: { command: [process.execPath, "-e", slow] as [string, ...string[]], timeoutMs: 120000 } } : p) } } as unknown as HarnessConfigInput);
  // Without cloning there is no prewarm, and c2 would set up in its own check.
  if (!method) return;
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const started = Date.now();
  expect(await f.run("gate")).toBe(1);
  expect(Date.now() - started).toBeLessThan(30000);
  const out = f.out.join("\n");
  expect(out).toMatch(/failed check\.c1: check_command_failed/);
  expect(out).toMatch(/interrupted check\.c2: check_cancelled before it started, after check\.c1 failed/);
  expect(out).not.toMatch(/setup check\.c2|checking check\.c2/);
  expect(await f.installs("2")).toBe(0);
  expect(await lastStatuses(f)).toEqual([["check.c1", ["failed"]], ["check.c2", ["interrupted"]]]);
  // Cleanup stopped the prewarm: its setup process is gone, and so is the tree it was setting up.
  const setup = JSON.parse(await readFile(path.join(f.shared, "slow-setup"), "utf8")) as { pid: number; cwd: string };
  expect(() => process.kill(setup.pid, 0)).toThrow();
  await expect(access(setup.cwd)).rejects.toThrow();
}, 120000);
it.each([undefined, true])("on a single worker with failFast %s, a failure leaves the rest to run or records them interrupted unstarted", async failFast => {
  const f = await poolFixture(["1", "1", "1"], 1, (id, shared) => id === "c1" ? `if(require('fs').existsSync(${JSON.stringify(path.join(shared, "fail"))}))process.exit(3)` : "");
  if (failFast !== undefined) f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast } } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  await writeFile(path.join(f.shared, "fail"), "");
  expect(await f.run("gate")).toBe(1);
  const out = f.out.join("\n");
  expect(out).toMatch(/failed check\.c1: check_command_failed/);
  if (failFast) {
    expect(out).not.toMatch(/checking check\.c[23]/);
    expect(out).toMatch(/interrupted check\.c2: check_cancelled before it started, after check\.c1 failed/);
    expect(await lastStatuses(f)).toEqual([["check.c1", ["failed"]], ["check.c2", ["interrupted"]], ["check.c3", ["interrupted"]]]);
  } else expect(await lastStatuses(f)).toEqual([["check.c1", ["failed"]], ["check.c2", ["passed"]], ["check.c3", ["passed"]]]);
  // A cancelled attempt fences nothing: once c1 is fixed, the same gate admits and records.
  await rm(path.join(f.shared, "fail"));
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
}, 240000);
it.each([undefined, true])("on a pool with failFast %s, a scoped failure leaves an unscoped declared check to run or never starts it", async failFast => {
  const f = await poolFixture(["1", "1"], 2, id => id === "c1" ? "process.exit(3)" : "");
  const plain = { id: "check.plain", findingCodes: [], check: { command: [process.execPath, "-e", ""] as [string, ...string[]], timeoutMs: 5000 } };
  f.setConfig({ ...f.config, providers: [...f.config.providers, plain],
    obligations: [...f.config.obligations, { ...f.config.obligations[0]!, id: "check.plain.passed", providers: [plain.id] }],
    scopedExecution: { ...f.config.scopedExecution!, ...(failFast === undefined ? {} : { failFast }) } } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1);
  const out = f.out.join("\n");
  expect(out).toMatch(/failed check\.c1: check_command_failed/);
  if (failFast) expect(out).not.toContain("checking check.plain");
  else expect(out).toContain("checking check.plain");
}, 240000);
/** Three 30000 ms checks, so the budget is exactly met at 90000 and the cap at 30000. `f.config` is the
 * pool fixture's, read when it was spread, so a later reconfiguration restates the bounds it keeps. */
async function budgetFixture(budget: { budgetMs?: number; checkBudgetMs?: number }, timeouts: readonly number[] = [30000, 30000, 30000]) {
  const f = await poolFixture(["1", "1", "1"], 2, () => "");
  f.setConfig({ ...f.config, providers: f.config.providers.map((p, i) => ({ ...p, check: { ...p.check!, timeoutMs: timeouts[i]! } })),
    scopedExecution: { ...f.config.scopedExecution!, ...budget } } as unknown as HarnessConfigInput);
  return f;
}
it("a selection at exactly budgetMs, every check at exactly checkBudgetMs, prepares and gate runs it", async () => {
  const f = await budgetFixture({ budgetMs: 90000, checkBudgetMs: 30000 });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n").match(/passed check\.c\d/g)?.sort()).toEqual(["passed check.c1", "passed check.c2", "passed check.c3"]);
}, 90000);
it.each(["prepare", "gate"])("%s refuses a selection one millisecond over budgetMs, naming only the check that pushes it over", async command => {
  const f = await budgetFixture({ budgetMs: 90000, checkBudgetMs: 30000 });
  if (command === "gate") expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, timeoutMs: 30000 } })), scopedExecution: { ...f.config.scopedExecution!, budgetMs: 89999, checkBudgetMs: 30000 } } as unknown as HarnessConfigInput);
  expect(await f.run(command)).toBe(1);
  const err = f.err.join("\n");
  expect(err).toContain("scoped_budget_exceeded");
  expect(err).toContain("check.c3 pushes the declared total to 90000ms over budgetMs 89999");
  expect(err).not.toMatch(/check\.c[12]\b/);
  expect(f.out.join("\n")).not.toMatch(/checking /);
}, 90000);
it.each(["prepare", "gate"])("%s refuses a selection under budget with one check over checkBudgetMs, naming only that check", async command => {
  const f = await budgetFixture({ budgetMs: 1000000, checkBudgetMs: 30000 });
  if (command === "gate") expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, timeoutMs: p.id === "check.c2" ? 30001 : 30000 } })),
    scopedExecution: { ...f.config.scopedExecution!, budgetMs: 1000000, checkBudgetMs: 30000 } } as unknown as HarnessConfigInput);
  expect(await f.run(command)).toBe(1);
  const err = f.err.join("\n");
  expect(err).toContain("scoped_budget_exceeded");
  expect(err).toContain("check.c2 declares timeoutMs 30001 over checkBudgetMs 30000");
  expect(err).not.toMatch(/check\.c[13]\b/);
  expect(f.out.join("\n")).not.toMatch(/checking /);
}, 90000);
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

/** The setup each provider's most recent attempt recorded, in provider order. */
async function latestSetups(f: { dir: string; config: ReturnType<typeof defineHarnessConfig> }) {
  const { readScopedCheckObservations, readScopedCheckDiagnostics } = await import("./index.ts");
  const observed = await readScopedCheckObservations({ rootDir: f.dir, config: f.config });
  const diagnostics = await readScopedCheckDiagnostics({ rootDir: f.dir, config: f.config, attemptIds: observed.providers.flatMap(p => p.attempts.slice(-1).map(a => a.attemptId)) });
  return diagnostics.providers.map(p => { const diagnostic = p.attempts.at(-1)?.diagnostic; return diagnostic?.availability === "available" ? diagnostic : undefined; });
}
it("concurrency 2 on one setup key installs once, ahead of both checks, and records each check's setup as reused on a clone", async () => {
  const method = await (await import("./check-snapshot.ts")).snapshotCloneMethod();
  const f = await poolFixture(["1", "1"], 2, (_, shared) => barrier(shared, 2));
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  const setups = (await latestSetups(f)).map(d => d!.setup!);
  const lines = f.out.flatMap(line => line.split("\n")).filter(line => line.startsWith("setup "));
  expect(lines).toHaveLength(2);
  if (!method) {
    // Without copy-on-write each worker builds its own tree, and the record says why.
    expect(await f.installs("1")).toBe(2);
    expect(setups.map(({ phases: _, ...s }) => s)).toEqual([0, 1].map(() => ({ action: "executed", snapshot: "built", clone: "unavailable", verification: "inventory" })));
    return;
  }
  expect(await f.installs("1")).toBe(1);
  // The pool's prewarm ran the setup before either check took a worker, so neither built it or waited on a build.
  expect(setups.map(({ phases: _, ...s }) => s)).toEqual([0, 1].map(() => ({ action: "reused", snapshot: "cloned", clone: method, verification: "index" })));
  for (const setup of setups) {
    expect(setup.phases.map(p => p.phase)).toEqual(["warm-base-wait", "clone", "pre-command-verification"]);
    expect(setup.phases.find(p => p.phase === "warm-base-wait")!.durationMs).toBeLessThan(1000);
  }
  expect(lines.every(line => /^setup check\.c[12]: attempt \S+; reused on a cloned tree \(clone (clonefile|reflink)\), index verification; \d+ms$/.test(line)), lines.join("\n")).toBe(true);
  const out = f.out.flatMap(line => line.split("\n"));
  expect(out.filter(line => /^prewarm pc1: dependencies \d+ms$/.test(line)), out.join("\n")).toHaveLength(1);
  // No attempt ran the dependency setup, so none carries its result.
  expect((await latestSetups(f)).filter(d => d!.dependency !== undefined)).toHaveLength(0);
}, 90000);
it("a pool prewarms each setup key one at a time, the longest-expected first, and no check of a key starts while its base is setting up", async () => {
  const method = await (await import("./check-snapshot.ts")).snapshotCloneMethod();
  if (!method) return;
  const f = await poolFixture(["1", "2", "1", "2"], 2, () => "");
  // Each setup records when it ran and takes half a second, so overlapping setups would show.
  const span = (key: string) => `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(f.shared, "begin-"))}+'${key}',String(Date.now()));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);fs.writeFileSync(${JSON.stringify(path.join(f.shared, "end-"))}+'${key}',String(Date.now()))`;
  const keyOf = (profile: string) => profile === "pc1" || profile === "pc3" ? "1" : "2";
  // Each check reads its own setup's install, so a base of the other key is never what it runs in. Setup 2's
  // checks declare the longer timeout, so with no history its base goes first.
  f.setConfig({ ...f.config, providers: f.config.providers.map((p, i) => ({ ...p, check: { ...p.check!, timeoutMs: i % 2 === 0 ? 30000 : 60000,
      command: [process.execPath, "-e", `if(require('fs').readFileSync('node_modules/key','utf8')!=='${i % 2 === 0 ? "1" : "2"}')process.exit(9);require('fs').writeFileSync('result-c${i + 1}.json','{}')`] as [string, ...string[]] } })),
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p,
      dependencies: { command: [process.execPath, "-e", `${span(keyOf(p.id))};${p.dependencies!.command[2]};fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/key','${keyOf(p.id)}')`] as [string, ...string[]], timeoutMs: 60000 } })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect([await f.installs("1"), await f.installs("2")]).toEqual([1, 1]);
  const at = async (name: string) => Number(await readFile(path.join(f.shared, name), "utf8"));
  expect(await at("end-2")).toBeLessThanOrEqual(await at("begin-1"));
  const setups = (await latestSetups(f)).map(d => d!.setup!);
  expect(setups.every(s => s.action === "reused" && !s.phases.some(p => p.phase === "dependencies"))).toBe(true);
  // A half-second setup was never inside a check: each one's wait for its base is near zero.
  for (const setup of setups) expect(setup.phases.filter(p => p.phase === "warm-base-wait").reduce((sum, p) => sum + p.durationMs, 0)).toBeLessThan(300);
}, 90000);
it("without copy-on-write each worker sets up its own tree and the record says cloning is unavailable", async () => {
  const snapshots = await import("./check-snapshot.ts");
  const probe = vi.spyOn(snapshots, "snapshotCloneMethod").mockResolvedValue(undefined);
  try {
    const f = await poolFixture(["1", "1"], 2, (_, shared) => barrier(shared, 2));
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
    expect(await f.installs("1")).toBe(2);
    expect((await latestSetups(f)).map(d => { const { phases, ...setup } = d!.setup!; return { ...setup, phases: phases.map(p => p.phase) }; })).toEqual([0, 1].map(() => ({ action: "executed", snapshot: "built", clone: "unavailable", verification: "inventory",
      phases: ["materialization", "baseline-inventory", "dependencies", "post-dependency-inventory", "pre-command-verification"] })));
  } finally { probe.mockRestore(); }
}, 90000);
it.each([true, false])("two concurrent checks of one profile write the same output path and each reads back only its own (cloning %s)", async cloning => {
  const snapshots = await import("./check-snapshot.ts");
  const probe = cloning ? undefined : vi.spyOn(snapshots, "snapshotCloneMethod").mockResolvedValue(undefined);
  try {
    const f = await fixture(); f.env["FAIL"] = "0";
    const shared = await mkdtemp(path.join(tmpdir(), "scoped-same-output-")); dirs.push(shared);
    const template = f.config.providers[0]!, profile = f.config.scopedExecution!.profiles[0]!;
    const ready = (id: string) => JSON.stringify(path.join(shared, `ready-${id}`));
    const providers = ["c1", "c2"].map(id => ({ ...template, id: `check.${id}`, check: { ...template.check!, timeoutMs: 30000,
      command: [process.execPath, "-e", `const fs=require('fs');fs.writeFileSync('shared.json',${JSON.stringify(id)});fs.writeFileSync(${ready(id)},'');` +
        `const end=Date.now()+20000;while(!(fs.existsSync(${ready("c1")})&&fs.existsSync(${ready("c2")}))){if(Date.now()>end)process.exit(7)}` +
        `if(fs.readFileSync('shared.json','utf8')!==${JSON.stringify(id)})process.exit(9)`] as [string, ...string[]],
      outputs: ["shared.json"], scope: { ...template.check!.scope!, environment: [], profile: "one" } } }));
    f.setConfig({ ...f.config, providers, obligations: providers.map(p => ({ ...f.config.obligations[0]!, id: `${p.id}.passed`, providers: [p.id] })),
      scopedExecution: { ...f.config.scopedExecution!, concurrency: 2, mechanicalProviders: [],
        profiles: [{ ...profile, id: "one", mutableOutputs: ["shared.json"], dependencies: { command: [process.execPath, "-e", "0"], timeoutMs: 30000 } }] } });
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
    expect(f.out.join("\n").match(/passed check\.c\d/g)?.sort()).toEqual(["passed check.c1", "passed check.c2"]);
  } finally { probe?.mockRestore(); }
}, 90000);
it.each([{ planted: "own", name: "keeps a write in the running profile's own outputs for its command" }, { planted: "other", name: "refuses a stray write to another profile's output before the command" }] as const)("a reused snapshot's pre-command verification $name", async ({ planted }) => {
  // Serial, so c runs in the tree a left; d shares their setup but has not run yet.
  const f = await sharedSetupFixture(id => id === "c" ? "const fs=require('fs');if(!fs.existsSync('cache-c/seed'))process.exit(5);fs.writeFileSync('result-c.json','{}')" : `require('fs').writeFileSync('result-${id}.json','{}')`);
  const template = f.config.providers[0]!;
  const d = { ...template, id: "check.d", check: { ...template.check!, command: [process.execPath, "-e", "require('fs').writeFileSync('result-d.json','{}')"] as [string, ...string[]], outputs: ["result-d.json"], scope: { ...template.check!.scope!, profile: "pd" } } };
  const profiles = f.config.scopedExecution!.profiles;
  f.setConfig({ ...f.config, providers: [...f.config.providers, d].map(p => ({ ...p, check: { ...p.check!, timeoutMs: 60000 } })), obligations: [...f.config.obligations, { ...f.config.obligations[0]!, id: "check.d.passed", providers: ["check.d"] }],
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a", "check.c", "check.d", "check.b"],
      profiles: [...profiles.map(p => p.id === "pc" ? { ...p, mutableOutputs: ["result-c.json", "cache-c/"] } : p), { ...profiles.find(p => p.id === "pa")!, id: "pd", mutableOutputs: ["result-d.json"] }]
        .map(p => ({ ...p, dependencies: { ...p.dependencies!, timeoutMs: 60000 } })) } });
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  let plant: ((root: string) => Promise<void>) | undefined = planted === "own"
    ? async root => { await mkdir(path.join(root, "cache-c"), { recursive: true }); await writeFile(path.join(root, "cache-c/seed"), "warm"); }
    : async root => { await writeFile(path.join(root, "result-d.json"), "stray"); };
  // Plant right after a's post-command verification (the tree's second full one), so the write is
  // already there when c takes the tree, before its outputs are removed.
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await create(input);
    let full = 0;
    return { ...snapshot, verify: async options => {
      await snapshot.verify(options);
      if (!options?.unchanged && ++full === 2 && plant) { await plant(snapshot.rootDir); plant = undefined; }
    } };
  });
  try {
    if (planted === "own") {
      // Allowed: a write inside c's own outputs passes and is still there when c's command runs.
      expect(await f.run("prepare"), f.err.join("\n") + f.out.join("\n")).toBe(0);
      expect(f.out.join("\n").match(/checking check\.\w/g)).toEqual(["checking check.a", "checking check.c", "checking check.d", "checking check.b"]);
      return;
    }
    // Refused: a write to d's output that no check here produced fails c before its command; it is not erased.
    expect(await f.run("prepare")).toBe(1);
    expect(f.err.join("\n")).toContain("check_snapshot_drift");
    expect(f.out.join("\n").match(/checking check\.\w/g)).toEqual(["checking check.a"]);
    const c = (await latestSetups(f))[2]!;
    expect(c).toMatchObject({ phase: "pre-command-verification", failure: { code: "check_snapshot_drift" }, command: { unavailable: "not-started" }, setup: { action: "reused", snapshot: "retained", verification: "index" } });
  } finally { spy.mockRestore(); }
}, 90000);
it("a dependency-input change invalidates the warm base, which rebuilds once from the changed input", async () => {
  // Warm bases live for one invocation; what this pins is that each gate builds one, from its own
  // candidate's inputs: every check reads the installed copy of the lock and needs it current.
  const f = await poolFixture(["1", "1"], 2, (_, shared) => `${barrier(shared, 2)};if(fs.readFileSync('node_modules/lock.txt','utf8')!==fs.readFileSync('deps.lock','utf8'))process.exit(9)`);
  const method = await (await import("./check-snapshot.ts")).snapshotCloneMethod();
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p, dependencyInputs: ["deps.lock"],
    dependencies: { ...p.dependencies!, command: [process.execPath, "-e", `${p.dependencies!.command[2]};require('fs').mkdirSync('node_modules',{recursive:true});require('fs').copyFileSync('deps.lock','node_modules/lock.txt')`] as [string, ...string[]], timeoutMs: 60000 } })) } });
  await writeFile(path.join(f.dir, "deps.lock"), "one"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "lock");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  const perGate = method ? 1 : 2;
  expect(await f.installs("1")).toBe(perGate);
  await rm(path.join(f.shared, "arrived"), { recursive: true, force: true });
  await writeFile(path.join(f.dir, "deps.lock"), "two"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "lock two");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect(await f.installs("1")).toBe(2 * perGate);
}, 120000);

it("a setup that writes its own path into the tree is not shared, and a prewarmed one goes to exactly one worker", async () => {
  const method = await (await import("./check-snapshot.ts")).snapshotCloneMethod();
  const f = await poolFixture(["1", "1", "1"], 3, (_, shared) => barrier(shared, 3));
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p,
    dependencies: { command: [process.execPath, "-e", `${p.dependencies!.command[2]};const fs=require('fs');fs.mkdirSync('node_modules/.bin',{recursive:true});fs.writeFileSync('node_modules/.bin/tool','#!'+process.cwd()+'/node_modules/.venv/bin/python')`] as [string, ...string[]], timeoutMs: 60000 } })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  // With cloning, the prewarm's tree is one worker's own and the other two set up their own; without it, all three do.
  expect(await f.installs("1")).toBe(3);
  const setups = (await latestSetups(f)).map(d => { const { phases: _, ...setup } = d!.setup!; return setup; });
  expect(setups.map(s => s.action).sort()).toEqual(method ? ["executed", "executed", "reused"] : ["executed", "executed", "executed"]);
  expect(setups.map(({ action: _, ...s }) => s)).toEqual([0, 1, 2].map(() => ({ snapshot: "built", clone: method ? "path-bound" : "unavailable", verification: "inventory" })));
}, 90000);
it("the gate gives the check expected to run longest its worker and its clone first", async () => {
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  if (!await snapshots.snapshotCloneMethod()) return;
  const f = await poolFixture(["1", "1", "1"], 2, (id, shared) => `require('fs').writeFileSync(${JSON.stringify(path.join(shared, "start-"))}+'${id}',String(Date.now()))` +
    (id === "c3" ? `;if(require('fs').existsSync(${JSON.stringify(path.join(shared, "slow"))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500)` : ""));
  // A first gate times c3 as the longest; a source change makes the second one run all three again.
  await writeFile(path.join(f.shared, "slow"), "");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  await writeFile(path.join(f.dir, "source.txt"), "changed"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "changed");
  const clones: string[] = [];
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await create(input);
    return { ...snapshot, clone: async (m, onPhase) => { clones.push(""); const index = clones.length - 1; await new Promise(resolve => setTimeout(resolve, 200)); const clone = await snapshot.clone(m, onPhase); clones[index] = clone.rootDir; return clone; } };
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  } finally { spy.mockRestore(); }
  const started = Object.fromEntries(await Promise.all(["c1", "c2", "c3"].map(async id => [id, Number(await readFile(path.join(f.shared, `start-${id}`), "utf8"))])));
  // Declared first would be c1 and c2; longest first puts c3 on one of the two workers before the third check.
  expect(started["c3"]).toBeLessThan(Math.max(started["c1"]!, started["c2"]!));
  // Its clone was the first of the two queued together.
  const setups = await latestSetups(f);
  const c3 = setups[2]!.setup!.phases.find(p => p.phase === "clone")!.durationMs;
  const others = setups.slice(0, 2).map(d => d!.setup!.phases.find(p => p.phase === "clone")?.durationMs ?? 0);
  expect(c3).toBeLessThan(Math.max(...others));
}, 120000);
it("workers clone a warm base one at a time, and a clone's queue counts as its clone", async () => {
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  const method = await snapshots.snapshotCloneMethod();
  if (!method) return;
  const f = await poolFixture(["1", "1", "1"], 3, (_, shared) => barrier(shared, 3));
  const spans: [number, number][] = [];
  // Each clone holds for 300 ms, so three overlapping ones would show.
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await create(input);
    return { ...snapshot, clone: async (m, onPhase) => { const start = performance.now(); await new Promise(resolve => setTimeout(resolve, 300)); const clone = await snapshot.clone(m, onPhase); spans.push([start, performance.now()]); return clone; } };
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  } finally { spy.mockRestore(); }
  expect(spans).toHaveLength(3);
  const ordered = [...spans].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ordered.length; i++) expect(ordered[i]![0]).toBeGreaterThanOrEqual(ordered[i - 1]![1]);
  // The last clone queued behind two others, and its recorded clone phase says so.
  const clones = (await latestSetups(f)).map(d => d!.setup!.phases.find(p => p.phase === "clone")!.durationMs).sort((a, b) => a - b);
  expect(clones[2]!).toBeGreaterThanOrEqual(600);
}, 90000);
it("a longer check's clone goes ahead of a shorter one already queued", async () => {
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  if (!await snapshots.snapshotCloneMethod()) return;
  // c1 is the longest and c3 the next; c2 is short and shares c1's setup.
  const slept = { c1: 1500, c2: 0, c3: 700 } as Record<string, number>;
  const f = await poolFixture(["1", "1", "2"], 3, (id, shared) => `if(require('fs').existsSync(${JSON.stringify(path.join(shared, "slow"))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${slept[id]})`);
  // A first gate times them; a source change makes the second one run all three again.
  await writeFile(path.join(f.shared, "slow"), "");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  await writeFile(path.join(f.dir, "source.txt"), "changed"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "changed");
  // Setup 1 goes first, for c1. c1 clones at once and c2 queues; setup 2 settles while c1's clone is held.
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await create(input);
    return { ...snapshot, clone: async (m, onPhase) => { await new Promise(resolve => setTimeout(resolve, 1500)); return snapshot.clone(m, onPhase); } };
  });
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  } finally { spy.mockRestore(); }
  // The clone phase counts the queue: c3, queued after c2, still cloned before it.
  const clone = (d: Awaited<ReturnType<typeof latestSetups>>[number]) => d!.setup!.phases.find(p => p.phase === "clone")!.durationMs;
  const [c1, c2, c3] = (await latestSetups(f)).map(clone);
  expect(c1!).toBeLessThan(c3!);
  expect(c3!).toBeLessThan(c2!);
  expect(c2!).toBeGreaterThanOrEqual(2800);
}, 120000);
it("a never-timed check is expected to take its declared timeout, so the longest declared one goes first", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1", "1", "1"], 2, (id, shared) => `require('fs').writeFileSync(${JSON.stringify(path.join(shared, "start-"))}+'${id}',String(Date.now()));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)`);
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => p.id === "check.c3" ? { ...p, check: { ...p.check!, timeoutMs: 120000 } } : p) });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  const started = Object.fromEntries(await Promise.all(["c1", "c2", "c3"].map(async id => [id, Number(await readFile(path.join(f.shared, `start-${id}`), "utf8"))])));
  // Declared order would start c1 and c2 first; c3 declares four times their timeout.
  expect(started["c3"]).toBeLessThan(Math.max(started["c1"]!, started["c2"]!));
}, 90000);
it("prepare sets up nothing for the other mechanical checks until the guard has passed", async () => {
  // The guard runs two seconds before it fails: long enough for setup 2 to have run, had it started.
  const f = await poolFixture(["1", "2", "2"], 2, id => id === "c1" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);process.exit(3)" : "", true);
  expect(await f.run("prepare")).toBe(1);
  expect(f.out.join("\n")).toMatch(/failed check\.c1/);
  expect(f.out.join("\n")).not.toMatch(/prewarm pc[23]:/);
  expect(await f.installs("2")).toBe(0);
}, 90000);
it("a failed mechanical check ends prepare without waiting for a prewarm no check will take", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1", "1", "2"], 2, id => id === "c2" ? "process.exit(3)" : "", true);
  // Setup 2 would take a minute; once c2 fails, the worker waiting for it must stop waiting.
  slowSetups(f, ["pc3"], 60000);
  const started = Date.now();
  expect(await f.run("prepare")).toBe(1);
  expect(Date.now() - started).toBeLessThan(30000);
  expect(f.out.join("\n")).toMatch(/failed check\.c2/);
  expect(f.out.join("\n")).not.toMatch(/checking check\.c3/);
  expect(await f.installs("2")).toBe(0);
}, 120000);
it("a prepare whose mechanical checks are all reused prewarms nothing", async () => {
  const f = await poolFixture(["1", "2"], 2, () => "", true);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const snapshots = await import("./check-snapshot.ts"), spy = vi.spyOn(snapshots, "createCheckSnapshot");
  try {
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    expect(f.out.join("\n")).toMatch(/reusing mechanical check\.c1/);
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
}, 90000);
it("a reused mechanical check that claimed a key with no base frees it for the next check of that key", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // c2 and c3 share setup 2; c3 also reads e.txt and runs longer, so prepare takes c2 first.
  const f = await poolFixture(["1", "2", "2"], 2, id => id === "c3" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300)" : "", true);
  const arm = JSON.stringify(path.join(f.shared, "arm")), once = JSON.stringify(path.join(f.shared, "failed-once"));
  await writeFile(path.join(f.dir, "e.txt"), "one"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "e");
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => p.id === "check.c3" ? { ...p, check: { ...p.check!, scope: { ...p.check!.scope!, files: ["source.txt", "e.txt"] } } } : p),
    scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => p.id === "pc1" ? p : { ...p,
      dependencies: { command: [process.execPath, "-e", `const fs=require('fs');if(fs.existsSync(${arm})){let first=true;try{fs.writeFileSync(${once},'',{flag:'wx'})}catch{first=false}if(first)process.exit(3)}${p.dependencies!.command[2]}`] as [string, ...string[]], timeoutMs: 60000 } }) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  // Only c3 changes; setup 2's prewarm for it fails once, so c2, reused, is taken with no base for its key.
  await writeFile(path.join(f.shared, "arm"), "");
  await writeFile(path.join(f.dir, "e.txt"), "two"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "e two");
  expect(await f.run("prepare"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  const out = f.out.join("\n");
  expect(out).toMatch(/reusing mechanical check\.c2/);
  expect(out).toMatch(/prewarm pc[23]: setup failed/);
  expect(out).toMatch(/passed check\.c3/);
}, 90000);
it("a check's last clone and its queue are not part of what it is expected to cost", async () => {
  const snapshots = await import("./check-snapshot.ts"), create = snapshots.createCheckSnapshot;
  if (!await snapshots.snapshotCloneMethod()) return;
  // c1 runs 700 ms on setup 1; c2 and c3 are instant on setup 2, but their clones in the first gate were held 1.5 s.
  const f = await poolFixture(["1", "2", "2"], 2, id => id === "c1" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700)" : "");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const spy = vi.spyOn(snapshots, "createCheckSnapshot").mockImplementation(async input => {
    const snapshot = await create(input);
    if (!input.outputs.includes("result-c2.json")) return snapshot;
    return { ...snapshot, clone: async (m, onPhase) => { await new Promise(resolve => setTimeout(resolve, 1500)); return snapshot.clone(m, (phase, ms) => onPhase?.(phase, phase === "clone" ? ms + 1500 : ms)); } };
  });
  try { expect(await f.run("gate"), f.err.join("\n")).toBe(0); } finally { spy.mockRestore(); }
  await writeFile(path.join(f.dir, "source.txt"), "changed"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "changed");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  f.out.length = 0;
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  // Without their clones, setup 2's checks cost almost nothing, so c1's setup goes first.
  const lines = f.out.flatMap(line => line.split("\n"));
  const first = (pattern: RegExp) => lines.findIndex(line => pattern.test(line));
  expect(first(/^prewarm pc1: materialization /), lines.join("\n")).toBeGreaterThanOrEqual(0);
  expect(first(/^prewarm pc1: materialization /)).toBeLessThan(first(/^prewarm pc[23]: materialization /));
}, 120000);
it("a setup key's prewarm is ordered by the longest check that needs it, not its first", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // Setup 1's first check is short and its second the longest; setup 2's one check is in between.
  const f = await poolFixture(["1", "2", "1"], 2, () => "");
  const timeouts: Record<string, number> = { "check.c1": 10000, "check.c2": 30000, "check.c3": 60000 };
  f.setConfig({ ...f.config, providers: f.config.providers.map(p => ({ ...p, check: { ...p.check!, timeoutMs: timeouts[p.id]! } })) });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  const lines = f.out.flatMap(line => line.split("\n"));
  const first = (pattern: RegExp) => lines.findIndex(line => pattern.test(line));
  expect(first(/^prewarm pc[13]: materialization /), lines.join("\n")).toBeGreaterThanOrEqual(0);
  expect(first(/^prewarm pc[13]: materialization /)).toBeLessThan(first(/^prewarm pc2: materialization /));
}, 90000);
it("the gate prewarms first the setup whose own critical path is longest: its last build plus its longest check", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // Setup 1 takes 1.5 s to build and its check is instant; setup 2 builds at once and its check takes 700 ms.
  const f = await poolFixture(["1", "2"], 2, id => id === "c2" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700)" : "");
  slowSetups(f, ["pc1"], 1500);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  await writeFile(path.join(f.dir, "source.txt"), "changed"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "changed");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  f.out.length = 0;
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  // By its longest check alone setup 2 would go first; with its build, setup 1's path is the longer.
  const lines = f.out.flatMap(line => line.split("\n"));
  const first = (pattern: RegExp) => lines.findIndex(line => pattern.test(line));
  expect(first(/^prewarm pc1: materialization /), lines.join("\n")).toBeGreaterThanOrEqual(0);
  expect(first(/^prewarm pc1: materialization /)).toBeLessThan(first(/^prewarm pc2: materialization /));
}, 120000);
it("a prewarm whose setup failed leaves no base, and the check that next needs it sets up itself", async () => {
  const method = await (await import("./check-snapshot.ts")).snapshotCloneMethod();
  const f = await poolFixture(["1", "1"], 2, () => "");
  const once = JSON.stringify(path.join(f.shared, "failed-once"));
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p,
    dependencies: { command: [process.execPath, "-e", `const fs=require('fs');{let first=true;try{fs.writeFileSync(${once},'',{flag:'wx'})}catch{first=false}if(first)process.exit(3)}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);${p.dependencies!.command[2]}`] as [string, ...string[]], timeoutMs: 60000 } })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const gate = await f.run("gate");
  const out = f.out.join("\n");
  expect(await f.installs("1")).toBe(1);
  const setups = await latestSetups(f);
  if (!method) {
    // Without cloning the failed setup is one check's own, as before.
    expect(gate).toBe(1);
    expect(setups.find(d => d!.failure && "code" in d!.failure)).toMatchObject({ phase: "snapshot-setup", failure: { code: "check_dependency_failed" }, dependency: { command: { exitCode: 3 } }, setup: { action: "executed" } });
    return;
  }
  // The prewarm's failure is no check's: one check sets up again, owns that result, and the other clones it.
  expect(gate, out).toBe(0);
  expect(out).toMatch(/prewarm pc1: setup failed \(check_dependency_failed\); its first check sets up itself/);
  expect(setups.map(d => d!.setup!.action).sort()).toEqual(["executed", "reused"]);
  expect(setups.filter(d => d!.dependency !== undefined)).toHaveLength(1);
  // The other check waited for that second-long setup outside its attempt, not inside it.
  const reused = setups.find(d => d!.setup!.action === "reused")!.setup!;
  expect(reused.phases.find(p => p.phase === "warm-base-wait")!.durationMs).toBeLessThan(500);
}, 90000);
it("a setup that always fails is recorded on each check that needed it", async () => {
  const f = await poolFixture(["1", "1"], 2, () => "");
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: f.config.scopedExecution!.profiles.map(p => ({ ...p,
    dependencies: { command: [process.execPath, "-e", "process.exit(3)"] as [string, ...string[]], timeoutMs: 60000 } })) } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1);
  const setups = await latestSetups(f);
  // Whether or not a prewarm failed first, each failed attempt owns a setup it ran and its dependency result.
  for (const d of setups) expect(d).toMatchObject({ phase: "snapshot-setup", failure: { code: "check_dependency_failed" }, dependency: { command: { exitCode: 3 } }, setup: { action: "executed" } });
}, 90000);
it("hashes an unchanged host tool once a process, and a changed one again", async () => {
  const { hostToolDigest } = await import("./scoped-checks.ts");
  const { createHash } = await import("node:crypto");
  const { utimes } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "host-tool-")); dirs.push(dir);
  const tool = path.join(dir, "tool");
  await writeFile(tool, "one", { mode: 0o755 });
  // A whole-millisecond mtime survives being set again exactly, so only ctime can tell the rewrite apart.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await utimes(tool, pinned, pinned);
  let reads = 0;
  const counting = async (file: string) => { reads++; return readFile(file); };
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  // Every scoped check binds the same tool: one read serves them all, concurrent or not.
  const first = await Promise.all([1, 2, 3].map(() => hostToolDigest(tool, counting)));
  expect(await hostToolDigest(tool, counting)).toEqual(first[0]);
  expect(first.map(d => d.sha256)).toEqual([sha("one"), sha("one"), sha("one")]);
  expect(first[0]!.mode).toBe(0o111);
  expect(reads).toBe(1);
  // Same size, same mtime: the change of ctime alone gives a new key, so the new bytes are hashed.
  await writeFile(tool, "two"); await utimes(tool, pinned, pinned);
  expect((await import("node:fs")).statSync(tool).mtimeMs).toBe(pinned.getTime());
  expect((await hostToolDigest(tool, counting)).sha256).toBe(sha("two"));
  expect(reads).toBe(2);
  // A read that fails is not remembered: the next check reads the tool again.
  const flaky = path.join(dir, "flaky");
  await writeFile(flaky, "three", { mode: 0o755 });
  let failing = true;
  const once = async (file: string) => { if (failing) { failing = false; throw new Error("fixture read refused"); } return readFile(file); };
  await expect(hostToolDigest(flaky, once)).rejects.toThrow("fixture read refused");
  expect((await hostToolDigest(flaky, once)).sha256).toBe(sha("three"));
});
it("each scoped session sweeps what ended sessions left in the trash", async () => {
  const { spawn: start } = await import("node:child_process");
  const { access, mkdir: makeDir } = await import("node:fs/promises");
  const done = start("/bin/sh", ["-c", "exit 0"]); await new Promise(resolve => done.once("exit", resolve));
  // A private temporary directory: this user's other sessions sweep the real trash too.
  const shared = await mkdtemp(path.join(tmpdir(), "scoped-session-sweep-")); dirs.push(shared);
  const trashed = path.join(shared, `delivery-harness-trash-${process.getuid!()}`);
  const left = path.join(trashed, `${done.pid}-left`);
  await makeDir(trashed, { mode: 0o700 });
  await makeDir(path.join(left, "node_modules"), { recursive: true });
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = shared;
  try {
    const f = await poolFixture(["1"], 1, () => "");
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    await f.run("gate");
    let gone = false;
    for (const end = Date.now() + 20_000; !gone && Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50)))
      gone = await access(left).then(() => false, () => true);
    expect(gone).toBe(true);
  } finally { if (previous === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previous; }
}, 90_000);
it("a gate reports the same result and records whether or not its trees' deletion finishes", async ({ skip }) => {
  // Without cloning a gate owns no snapshot trees to delete; the row is reported skipped, not passed.
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) skip();
  const runs: { gate: number; out: string[]; verify: number }[] = [];
  for (const kill of [false, true]) {
    const f = await poolFixture(["1", "2"], 2, () => "");
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    deletion.kill = kill; deletion.killed = 0;
    try {
      const gate = await f.run("gate");
      const out = f.out.map(line => normalized(f, line)).filter(line => !/^(snapshot|setup|prewarm) /.test(line)).sort();
      expect(await f.run("record"), f.err.join("\n")).toBe(0);
      await f.git("add", ".");
      runs.push({ gate, out, verify: await f.run("verify") });
      if (kill) expect(deletion.killed).toBeGreaterThan(0);
    } finally { deletion.kill = false; }
  }
  expect(runs[0]!.gate).toBe(0);
  expect(runs[0]!.verify).toBe(0);
  expect(runs[1]).toEqual(runs[0]);
}, 90000);

/** A live rail provider that marks when it starts and ends, waits `ms` (or until `until` exists), and then succeeds.
 * A `cancel` from the gate makes it mark that and exit, so a stopped provider never reports success. */
function liveProvider(shared: string, name: string, ms: number, until?: string, outcome: "success" | "failed" | "cancelled" = "success", cancelDelayMs = 0): [string, ...string[]] {
  const mark = (what: string) => `require('fs').writeFileSync(${JSON.stringify(path.join(shared, `${name}-`))}+'${what}',String(Date.now()))`;
  return [process.execPath, "-e", `${mark("start")};require('fs').appendFileSync(${JSON.stringify(path.join(shared, `${name}-starts`))},'x');require('fs').writeFileSync(${JSON.stringify(path.join(shared, `${name}-pid`))},String(process.pid));let id;require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.kind==='negotiate')console.log(JSON.stringify({kind:'negotiation',outcome:'supported',selectedVersion:'delivery-provider-rails/1',supportedVersions:['delivery-provider-rails/1']}));
 if(m.kind==='cancel'){${mark("cancelled")};setTimeout(()=>process.exit(0),${cancelDelayMs})}
 if(m.kind==='request'){id=m.requestId;const end=Date.now()+${ms};const done=()=>{${mark("end")};console.log(JSON.stringify({kind:'terminal',version:m.version,requestId:m.requestId,sequence:1,summary:'observed',outcome:'${outcome}'}))};
  const tick=()=>{if(${until ? `require('fs').existsSync(${JSON.stringify(until)})||` : ""}Date.now()>=end)return done();setTimeout(tick,20)};tick()}});`];
}
/** Adds live providers to a pool fixture: each its own always-active live obligation, declared independent or not. */
function withLiveProviders(f: Awaited<ReturnType<typeof poolFixture>>, providers: readonly { id: string; command: [string, ...string[]]; independent: boolean }[]) {
  const template = f.config.obligations[0]!;
  f.setConfig({ ...f.config, providers: [...f.config.providers, ...providers.map(p => ({ id: p.id, findingCodes: [], command: p.command, ...(p.independent ? { independentOfScopedChecks: true as const } : {}) }))],
    obligations: [...f.config.obligations, ...providers.map(p => ({ ...template, id: `${p.id}.current`, freshness: "live" as const, providers: [p.id], allowedResolutionKinds: ["satisfied_live_fact" as const, "not_applicable" as const] }))] } as unknown as HarnessConfigInput);
}
const at = async (shared: string, name: string) => { try { return Number(await readFile(path.join(shared, name), "utf8")); } catch { return undefined; } };
it("a provider declared independent runs while the scoped checks run, and an undeclared one still waits for them", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // c1 finishes only once the declared provider has started: a serial gate would never get there.
  const f = await poolFixture(["1", "2"], 2, (id, shared) => id === "c1" ? `const fs=require('fs'),end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(path.join(shared, "beside-start"))})){if(Date.now()>end)process.exit(7);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}` : "");
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 300), independent: true }, { id: "live.after", command: liveProvider(f.shared, "after", 0), independent: false }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const checked = path.join(f.shared, "checks-done");
  const proto = (await import("./scoped-checks.ts")).ScopedChecks.prototype, executeAll = proto.executeAll;
  const wrapped = vi.spyOn(proto, "executeAll").mockImplementation(async function (this: unknown, ...args: Parameters<typeof executeAll>) { const out = await executeAll.apply(this as never, args); await writeFile(checked, String(Date.now())); return out; });
  try { expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0); } finally { wrapped.mockRestore(); }
  expect(f.out.join("\n")).toMatch(/admitted: .*live\.beside\.current=satisfied_live_fact/);
  expect(f.out.join("\n")).toMatch(/live\.after\.current=satisfied_live_fact/);
  // The undeclared provider started only after every scoped check had finished.
  expect((await at(f.shared, "after-start"))!).toBeGreaterThanOrEqual((await at(f.shared, "checks-done"))!);
  expect((await at(f.shared, "beside-start"))!).toBeLessThan((await at(f.shared, "checks-done"))!);
}, 90000);
it("under failFast a scoped failure cancels a provider running beside the checks, which is reported cancelled and never passed", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, (id, shared) => `const fs=require('fs'),end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(path.join(shared, "beside-start"))})){if(Date.now()>end)process.exit(7);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}process.exit(3)`);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast: true } });
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 20000), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const started = Date.now();
  expect(await f.run("gate")).toBe(1);
  const out = f.out.join("\n") + f.err.join("\n");
  expect(out).toMatch(/^interrupted live\.beside: check_cancelled after check\.c1 failed$/m);
  expect(out).not.toMatch(/live\.beside\.current=satisfied/);
  // The gate stopped the provider through its rail, so it never finished its twenty seconds.
  expect(await at(f.shared, "beside-start")).toBeDefined();
  expect(await at(f.shared, "beside-end")).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(15000);
}, 90000);
it("failFast's cancel reaches only the rail session the gate opened for that provider", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, (_, shared) => `const fs=require('fs'),end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(path.join(shared, "opened"))})){if(Date.now()>end)process.exit(7);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}process.exit(3)`);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast: true } });
  withLiveProviders(f, [{ id: "live.beside", command: ["/bin/false"], independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  // No process at all: a scripted session records what the gate sends it and whether it closes it.
  const sessions: { providerId: string; sent: unknown[]; closed: boolean }[] = [];
  (f.runtime as { openProviderRail?: unknown }).openProviderRail = async (input: { providerId: string }) => {
    const session = { providerId: input.providerId, sent: [] as unknown[], closed: false };
    sessions.push(session); await writeFile(path.join(f.shared, "opened"), "");
    let pending: ((value: unknown) => void) | undefined;
    return { async send(message: { kind: string; requestId?: string; version?: string }) {
        session.sent.push(message);
        if (message.kind === "negotiate") pending?.({ kind: "negotiation", outcome: "supported", selectedVersion: "delivery-provider-rails/1", supportedVersions: ["delivery-provider-rails/1"] });
      },
      receive: () => new Promise(resolve => { pending = resolve; if (session.sent.length === 1) resolve({ kind: "negotiation", outcome: "supported", selectedVersion: "delivery-provider-rails/1", supportedVersions: ["delivery-provider-rails/1"] }); }),
      async close() { session.closed = true; pending?.(null); } };
  };
  expect(await f.run("gate")).toBe(1);
  expect(sessions.map(s => s.providerId)).toEqual(["live.beside"]);
  expect(sessions[0]!.sent.map(m => (m as { kind: string }).kind)).toEqual(["negotiate", "request", "cancel"]);
  expect(sessions[0]!.closed).toBe(true);
}, 90000);
it.each(["passing", "failing"] as const)("the verdict, the output in order and every record on a %s candidate are the same whether a provider runs beside the checks or after them", async outcome => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const runs: { code: number; lines: string[]; records: string[] }[] = [];
  for (const independent of [false, true]) {
    const f = await poolFixture(["1", "2"], 2, id => outcome === "failing" && id === "c2" ? "process.exit(3)" : "");
    // An undeclared provider first, then a declared one: serial applies them in that order, and so must the gate.
    withLiveProviders(f, [{ id: "live.first", command: liveProvider(f.shared, "first", 50), independent: false }, { id: "live.second", command: liveProvider(f.shared, "second", 100), independent },
      // A blocked provider too: its blockers and its failed live result must land exactly where serial puts them.
      { id: "live.third", command: liveProvider(f.shared, "third", 0, undefined, "failed"), independent }]);
    expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
    const code = await f.run("gate");
    // Timing and attempt identity aside, every line the gate printed, in its order.
    const lines = [...f.out, ...f.err].flatMap(line => line.split("\n")).filter(line => !/^(snapshot|setup|prewarm|checking) /.test(line)).map(line => normalized(f, line));
    const recordDir = path.join(f.dir, ".git/delivery-harness/records");
    const records = (await (await import("node:fs/promises")).readdir(recordDir).catch(() => [] as string[])).map(name => name.replace(/--[0-9a-f]{64}\.json$/, "")).sort();
    runs.push({ code, lines, records });
  }
  expect(runs[1]).toEqual(runs[0]);
  expect(runs[0]!.code).toBe(1);
  // Both shapes ran the checks and all three providers: the comparison is not between two empty runs.
  expect(runs[0]!.records.filter(name => name.includes("check.c")).length).toBe(outcome === "passing" ? 2 : 1);
  expect(runs[0]!.lines.join("\n")).toMatch(/live\.third/);
}, 180000);
it("a declared provider that an existential obligation shares with another stays serial, and is never started when the other satisfies it", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, () => "");
  withLiveProviders(f, [{ id: "live.one", command: liveProvider(f.shared, "one", 0), independent: false }, { id: "live.two", command: liveProvider(f.shared, "two", 0), independent: true }]);
  // One obligation either provider may satisfy, in place of the two the helper made.
  const template = f.config.obligations.find(o => o.id === "live.one.current")!;
  f.setConfig({ ...f.config, obligations: [...f.config.obligations.filter(o => !o.id.startsWith("live.")), { ...template, id: "live.either", providers: ["live.one", "live.two"], providerPolicy: "existential" }] } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  expect(f.out.join("\n")).toMatch(/live\.either=satisfied_live_fact/);
  expect(await at(f.shared, "one-start")).toBeDefined();
  expect(await at(f.shared, "two-start")).toBeUndefined();
}, 90000);

it("a declared provider an evidence obligation also names stays serial", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, () => "");
  withLiveProviders(f, [{ id: "live.both", command: liveProvider(f.shared, "both", 0), independent: true }]);
  // The same provider owes exact-candidate evidence too, which only the serial loop publishes.
  const template = f.config.obligations[0]!;
  f.setConfig({ ...f.config, obligations: [...f.config.obligations, { ...template, id: "live.both.evidence", providers: ["live.both"] }] } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const proto = (await import("./scoped-checks.ts")).ScopedChecks.prototype, executeAll = proto.executeAll, checked = path.join(f.shared, "checks-done");
  const wrapped = vi.spyOn(proto, "executeAll").mockImplementation(async function (this: unknown, ...args: Parameters<typeof executeAll>) { const out = await executeAll.apply(this as never, args); await writeFile(checked, String(Date.now())); return out; });
  try { await f.run("gate"); } finally { wrapped.mockRestore(); }
  expect((await at(f.shared, "both-start"))!).toBeGreaterThanOrEqual((await at(f.shared, "checks-done"))!);
}, 90000);
it.each([false, true])("a provider reporting its own cancellation interrupts the gate, beside the checks or not (%s)", async independent => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, () => "");
  withLiveProviders(f, [{ id: "live.stop", command: liveProvider(f.shared, "stop", 0, undefined, "cancelled"), independent }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(130);
}, 90000);
it.each([false, true])("a provider whose invocation throws fails the gate the same way, beside the checks or not (%s)", async independent => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, () => "");
  withLiveProviders(f, [{ id: "live.root", command: liveProvider(f.shared, "root", 0), independent }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const artifacts = f.runtime.artifacts!, allocate = artifacts.allocateRunRoot.bind(artifacts);
  (artifacts as { allocateRunRoot: typeof allocate }).allocateRunRoot = async input => input.providerId === "live.root" ? { ok: false, reason: "refused for the test" } as never : allocate(input);
  expect(await f.run("gate")).toBe(1);
  expect(f.err.join("\n") + f.out.join("\n")).toContain("provider_rail_run_root_refused");
}, 90000);
it("a provider running beside the checks is cancelled and awaited when the scoped run itself throws", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, () => "");
  // Slow to honour its cancel: the gate must still wait for it to end.
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 20000, undefined, "success", 1500), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const proto = (await import("./scoped-checks.ts")).ScopedChecks.prototype;
  const thrown = vi.spyOn(proto, "executeAll").mockImplementation(async (_requests, _onFailFast, onAllStarted) => {
    onAllStarted?.();
    for (const end = Date.now() + 20000; !await at(f.shared, "beside-start") && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error("the scoped run broke");
  });
  const started = Date.now();
  try { await expect(f.run("gate")).resolves.not.toBe(0); } finally { thrown.mockRestore(); }
  // The gate did not leave the provider running: it was stopped before finishing, and waited for.
  expect(await at(f.shared, "beside-end")).toBeUndefined();
  const pid = (await at(f.shared, "beside-pid"))!;
  expect(() => process.kill(pid, 0)).toThrow();
  expect(Date.now() - started).toBeLessThan(15000);
}, 90000);
it.each([true, false])("an interruption while a provider runs beside the checks interrupts the gate and stops the provider, never reported as a failure's cancellation (failFast %s)", async failFast => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, (_, shared) => `const fs=require('fs'),end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(path.join(shared, "beside-start"))})){if(Date.now()>end)process.exit(7);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)`);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast } });
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 20000), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const controller = new AbortController();
  (f.runtime as { signal?: AbortSignal }).signal = controller.signal;
  void (async () => { for (const end = Date.now() + 20000; !await at(f.shared, "beside-start") && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); })();
  expect(await f.run("gate")).toBe(130);
  expect(f.out.join("\n") + f.err.join("\n")).not.toMatch(/check_cancelled after/);
  // The invocation's own interruption reached the provider: it never ran its twenty seconds out.
  expect(await at(f.shared, "beside-end")).toBeUndefined();
}, 90000);
/** Admits as the kernel does, except that the first admission leaves out the blocked resolutions of `hidden`: what a
 * waiver lost later in the gate looks like to the loop, an obligation it requests only after its first pass. */
async function hideFromFirstAdmission(hidden: readonly string[]) {
  const kernel = await import("@agent-delivery-harness/kernel"), real = kernel.runAdmission;
  let calls = 0;
  return vi.spyOn(kernel, "runAdmission").mockImplementation(async (input, options) => {
    const result = await real(input, options);
    if (calls++ > 0 || !result.decision) return result;
    return { ...result, decision: { ...result.decision, resolutions: result.decision.resolutions.filter(r => !(r.kind === "blocked" && hidden.includes(r.obligationId))) } };
  });
}
const starts = async (shared: string, name: string) => (await readFile(path.join(shared, `${name}-starts`), "utf8").catch(() => "")).length;
it("a provider the loop later requests for more obligations than it ran beside the checks for runs again, as serial runs it then", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1"], 2, () => "");
  withLiveProviders(f, [{ id: "live.p", command: liveProvider(f.shared, "p", 0), independent: true }]);
  // A second live obligation of the same provider, which the loop sees only after its first pass.
  const template = f.config.obligations.find(o => o.id === "live.p.current")!;
  f.setConfig({ ...f.config, obligations: [...f.config.obligations, { ...template, id: "live.p.late" }] } as unknown as HarnessConfigInput);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const spy = await hideFromFirstAdmission(["live.p.late"]);
  try { expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0); } finally { spy.mockRestore(); }
  // Beside the checks for one obligation, then again for both: never the first answer replayed for the larger request.
  expect(await starts(f.shared, "p")).toBe(2);
  expect(f.out.join("\n")).toMatch(/live\.p\.late=satisfied_live_fact/);
}, 90000);
it("a second pass of the scoped pool does not start a provider that already ran beside the first", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  const f = await poolFixture(["1", "2"], 2, () => "");
  withLiveProviders(f, [{ id: "live.p", command: liveProvider(f.shared, "p", 0), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  // c2 becomes requestable only after the first pass, so the pool runs twice.
  const spy = await hideFromFirstAdmission(["check.c2.passed"]);
  try { expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0); } finally { spy.mockRestore(); }
  expect(f.out.join("\n").match(/passed check\.c\d/g)?.sort()).toEqual(["passed check.c1", "passed check.c2"]);
  expect(await starts(f.shared, "p")).toBe(1);
}, 90000);
it("providers beside the checks start only once the pool is saturated: every worker holds a check", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // Three checks on two workers. c2's and c3's base takes 1.5 s longer to set up, so the second worker stays empty
  // until then; the third check waits for c1 to free a worker. Saturation comes at the first, not the last.
  const f = await poolFixture(["1", "2", "2"], 2, (id, shared) => `require('fs').writeFileSync(${JSON.stringify(path.join(shared, `check-${id}`))},String(Date.now()));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500)`);
  slowSetups(f, ["pc2"], 1500);
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 0), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const proto = (await import("./scoped-checks.ts")).ScopedChecks.prototype, executeAll = proto.executeAll, checked = path.join(f.shared, "checks-done");
  const wrapped = vi.spyOn(proto, "executeAll").mockImplementation(async function (this: unknown, ...args: Parameters<typeof executeAll>) { const out = await executeAll.apply(this as never, args); await writeFile(checked, String(Date.now())); return out; });
  try { expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0); } finally { wrapped.mockRestore(); }
  const c1 = (await at(f.shared, "check-c1"))!, later = [(await at(f.shared, "check-c2"))!, (await at(f.shared, "check-c3"))!].sort((a, b) => a - b), beside = (await at(f.shared, "beside-start"))!;
  // c1 ran alone first; the providers waited for the second worker to fill, but not for the last check to be handed out.
  expect(later[0]! - c1).toBeGreaterThan(800);
  expect(beside).toBeGreaterThan(c1 + 800);
  expect(beside).toBeLessThan(later[1]! - 300);
  expect(beside).toBeLessThan((await at(f.shared, "checks-done"))!);
}, 90000);
it("under failFast a check failing before the pool is saturated leaves the providers beside the checks unstarted", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // c1 fails at once while c2's base is still setting up, so the second worker is still empty: the halted pool then
  // hands c2 out after the cancel, and the providers must not start then.
  const f = await poolFixture(["1", "2"], 2, id => id === "c1" ? "process.exit(3)" : "");
  slowSetups(f, ["pc2"], 2000);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, failFast: true } });
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 0), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const artifacts = f.runtime.artifacts!, allocate = artifacts.allocateRunRoot.bind(artifacts), allocated: string[] = [];
  (artifacts as { allocateRunRoot: typeof allocate }).allocateRunRoot = async input => { allocated.push(input.providerId); return allocate(input); };
  expect(await f.run("gate")).toBe(1);
  expect(f.out.join("\n")).toMatch(/^interrupted live\.beside: check_cancelled after check\.c1 failed$/m);
  // Never invoked at all: no run root, no process.
  expect(allocated).not.toContain("live.beside");
  expect(await at(f.shared, "beside-start")).toBeUndefined();
}, 90000);
it("a worker that has finished its check no longer counts toward saturation", async () => {
  if (!await (await import("./check-snapshot.ts")).snapshotCloneMethod()) return;
  // c1 finishes at once on the first worker; c2's base is ready after 1.5 s, c3's after a further 1.5 s. Only when c3
  // is handed out are both workers busy again.
  const f = await poolFixture(["1", "2", "3"], 2, (id, shared) => `require('fs').writeFileSync(${JSON.stringify(path.join(shared, `check-${id}`))},String(Date.now()));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${id === "c2" ? 4000 : 0})`);
  slowSetups(f, ["pc2", "pc3"], 1500);
  withLiveProviders(f, [{ id: "live.beside", command: liveProvider(f.shared, "beside", 0), independent: true }]);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n") + f.out.join("\n")).toBe(0);
  const c2 = (await at(f.shared, "check-c2"))!, c3 = (await at(f.shared, "check-c3"))!, beside = (await at(f.shared, "beside-start"))!;
  expect(c3 - c2).toBeGreaterThan(800);
  expect(beside).toBeGreaterThan(c3 - 400);
}, 90000);
