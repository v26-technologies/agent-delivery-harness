import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactsPort, defineHarnessConfig, DELIVERY_POSTURE_PATH, resolveDeliveryPosture, type HarnessConfigInput } from "@agent-delivery-harness/kernel";
import adopterConfig from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
let pinnedStore: string | undefined;
beforeEach(() => { pinnedStore = process.env["DELIVERY_HARNESS_RUN_STORE"]; });
afterEach(async () => {
  process.env["DELIVERY_HARNESS_RUN_STORE"] = pinnedStore;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const HONOURING = ["verify", "gate", "record", "resume"] as const;
const FOCUSED_REASON = "The gate is still being optimized.";
const declaration = (posture: string, reason = FOCUSED_REASON): string =>
  `${JSON.stringify({ schemaVersion: "delivery-posture/1", posture, reason })}\n`;

/**
 * A real bare remote, a seed that publishes to it, and a real clone holding a
 * candidate branch. One obligation, a declared check whose command writes a
 * sentinel, so a gate that ran anything leaves a file behind.
 */
async function fixture(options: { readonly baseRef?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cli-dp-")); dirs.push(root);
  const remote = path.join(root, "remote.git"), seed = path.join(root, "seed"), repo = path.join(root, "repo");
  const sentinel = path.join(root, "sentinel");
  const run = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, maxBuffer: 1 << 24 })).stdout.trim();
  await mkdir(remote); await run(remote, "init", "-q", "--bare", "-b", "main");
  await mkdir(seed); await run(seed, "init", "-q", "-b", "main");
  await run(seed, "config", "user.name", "Test"); await run(seed, "config", "user.email", "test@example.invalid");
  await run(seed, "remote", "add", "origin", remote);
  await writeFile(path.join(seed, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(seed, "source.ts"), "export const value = 1;\n");
  const publish = async (content: string | null, branch = "main"): Promise<string> => {
    await mkdir(path.join(seed, ".agents"), { recursive: true });
    const file = path.join(seed, DELIVERY_POSTURE_PATH);
    if (content === null) await rm(file, { force: true });
    else await writeFile(file, content);
    await writeFile(path.join(seed, "touched"), `${Math.random()}\n`);
    await run(seed, "add", "-A"); await run(seed, "-c", "commit.gpgsign=false", "commit", "-qm", "publish");
    await run(seed, "push", "-qf", "origin", `HEAD:refs/heads/${branch}`);
    return run(seed, "rev-parse", "HEAD");
  };
  await publish(null);
  await run(root, "clone", "-q", remote, repo);
  const git = (...args: string[]) => run(repo, ...args);
  await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await git("checkout", "-q", "-b", "candidate");
  await writeFile(path.join(repo, "candidate.ts"), "export const candidate = 1;\n");
  await git("add", "-A"); await git("-c", "commit.gpgsign=false", "commit", "-qm", "candidate");

  const input = {
    ...adopterConfig,
    ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
    preparationWiringPaths: ["harness.config.ts"],
    preparationCommands: [],
    providers: [{ id: "check.tests", findingCodes: [], check: { command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)},"ran")`], timeoutMs: 20_000, outputs: [] } }],
    obligations: [{ ...adopterConfig.obligations[0]!, id: "validation.passed", activation: { kind: "always" }, providers: ["check.tests"], acceptedPayloadSpecs: ["checks.passed/1"], humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_evidence", "not_applicable"] }],
  };
  const config = defineHarnessConfig(input as unknown as HarnessConfigInput);
  const artifactDir = path.join(repo, ".git/artifacts"); await mkdir(artifactDir);
  const out: string[] = [], err: string[] = [];
  const runtime: CliRuntime = { cwd: repo, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: text => out.push(text), stderr: text => err.push(text), loadConfig: async () => config,
    artifacts: createArtifactsPort({ runRootBase: artifactDir }),
  };
  /** One invocation's whole observable result. */
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    const code = await runCli(args, runtime);
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  return { root, repo, seed, remote, sentinel, publish, git, cli, config, runtime,
    tracking: () => git("rev-parse", "refs/remotes/origin/main"),
    /** The candidate-keyed path `verify` expects, as it reports it under `gate`. */
    recordPath: async () => {
      const { stderr } = await cli("verify");
      const match = /expected (\S+)/.exec(stderr);
      if (match === null) throw new Error(`no expected record path in: ${stderr}`);
      return path.join(repo, match[1]!);
    },
  };
}

/**
 * Every file a command could have written outside git's own bookkeeping, with its
 * bytes, so an append to a journal shows as well as a new file. The run store is
 * named by the caller, because the suite's pin is shared with every other test
 * file running at the same time.
 */
async function filesWritten(f: Awaited<ReturnType<typeof fixture>>, runStore: string): Promise<Readonly<Record<string, string>>> {
  const written: Record<string, string> = {};
  for (const store of [f.repo, runStore]) {
    if (!existsSync(store)) continue;
    for (const entry of await readdir(store, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath, entry.name);
      const relative = path.relative(f.repo, full);
      if (/^\.git\/(objects|refs|logs|hooks|info|branches|packed-refs|HEAD|ORIG_HEAD|config|description|index)/.test(relative)) continue;
      written[full] = await readFile(full, "base64");
    }
  }
  return written;
}

const expectFocused = (result: { code: number; stdout: string; stderr: string }, tip: string, reason = FOCUSED_REASON) => {
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`outcome: focused\nposture: focused\nreason: ${reason}\nsource: origin/main\nbase tip: ${tip}\n`);
};

describe("base focused", () => {
  it.each(HONOURING)("%s exits 0 with the focused outcome and no record", async (command) => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused"));
    expectFocused(await f.cli(command), tip);
  });

  it("still answers a malformed invocation as a usage error", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    expect((await f.cli("verify", "--nope")).code).toBe(2);
    expect((await f.cli("gate", "extra")).code).toBe(2);
    expect((await f.cli("record", "--keep-superseded")).code).toBe(2);
    expect((await f.cli("resume", "--nope")).code).toBe(2);
  });

  it.each(HONOURING)("%s leaves a corrupt record alone, writes nothing and runs nothing", async (command) => {
    const f = await fixture();
    // A store of this test's own, holding a real current run, so that "no new
    // file in the run store" is a claim about a store that is in use.
    const runStore = path.join(f.root, "run-store");
    process.env["DELIVERY_HARNESS_RUN_STORE"] = runStore;
    const started = await f.cli("emit", "run.started", "--json", JSON.stringify({ host: "codex", workflow: { releaseId: "test", profile: "linear" } }));
    expect(started.code, started.stderr).toBe(0);
    const recordPath = await f.recordPath();
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, "{ corrupt");
    // The control: at this base the corrupt record is what `verify` reports.
    expect((await f.cli("verify")).code).toBe(1);

    const tip = await f.publish(declaration("focused"));
    const before = await filesWritten(f, runStore);
    expect(Object.keys(before).filter(file => file.startsWith(runStore))).not.toEqual([]);
    expectFocused(await f.cli(command), tip);
    expect(await readFile(recordPath, "utf8")).toBe("{ corrupt");
    expect(await filesWritten(f, runStore)).toEqual(before);
    expect(existsSync(f.sentinel)).toBe(false);
  });

  it("the journal check is real: under gate the same commands append to the run", async () => {
    const f = await fixture();
    const runStore = path.join(f.root, "run-store");
    process.env["DELIVERY_HARNESS_RUN_STORE"] = runStore;
    expect((await f.cli("emit", "run.started", "--json", JSON.stringify({ host: "codex", workflow: { releaseId: "test", profile: "linear" } }))).code).toBe(0);
    await f.publish(declaration("gate"));
    const before = await filesWritten(f, runStore);
    await f.cli("verify");
    expect(await filesWritten(f, runStore)).not.toEqual(before);
  });

  it("gates, by the real command, on a bare repository in the candidate's tree when origin isn't configured", async () => {
    const f = await fixture();
    const inTree = path.join(f.root, "in-tree.git");
    await f.git("clone", "-q", "--bare", f.remote, inTree);
    const work = path.join(f.root, "in-tree-work");
    await f.git("clone", "-q", inTree, work);
    await f.git("-C", work, "config", "user.name", "Test"); await f.git("-C", work, "config", "user.email", "test@example.invalid");
    await mkdir(path.join(work, ".agents"), { recursive: true });
    await writeFile(path.join(work, DELIVERY_POSTURE_PATH), declaration("focused"));
    await f.git("-C", work, "add", "-A"); await f.git("-C", work, "-c", "commit.gpgsign=false", "commit", "-qm", "self-declare");
    await f.git("-C", work, "push", "-q", "origin", "HEAD:refs/heads/main");
    await cp(inTree, path.join(f.repo, "origin"), { recursive: true });
    await f.git("add", "-A", "-f", "origin"); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "a remote in the tree");
    await f.git("remote", "remove", "origin");
    for (const command of ["verify", "gate"]) {
      const result = await f.cli(command);
      expect(result.stdout).not.toContain("outcome: focused");
      expect(result.code).toBe(1);
    }
  });

  it("answers an interrupt during a hanging read with exit 130, killing what it started", async () => {
    const f = await fixture();
    await f.publish(declaration("focused"));
    const bin = path.join(f.root, "shim"); await mkdir(bin);
    const real = (await exec("/bin/sh", ["-c", "command -v git"])).stdout.trim();
    await writeFile(path.join(bin, "git"), `#!/bin/sh\ncase "$1" in\n  ls-remote) sleep 120 ;;\nesac\nexec "${real}" "$@"\n`);
    await chmod(path.join(bin, "git"), 0o755);
    const original = process.env["PATH"];
    process.env["PATH"] = `${bin}${path.delimiter}${original}`;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const started = Date.now();
      const code = await runCli(["verify"], { ...f.runtime, signal: controller.signal });
      expect(code).toBe(130);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { process.env["PATH"] = original; }
  }, 30_000);

  it("the sentinel is real: the same obligation runs it under gate", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    expect((await f.cli("prepare")).code).toBe(0);
    await f.cli("gate");
    expect(existsSync(f.sentinel)).toBe(true);
  });

  it("neutralizes a reason's control characters and line breaks in the outcome", async () => {
    const f = await fixture();
    const tip = await f.publish(declaration("focused", "first\nsecond\u001b[31m"));
    const { stdout, code } = await f.cli("verify");
    expect(code).toBe(0);
    expect(stdout.split("\n")).toHaveLength(6);
    expect(stdout).not.toContain("\u001b");
    expect(stdout).toContain(`base tip: ${tip}`);
  });

  it("admit and check refuse what they refuse under gate", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const gatedCheck = await f.cli("check");
    const gatedAdmit = await f.cli("admit", "--outcome", "no-such-outcome.json");
    expect(gatedAdmit.code).not.toBe(0);

    await f.publish(declaration("focused"));
    expect(await f.cli("check")).toEqual(gatedCheck);
    expect(await f.cli("admit", "--outcome", "no-such-outcome.json")).toEqual(gatedAdmit);
  });
});

describe("base gate", () => {
  it("still gates a candidate declaring focused", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    await mkdir(path.join(f.repo, ".agents"), { recursive: true });
    await writeFile(path.join(f.repo, DELIVERY_POSTURE_PATH), declaration("focused"));
    await f.git("add", "-A"); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "self-declare");
    const result = await f.cli("verify");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("delivery_record_missing");
    expect(result.stdout).not.toContain("focused");
  });

  it("gates on a local branch and a tag spelled as the base carrying focused", async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    await f.git("fetch", "-q", "origin");
    const focused = await f.publish(declaration("focused"), "elsewhere");
    await f.git("fetch", "-q", "origin", "refs/heads/elsewhere");
    await f.git("branch", "origin/main", focused);
    await f.git("tag", "origin/main", focused);
    const result = await f.cli("verify");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("delivery_record_missing");
  });

  it.each([
    ["a candidate branched from focused, the base later gate", "focused", "gate", false],
    ["a candidate branched from gate, the base later focused", "gate", "focused", true],
  ])("reads the tip for %s", async (_name, earlier, later, isFocused) => {
    const f = await fixture();
    await f.publish(declaration(earlier));
    await f.git("fetch", "-q", "origin");
    await f.git("checkout", "-q", "-B", "candidate", "origin/main");
    const tip = await f.publish(declaration(later));
    const result = await f.cli("verify");
    if (isFocused) expectFocused(result, tip);
    else expect(result.code).toBe(1);
  });
});

describe("output that does not change", () => {
  /** The same candidate under each base state, with the output each gives. */
  const outcomes = async (command: string) => {
    const f = await fixture();
    const results: Record<string, Awaited<ReturnType<typeof f.cli>>> = {};
    results["undeclared"] = await f.cli(command);
    await f.publish(declaration("gate"));
    results["gate"] = await f.cli(command);
    await f.git("remote", "set-url", "origin", path.join(f.root, "gone.git"));
    await f.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    results["unreadable"] = await f.cli(command);
    return results;
  };

  it.each(HONOURING)("%s is byte for byte the same undeclared, gate and unreadable, naming no posture", async (command) => {
    const results = await outcomes(command);
    expect(results["gate"]).toEqual(results["undeclared"]);
    expect(results["unreadable"]).toEqual(results["undeclared"]);
    const text = results["undeclared"]!.stdout + results["undeclared"]!.stderr;
    expect(text).not.toMatch(/posture|focused/);
  });

  it("a plain baseRef of main gives the output of the candidate's own capture and names no posture", async () => {
    const f = await fixture({ baseRef: "main" });
    await f.publish(declaration("focused"));
    await f.git("fetch", "-q", "origin", "main:main");
    const result = await f.cli("verify");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("delivery_record_missing");
    expect(result.stdout + result.stderr).not.toMatch(/posture|focused/);
  });
});

describe("a malformed declaration", () => {
  it.each(HONOURING)("%s stays gated and names the code and reason on stderr, leaving stdout as it was", async (command) => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const gated = await f.cli(command);
    await f.publish("not json");
    const result = await f.cli(command);
    expect(result.code).toBe(gated.code);
    expect(result.stdout).toBe(gated.stdout);
    expect(result.stderr).toMatch(new RegExp(`^posture_malformed: ${DELIVERY_POSTURE_PATH.replace(".", "\\.")} on origin/main is malformed`));
    expect(result.stderr).toContain(gated.stderr);
  });
});

describe("no side effect on the base", () => {
  it("a passing verify stays passing when the remote moves, in a repository that declares nothing", async () => {
    const f = await fixture();
    expect((await f.cli("prepare")).code).toBe(0);
    const gate = await f.cli("gate");
    expect(gate.code, gate.stderr).toBe(0);
    const recorded = await f.cli("record");
    expect(recorded.code, recorded.stderr).toBe(0);
    await f.git("add", "-A"); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "record");
    const verified = await f.cli("verify");
    expect(verified.code, verified.stderr).toBe(0);

    const tracking = await f.tracking();
    await f.publish(null);
    await f.publish(null);
    const after = await f.cli("verify");
    expect(after).toEqual(verified);
    expect(await f.tracking()).toBe(tracking);
  });
});

describe("a baseRef moved to a branch that publishes itself", () => {
  /** The real CLI in its own process, so `harness.config.ts` itself is what loads. */
  const realCli = async (cwd: string, ...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("packages/cli/src/main.ts"), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });

  const configText = (f: Awaited<ReturnType<typeof fixture>>, baseRefSource: string) =>
    `${baseRefSource}\nexport default { ...${JSON.stringify(f.config)}, baseRef };\n`;

  const setUp = async () => {
    const f = await fixture();
    await f.publish(declaration("gate"));
    const self = await f.publish(declaration("focused"), "self");
    await f.git("fetch", "-q", "origin");
    return { f, self };
  };

  const expectGated = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const result = await realCli(f.repo, "verify");
    expect(result.stdout).not.toContain("outcome: focused");
    expect(result.code).toBe(1);
    expect(await resolveDeliveryPosture({ rootDir: f.repo, baseRef: "origin/self" })).toMatchObject({ posture: "gate", code: "posture_unreadable", source: "fallback" });
  };

  it("by a direct edit, committed", async () => {
    const { f } = await setUp();
    await writeFile(path.join(f.repo, "harness.config.ts"), configText(f, `const baseRef = "origin/self";`));
    await f.git("add", "-A"); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "self-base");
    await expectGated(f);
  });

  it("by an imported module", async () => {
    const { f } = await setUp();
    await writeFile(path.join(f.repo, "base.ts"), `export const baseRef = "origin/self";\n`);
    await writeFile(path.join(f.repo, "harness.config.ts"), configText(f, `import { baseRef } from "./base.ts";`));
    await f.git("add", "-A"); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "self-base");
    await expectGated(f);
  });

  it("by an uncommitted edit", async () => {
    const { f } = await setUp();
    await writeFile(path.join(f.repo, "harness.config.ts"), configText(f, `const baseRef = "origin/self";`));
    await expectGated(f);
  });
});
