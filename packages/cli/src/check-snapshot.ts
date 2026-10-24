/** Private execution tree. Never shares writable source, objects, index or dependencies. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExecPort, type ExecOutcome } from "@agent-delivery-harness/kernel";

import { snapshotInventoryWorker } from "./snapshot-inventory-worker.ts";

const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
export class CheckSnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export type SnapshotPhase = "materialization" | "baseline-inventory" | "dependencies" | "post-dependency-inventory" | "verification";
export interface SnapshotRequest {
  readonly rootDir: string;
  readonly candidate: { readonly treeSha: string; readonly headSha: string; readonly base: { readonly ref: string; readonly tipSha: string; readonly mergeBaseSha: string } };
  readonly outputs: readonly string[];
  readonly gitContext?: "full" | "none";
  readonly environment: Readonly<Record<string, string>>;
  readonly dependencies?: { readonly command: readonly [string, ...string[]]; readonly timeoutMs: number };
  readonly onDependencyResult?: (result: ExecOutcome, durationMs: number) => void;
  /** Best-effort phase timing only; never admission evidence. */
  readonly onPhase?: (phase: SnapshotPhase, durationMs: number) => void;
  readonly signal?: AbortSignal;
}
export interface CheckSnapshot {
  readonly commandRoot: string;
  readonly rootDir: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly dependencyDigest: string;
  /** `outputs` narrows the writable paths to one profile's within a snapshot shared by several. */
  verify(options?: { readonly timeoutMs?: number; readonly outputs?: readonly string[] }): Promise<void>;
  cleanup(): Promise<void>;
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Kill the owned read-only process and await close before callers may clean up.
 * AbortSignal is handled here: child_process's early AbortError event is not
 * proof that the process has stopped touching the snapshot. */
async function snapshotProcess(command: string, args: string[], cwd: string, env: Readonly<Record<string, string>>, deadline: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  if (signal?.aborted) throw new CheckSnapshotError("check_snapshot_interrupted", "Snapshot verification was interrupted.");
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new CheckSnapshotError("check_snapshot_timeout", "Snapshot verification exceeded its deadline.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let failure: CheckSnapshotError | undefined, stdout = "", size = 0;
    const stop = (code: string, message: string) => {
      failure ??= new CheckSnapshotError(code, message);
      child.kill("SIGKILL");
    };
    const abort = () => stop("check_snapshot_interrupted", "Snapshot verification was interrupted.");
    const timer = setTimeout(() => stop("check_snapshot_timeout", "Snapshot verification exceeded its deadline."), remaining);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 64 * 1024) stop("check_snapshot_unavailable", "Snapshot verifier output exceeded its limit.");
      else stdout += bytes.toString();
    });
    child.stderr.on("data", () => {}); // Drain; never expose private paths or source bytes.
    child.on("error", () => { failure ??= new CheckSnapshotError("check_snapshot_unavailable", "Snapshot verifier could not execute."); });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (!failure && performance.now() >= deadline) failure = new CheckSnapshotError("check_snapshot_timeout", "Snapshot verification exceeded its deadline.");
      if (failure) reject(failure); else resolve({ code, stdout });
    });
  });
}
/** The inventory's blocking filesystem operations live only in a killable process. */
export async function snapshotInventory(root: string, outputs: readonly string[], excludeDependencies = false, deadline = performance.now() + SNAPSHOT_TIMEOUT_MS, signal?: AbortSignal, forbidGit = false): Promise<string> {
  return (await snapshotDigests(root, outputs, excludeDependencies, deadline, signal, forbidGit)).digest;
}
async function snapshotDigests(root: string, outputs: readonly string[], excludeDependencies: boolean, deadline: number, signal?: AbortSignal, forbidGit = false, includeSource = false): Promise<{ digest: string; sourceDigest?: string }> {
  const result = await snapshotProcess(process.execPath, ["--input-type=module", "--eval", snapshotInventoryWorker], root,
    { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DELIVERY_SNAPSHOT_REQUEST: JSON.stringify({ root, outputs, excludeDependencies, forbidGit, includeSource }) }, deadline, signal);
  let parsed: { code?: string; digest?: string; sourceDigest?: string };
  try { parsed = JSON.parse(result.stdout); } catch { throw new CheckSnapshotError("check_snapshot_unavailable", "Snapshot inventory returned no valid result."); }
  if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(parsed.digest ?? "") || (includeSource && !/^[a-f0-9]{64}$/.test(parsed.sourceDigest ?? ""))) throw new CheckSnapshotError(["check_snapshot_escape", "check_snapshot_drift"].includes(parsed.code ?? "") ? parsed.code! : "check_snapshot_unavailable", "Snapshot inventory could not verify private bytes and links.");
  return { digest: parsed.digest!, ...(includeSource ? { sourceDigest: parsed.sourceDigest! } : {}) };
}
export function executionPath(root: string, value: string): string {
  return value.split(path.delimiter).filter(p => p && path.isAbsolute(p) && !inside(root, p) && !p.split(path.sep).includes("node_modules")).join(path.delimiter) || "/usr/bin:/bin";
}
export async function createCheckSnapshot(input: SnapshotRequest): Promise<CheckSnapshot> {
  const report = (phase: SnapshotPhase, started: number) => {
    try { input.onPhase?.(phase, performance.now() - started); } catch { /* Timing cannot change admission. */ }
  };
  const measured = async <T>(phase: SnapshotPhase, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { return await operation(); } finally { report(phase, started); }
  };
  const materializationStarted = performance.now();
  const rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "delivery-check-")));
  const cleanEnv = { ...input.environment, PATH: executionPath(input.rootDir, input.environment["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
  let privateControl: string | undefined;
  let gitDirectory: string | undefined;
  const git = async (...args: string[]) => {
    const controller = new AbortController();
    let timedOut = false;
    const deadline = performance.now() + SNAPSHOT_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SNAPSHOT_TIMEOUT_MS);
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      const result = await createExecPort().run({ command: "git", args: gitDirectory ? [`--git-dir=${gitDirectory}`, `--work-tree=${rootDir}`, ...args] : args,
        cwd: rootDir, env: cleanEnv, maxBuffer: 128 * 1024 * 1024, signal: controller.signal });
      timedOut ||= performance.now() >= deadline;
      if (timedOut || result.code !== 0) throw new CheckSnapshotError(timedOut ? "check_snapshot_timeout" : input.signal?.aborted ? "check_snapshot_interrupted" : "check_snapshot_unavailable", "Private Git materialization did not complete successfully.");
      return result.stdout.trim();
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  };
  const cleanup = async () => {
    const removed = await Promise.allSettled([rootDir, ...(privateControl ? [privateControl] : [])].map(dir => rm(dir, { recursive: true, force: true })));
    if (removed.some(result => result.status === "rejected")) throw new CheckSnapshotError("check_snapshot_cleanup_failed", "Cannot remove the owned execution snapshot after retaining evidence.");
  };
  try {
    await git("init", "-q");
    // Fetch transfers object bytes; unlike worktrees/alternates/local clones it
    // cannot create writable links back to the author's Git metadata.
    // Accept the source's shallow boundary in this private repository. Without
    // it, fetch can reject objects or succeed while dropping required grafts.
    await git("fetch", "--update-shallow", "--no-tags", "--no-write-fetch-head", input.rootDir, input.candidate.headSha, input.candidate.base.tipSha, input.candidate.treeSha);
    await git("update-ref", "HEAD", input.candidate.headSha);
    await git("read-tree", input.candidate.treeSha);
    await git("checkout-index", "--all", "--force");
    if ((await git("ls-tree", "-r", "--name-only", input.candidate.treeSha)).split("\n").some(p => p.split("/").includes("node_modules"))) throw new CheckSnapshotError("check_dependency_source_overlap", "Tracked node_modules cannot be replaced by private dependency setup.");
    const candidateRef = "refs/delivery/candidate", baseRef = "refs/delivery/base";
    const candidateCommit = await git("-c", "user.name=Delivery", "-c", "user.email=delivery@example.invalid", "-c", "commit.gpgsign=false", "commit-tree", input.candidate.treeSha, "-p", input.candidate.headSha, "-m", "Prepared execution snapshot");
    await git("update-ref", candidateRef, candidateCommit);
    await git("update-ref", "refs/delivery/origin-head", input.candidate.headSha);
    await git("update-ref", "HEAD", candidateCommit);
    await git("update-ref", baseRef, input.candidate.base.tipSha);
    await git("update-ref", "refs/delivery/merge-base", input.candidate.base.mergeBaseSha);
    // Conventional branch refs also resolve to the pinned base for existing checks.
    if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.candidate.base.ref)) await git("update-ref", input.candidate.base.ref.startsWith("refs/") ? input.candidate.base.ref : `refs/remotes/${input.candidate.base.ref}`, input.candidate.base.tipSha);
    if (input.gitContext === "none") {
      privateControl = await realpath(await mkdtemp(path.join(tmpdir(), "delivery-check-control-")));
      gitDirectory = path.join(privateControl, "repository");
      await rename(path.join(rootDir, ".git"), gitDirectory);
    }
    const controlRoot = privateControl ?? path.join(rootDir, ".git");
    const inventory = (outputs: readonly string[], sourceOnly = false, deadline = performance.now() + SNAPSHOT_TIMEOUT_MS) => snapshotInventory(rootDir, outputs, sourceOnly, deadline, input.signal, input.gitContext === "none");
    report("materialization", materializationStarted);
    // Setup needs a source baseline only when a dependency command can mutate it.
    const baseline = await measured("baseline-inventory", () => inventory(input.outputs, Boolean(input.dependencies)));
    let dependencyDigest = baseline;
    const environment: Record<string, string> = { ...input.environment, PATH: `${path.join(rootDir, "node_modules/.bin")}${path.delimiter}${cleanEnv["PATH"]}`, HOME: path.join(controlRoot, "home"), TMPDIR: path.join(controlRoot, "tmp"), GIT_CEILING_DIRECTORIES: path.dirname(rootDir),
      ...(input.gitContext === "none" ? {} : {
      DELIVERY_CHECK_BASE_REF: baseRef, DELIVERY_CHECK_CANDIDATE_REF: candidateRef, DELIVERY_CHECK_ORIGIN_HEAD: input.candidate.headSha, DELIVERY_CHECK_ORIGIN_TREE: input.candidate.treeSha, DELIVERY_CHECK_MERGE_BASE: input.candidate.base.mergeBaseSha }) };
    await mkdir(environment["HOME"]!, { recursive: true }); await mkdir(environment["TMPDIR"]!, { recursive: true });
    if (input.dependencies) {
      const started = performance.now();
      const result = await measured("dependencies", () => createExecPort().run({ command: input.dependencies!.command[0], args: input.dependencies!.command.slice(1), cwd: rootDir, env: environment, timeoutMs: input.dependencies!.timeoutMs, maxBuffer: 1024 * 1024, ...(input.signal ? { signal: input.signal } : {}) }));
      input.onDependencyResult?.(result, Math.round(performance.now() - started));
      if (result.code !== 0 || input.signal?.aborted) throw new CheckSnapshotError("check_dependency_failed", "Private dependency installation did not complete successfully.");
      // Both digests use the same tuples from one safety walk, hashing each
      // immutable file once. Source comparison still excludes node_modules.
      const installed = await measured("post-dependency-inventory", () => snapshotDigests(rootDir, input.outputs, false, performance.now() + SNAPSHOT_TIMEOUT_MS, input.signal, input.gitContext === "none", true));
      if (baseline !== installed.sourceDigest) throw new CheckSnapshotError("check_snapshot_drift", "Dependency setup changed prepared source bytes.");
      dependencyDigest = installed.digest;
    }
    // The full baseline always covers source, dependencies and immutable links.
    const verify = async (options?: { readonly timeoutMs?: number; readonly outputs?: readonly string[] }) => {
      return measured("verification", async () => {
        const timeoutMs = options?.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SNAPSHOT_TIMEOUT_MS) throw new CheckSnapshotError("check_snapshot_timeout", "Snapshot deadline must be positive and cannot exceed five minutes.");
        const deadline = performance.now() + timeoutMs;
        // The worker also checks file-only Git metadata, so lstat cannot stall the parent.
        const verifyGit = async (...args: string[]) => {
          const result = await snapshotProcess("git", gitDirectory ? [`--git-dir=${gitDirectory}`, `--work-tree=${rootDir}`, ...args] : args, rootDir, cleanEnv, deadline, input.signal);
          if (result.code !== 0) throw new CheckSnapshotError("check_snapshot_unavailable", "Snapshot Git identity could not be read.");
          return result.stdout.trim();
        };
        // One worker checks every non-Git link/type and hashes only immutable bytes.
        // Finish safety validation before Git reads, under the same owned deadline.
        const currentDigest = await inventory(options?.outputs ?? input.outputs, false, deadline);
        const tree = await verifyGit("write-tree");
        const identities = (await verifyGit("rev-parse", "HEAD", `${candidateRef}^{tree}`, baseRef)).split("\n");
        if (tree !== input.candidate.treeSha || identities.length !== 3 || identities[0] !== candidateCommit || identities[1] !== input.candidate.treeSha || identities[2] !== input.candidate.base.tipSha || dependencyDigest !== currentDigest) throw new CheckSnapshotError("check_snapshot_drift", "Execution changed the private source, dependencies or pinned Git context.");
      });
    };
    return { rootDir, commandRoot: path.join(controlRoot, "commands"), environment, dependencyDigest, verify, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof CheckSnapshotError) throw error;
    throw new CheckSnapshotError("check_snapshot_unavailable", "The exact prepared Git tree could not be materialized privately.");
  }
}
