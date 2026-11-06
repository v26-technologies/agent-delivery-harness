/** Private execution tree. Never shares writable source, objects, index or dependencies. */
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { candidateTreeSourceReader, capturePhysicalSource, createExecPort, isPhysicalSourceDefinition, physicalSourceOutputOverlap, type CandidateCommandRunner, type PhysicalSourceDefinition, type ExecOutcome } from "@agent-delivery-harness/kernel";

import { snapshotInventoryWorker } from "./snapshot-inventory-worker.ts";

const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
export class CheckSnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export type SnapshotPhase = "materialization" | "baseline-inventory" | "dependencies" | "post-dependency-inventory" | "clone" | "verification";
/** Copy-on-write cloning: APFS `clonefile(2)` on macOS, a reflink copy on Linux. */
export type CloneMethod = "clonefile" | "reflink";
export interface SnapshotRequest {
  readonly rootDir: string;
  readonly candidate: { readonly treeSha: string; readonly headSha: string; readonly base: { readonly ref: string; readonly tipSha: string; readonly mergeBaseSha: string } };
  readonly outputs: readonly string[];
  readonly gitContext?: "full" | "none";
  readonly physicalSource?: PhysicalSourceDefinition;
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
  /** What `verify` checks when given `unchanged`: Git's index and untracked listing, or (finite snapshots, which have no Git) the full inventory. */
  readonly reusedVerification: "index" | "inventory";
  /** `outputs` narrows the writable paths to one profile's within a snapshot shared by several.
   * `unchanged` verifies a reused tree that a full verification already accepted after its last
   * command: untracked paths may exist only where the setup left them or inside `allowed`. */
  verify(options?: { readonly timeoutMs?: number; readonly outputs?: readonly string[]; readonly unchanged?: { readonly allowed: readonly string[] } }): Promise<void>;
  /** A private copy-on-write tree of this one, which stays untouched. The clone's own phases go to `onPhase`. */
  clone(method: CloneMethod, onPhase?: (phase: SnapshotPhase, durationMs: number) => void): Promise<CheckSnapshot>;
  cleanup(): Promise<void>;
}
/** A materialized tree: the work tree, the Git-none control directory, and the directories cleanup removes. */
interface PrivateTree { readonly rootDir: string; readonly privateControl?: string; readonly owned: readonly string[] }
const nulSeparated = (text: string) => text.split("\0").filter(Boolean);
/** A listed path (a directory ends in a slash) lies at or below a declared output. As in the
 * inventory, an output without a trailing slash that is a directory covers what is inside it. */
function withinOutputs(entry: string, outputs: readonly string[]): boolean {
  return outputs.some(output => { const root = output.replace(/\/$/, ""); return entry === root || entry.startsWith(`${root}/`); });
}
function phaseMeter(onPhase?: (phase: SnapshotPhase, durationMs: number) => void) {
  return async <T>(phase: SnapshotPhase, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { return await operation(); } finally { try { onPhase?.(phase, performance.now() - started); } catch { /* Timing cannot change admission. */ } }
  };
}
async function removeTrees(directories: readonly string[]): Promise<void> {
  const removed = await Promise.allSettled(directories.map(dir => rm(dir, { recursive: true, force: true })));
  if (removed.some(result => result.status === "rejected")) throw new CheckSnapshotError("check_snapshot_cleanup_failed", "Cannot remove the owned execution snapshot after retaining evidence.");
}
/** One copy-on-write clone of a directory tree into a path that must not exist yet. On macOS
 * `clonefileat(2)` (syscall 462) clones the hierarchy in one call; `cp -c` clones file by file
 * and silently copies where cloning is unsupported. */
async function cloneTree(method: CloneMethod, source: string, destination: string, deadline: number, signal?: AbortSignal): Promise<void> {
  const [command, args] = method === "clonefile"
    ? ["/usr/bin/perl", ["-e", "syscall(462, -2, $ARGV[0], -2, $ARGV[1], 0) == 0 or exit 1", source, destination]] as const
    : ["cp", ["-a", "--reflink=always", "--", source, destination]] as const;
  const result = await snapshotProcess(command, [...args], path.dirname(destination), { PATH: "/usr/bin:/bin" }, deadline, signal);
  if (result.code !== 0) throw new CheckSnapshotError("check_snapshot_unavailable", "The warm snapshot could not be cloned.");
}
let cloneProbe: Promise<CloneMethod | undefined> | undefined;
/** The copy-on-write method the temporary directory supports, probed once per process; undefined where none does. */
export function snapshotCloneMethod(): Promise<CloneMethod | undefined> {
  return cloneProbe ??= (async () => {
    const method: CloneMethod | undefined = process.platform === "darwin" ? "clonefile" : process.platform === "linux" ? "reflink" : undefined;
    if (!method) return undefined;
    const probe = await mkdtemp(path.join(tmpdir(), "delivery-clone-probe-"));
    try {
      await mkdir(path.join(probe, "source")); await writeFile(path.join(probe, "source", "probe"), "probe");
      await cloneTree(method, path.join(probe, "source"), path.join(probe, "clone"), performance.now() + 30_000);
      return method;
    } catch { return undefined; } finally { await rm(probe, { recursive: true, force: true }).catch(() => undefined); }
  })();
}
async function cloneSnapshot(tree: PrivateTree, method: CloneMethod, signal: AbortSignal | undefined, onPhase: SnapshotRequest["onPhase"], open: (tree: PrivateTree, onPhase?: SnapshotRequest["onPhase"]) => CheckSnapshot): Promise<CheckSnapshot> {
  return phaseMeter(onPhase)("clone", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "delivery-check-clone-")));
    const cloned: PrivateTree = { rootDir: path.join(parent, "tree"), ...(tree.privateControl ? { privateControl: path.join(parent, "control") } : {}), owned: [parent] };
    try {
      const deadline = performance.now() + SNAPSHOT_TIMEOUT_MS;
      await cloneTree(method, tree.rootDir, cloned.rootDir, deadline, signal);
      if (tree.privateControl) await cloneTree(method, tree.privateControl, cloned.privateControl!, deadline, signal);
    } catch (error) {
      await rm(parent, { recursive: true, force: true }).catch(() => undefined);
      throw error instanceof CheckSnapshotError ? error : new CheckSnapshotError("check_snapshot_unavailable", "The warm snapshot could not be cloned.");
    }
    return open(cloned, onPhase);
  });
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
export async function snapshotInventory(root: string, outputs: readonly string[], excludeDependencies = false, deadline = performance.now() + SNAPSHOT_TIMEOUT_MS, signal?: AbortSignal, forbidGit = false, absentInputs: readonly string[] = []): Promise<string> {
  return (await snapshotDigests(root, outputs, excludeDependencies, deadline, signal, forbidGit, false, absentInputs)).digest;
}
async function snapshotDigests(root: string, outputs: readonly string[], excludeDependencies: boolean, deadline: number, signal?: AbortSignal, forbidGit = false, includeSource = false, absentInputs: readonly string[] = []): Promise<{ digest: string; sourceDigest?: string }> {
  const result = await snapshotProcess(process.execPath, ["--input-type=module", "--eval", snapshotInventoryWorker], root,
    { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DELIVERY_SNAPSHOT_REQUEST: JSON.stringify({ root, outputs, excludeDependencies, forbidGit, includeSource, absentInputs }) }, deadline, signal);
  let parsed: { code?: string; digest?: string; sourceDigest?: string };
  try { parsed = JSON.parse(result.stdout); } catch { throw new CheckSnapshotError("check_snapshot_unavailable", "Snapshot inventory returned no valid result."); }
  if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(parsed.digest ?? "") || (includeSource && !/^[a-f0-9]{64}$/.test(parsed.sourceDigest ?? ""))) throw new CheckSnapshotError(["check_snapshot_escape", "check_snapshot_drift"].includes(parsed.code ?? "") ? parsed.code! : "check_snapshot_unavailable", "Snapshot inventory could not verify private bytes and links.");
  return { digest: parsed.digest!, ...(includeSource ? { sourceDigest: parsed.sourceDigest! } : {}) };
}
export function executionPath(root: string, value: string): string {
  return value.split(path.delimiter).filter(p => p && path.isAbsolute(p) && !inside(root, p) && !p.split(path.sep).includes("node_modules")).join(path.delimiter) || "/usr/bin:/bin";
}
export async function createCheckSnapshot(input: SnapshotRequest): Promise<CheckSnapshot> {
  if (input.physicalSource !== undefined) return createFiniteCheckSnapshot(input);
  const report = (phase: SnapshotPhase, started: number) => {
    try { input.onPhase?.(phase, performance.now() - started); } catch { /* Timing cannot change admission. */ }
  };
  const measured = phaseMeter(input.onPhase);
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
  const cleanup = () => removeTrees([rootDir, ...(privateControl ? [privateControl] : [])]);
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
    const inventory = (root: string, outputs: readonly string[], sourceOnly = false, deadline = performance.now() + SNAPSHOT_TIMEOUT_MS) => snapshotInventory(root, outputs, sourceOnly, deadline, input.signal, input.gitContext === "none");
    report("materialization", materializationStarted);
    // Setup needs a source baseline only when a dependency command can mutate it.
    const baseline = await measured("baseline-inventory", () => inventory(rootDir, input.outputs, Boolean(input.dependencies)));
    let dependencyDigest = baseline;
    const environmentFor = (root: string, control: string): Record<string, string> => ({ ...input.environment, PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${cleanEnv["PATH"]}`, HOME: path.join(control, "home"), TMPDIR: path.join(control, "tmp"), GIT_CEILING_DIRECTORIES: path.dirname(root),
      ...(input.gitContext === "none" ? {} : {
      DELIVERY_CHECK_BASE_REF: baseRef, DELIVERY_CHECK_CANDIDATE_REF: candidateRef, DELIVERY_CHECK_ORIGIN_HEAD: input.candidate.headSha, DELIVERY_CHECK_ORIGIN_TREE: input.candidate.treeSha, DELIVERY_CHECK_MERGE_BASE: input.candidate.base.mergeBaseSha }) });
    const environment = environmentFor(rootDir, controlRoot);
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
    const treeGit = (tree: PrivateTree, deadline: number, accepted: readonly number[] = [0]) => {
      const gitDir = tree.privateControl ? path.join(tree.privateControl, "repository") : undefined;
      return async (...args: string[]) => {
        const result = await snapshotProcess("git", gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${tree.rootDir}`, ...args] : args, tree.rootDir, cleanEnv, deadline, input.signal);
        if (!accepted.includes(result.code ?? -1)) throw new CheckSnapshotError("check_snapshot_unavailable", "Snapshot Git identity could not be read.");
        return result.stdout;
      };
    };
    // Untracked entries the setup left, with each wholly untracked directory
    // (an installed dependency tree) collapsed to one entry. Exclude rules are
    // not read: a command could write one to hide its own files.
    const others = ["ls-files", "--others", "--directory", "--no-empty-directory", "-z"];
    const setupEntries = new Set(nulSeparated(await treeGit({ rootDir, ...(privateControl ? { privateControl } : {}), owned: [] }, performance.now() + SNAPSHOT_TIMEOUT_MS)(...others)));
    const reusedVerification = "index" as const;
    const open = (tree: PrivateTree, onPhase?: SnapshotRequest["onPhase"]): CheckSnapshot => {
      const control = tree.privateControl ?? path.join(tree.rootDir, ".git");
      const verify: CheckSnapshot["verify"] = async (options = {}) => phaseMeter(onPhase)("verification", async () => {
        const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SNAPSHOT_TIMEOUT_MS) throw new CheckSnapshotError("check_snapshot_timeout", "Snapshot deadline must be positive and cannot exceed five minutes.");
        const deadline = performance.now() + timeoutMs;
        // The worker also checks file-only Git metadata, so lstat cannot stall the parent.
        const verifyGit = treeGit(tree, deadline);
        if (options.unchanged && reusedVerification === "index") {
          // A reused tree passed a full inventory after its last command. Before
          // the next one it must still match the index: no tracked edit, and no
          // untracked entry the setup did not leave outside the allowed outputs.
          const allowed = options.unchanged.allowed;
          // A clone has new inodes, so refresh rehashes; 1 means a tracked file differs, which diff-files names.
          await treeGit(tree, deadline, [0, 1])("update-index", "-q", "--refresh");
          if (input.gitContext === "none" && await lstat(path.join(tree.rootDir, ".git")).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(new CheckSnapshotError("check_snapshot_unavailable", "Snapshot Git absence could not be read."))))
            throw new CheckSnapshotError("check_snapshot_drift", "A file-only snapshot gained Git metadata.");
          if (nulSeparated(await verifyGit("diff-files", "--name-only", "-z")).length) throw new CheckSnapshotError("check_snapshot_drift", "A reused snapshot changed tracked source.");
          for (const entry of nulSeparated(await verifyGit(...others))) {
            if (setupEntries.has(entry) || withinOutputs(entry, allowed)) continue;
            // A collapsed directory is looked into only when an allowed output lies inside it.
            if (!entry.endsWith("/") || !allowed.some(output => output.startsWith(entry))) throw new CheckSnapshotError("check_snapshot_drift", "A reused snapshot gained an undeclared untracked path.");
            if (nulSeparated(await verifyGit("ls-files", "--others", "-z", "--", `:(literal)${entry}`)).some(file => !withinOutputs(file, allowed))) throw new CheckSnapshotError("check_snapshot_drift", "A reused snapshot gained an undeclared untracked path.");
          }
        } else {
          // One worker checks every non-Git link/type and hashes only immutable bytes.
          // Finish safety validation before Git reads, under the same owned deadline.
          if (await inventory(tree.rootDir, options.outputs ?? input.outputs, false, deadline) !== dependencyDigest) throw new CheckSnapshotError("check_snapshot_drift", "Execution changed the private source, dependencies or pinned Git context.");
        }
        const indexTree = (await verifyGit("write-tree")).trim();
        const identities = (await verifyGit("rev-parse", "HEAD", `${candidateRef}^{tree}`, baseRef)).trim().split("\n");
        if (indexTree !== input.candidate.treeSha || identities.length !== 3 || identities[0] !== candidateCommit || identities[1] !== input.candidate.treeSha || identities[2] !== input.candidate.base.tipSha) throw new CheckSnapshotError("check_snapshot_drift", "Execution changed the private source, dependencies or pinned Git context.");
      });
      return { rootDir: tree.rootDir, commandRoot: path.join(control, "commands"), environment: environmentFor(tree.rootDir, control), dependencyDigest, reusedVerification, verify,
        clone: (method, onClonePhase) => cloneSnapshot(tree, method, input.signal, onClonePhase, open), cleanup: () => removeTrees(tree.owned) };
    };
    return open({ rootDir, ...(privateControl ? { privateControl } : {}), owned: [rootDir, ...(privateControl ? [privateControl] : [])] }, input.onPhase);
  } catch (error) {
    await cleanup();
    if (error instanceof CheckSnapshotError) throw error;
    throw new CheckSnapshotError("check_snapshot_unavailable", "The exact prepared Git tree could not be materialized privately.");
  }
}

/** Opt-in file-only execution; legacy snapshots above retain complete Git semantics. */
function finiteSourceReaderRunner(input: SnapshotRequest): CandidateCommandRunner {
  const deadline = performance.now() + SNAPSHOT_TIMEOUT_MS;
  // Logical source bounds belong to capturePhysicalSource, including repeated
  // blobs. Reserve separate bounded transport room for listings/size responses;
  // protocol overhead must not consume the supported 64 MiB of source bytes.
  const transportLimit = 128 * 1024 * 1024;
  let transportBytes = 0;
  return async (command, options) => {
    if (input.signal?.aborted) throw new CheckSnapshotError("check_snapshot_interrupted", "Finite source capture was cancelled.");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new CheckSnapshotError("check_snapshot_timeout", "Finite source capture exceeded its deadline.");
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), { cwd: options.cwd,
        env: { PATH: executionPath(input.rootDir, input.environment["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let failure: CheckSnapshotError | undefined;
      const chunks: Buffer[] = [];
      const stop = (code: string) => { failure ??= new CheckSnapshotError(code, "Finite source reader did not complete safely."); child.kill("SIGKILL"); };
      const abort = () => stop("check_snapshot_interrupted"), timer = setTimeout(() => stop("check_snapshot_timeout"), remaining);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      child.stdout!.on("data", (chunk: Buffer) => { transportBytes += chunk.length; if (transportBytes > transportLimit) stop("check_snapshot_unavailable"); else chunks.push(chunk); });
      child.stderr!.on("data", () => {});
      child.once("error", () => { failure ??= new CheckSnapshotError("check_snapshot_unavailable", "Finite source reader failed to start."); });
      child.stdin?.once("error", () => stop("check_snapshot_unavailable"));
      child.stdin?.end(options.stdin);
      child.once("close", code => {
        clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else { const bytes = Buffer.concat(chunks); resolve({ exitCode: code ?? -1, stdout: bytes.toString("utf8"), stderr: "", ...(options.captureBytes ? { stdoutBase64: bytes.toString("base64") } : {}) }); }
      });
    });
  };
}
async function createFiniteCheckSnapshot(input: SnapshotRequest): Promise<CheckSnapshot> {
  const materializationStarted = performance.now();
  const source = input.physicalSource!;
  if (input.gitContext !== "none" || !isPhysicalSourceDefinition(source) || physicalSourceOutputOverlap(source, input.outputs))
    throw new CheckSnapshotError("check_physical_source_invalid", "Finite source requires Git-none and absences disjoint from all mutable outputs.");
  let captured: Awaited<ReturnType<typeof capturePhysicalSource>>;
  try { captured = await capturePhysicalSource(source, await candidateTreeSourceReader(input.rootDir, input.candidate.treeSha, finiteSourceReaderRunner(input))); }
  catch (error) { if (error instanceof CheckSnapshotError) throw error; throw new CheckSnapshotError("check_physical_source_invalid", "Finite source inputs are missing, linked or unsupported in the candidate."); }
  const rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "delivery-check-")));
  let control: string | undefined;
  const cleanup = () => removeTrees([rootDir, ...(control ? [control] : [])]);
  const measured = phaseMeter(input.onPhase);
  const inventory = async (root: string, outputs: readonly string[], sourceOnly = false, deadline?: number) => {
    if (physicalSourceOutputOverlap(source, outputs)) throw new CheckSnapshotError("check_physical_source_invalid", "Mutable output overlaps a required absence.");
    return snapshotInventory(root, outputs, sourceOnly, deadline, input.signal, true, source.absentInputs);
  };
  try {
    control = await realpath(await mkdtemp(path.join(tmpdir(), "delivery-check-control-")));
    for (const file of captured.files) {
      await mkdir(path.dirname(path.join(rootDir, file.file)), { recursive: true });
      await writeFile(path.join(rootDir, file.file), file.bytes, { flag: "wx" });
      await chmod(path.join(rootDir, file.file), file.mode === "100755" ? 0o755 : 0o644);
    }
    try { input.onPhase?.("materialization", performance.now() - materializationStarted); } catch { /* Best-effort observation. */ }
    const cleanPath = executionPath(input.rootDir, input.environment["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin");
    const environmentFor = (root: string, controlDir: string) => ({ ...input.environment, PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${cleanPath}`,
      HOME: path.join(controlDir, "home"), TMPDIR: path.join(controlDir, "tmp"), GIT_CEILING_DIRECTORIES: path.dirname(root) });
    const environment = environmentFor(rootDir, control);
    await mkdir(environment.HOME, { recursive: true }); await mkdir(environment.TMPDIR, { recursive: true });
    const baseline = await measured("baseline-inventory", () => inventory(rootDir, input.outputs, Boolean(input.dependencies)));
    if (input.dependencies) {
      const start = performance.now();
      const result = await measured("dependencies", () => createExecPort().run({ command: input.dependencies!.command[0], args: input.dependencies!.command.slice(1), cwd: rootDir,
        env: environment, timeoutMs: input.dependencies!.timeoutMs, maxBuffer: 1024 * 1024, ...(input.signal ? { signal: input.signal } : {}) }));
      input.onDependencyResult?.(result, Math.round(performance.now() - start));
      if (result.code !== 0 || input.signal?.aborted) throw new CheckSnapshotError("check_dependency_failed", "Private finite dependency installation failed.");
    }
    const installed = input.dependencies ? await measured("post-dependency-inventory", () =>
      snapshotDigests(rootDir, input.outputs, false, performance.now() + SNAPSHOT_TIMEOUT_MS, input.signal, true, true, source.absentInputs)) : { digest: baseline, sourceDigest: baseline };
    if (baseline !== installed.sourceDigest) throw new CheckSnapshotError("check_snapshot_drift", "Dependency setup changed finite source bytes or modes.");
    // Without Git there is no index to compare, so a reused finite tree is verified by its full inventory.
    const open = (tree: PrivateTree, onPhase?: SnapshotRequest["onPhase"]): CheckSnapshot => {
      const controlDir = tree.privateControl!;
      const verify: CheckSnapshot["verify"] = async (options = {}) => phaseMeter(onPhase)("verification", async () => {
        const timeout = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > SNAPSHOT_TIMEOUT_MS) throw new CheckSnapshotError("check_snapshot_timeout", "Invalid finite verification deadline.");
        if (await inventory(tree.rootDir, options.outputs ?? input.outputs, false, performance.now() + timeout) !== installed.digest)
          throw new CheckSnapshotError("check_snapshot_drift", "Finite source or installed dependencies changed.");
      });
      return { rootDir: tree.rootDir, commandRoot: path.join(controlDir, "commands"), environment: environmentFor(tree.rootDir, controlDir), dependencyDigest: installed.digest, reusedVerification: "inventory", verify,
        clone: (method, onClonePhase) => cloneSnapshot(tree, method, input.signal, onClonePhase, open), cleanup: () => removeTrees(tree.owned) };
    };
    return open({ rootDir, privateControl: control, owned: [rootDir, control] }, input.onPhase);
  } catch (error) {
    await cleanup();
    if (error instanceof CheckSnapshotError) throw error;
    throw new CheckSnapshotError("check_snapshot_unavailable", "Finite source could not be materialized or verified.");
  }
}
