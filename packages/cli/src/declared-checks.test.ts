import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactsPort, defineHarnessConfig, receiptFileName, resolveReceiptStorage, type HarnessConfigInput } from "@agent-delivery-harness/kernel";
import adopterConfig from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";

// Scheduling barrier after the real evaluation: no receipt or result is mocked.
const refreshPause = vi.hoisted(() => ({
  enabled: false,
  reached: undefined as undefined | (() => void),
  resume: undefined as undefined | Promise<void>,
}));
const publicationPause = vi.hoisted(() => ({
  enabled: false,
  reached: undefined as undefined | (() => void),
  resume: undefined as undefined | Promise<void>,
}));
vi.mock("@agent-delivery-harness/kernel", async importOriginal => {
  const actual = await importOriginal<typeof import("@agent-delivery-harness/kernel")>();
  return { ...actual, evaluatePreparationReceipt: async (...args: Parameters<typeof actual.evaluatePreparationReceipt>) => {
    const result = await actual.evaluatePreparationReceipt(...args);
    if (refreshPause.enabled && args[2]?.allowValidationEquivalent && result.prepared) {
      refreshPause.enabled = false;
      refreshPause.reached!();
      await refreshPause.resume;
    }
    return result;
  }, publishPreparationReceipt: async (...args: Parameters<typeof actual.publishPreparationReceipt>) => {
    const result = await actual.publishPreparationReceipt(...args);
    if (publicationPause.enabled) {
      publicationPause.enabled = false;
      publicationPause.reached!();
      await publicationPause.resume;
    }
    return result;
  } };
});

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(command: readonly string[], outputs: string[] = [], timeoutMs = 5000) {
  const dir = await mkdtemp(path.join(tmpdir(), "declared-check-")); dirs.push(dir);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(dir, "source.ts"), "export const value = 1;\n");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "initial"); await git("branch", "origin/main");
  const input = { ...adopterConfig, preparationWiringPaths: ["harness.config.ts"], preparationCommands: [],
    providers: [...adopterConfig.providers, { id: "check.tests", findingCodes: [], check: { command, timeoutMs, outputs } }],
    obligations: [...adopterConfig.obligations, { ...adopterConfig.obligations[0]!, id: "validation.passed", activation: { kind: "always" }, providers: ["check.tests"], acceptedPayloadSpecs: ["checks.passed/1"], humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_evidence", "not_applicable"] }],
  };
  let config = defineHarnessConfig(input as unknown as HarnessConfigInput);
  const artifactDir = path.join(dir, ".git/artifacts"); await mkdir(artifactDir);
  const out: string[] = [], err: string[] = [];
  const runtime: CliRuntime = { cwd: dir, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: text => out.push(text), stderr: text => err.push(text), loadConfig: async () => config,
    artifacts: createArtifactsPort({ runRootBase: artifactDir }),
  };
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; return runCli(args, runtime); };
  return { dir, git, run, out, err, runtime, config, input, setConfig: (value: HarnessConfigInput) => { config = defineHarnessConfig(value); } };
}

async function observePreparations(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.run("emit", "run.started", "--version", "2", "--event-id", "start", "--json",
    JSON.stringify({ host: "codex", workflow: { releaseId: "fixture", profile: "core" } }))).toBe(0);
  const resolved = await resolveRunSurface(f.dir); if (!resolved.ok) throw Error(resolved.reason);
  const { store, worktreeKey } = resolved.surface;
  const current = await store.current(worktreeKey); if (!current.ok || !current.runId) throw Error("missing run");
  const runId = current.runId;
  return async () => {
    const result = await store.read(runId); if (!result.ok) throw Error("invalid journal");
    return result.events.filter(event => event.kind === "command.completed" && event.payload["command"] === "prepare");
  };
}

describe("declared deterministic check providers", () => {
  it.each([false, true])("does not republish success after an overlapping ordinary prepare (failed: %s)", async failed => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "const fs=require('fs');fs.appendFileSync('.git/mechanical','x');if(fs.existsSync('.git/fail'))process.exit(3)"], timeoutMs: 5000 }] });
    expect(await f.run("prepare")).toBe(0);
    let reached!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    refreshPause.resume = new Promise<void>(resolve => { resume = resolve; });
    refreshPause.reached = reached;
    refreshPause.enabled = true;
    const completions = await observePreparations(f);
    const refresh = runCli(["prepare", "--refresh-record-neutral"], f.runtime);
    try {
      await paused;
      if (failed) await writeFile(path.join(f.dir, ".git/fail"), "fail");
      expect(await runCli(["prepare"], f.runtime)).toBe(failed ? 1 : 0);
    } finally {
      refreshPause.enabled = false;
      resume();
    }
    expect(await refresh).toBe(1);
    expect((await completions()).at(-1)?.payload).toMatchObject({ outcome: "policy" });
    expect((await completions()).at(-1)?.payload["preparation"]).toBeUndefined();
    expect(await runCli(["review-context"], f.runtime)).toBe(failed ? 1 : 0);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xx");
  }, 30_000);


  it("an interrupted overlapping refresh revokes the shared prior success", async () => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    expect(await f.run("prepare")).toBe(0);
    let reached!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    refreshPause.resume = new Promise<void>(resolve => { resume = resolve; });
    refreshPause.reached = reached;
    refreshPause.enabled = true;
    const completions = await observePreparations(f);
    const refresh = runCli(["prepare", "--refresh-record-neutral"], f.runtime);
    try {
      await paused;
      const controller = new AbortController(); controller.abort();
      expect(await runCli(["prepare", "--refresh-record-neutral"], { ...f.runtime, signal: controller.signal })).toBe(130);
    } finally {
      refreshPause.enabled = false;
      resume();
    }
    expect(await refresh).toBe(1);
    expect((await completions()).map(event => [event.payload["outcome"], event.payload["preparation"]])).toEqual([
      ["interrupted", undefined], ["policy", undefined],
    ]);
    expect(await f.run("review-context")).toBe(1);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("x");
  }, 30_000);

  it.each([false, true])("revokes ordinary preparation interrupted after publication without revoking a newer success (%s)", async newerSuccess => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    let reached!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    publicationPause.resume = new Promise<void>(resolve => { resume = resolve; });
    publicationPause.reached = reached;
    publicationPause.enabled = true;
    const controller = new AbortController();
    const completions = await observePreparations(f);
    const preparing = runCli(["prepare"], { ...f.runtime, signal: controller.signal });
    try {
      await paused;
      if (newerSuccess) expect(await f.run("prepare")).toBe(0);
      controller.abort();
    } finally {
      publicationPause.enabled = false;
      resume();
    }
    expect(await preparing).toBe(130);
    expect((await completions()).at(-1)?.payload).toMatchObject({ outcome: "interrupted" });
    expect((await completions()).at(-1)?.payload["preparation"]).toBeUndefined();
    expect(await f.run("review-context")).toBe(newerSuccess ? 0 : 1);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe(newerSuccess ? "xx" : "x");
  }, 30_000);

  it("records fallback execution when wiring changes after a reusable receipt was evaluated", async () => {
    const f = await fixture([process.execPath, "-e", ""]);
    await writeFile(path.join(f.dir, ".git/wiring"), "first");
    f.setConfig({ ...f.config, preparationWiringPaths: ["harness.config.ts", ".git/wiring"],
      preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    const completions = await observePreparations(f);
    expect(await f.run("prepare")).toBe(0);
    let reached!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    refreshPause.resume = new Promise<void>(resolve => { resume = resolve; });
    refreshPause.reached = reached;
    refreshPause.enabled = true;
    const refresh = runCli(["prepare", "--refresh-record-neutral"], f.runtime);
    try {
      await paused;
      // Ignored wiring changes the fingerprint without changing the captured tree.
      await writeFile(path.join(f.dir, ".git/wiring"), "second");
    } finally {
      refreshPause.enabled = false;
      resume();
    }
    expect(await refresh, f.err.join("\n")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xx");
    expect((await completions()).at(-1)?.payload["preparation"]).toEqual({ checks: "executed", reason: "preparation-fingerprint-changed" });
    expect(await f.run("review-context")).toBe(0);
  }, 30_000);

  it("legacy receipts rerun mechanics before first explicit refresh", async () => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    expect(await f.run("prepare")).toBe(0);
    const { storageDir } = await resolveReceiptStorage(f.dir);
    const file = path.join(storageDir, receiptFileName(f.config.gateId));
    const receipt = JSON.parse(await readFile(file, "utf8"));
    delete receipt.validationDigest; delete receipt.policyDigest;
    await writeFile(file, JSON.stringify(receipt));
    expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xx");
    expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xx");
  });
  it("refreshes preparation only for unchanged strict validation, policy, wiring and base", async () => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    const prepare = async () => { expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0); };
    const calls = () => readFile(path.join(f.dir, ".git/mechanical"), "utf8");
    await prepare(); await prepare(); expect(await calls()).toBe("x");
    await mkdir(path.join(f.dir, "delivery/records"), { recursive: true });
    await writeFile(path.join(f.dir, "delivery/records/new.json"), "{}"); await f.git("add", ".");
    expect(await f.run("gate")).toBe(1); // Refresh never relaxes admission itself.
    await prepare(); expect(await calls()).toBe("x");
    await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "neutral artifact");
    await prepare(); expect(await calls()).toBe("x");
    await mkdir(path.join(f.dir, "docs/reports"), { recursive: true });
    await writeFile(path.join(f.dir, "docs/reports/new.html"), "report"); await f.git("add", ".");
    await prepare(); expect(await calls()).toBe("xx");
    await writeFile(path.join(f.dir, "source.ts"), "changed"); await f.git("add", ".");
    await prepare(); expect(await calls()).toBe("xxx");
    await writeFile(path.join(f.dir, "harness.config.ts"), "changed wiring"); await f.git("add", ".");
    await prepare(); expect(await calls()).toBe("xxxx");
    f.setConfig({ ...f.config, activationThreshold: 2, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    await prepare(); expect(await calls()).toBe("xxxxx");
    await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "source changes"); await f.git("branch", "-f", "origin/main", "HEAD");
    await prepare(); expect(await calls()).toBe("xxxxxx");
  }, 30_000);

  it("invalidates preparation authority when a receipt refresh is interrupted", async () => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
    expect(await f.run("prepare")).toBe(0);
    const controller = new AbortController(); controller.abort();
    expect(await runCli(["prepare", "--refresh-record-neutral"], { ...f.runtime, signal: controller.signal })).toBe(130);
    expect(await f.run("gate")).toBe(1);
    expect(await f.run("prepare")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xx");
  }, 30_000);

  it("does not reuse mechanics after a failed preparation attempt", async () => {
    const f = await fixture([process.execPath, "-e", ""]);
    f.setConfig({ ...f.config, preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "const fs=require('fs');fs.appendFileSync('.git/mechanical','x');if(fs.existsSync('.git/fail'))process.exit(3)"], timeoutMs: 5000 }] });
    expect(await f.run("prepare")).toBe(0);
    await writeFile(path.join(f.dir, "source.ts"), "changed"); await f.git("add", ".");
    await writeFile(path.join(f.dir, ".git/fail"), "fail");
    expect(await f.run("prepare")).toBe(1);
    await f.git("restore", "--staged", "--worktree", "source.ts");
    await rm(path.join(f.dir, ".git/fail"));
    expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xxx");
  }, 30_000);

  it("verifies retained check outputs after the original ignored output disappears", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').writeFileSync('.git/result',Buffer.from([0,255,128,1]))"], [".git/result"]);
    f.setConfig({ ...f.config,
      providers: [...f.config.providers, { id: "check.second", findingCodes: [], check: {
        command: [process.execPath, "-e", "require('fs').writeFileSync('.git/second-result','second')"],
        timeoutMs: 5000, outputs: [".git/second-result"],
      } }],
      obligations: f.config.obligations.map(obligation => obligation.id === "validation.passed"
        ? { ...obligation, providers: ["check.tests", "check.second"] } : obligation),
    });
    expect(await f.run("prepare")).toBe(0);
    expect(await f.run("record"), f.err.join("\n")).toBe(0);
    await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "portable evidence");
    await rm(path.join(f.dir, ".git/result"));
    await rm(path.join(f.dir, ".git/second-result"));
    expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  }, 30_000);

  it("executes argv, validates outputs and reuses unchanged evidence", async () => {
    const f = await fixture([process.execPath, "-e", "const f=require('fs');f.appendFileSync('.git/calls','x');f.writeFileSync('.git/result','passed')"], [".git/result"]);
    expect(await f.run("prepare")).toBe(0);
    expect(await f.run("gate")).toBe(0);
    expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("x");
  }, 30_000);
  it.each([
    ["exit", [process.execPath, "-e", "process.exit(3)"], [], 5000],
    ["spawn", ["/does-not-exist/check"], [], 5000],
    ["timeout", [process.execPath, "-e", "setInterval(()=>{},1000)"], [], 30],
    ["output-limit", [process.execPath, "-e", "process.stdout.write('x'.repeat(2*1024*1024))"], [], 5000],
    ["missing-output", [process.execPath, "-e", ""], ["missing.txt"], 5000],
  ] as const)("blocks %s without check evidence", async (_label, command, outputs, timeoutMs) => {
    const f = await fixture(command, [...outputs], timeoutMs);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toMatch(/check_(command_failed|output_missing)/);
  }, 30_000);
  it("does not execute expensive validation while active review is missing", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').writeFileSync('.git/expensive','ran')"]);
    await writeFile(path.join(f.dir, "source.ts"), "export const value = 2;\n"); await f.git("add", ".");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(existsSync(path.join(f.dir, ".git/expensive"))).toBe(false);
  }, 30_000);
  it.each(["source.ts", "harness.config.ts"])("rejects a passing check that changes %s", async file => {
    const f = await fixture([process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(file)},'changed')`]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toMatch(/candidate_unprepared|check_candidate_changed/);
  }, 30_000);
  it("rechecks changed policy and the same provider id with changed argv", async () => {
    const command = [process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"];
    const f = await fixture(command);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    f.setConfig({ ...f.config, activationThreshold: 2 });
    expect(await f.run("gate")).toBe(0);
    f.setConfig({ ...f.config, providers: f.config.providers.map(provider => provider.id === "check.tests" ? { ...provider, check: { command: [process.execPath, "-e", "require('fs').appendFileSync('.git/calls','y')"], timeoutMs: 5000 } } : provider) });
    expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xxy");
  }, 30_000);
  it("blocks a moved base until preparation and reruns its check", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "move base"); await f.git("branch", "-f", "origin/main", "HEAD");
    expect(await f.run("gate")).toBe(1); expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xx");
  }, 30_000);
  it("invalidates validation for a review-neutral report but reuses after a record-neutral edit", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"]);
    f.setConfig({ ...f.config, activationThreshold: 100 });
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await mkdir(path.join(f.dir, "docs/reports"), { recursive: true }); await writeFile(path.join(f.dir, "docs/reports/report.md"), "new report"); await f.git("add", ".");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await mkdir(path.join(f.dir, "delivery/records"), { recursive: true }); await writeFile(path.join(f.dir, "delivery/records/run.json"), "{}"); await f.git("add", ".");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xx");
  }, 30_000);
  it("reruns when a required output disappears or changes", async () => {
    const f = await fixture([process.execPath, "-e", "const f=require('fs');f.appendFileSync('.git/calls','x');f.writeFileSync('.git/result','passed')"], [".git/result"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await rm(path.join(f.dir, ".git/result")); expect(await f.run("gate")).toBe(0);
    await writeFile(path.join(f.dir, ".git/result"), "different"); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xxx");
  }, 30_000);
  it("does not accept a caller parent-skip flag", async () => {
    const f = await fixture([process.execPath, "-e", "process.exit(3)"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate", "--parent-passed")).not.toBe(0);
  }, 30_000);
  it("cancellation publishes no reusable evidence", async () => {
    const f = await fixture([process.execPath, "-e", "setInterval(()=>{},1000)"]);
    expect(await f.run("prepare")).toBe(0);
    const controller = new AbortController();
    const pending = runCli(["gate"], { ...f.runtime, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).not.toBe(0);
    expect(f.out.join("\n")).not.toContain("admitted");
  }, 30_000);

  it("rejects a moved base during an otherwise passing check", async () => {
    const f = await fixture([process.execPath, "-e", "const x=require('child_process');const id=x.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit-tree','HEAD^{tree}','-p','HEAD','-m','new base'],{encoding:'utf8'}).trim();x.execFileSync('git',['update-ref','refs/heads/origin/main',id])"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_candidate_changed");
  }, 30_000);
  it.each([
    { command: ["node"], timeoutMs: 0 },
    { command: ["node"], timeoutMs: 10, outputs: ["../outside"] },
    { command: ["node"], timeoutMs: 10, outputs: ["same", "same"] },
    { command: ["node"], timeoutMs: 10, parentPassed: true },
  ])("rejects invalid check configuration %j", async check => {
    const f = await fixture([process.execPath, "-e", ""]);
    expect(() => f.setConfig({ ...f.config, providers: [{ id: "check.tests", findingCodes: [], check }, ...f.config.providers.filter(provider => provider.id !== "check.tests")] } as unknown as HarnessConfigInput)).toThrow();
  }, 30_000);

  it("rechecks installed release swaps with the same package version and blocks corrupt receipts", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"]);
    await writeFile(path.join(f.dir, ".git/info/exclude"), ".agent-skills/\n");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await mkdir(path.join(f.dir, ".agent-skills"));
    const receipt = (releaseId: string) => JSON.stringify({ release: { releaseId, profile: "linear-v2", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) } });
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), receipt("first")); expect(await f.run("gate")).toBe(0);
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), receipt("second")); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xxx");
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), "broken"); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_release_unreadable");
  }, 30_000);
  it("rejects an installed release change while checks run", async () => {
    const f = await fixture([process.execPath, "-e", "const f=require('fs');const p='.agent-skills/active.json';const v=JSON.parse(f.readFileSync(p));v.release.releaseId='changed';f.writeFileSync(p,JSON.stringify(v))"]);
    await writeFile(path.join(f.dir, ".git/info/exclude"), ".agent-skills/\n"); await mkdir(path.join(f.dir, ".agent-skills"));
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), JSON.stringify({ release: { releaseId: "first", profile: "linear-v2", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) } }));
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_candidate_changed");
  }, 30_000);

});

it("rejects wiring drift after refresh skipped repairs, then repairs on retry", async () => {
  const f = await fixture([process.execPath, "-e", ""]);
  await writeFile(path.join(f.dir, ".git/wiring"), "first");
  f.setConfig({ ...f.config, preparationWiringPaths: ["harness.config.ts", ".git/wiring"],
    scopedExecution: { version: "scoped-execution/1", mechanicalProviders: [],
      profiles: [{ id: "fixture", gitContext: "none", dependencyInputs: [], mutableOutputs: [], credentialIdentities: {} }],
      repairCommands: [{ id: "repair", command: [process.execPath, "-e", "const fs=require('fs');fs.appendFileSync('.git/repair-count','x');fs.writeFileSync('.git/repaired-wiring',fs.readFileSync('.git/wiring'))"], timeoutMs: 5000 }] },
    preparationCommands: [{ id: "mechanical", command: [process.execPath, "-e", "require('fs').appendFileSync('.git/mechanical','x')"], timeoutMs: 5000 }] });
  expect(await f.run("prepare")).toBe(0);
  let reached!: () => void, resume!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  refreshPause.resume = new Promise<void>(resolve => { resume = resolve; });
  refreshPause.reached = reached; refreshPause.enabled = true;
  const refresh = runCli(["prepare", "--refresh-record-neutral"], f.runtime);
  try { await paused; await writeFile(path.join(f.dir, ".git/wiring"), "second"); }
  finally { refreshPause.enabled = false; resume(); }
  expect(await refresh, f.err.join("\n")).toBe(1);
  expect(f.err.join("\n")).toContain("preparation_candidate_changed");
  expect(await f.run("review-context")).toBe(1);
  expect(await readFile(path.join(f.dir, ".git/repair-count"), "utf8")).toBe("x");
  expect(await f.run("prepare", "--refresh-record-neutral"), f.err.join("\n")).toBe(0);
  expect(await f.run("review-context"), f.err.join("\n")).toBe(0);
  expect(await readFile(path.join(f.dir, ".git/mechanical"), "utf8")).toBe("xx");
  expect(await readFile(path.join(f.dir, ".git/repaired-wiring"), "utf8")).toBe("second");
  expect(await readFile(path.join(f.dir, ".git/repair-count"), "utf8")).toBe("xx");
}, 30000);
