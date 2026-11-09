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
 * WHY BARE REPOSITORIES ARE REFUSED. From a subdirectory, git would discover a
 * bare layout committed there as the repository, with its own config and refs
 * answering every question here. So only an explicit bare repository is honoured.
 *
 * WHY ONLY FROM THE REPOSITORY ROOT. From a subdirectory, the repository that
 * answers need not be the candidate's: a real nested repository, an initialised
 * submodule or an untracked gitfile each brings its own `origin`. And a git older
 * than 2.38 ignores `safe.bareRepository`, so a bare layout would answer too. So
 * the directory must be its work tree's root, not a submodule's, and not nested
 * in another repository's work tree, unless every enclosing repository shares its
 * git directory, as a linked worktree nested in its own main checkout does.
 *
 * Everything that can't be read resolves to `gate`. This never rejects.
 */
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
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
      child = spawn("git", ["-c", "safe.bareRepository=explicit", ...args], { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: true, windowsHide: true });
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

/**
 * How deep a declaration may nest arrays and objects, the top-level object being
 * depth 1. No declared member needs depth, and a decoder's own limit differs by
 * language and version, so each reader measures the text before it parses.
 */
const MAX_DEPTH = 64;

const QUOTE = 0x22, BACKSLASH = 0x5c, OPEN_ARRAY = 0x5b, CLOSE_ARRAY = 0x5d, OPEN_OBJECT = 0x7b, CLOSE_OBJECT = 0x7d;

/**
 * Whether more than `MAX_DEPTH` arrays and objects are open at once, outside
 * strings. A string starts and ends at an unescaped `"`, and inside one a `\`
 * escapes exactly the next character. Malformed text is the parser's to refuse.
 */
function nestsTooDeep(text: string): boolean {
  let depth = 0, inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (inString) {
      if (unit === BACKSLASH) i += 1;
      else if (unit === QUOTE) inString = false;
    } else if (unit === QUOTE) inString = true;
    else if (unit === OPEN_ARRAY || unit === OPEN_OBJECT) {
      depth += 1;
      if (depth > MAX_DEPTH) return true;
    } else if (unit === CLOSE_ARRAY || unit === CLOSE_OBJECT) depth -= 1;
  }
  return false;
}

/** The declaration's verdict from its bytes, or why it didn't take. */
function parseDeclaration(bytes: Buffer): { readonly posture: DeliveryPosture; readonly reason: string } | { readonly malformed: string } {
  let text: string;
  try {
    // `ignoreBOM` keeps a byte-order mark as a character, and `JSON.parse` refuses it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { malformed: "it is not valid UTF-8 JSON" };
  }
  if (nestsTooDeep(text)) return { malformed: `it nests deeper than ${MAX_DEPTH} levels` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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

/** The results refused because the directory was not a repository's root, which a caller may report. */
const notAtRoot = new WeakSet<DeliveryPostureResult>();

/**
 * Whether this result is the refusal of a directory that is not its repository's
 * root. Its shape is that of any other `posture_unreadable`, so a caller that
 * reports only this case can tell it from one the base caused.
 */
export function deliveryPostureRefusedOutsideRoot(result: DeliveryPostureResult): boolean {
  return notAtRoot.has(result);
}

/** A path as the file system names it, symlinks followed, or undefined where it doesn't exist. */
async function canonical(target: string): Promise<string | undefined> {
  try { return await realpath(target); } catch { return undefined; }
}

/**
 * Whether a path may exist, of any type, as `lstat` sees it. Only "no such
 * entry" is an answer of no; any other failure counts as yes, so git is asked.
 */
async function mayExist(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Whether git could take this directory for a repository: it holds a `.git`
 * entry of any kind, or it has the shape of a git directory itself (`HEAD`,
 * `objects` and `refs`), as a bare layout does.
 */
async function couldBeRepository(dir: string): Promise<boolean> {
  const [dotGit, ...gitDirectory] = await Promise.all([".git", "HEAD", "objects", "refs"].map(name => mayExist(path.join(dir, name))));
  return dotGit === true || gitDirectory.every(Boolean);
}

/**
 * Why the directory is not a repository root the posture may be read from, or
 * undefined where it is one. Each condition fails closed: a git that fails,
 * times out or prints something else refuses, except where git finds no
 * repository at all above the directory.
 */
async function whyNotRoot(rootDir: string, git: GitRunner, gitIn: (cwd: string) => GitRunner): Promise<string | undefined> {
  const directory = await canonical(rootDir);
  if (directory === undefined) return "it does not exist";
  const top = await git(["rev-parse", "--show-toplevel"], LOCAL_TIMEOUT_MS);
  if (top.exitCode !== 0) return "it is not in a work tree";
  const topText = top.stdout.toString("utf8").replace(/\n$/, "");
  // An empty answer canonicalises to nothing, so it refuses too.
  if (await canonical(topText) !== directory) return "it is not its work tree's root";
  const superproject = await git(["rev-parse", "--show-superproject-working-tree"], LOCAL_TIMEOUT_MS);
  if (superproject.exitCode !== 0 || superproject.stdout.length !== 0) return "it is a submodule's work tree";
  const commonDir = async (run: GitRunner, cwd: string): Promise<string | undefined> => {
    const listed = await run(["rev-parse", "--git-common-dir"], LOCAL_TIMEOUT_MS);
    const text = listed.stdout.toString("utf8").replace(/\n$/, "");
    if (listed.exitCode !== 0 || text === "") return undefined;
    return canonical(path.resolve(cwd, text));
  };
  const own = await commonDir(git, directory);
  if (own === undefined) return "its git directory did not read";
  const nested = "it is nested in another repository's work tree";
  // The parent as the file system has it, as `git -C <dir>/..` would reach it.
  const parent = path.dirname(directory);
  const parentGit = gitIn(parent);
  const enclosing = await parentGit(["rev-parse", "--is-inside-work-tree"], LOCAL_TIMEOUT_MS);
  // A git that never ran or was stopped told nothing; one that found no repository is the walk's to settle.
  if (enclosing.exitCode === -1) return nested;
  if (enclosing.exitCode === 0 && enclosing.stdout.toString("utf8").trim() === "true" && await commonDir(parentGit, parent) !== own) return nested;
  // Every ancestor git could take for a repository, not only the parent's: a worktree of a nested clone
  // shares its parent's git directory, and a layout git refuses to open hides what encloses it from the
  // parent's own answer. Each must read, and be the directory's own repository.
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    if (await couldBeRepository(ancestor) && await commonDir(gitIn(ancestor), ancestor) !== own) return nested;
    if (path.dirname(ancestor) === ancestor) return undefined;
  }
}

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
  const gitIn = (cwd: string): GitRunner => (args, timeoutMs) => boundedGit(args, cwd, localEnvironment(), timeoutMs, signal);
  try {
    const named = /^origin\/(.+)$/.exec(baseRef)?.[1];
    if (named === undefined) return unreadable(baseRef, "the base does not name origin/<branch>");
    const notRoot = await whyNotRoot(rootDir, git, gitIn);
    if (notRoot !== undefined) {
      const refused = unreadable(baseRef, `${rootDir} is not a repository root it may be read from: ${notRoot}`);
      notAtRoot.add(refused);
      return refused;
    }
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
