/**
 * The delivery posture a repository declares on its protected base.
 *
 * WHY THIS IS NOT A CONFIG MEMBER. Config loads from the candidate's tree, which
 * a branch controls, so a branch could declare itself out of its own gate. The
 * posture is read from one file at the tip of the base instead, never from a
 * merge base or a working tree, so a candidate changing it gets nothing until
 * that change is on the base.
 *
 * WHY `baseRef` IS CHECKED AGAINST THE REMOTE. The base's name is itself config,
 * so its value can't be trusted either. It must name `origin/<branch>`, and
 * `<branch>` must be the remote's default branch: a branch that publishes itself
 * as its own `baseRef` gets nothing, however `baseRef` came to say so.
 *
 * WHY A PRIVATE REF. Moving `refs/remotes/origin/<branch>` would turn a passing
 * `verify` into `base_tip_moved` in a repository that declares nothing, so the
 * fetch lands on `refs/delivery/posture/<branch>` alone. When it fails either ref
 * can be the stale one, since an earlier run left the private ref and a normal
 * fetch moves only the tracking ref, so `focused` then needs both to say so.
 *
 * WHY `origin` MUST BE CONFIGURED. With no such remote, git reads `origin` as a
 * relative path, so a bare repository committed at `origin/` in the candidate's
 * own tree would answer as the remote and could declare itself `focused`.
 *
 * Everything that can't be read resolves to `gate`. This never rejects.
 */
import { spawn } from "node:child_process";
import { scrubbedEnvironment } from "./candidate.ts";

export const DELIVERY_POSTURE_PATH = ".agents/delivery-posture.json";
export const DELIVERY_POSTURE_SCHEMA = "delivery-posture/1";
export const DELIVERY_POSTURE_FALLBACK_SOURCE = "fallback";
/** The bound on each network call: the fetch and `ls-remote` alike. */
export const DELIVERY_POSTURE_NETWORK_TIMEOUT_MS = 15_000;
export const DELIVERY_POSTURE_MAX_BYTES = 64 * 1024;

/** Local reads get the same bound: a `git` that hangs is `posture_unreadable`, whatever it was asked. */
const LOCAL_TIMEOUT_MS = DELIVERY_POSTURE_NETWORK_TIMEOUT_MS;

export type DeliveryPosture = "gate" | "focused";
export type DeliveryPostureCode = "posture_undeclared" | "posture_malformed" | "posture_unreadable";

export interface DeliveryPostureResult {
  readonly posture: DeliveryPosture;
  readonly reason: string;
  /** The base as text, such as `origin/main`, or `fallback` where nothing was read. */
  readonly source: string;
  readonly baseTipSha: string | null;
  readonly code: DeliveryPostureCode | null;
}

export interface ResolveDeliveryPostureInput {
  readonly rootDir: string;
  /** The configured base. It is checked here, not trusted. */
  readonly baseRef: string;
  readonly networkTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

type GitRunner = (args: readonly string[], timeoutMs: number) => Promise<GitResult>;

/** A local replace ref would make a base's objects read as something it never held. */
const NO_REPLACE = { GIT_NO_REPLACE_OBJECTS: "1" };

const localEnvironment = (): Record<string, string> => ({ ...scrubbedEnvironment(), ...NO_REPLACE });

/**
 * What git itself treats as selecting a repository, which a hook or another
 * tool's subprocess can leave set.
 */
const REPOSITORY_SELECTING = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_DIR", "GIT_GRAFT_FILE", "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH", "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE", "GIT_WORK_TREE",
]);

/**
 * The network calls keep what carries transport and authentication, such as
 * `GIT_SSH_COMMAND`, `GIT_ASKPASS` and `GIT_CONFIG_*`. Scrubbing those would send
 * a machine that reaches `origin` only through them down the offline path, where
 * a stale tip could decide.
 */
function networkEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !REPOSITORY_SELECTING.has(name)) environment[name] = value;
  }
  return { ...environment, ...localEnvironment() };
}

/**
 * One bounded `git`, in its own process group. A fetch hands the network to a
 * helper that inherits the pipes, so killing `git` alone leaves `close` waiting
 * on that helper: the timer kills the group and settles without waiting for it.
 */
function boundedGit(args: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve) => {
    const failed: GitResult = { exitCode: -1, stdout: Buffer.alloc(0) };
    if (signal?.aborted) { resolve(failed); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: true, windowsHide: true });
    } catch { resolve(failed); return; }
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(result);
    };
    const stop = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch { child.kill("SIGKILL"); }
      child.stdout?.destroy();
      child.unref();
      settle(failed);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.once("error", () => settle(failed));
    child.once("close", (code) => settle({ exitCode: code ?? -1, stdout: Buffer.concat(chunks) }));
  });
}

/**
 * What either language calls whitespace: JavaScript's `\s`, plus the separators
 * and next-line that only Python's `str.isspace` counts. Trimming would give two
 * readers two answers for the same bytes, and the same bytes must get one.
 */
const BLANK = /^[\s\x1c-\x1f\x85]*$/;

/** The declaration's verdict from its bytes, or why it didn't take. */
function parseDeclaration(bytes: Buffer): { readonly posture: DeliveryPosture; readonly reason: string } | { readonly malformed: string } {
  let parsed: unknown;
  try {
    // `ignoreBOM` keeps a byte-order mark as a character, and `JSON.parse` refuses it.
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { malformed: "it is not valid UTF-8 JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { malformed: "it is not a JSON object" };
  const declared = parsed as Record<string, unknown>;
  if (declared["schemaVersion"] !== DELIVERY_POSTURE_SCHEMA) return { malformed: `its schemaVersion is not ${DELIVERY_POSTURE_SCHEMA}` };
  const posture = declared["posture"];
  if (posture !== "gate" && posture !== "focused") return { malformed: "its posture is not gate or focused" };
  const reason = declared["reason"];
  if (typeof reason !== "string" || BLANK.test(reason)) return { malformed: "its reason is missing or blank" };
  return { posture, reason };
}

const unreadable = (baseRef: string, why: string): DeliveryPostureResult => ({
  posture: "gate",
  reason: `${DELIVERY_POSTURE_PATH} on ${baseRef} could not be read: ${why}; treating the base as gate.`,
  source: DELIVERY_POSTURE_FALLBACK_SOURCE,
  baseTipSha: null,
  code: "posture_unreadable",
});

/**
 * What one exact ref holds: an object, nothing, or `undefined` where git failed.
 * `for-each-ref` rather than `rev-parse`, whose lookup rules would let a tag or
 * branch literally named after a missing ref answer for it.
 */
async function exactRef(fullRef: string, git: GitRunner): Promise<{ readonly sha: string | null } | undefined> {
  const listed = await git(["for-each-ref", "--format=%(refname) %(objectname)", fullRef], LOCAL_TIMEOUT_MS);
  if (listed.exitCode !== 0) return undefined;
  for (const line of listed.stdout.toString("utf8").split("\n")) {
    const [name, sha] = line.split(" ");
    if (name === fullRef && sha !== undefined) return { sha };
  }
  return { sha: null };
}

/** Reads the declaration at one exact ref's tip, so no tag or branch of a similar name can win. */
async function readAtRef(fullRef: string, baseRef: string, git: GitRunner): Promise<DeliveryPostureResult> {
  const held = await exactRef(fullRef, git);
  if (held === undefined || held.sha === null) return unreadable(baseRef, `${fullRef} did not resolve`);
  const tip = await git(["rev-parse", "--verify", "--quiet", `${held.sha}^{commit}`], LOCAL_TIMEOUT_MS);
  const baseTipSha = tip.stdout.toString("utf8").trim();
  if (tip.exitCode !== 0 || baseTipSha === "") return unreadable(baseRef, `${fullRef} did not resolve`);

  const malformed = (why: string): DeliveryPostureResult => ({
    posture: "gate",
    reason: `${DELIVERY_POSTURE_PATH} on ${baseRef} is malformed: ${why}; treating the base as gate.`,
    source: baseRef,
    baseTipSha,
    code: "posture_malformed",
  });

  const listing = await git(["ls-tree", "-z", "--full-tree", baseTipSha, "--", DELIVERY_POSTURE_PATH], LOCAL_TIMEOUT_MS);
  if (listing.exitCode !== 0) return unreadable(baseRef, `${fullRef}'s tree did not read`);
  const entry = listing.stdout.toString("utf8").split("\0")[0] ?? "";
  if (entry === "") {
    return { posture: "gate", reason: `No ${DELIVERY_POSTURE_PATH} on ${baseRef}; treating the base as gate.`, source: baseRef, baseTipSha, code: "posture_undeclared" };
  }
  const [mode, type, objectSha] = entry.split("\t")[0]!.split(" ");
  if (type !== "blob" || (mode !== "100644" && mode !== "100755") || objectSha === undefined) return malformed("it is not a regular file");

  const size = await git(["cat-file", "-s", objectSha], LOCAL_TIMEOUT_MS);
  if (size.exitCode !== 0) return unreadable(baseRef, "its size did not read");
  if (Number(size.stdout.toString("utf8").trim()) > DELIVERY_POSTURE_MAX_BYTES) return malformed(`it is over ${DELIVERY_POSTURE_MAX_BYTES} bytes`);

  const blob = await git(["cat-file", "blob", objectSha], LOCAL_TIMEOUT_MS);
  if (blob.exitCode !== 0) return unreadable(baseRef, "its content did not read");
  const declaration = parseDeclaration(blob.stdout);
  if ("malformed" in declaration) return malformed(declaration.malformed);
  return { posture: declaration.posture, reason: declaration.reason, source: baseRef, baseTipSha, code: null };
}

/** The remote's default branch, or undefined where it can't be determined. Offline, the last-recorded one. */
async function defaultBranch(git: GitRunner, network: GitRunner, networkTimeoutMs: number): Promise<string | undefined> {
  const remote = await network(["ls-remote", "--symref", "origin", "HEAD"], networkTimeoutMs);
  if (remote.exitCode === 0) return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote.stdout.toString("utf8"))?.[1];
  const recorded = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], LOCAL_TIMEOUT_MS);
  if (recorded.exitCode !== 0) return undefined;
  return /^refs\/remotes\/origin\/(\S+)$/.exec(recorded.stdout.toString("utf8").trim())?.[1];
}

/**
 * Resolves the posture at the tip of the protected base. Every reader of the
 * file gives the same posture, code and source for the same bytes.
 */
export async function resolveDeliveryPosture(input: ResolveDeliveryPostureInput): Promise<DeliveryPostureResult> {
  const { baseRef, rootDir, signal } = input;
  const networkTimeoutMs = input.networkTimeoutMs ?? DELIVERY_POSTURE_NETWORK_TIMEOUT_MS;
  const git: GitRunner = (args, timeoutMs) => boundedGit(args, rootDir, localEnvironment(), timeoutMs, signal);
  const network: GitRunner = (args, timeoutMs) => boundedGit(args, rootDir, networkEnvironment(), timeoutMs, signal);
  try {
    const named = /^origin\/(.+)$/.exec(baseRef)?.[1];
    if (named === undefined) return unreadable(baseRef, "the base does not name origin/<branch>");
    const url = await network(["config", "--get", "remote.origin.url"], LOCAL_TIMEOUT_MS);
    if (url.exitCode !== 0 || url.stdout.toString("utf8").trim() === "") return unreadable(baseRef, "origin is not a configured remote");
    const branch = await defaultBranch(git, network, networkTimeoutMs);
    if (branch === undefined) return unreadable(baseRef, "origin's default branch could not be determined");
    if (branch !== named) return unreadable(baseRef, `the base is not origin's default branch, ${branch}`);

    const privateRef = `refs/delivery/posture/${branch}`;
    const trackingRef = `refs/remotes/origin/${branch}`;
    const fetched = await network(["fetch", "--no-tags", "--refmap=", "--no-write-fetch-head", "--no-auto-maintenance", "--no-recurse-submodules", "origin", `+refs/heads/${branch}:${privateRef}`], networkTimeoutMs);
    if (fetched.exitCode === 0) return await readAtRef(privateRef, baseRef, git);

    const tracking = await readAtRef(trackingRef, baseRef, git);
    if (tracking.posture !== "focused") return tracking;
    const held = await exactRef(privateRef, git);
    if (held === undefined) return unreadable(baseRef, `${privateRef} did not read`);
    if (held.sha === null) return tracking;
    const earlier = await readAtRef(privateRef, baseRef, git);
    return earlier.posture === "focused" ? tracking : earlier;
  } catch {
    return unreadable(baseRef, "git failed");
  }
}
