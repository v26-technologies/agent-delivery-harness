/**
 * Capturing a candidate: what is about to be reviewed, observed stably enough
 * that evidence can be bound to it.
 *
 * THE PROBLEM THIS SOLVES. Every input here is mutable while it is being read.
 * HEAD moves, the index is written, a base ref is fetched, a build drops a file
 * into the worktree. A capture assembled from readings taken at different
 * moments describes a workspace state that may never have existed, and evidence
 * bound to it would be evidence about nothing. So the observation is taken
 * twice, in full, and accepted only when the two agree — a bracket around every
 * mutable input rather than a lock nobody can take. A repository that will not
 * hold still for two consecutive readings is reported as ambiguous, which is
 * the truthful answer.
 *
 * PREPARED, OR NOTHING. There are exactly two shapes a candidate can have: a
 * clean worktree, where HEAD's tree is the reviewable content, and a staged
 * index, where the author has said which files the change consists of. An
 * unstaged edit or an untracked file is neither, and this module never repairs
 * that by staging anything — `git add` is an authorship decision about what the
 * change *is*, and a gate that made it silently would be deciding the scope of
 * the work it is meant to be checking.
 *
 * FAIL CLOSED ON THE BASE. A base ref that does not resolve, or that shares no
 * history with HEAD, is a typed blocker. It is never allowed to become an empty
 * changed set, because an empty changed set is also a legitimate answer — a
 * candidate whose tree already matches its base — and the two would be
 * indistinguishable to the activation threshold. One means "nothing to review";
 * the other means "we cannot tell what there is to review".
 *
 * PROCESS CONTROL. Every git invocation goes through `node:child_process`, with
 * the executable and its arguments as an argv array and no shell in between.
 * There is no wrapper process that can outlive the call, nothing for an
 * argument to be re-parsed by, and the pipes are drained to completion so a
 * verbose command cannot deadlock on a full buffer.
 *
 * WHERE THE ENVIRONMENT SCRUB STOPS. `HOME` is kept, so the user's global git
 * configuration still applies — including settings that execute programs, such
 * as `core.fsmonitor`. That is deliberate rather than overlooked: the harness
 * runs as the user, from the user's shell, against the user's repository, and a
 * global config the user wrote is not a boundary this module is defending. What
 * it defends against is the narrower and genuinely surprising case — inherited
 * `GIT_` variables that silently point the same commands at a different
 * repository, which no amount of trusting the launcher makes correct.
 *
 * THE PURE HALF IS NEXT DOOR. Shapes, classification, projection, activation
 * and drift live in `candidate.types.ts`, which imports no process and no
 * filesystem; this file is only the part that has to talk to git.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { BlockedError, createBlocker, type Blocker, type NonEmptyTuple, type Remediation } from "./blockers.ts";
import type { HarnessConfig } from "./config.ts";
import {
  CANDIDATE_DIFF_UNREADABLE,
  CANDIDATE_VCS,
  projectReviewActivation,
  type CandidateCapture,
  type CandidateCaptureCode,
  type CandidateDiffEntry,
  type CandidateStatusEntry,
  type CaptureCandidate,
  type CapturedCandidate,
  type ComputeIdentity,
  type ReviewActivationProjection,
} from "./candidate.types.ts";

/**
 * How many times a bracket may be retried before the repository is declared
 * ambiguous. Three is a bound, not a budget: it distinguishes a workspace that
 * settles — a save, a formatter, an editor writing a swap file — from one that
 * is being written to continuously, and no number of retries makes the second
 * case safe to capture.
 */
export const DEFAULT_CAPTURE_ATTEMPTS = 3;

// ── Running git ────────────────────────────────────────────────────────────

export interface CandidateCommandResult {
  /** `-1` when the command could not be started at all. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutBase64?: string;
  readonly stderr: string;
}

export type CandidateCommandRunner = (
  command: readonly string[],
  options: { readonly cwd: string; readonly captureBytes?: boolean; readonly stdin?: string },
) => Promise<CandidateCommandResult>;

/**
 * Environment variables that redirect git at another repository, another index,
 * or another object store. Anything in this family is inherited from whoever
 * launched the harness, and a hook, a rebase script, or another tool's
 * subprocess can be that launcher — in which case the capture would silently
 * describe a repository nobody asked about. The whole `GIT_` namespace is
 * dropped rather than a curated list, because the failure mode of missing one
 * is a capture that looks perfectly healthy and is about the wrong tree.
 *
 * Nothing here needs the network, so nothing valuable is lost with them.
 */
const GIT_ENVIRONMENT_PREFIX = "GIT_";

/**
 * `GIT_TERMINAL_PROMPT` because a gate must fail rather than wait for someone
 * to type; `GIT_OPTIONAL_LOCKS` because these commands only observe, and an
 * observation has no business taking the index lock out from under whatever the
 * author is doing.
 */
const GIT_ENVIRONMENT_OVERRIDES: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

function scrubbedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith(GIT_ENVIRONMENT_PREFIX) || value === undefined) continue;
    environment[name] = value;
  }
  return { ...environment, ...GIT_ENVIRONMENT_OVERRIDES };
}

interface BinaryCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}
type GitCommandOptions = Parameters<CandidateCommandRunner>[1];

export const runGitCommand: CandidateCommandRunner = (command, options) => collectGitCommand(command, options, false);

/** Internal native transport. The public runner retains its text/base64 contract. */
export function runGitCommandBytes(command: readonly string[], options: Omit<GitCommandOptions, "captureBytes">): Promise<BinaryCommandResult> {
  return collectGitCommand(command, { ...options, captureBytes: true }, true);
}
function collectGitCommand(command: readonly string[], options: GitCommandOptions, rawBytes: true): Promise<BinaryCommandResult>;
function collectGitCommand(command: readonly string[], options: GitCommandOptions, rawBytes: false): Promise<CandidateCommandResult>;
function collectGitCommand(command: readonly string[], options: GitCommandOptions, rawBytes: boolean): Promise<BinaryCommandResult | CandidateCommandResult> {
  return new Promise<BinaryCommandResult | CandidateCommandResult>((resolve) => {
    const [executable, ...args] = command;
    if (executable === undefined) {
      resolve(rawBytes ? { exitCode: -1, stdout: Buffer.alloc(0), stderr: "no command was given" } : { exitCode: -1, stdout: "", stderr: "no command was given" });
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: scrubbedEnvironment(),
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let inputError: string | undefined;
    const chunks: Buffer[] = [];
    if (!options.captureBytes) child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string | Buffer) => {
      if (options.captureBytes) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      else stdout += chunk;
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => {
      resolve(rawBytes ? { exitCode: -1, stdout: Buffer.alloc(0), stderr: error.message } : { exitCode: -1, stdout, stderr: error.message });
    });
    if (options.stdin !== undefined) {
      child.stdin!.once("error", (error: Error) => {
        inputError = error.message;
        child.kill("SIGKILL");
      });
      child.stdin!.end(options.stdin);
    }
    // `close` rather than `exit`: it fires once the pipes are drained, so the
    // output is complete when the exit code is read.
    child.once("close", (code) => {
      const bytes = options.captureBytes ? Buffer.concat(chunks) : undefined;
      if (rawBytes) {
        resolve({ exitCode: inputError === undefined ? code ?? -1 : -1, stdout: bytes!, stderr: inputError ?? stderr });
        return;
      }
      resolve({ exitCode: inputError === undefined ? code ?? -1 : -1, stdout: bytes?.toString("utf8") ?? stdout, stderr: inputError ?? stderr, ...(bytes === undefined ? {} : { stdoutBase64: bytes.toString("base64") }) });
    });
  });
}

// ── Blockers ───────────────────────────────────────────────────────────────

function candidateBlocker(
  config: HarnessConfig,
  code: CandidateCaptureCode | typeof CANDIDATE_DIFF_UNREADABLE,
  summary: string,
  details: string | undefined,
  remediations: NonEmptyTuple<Remediation>,
): Blocker {
  return createBlocker({
    code,
    source: { kind: "candidate", id: config.gateId },
    summary,
    ...(details === undefined || details.trim() === "" ? {} : { details }),
    remediations,
  });
}

const INSPECT_STATUS: Remediation = {
  id: "inspect-worktree-status",
  kind: "command",
  command: ["git", "status", "--short", "--untracked-files=all"],
  summary: "Inspect what the worktree currently carries.",
};

function blocked(
  config: HarnessConfig,
  code: CandidateCaptureCode,
  summary: string,
  details: string | undefined,
  remediations: NonEmptyTuple<Remediation>,
): Extract<CandidateCapture, { ok: false }> {
  return { ok: false, code, blockers: [candidateBlocker(config, code, summary, details, remediations)] };
}

// ── Observation ────────────────────────────────────────────────────────────

/**
 * One complete reading of every mutable input. Two of these are compared, so
 * every member has to be something that can *change* while a capture runs;
 * anything constant would only be noise in the comparison.
 */
interface Observation {
  readonly headSha: string;
  readonly headTreeSha: string;
  readonly indexTreeSha: string;
  readonly baseTipSha: string;
  readonly mergeBaseSha: string;
  readonly status: string;
  readonly untracked: string;
  readonly worktreeDirty: boolean;
}

const OBSERVATION_FIELDS = [
  "headSha",
  "headTreeSha",
  "indexTreeSha",
  "baseTipSha",
  "mergeBaseSha",
  "status",
  "untracked",
  "worktreeDirty",
] as const satisfies readonly (keyof Observation)[];

function movedFields(before: Observation, after: Observation): readonly string[] {
  return OBSERVATION_FIELDS.filter((field) => before[field] !== after[field]);
}

type ObservationResult = { readonly ok: true; readonly observation: Observation } | Extract<CandidateCapture, { ok: false }>;

/**
 * The operations git can be part-way through, and the state each one leaves in
 * the git directory. Every entry is asked for by `--git-path` and answered by
 * whether the file or directory is there, which is how git itself decides —
 * `MERGE_HEAD` and its siblings are plain files, not refs that need resolving,
 * and one `rev-parse` can name all five paths at once.
 *
 * A rebase is named by its directory — `rebase-merge` for the merge backend,
 * `rebase-apply` for `--apply` — and by nothing else. The directory is present
 * for the whole operation however it paused: conflicted, stopped by a failing
 * `--exec`, or held at an `edit` or `break` instruction, the last two of which
 * leave a clean status and a perfectly writable index tree and would otherwise
 * capture as a healthy candidate while the branch is half rewritten.
 *
 * `REBASE_HEAD` is deliberately *not* in this list. It is a leftover, not a
 * state: git writes it when a rebase stops on a commit and does not remove it
 * when `--continue` concludes the rebase, so a worktree can carry the ref with
 * no directory, a clean status, and `git rebase --abort` answering that there
 * is no rebase in progress. Treating that ref as an operation refused exactly
 * the candidates a conflicted base-movement rebase produces, with a remediation
 * — conclude the rebase — that was already done. Anything genuinely in progress
 * has a directory, so nothing is lost by reading only the directories.
 *
 * Order matters only for the message: the first match names the operation, and
 * a rebase implemented as a sequence of cherry-picks would otherwise be
 * reported as a cherry-pick.
 */
const IN_PROGRESS_STATES: readonly { readonly gitPath: string; readonly operation: string }[] = [
  { gitPath: "rebase-merge", operation: "rebase" },
  { gitPath: "rebase-apply", operation: "rebase" },
  { gitPath: "MERGE_HEAD", operation: "merge" },
  { gitPath: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
  { gitPath: "REVERT_HEAD", operation: "revert" },
];

async function observe(
  run: CandidateCommandRunner,
  rootDir: string,
  config: HarnessConfig,
): Promise<ObservationResult> {
  const git = (args: readonly string[]) => run(["git", ...args], { cwd: rootDir });

  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) {
    return blocked(
      config,
      "candidate_repository_unreadable",
      `${JSON.stringify(rootDir)} does not resolve a HEAD commit`,
      head.stderr,
      [
        {
          id: "run-inside-a-repository",
          kind: "manual_action",
          summary: "Run the harness inside a git repository that has at least one commit.",
        },
      ],
    );
  }

  const headTree = await git(["rev-parse", "--verify", "HEAD^{tree}"]);
  if (headTree.exitCode !== 0) {
    return blocked(config, "candidate_repository_unreadable", "HEAD names no tree", headTree.stderr, [
      {
        id: "repair-repository",
        kind: "manual_action",
        summary: "Repair the repository: HEAD resolves to a commit whose tree cannot be read.",
      },
    ]);
  }

  // Probed before the index tree is written. A conflicted merge, rebase,
  // cherry-pick or revert makes `write-tree` fail with a message about unmerged
  // paths — true, but not the thing the author needs to be told — and an
  // operation that stopped without conflicting would not fail it at all.
  const statePaths = await git(["rev-parse", ...IN_PROGRESS_STATES.flatMap((state) => ["--git-path", state.gitPath])]);
  if (statePaths.exitCode !== 0) {
    return blocked(
      config,
      "candidate_repository_unreadable",
      "the repository would not say whether an operation is in progress",
      statePaths.stderr,
      [
        {
          id: "repair-repository",
          kind: "manual_action",
          summary: "Repair the repository: its git directory could not be located.",
        },
      ],
    );
  }
  const stateLines = statePaths.stdout.split("\n").map((line) => line.trim());
  const inProgress = IN_PROGRESS_STATES.find((state, index) => {
    const line = stateLines[index];
    return line !== undefined && line !== "" && existsSync(path.resolve(rootDir, line));
  });
  if (inProgress !== undefined) {
    return blocked(
      config,
      "candidate_merge_in_progress",
      `a ${inProgress.operation} is in progress, so the index does not yet describe a finished change`,
      `state left by the ${inProgress.operation}: ${inProgress.gitPath}`,
      [
        {
          id: "conclude-in-progress-operation",
          kind: "manual_action",
          summary: `Conclude the ${inProgress.operation} — finish it or abandon it — before preparing a candidate.`,
        },
        INSPECT_STATUS,
      ],
    );
  }

  const indexTree = await git(["write-tree"]);
  if (indexTree.exitCode !== 0) {
    if (/index\.lock['"]?: File exists/i.test(indexTree.stderr)) {
      return blocked(config, "candidate_repository_unreadable", "Git could not acquire the index lock", indexTree.stderr, [
        {
          id: "retry-index-lock",
          kind: "manual_action",
          summary: "Retry after the other Git operation finishes. If the lock persists, inspect the owning process before removing a stale lock.",
        },
        INSPECT_STATUS,
      ]);
    }
    return blocked(config, "candidate_repository_unreadable", "the index does not define a tree", indexTree.stderr, [
      {
        id: "repair-index",
        kind: "manual_action",
        summary: "Repair the index: it could not be written out as a tree.",
      },
      INSPECT_STATUS,
    ]);
  }

  // The ref grammar the config loader enforces excludes anything beginning with
  // a dash, so a configured base ref cannot arrive here as an option.
  const baseTip = await git(["rev-parse", "--verify", `${config.baseRef}^{commit}`]);
  if (baseTip.exitCode !== 0) {
    return blocked(
      config,
      "candidate_base_missing",
      `the configured base ref ${JSON.stringify(config.baseRef)} does not resolve to a commit`,
      baseTip.stderr,
      [
        {
          id: "fetch-base-ref",
          kind: "command",
          command: ["git", "fetch"],
          summary: "Fetch the remote so the configured base ref resolves.",
        },
        {
          id: "declare-a-resolvable-base-ref",
          kind: "code_change",
          summary: "Declare a base ref this repository has, in the harness config.",
        },
      ],
    );
  }

  const mergeBase = await git(["merge-base", config.baseRef, "HEAD"]);
  if (mergeBase.exitCode === 1) {
    // "No merge base" and "no merge base *that this clone has been given*" are
    // the same exit code and the same silence, and they call for opposite
    // actions. A depth-1 clone is what `actions/checkout` produces by default,
    // so the second case is the common one in CI — and telling that operator to
    // rebase onto the base would have them rewrite a branch to fix a fetch.
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.exitCode !== 0) {
      return blocked(config, "candidate_repository_unreadable", "the repository would not say whether it is shallow", shallow.stderr, [
        {
          id: "repair-repository",
          kind: "manual_action",
          summary: "Repair the repository: whether it is a shallow clone could not be determined.",
        },
      ]);
    }
    if (shallow.stdout.trim() === "true") {
      return blocked(
        config,
        "candidate_base_shallow",
        `this is a shallow clone, and any history HEAD shares with ${JSON.stringify(config.baseRef)} lies beyond its boundary`,
        mergeBase.stderr,
        [
          {
            id: "deepen-the-clone",
            kind: "command",
            command: ["git", "fetch", "--unshallow"],
            summary: "Deepen the clone so the merge base with the configured base ref is present.",
          },
          {
            id: "check-out-with-full-history",
            kind: "manual_action",
            summary: "Check the repository out with full history — in CI, the checkout step's fetch depth.",
          },
        ],
      );
    }
    return blocked(
      config,
      "candidate_base_unrelated",
      `HEAD shares no history with the configured base ref ${JSON.stringify(config.baseRef)}`,
      mergeBase.stderr,
      [
        {
          id: "rebase-onto-the-base",
          kind: "manual_action",
          summary: "Base this branch on the configured base ref, or configure the base ref this branch descends from.",
        },
      ],
    );
  }
  if (mergeBase.exitCode !== 0) {
    return blocked(config, "candidate_repository_unreadable", "the merge base could not be computed", mergeBase.stderr, [
      {
        id: "repair-repository",
        kind: "manual_action",
        summary: "Repair the repository: the merge base between HEAD and the base ref could not be computed.",
      },
    ]);
  }

  const status = await git(["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (status.exitCode !== 0) {
    return blocked(config, "candidate_repository_unreadable", "the worktree status could not be read", status.stderr, [
      { id: "repair-repository", kind: "manual_action", summary: "Repair the repository: its status could not be read." },
    ]);
  }

  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.exitCode !== 0) {
    return blocked(config, "candidate_repository_unreadable", "untracked files could not be listed", untracked.stderr, [
      { id: "repair-repository", kind: "manual_action", summary: "Repair the repository: untracked files could not be listed." },
    ]);
  }

  // Exit 1 is the answer "yes, the worktree differs from the index"; anything
  // else is a failure to answer, which must not read as "clean" — and a
  // negative code is the command never having run at all, which would otherwise
  // slip past an upper bound and be reported to the author as a dirty worktree
  // they cannot find. Every other probe above rejects on `!== 0` for the same
  // reason; this is the one that has a second legal code to admit.
  const unstaged = await git(["diff", "--quiet"]);
  if (unstaged.exitCode > 1 || unstaged.exitCode < 0) {
    return blocked(config, "candidate_repository_unreadable", "unstaged changes could not be determined", unstaged.stderr, [
      { id: "repair-repository", kind: "manual_action", summary: "Repair the repository: its unstaged changes could not be determined." },
    ]);
  }

  return {
    ok: true,
    observation: {
      headSha: head.stdout.trim(),
      headTreeSha: headTree.stdout.trim(),
      indexTreeSha: indexTree.stdout.trim(),
      baseTipSha: baseTip.stdout.trim(),
      mergeBaseSha: mergeBase.stdout.trim(),
      status: status.stdout,
      untracked: untracked.stdout,
      worktreeDirty: unstaged.exitCode !== 0,
    },
  };
}

// ── Reading git's NUL streams ──────────────────────────────────────────────

function splitNulStream(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

/**
 * `git status -z` writes `XY<space>path`, and for a rename or copy the origin
 * path follows as a second record. The origin is consumed rather than reported:
 * the status is diagnostic context, and the two-character code already says the
 * entry is a rename.
 */
function parseStatusEntries(output: string): readonly CandidateStatusEntry[] {
  const records = output.split("\0");
  const entries: CandidateStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    const code = record.slice(0, 2);
    entries.push({ code, path: record.slice(3) });
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return entries;
}

/**
 * `git diff --numstat -z` writes `additions<tab>deletions<tab>path`, except for
 * a rename or a copy, where the path field is empty and the origin and
 * destination follow as two further records. Reading the NUL stream rather than
 * the human format is what makes a path containing ` => ` — or a newline, or a
 * quote — parse as the path it is instead of as a rename.
 *
 * A record that does not parse throws rather than being skipped. A skipped
 * entry is a silently smaller diff, and a smaller diff is a change that fails
 * to reach the review threshold.
 */
const DECIMAL_COUNT = /^\d+$/;

export function parseCandidateNumstat(output: string): CandidateDiffEntry[] {
  const records = output.split("\0");
  const entries: CandidateDiffEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error(`numstat record ${JSON.stringify(record)} carries no counts`);
    }
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);

    let repoPath = inlinePath;
    let oldPath: string | undefined;
    if (inlinePath === "") {
      // A truncated stream splits into an empty final field rather than running
      // out of fields, so "missing" here is present-and-empty. Checking only
      // for absence would let a half-written rename through as an entry whose
      // path is the empty string, which matches no classifier and no sensitive
      // group — a change that quietly reviews as nothing.
      const origin = records[index + 1];
      const destination = records[index + 2];
      if (origin === undefined || origin === "" || destination === undefined || destination === "") {
        throw new Error(`numstat record ${JSON.stringify(record)} announces a rename whose paths are missing`);
      }
      oldPath = origin;
      repoPath = destination;
      index += 2;
    }

    // Git writes plain decimal counts, so anything else is not git's output.
    // `Number` would happily read `0x10`, `1e3`, ` 7 ` and `""`, each of which
    // turns a malformed stream into a plausible-looking line count.
    const binary = additionsText === "-" || deletionsText === "-";
    if (!binary && !(DECIMAL_COUNT.test(additionsText) && DECIMAL_COUNT.test(deletionsText))) {
      throw new Error(`numstat record ${JSON.stringify(record)} carries counts that are not plain decimal integers`);
    }
    const additions = binary ? null : Number(additionsText);
    const deletions = binary ? null : Number(deletionsText);
    entries.push({ path: repoPath, ...(oldPath === undefined ? {} : { oldPath }), additions, deletions, binary });
  }
  return entries;
}

// ── Capture ────────────────────────────────────────────────────────────────

export interface CandidateCaptureOptions {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  /**
   * The identity of the workspace this capture belongs to, supplied by the
   * evidence store that owns it. It is carried rather than derived here so a
   * candidate can be compared for workspace drift without this module needing
   * to know how a workspace is named.
   */
  readonly workspaceId: string;
  readonly computeIdentity: ComputeIdentity;
  readonly run?: CandidateCommandRunner;
  readonly maxAttempts?: number;
}

/**
 * Decides the mode from a settled observation, or refuses.
 *
 * The second refusal is a backstop on the first: once a status is non-empty and
 * the worktree is known clean, the change must live in the index, and an index
 * whose tree equals HEAD's contains no change at all. Accepting that would
 * produce a `staged-index` candidate indistinguishable from a clean one.
 */
function preparedCandidate(
  observation: Observation,
  config: HarnessConfig,
): { readonly ok: true; readonly mode: "clean" | "staged-index"; readonly treeSha: string; readonly statusEntries: readonly CandidateStatusEntry[] } | Extract<CandidateCapture, { ok: false }> {
  const untrackedFiles = splitNulStream(observation.untracked);
  if (observation.worktreeDirty || untrackedFiles.length > 0) {
    const detail = observation.worktreeDirty
      ? untrackedFiles.length > 0
        ? `unstaged changes to tracked files, and untracked files: ${untrackedFiles.slice(0, 20).join(", ")}`
        : "unstaged changes to tracked files"
      : `untracked files: ${untrackedFiles.slice(0, 20).join(", ")}`;
    return blocked(
      config,
      "candidate_unprepared",
      "the worktree carries content that is not part of any prepared candidate",
      detail,
      [
        {
          id: "stage-the-intended-change",
          kind: "manual_action",
          summary: "Stage the files this change is meant to deliver, then prepare the candidate again.",
        },
        INSPECT_STATUS,
      ],
    );
  }

  const statusEntries = parseStatusEntries(observation.status);
  if (statusEntries.length > 0 && observation.indexTreeSha === observation.headTreeSha) {
    return blocked(
      config,
      "candidate_unprepared",
      "the worktree is not clean, yet the index defines no distinct tree to review",
      `status: ${statusEntries.map((entry) => `${entry.code} ${entry.path}`).slice(0, 20).join("; ")}`,
      [
        {
          id: "stage-the-intended-change",
          kind: "manual_action",
          summary: "Stage the files this change is meant to deliver, then prepare the candidate again.",
        },
        INSPECT_STATUS,
      ],
    );
  }

  const mode = statusEntries.length > 0 ? "staged-index" : "clean";
  return { ok: true, mode, treeSha: mode === "staged-index" ? observation.indexTreeSha : observation.headTreeSha, statusEntries };
}

/**
 * Observes the repository twice, and again if the two readings disagree.
 *
 * The identity computation runs *after* the bracket closes rather than inside
 * it. It is a pure function of a tree that is now known to be stable, so
 * including it would only widen the window in which something can move.
 */
export async function captureGitCandidate(options: CandidateCaptureOptions): Promise<CandidateCapture> {
  const run = options.run ?? runGitCommand;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_CAPTURE_ATTEMPTS);
  let moved: readonly string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await observe(run, options.rootDir, options.config);
    if (!before.ok) return before;
    const after = await observe(run, options.rootDir, options.config);
    if (!after.ok) return after;

    moved = movedFields(before.observation, after.observation);
    if (moved.length > 0) continue;

    const prepared = preparedCandidate(after.observation, options.config);
    if (!prepared.ok) return prepared;

    const digest = await options.computeIdentity({
      rootDir: options.rootDir,
      treeSha: prepared.treeSha,
      config: options.config,
    });

    const candidate: CapturedCandidate = {
      vcs: CANDIDATE_VCS,
      headSha: after.observation.headSha,
      treeSha: prepared.treeSha,
      mode: prepared.mode,
      deliverable: { digest, identity: options.config.computingIdentityVersion },
      base: {
        ref: options.config.baseRef,
        tipSha: after.observation.baseTipSha,
        mergeBaseSha: after.observation.mergeBaseSha,
      },
      workspaceId: options.workspaceId,
      statusEntries: prepared.statusEntries,
      untrackedFiles: [],
    };
    return { ok: true, candidate };
  }

  return blocked(
    options.config,
    "candidate_ambiguous",
    `the repository did not hold still across ${maxAttempts} consecutive observations`,
    `moved between observations: ${moved.join(", ")}`,
    [
      {
        id: "capture-a-quiescent-repository",
        kind: "retry",
        summary: "Stop whatever is writing to the repository — a watcher, a build, a rebase — and capture again.",
      },
    ],
  );
}

/**
 * Binds a capture to its inputs. The recorder holds one of these rather than
 * the repository details, which is what lets a conformance run substitute
 * declared candidate values for a repository that does not exist.
 */
export function createCandidateCapture(options: CandidateCaptureOptions): CaptureCandidate {
  return () => captureGitCandidate(options);
}

// ── The activation projection ──────────────────────────────────────────────

export interface CandidateActivationOptions {
  readonly rootDir: string;
  readonly candidate: CapturedCandidate;
  readonly config: HarnessConfig;
  readonly run?: CandidateCommandRunner;
}

/**
 * The diff between the candidate's merge base and the tree it is defined by.
 *
 * A failure here throws rather than returning an empty projection, for the same
 * reason an unresolvable base blocks the capture: an unreadable diff and a diff
 * with nothing in it lead to opposite decisions about whether the change needs
 * review.
 */
export async function evaluateCandidateActivation(options: CandidateActivationOptions): Promise<ReviewActivationProjection> {
  const run = options.run ?? runGitCommand;
  const result = await run(
    ["git", "diff", "--numstat", "--find-renames", "-z", options.candidate.base.mergeBaseSha, options.candidate.treeSha],
    { cwd: options.rootDir },
  );
  const failure = (details: string): never => {
    throw new BlockedError(
      [
        candidateBlocker(
          options.config,
          CANDIDATE_DIFF_UNREADABLE,
          "the diff between the candidate and its base could not be read",
          details,
          [
            {
              id: "recapture-the-candidate",
              kind: "retry",
              summary: "Capture the candidate again; the base or the prepared tree it names is no longer readable.",
            },
          ],
        ),
      ],
      "The candidate's diff could not be read.",
    );
  };
  if (result.exitCode !== 0) failure(result.stderr || result.stdout);

  try {
    return projectReviewActivation(parseCandidateNumstat(result.stdout), options.config);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
