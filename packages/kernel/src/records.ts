import { isResourceApplicabilityBinding } from "./installed-data-evidence.ts";
import { recordIdentity, computeRecordId } from "./record-identity.ts";
/**
 * The git-private, content-addressed evidence record store.
 *
 * WHERE RECORDS LIVE. Under `git rev-parse --git-path <namespace>` — inside the
 * git directory, never the working tree. Three consequences follow, and all
 * three are the point:
 *
 *   - Records are untracked by construction. Writing one cannot perturb the
 *     deliverable identity the evidence is about, so no neutral-path rule has
 *     to carve out an exception for the store.
 *   - Records are worktree-private. A linked worktree resolves the same
 *     namespace to its own `.git/worktrees/<name>/…` directory, so evidence
 *     produced on one branch is not visible from another checkout of the same
 *     repository. The workspace id is the digest of that directory, which makes
 *     the privacy an identity property rather than a filesystem accident.
 *   - Records do not travel. Nothing here is a distribution format; portability
 *     is what the tracked delivery record and provider signatures are for.
 *
 * WHAT A RECORD IS NAMED. `recordId` is the digest of the spec's SUB-4 identity
 * tuple, and the filename carries the gate, the obligation and that id. Two
 * publications of the same identity therefore collide in the filesystem
 * namespace on purpose: the collision *is* the idempotency-versus-conflict
 * check, delegated to `link()`, which is atomic and which no lock file or
 * advisory convention can improve on.
 *
 * HOW PUBLICATION IS ATOMIC. Write a temporary under a name no reader will
 * serve, fsync it, then `link()` it into place. `link()` either creates the
 * entry or fails `EEXIST`; there is no window in which a reader can observe a
 * half-written record, and no window in which a crash leaves a truncated file
 * where a record belongs. On `EEXIST` the store reads what is already there and
 * decides: identical content is an idempotent success, anything else — including
 * a file it cannot parse — is `record_conflict`.
 *
 * ONE CANONICALIZER. Every digest here goes through `canonical.ts`/`digest.ts`
 * (RFC 8785). The Athena implementation this is ported from sorted object keys
 * with `localeCompare`, which makes a record id depend on the machine's locale;
 * that is not ported, and there is no second canonicalizer in this system.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BlockedError, createBlocker, sanitizedDetail, type Blocker, type Remediation } from "./blockers.ts";
import { digestCanonical } from "./digest.ts";
import { DEFAULT_STORAGE_NAMESPACE } from "./config.ts";
import {
  RECORD_SCHEMA_VERSION,
  WAIVER_SCOPES,
  type EvidenceRecord,
  type IgnoredStoreEntry,
  type PublishRecordInput,
  type PublishedRecord,
  type QuarantinedRecord,
  type RecordCandidateBinding,
  type RecordDiscovery,
  type RecordIdentity,
  type RecordQuarantineReason,
  type WorkspaceStorage,
} from "./records.types.ts";

export { RECORD_SCHEMA_VERSION } from "./records.types.ts";

const execFileAsync = promisify(execFile);

/** The leaf this module owns. Preparation receipts reuse the resolver with their own. */
export const RECORDS_LEAF = "records";

/** Owner-only, on the directory and on every record in it. */
const DIRECTORY_MODE = 0o700;
const RECORD_MODE = 0o600;

/**
 * Filesystem errors that mean "this store will not take the write", not
 * "something broke". `ENAMETOOLONG` belongs here because the slot name is built
 * from config-owned ids: an over-long `gateId` is a configuration the operator
 * can fix, and it must arrive as guidance rather than as a raw throw from
 * `link()`.
 */
const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR", "ENAMETOOLONG"]);

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export interface RecordStorageOptions {
  /** Repo-relative namespace under the git directory. Defaults to the config default. */
  readonly storageNamespace?: string;
  /** Leaf inside the namespace. Defaults to `records`. */
  readonly leaf?: string;
  /**
   * An already-resolved namespace root. When present git is never consulted,
   * which is what lets a caller (and this module's tests) address a store that
   * is not inside a repository.
   */
  readonly storageRoot?: string;
  readonly runGit?: GitRunner;
}

export interface PublishOptions extends RecordStorageOptions {
  /**
   * Runs after the temporary is fsynced and before it is linked into place.
   * The crash-window test kills the process here; production callers do not
   * pass it. It exists because the window it names is the one interval in
   * which a failure could plausibly corrupt the store, and a window nothing
   * can enter is a window nothing can test.
   */
  readonly beforeLink?: () => void | Promise<void>;
}

export interface RecordSelector extends RecordStorageOptions {
  readonly gateId: string;
  readonly obligationId: string;
}

// ── Blockers ───────────────────────────────────────────────────────────────

const RETRY: Remediation = {
  id: "retry-publication",
  kind: "retry",
  summary: "Re-run the command once the store is reachable.",
};

function storeBlocker(
  code:
    | "record_store_unresolved"
    | "record_store_unwritable"
    | "record_store_unreadable"
    | "record_conflict"
    | "record_input_invalid",
  summary: string,
  details: string,
  remediation: Remediation,
): Blocker {
  return createBlocker({
    code,
    source: { kind: "store", id: "evidence-records" },
    summary,
    details,
    remediations: [remediation],
  });
}

function blocked(blocker: Blocker): BlockedError {
  return new BlockedError([blocker], blocker.summary);
}

// ── Storage resolution ─────────────────────────────────────────────────────

/**
 * Trailing separators are stripped so that a config author who writes
 * `"delivery-harness/"` and one who writes `"delivery-harness"` address the
 * same directory — and, more to the point, get the same workspace id. The
 * repository's own default carries the slash, so this is the common case rather
 * than a defensive nicety.
 */
function normalizeNamespace(namespace: string): string {
  const trimmed = namespace.trim().replace(/^[./]+/, "").replace(/\/+$/, "");
  return trimmed === "" ? DEFAULT_STORAGE_NAMESPACE.replace(/\/+$/, "") : trimmed;
}

/**
 * The physical spelling of a path whose leaf need not exist yet.
 *
 * `workspaceId` is the digest of a directory, so it has to be the digest of a
 * *directory* and not of one caller's way of writing it. macOS hands out `/var`
 * temporary paths that are really `/private/var`, and a repository reached
 * through a symlinked parent is the same repository; without this, one store
 * would carry two workspace ids and each half would quarantine the other's
 * records as belonging to a foreign workspace.
 *
 * The store directory legitimately does not exist before the first
 * publication, so the walk resolves the deepest ancestor that does and
 * re-attaches the rest. Anything other than a missing path is left alone: a
 * directory that cannot be traversed is not this function's failure to report.
 */
async function physicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const trailing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...[...trailing].reverse());
    } catch (error) {
      const parent = path.dirname(cursor);
      if (errorCode(error) !== "ENOENT" || parent === cursor) return absolute;
      trailing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Strictly inside: a path is not contained in itself. */
function isInside(child: string, parent: string): boolean {
  return child !== parent && child.startsWith(parent + path.sep);
}

function unresolved(details: string): BlockedError {
  return blocked(
    storeBlocker(
      "record_store_unresolved",
      "The evidence store could not be located inside this worktree's git directory.",
      details,
      {
        id: "correct-storage-namespace",
        kind: "manual_action",
        summary:
          "Run the harness from inside the git repository, and give storageNamespace a plain relative path git does not already own.",
      },
    ),
  );
}

const defaultGitRunner: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
};

/**
 * Resolves the namespace root, and refuses anything that is not private to this
 * worktree.
 *
 * `--git-path` is asked for the namespace and `--git-dir` for the directory
 * git roots this worktree's private paths in, in one invocation, and the result
 * must land strictly inside that directory. Two different failures are closed
 * by the one containment check:
 *
 *   - TRAVERSAL. `--git-path` does not normalize, so a namespace like
 *     `foo/../../bar` resolves to a sibling of the git directory — in the main
 *     worktree, that lands in the working tree itself, which is the one place a
 *     store must never be: records would become tracked content and writing
 *     evidence would perturb the identity the evidence is about.
 *   - SHARED STORES. Git roots a fixed set of names — `objects`, `refs`,
 *     `info`, `hooks`, `logs` — in the *common* directory rather than the
 *     per-worktree one. A namespace under any of them therefore resolves
 *     identically from every worktree of the repository, and worktree privacy
 *     would be silently void. From a linked worktree the common directory is
 *     outside `--git-dir`, so the check refuses it.
 *
 * In the main worktree those two directories are the same by construction, so
 * the second case cannot be told apart there by any path comparison. It does
 * not need to be: a store shared by one worktree is not shared, and the moment
 * a second worktree exists the resolution fails closed rather than joining it.
 *
 * An explicitly injected `storageRoot` skips all of this. It is not a namespace
 * git was asked to interpret; it is a caller naming a directory outright, and
 * the caller owns where it points.
 */
async function resolveStorageRoot(rootDir: string, options: RecordStorageOptions): Promise<string> {
  if (options.storageRoot !== undefined) return physicalPath(options.storageRoot);

  const namespace = normalizeNamespace(options.storageNamespace ?? DEFAULT_STORAGE_NAMESPACE);
  const cwd = await physicalPath(rootDir);
  const runGit = options.runGit ?? defaultGitRunner;
  let reported: string;
  try {
    reported = await runGit(cwd, ["rev-parse", "--git-dir", "--git-path", namespace]);
  } catch (error) {
    throw unresolved(`git rev-parse --git-dir --git-path ${namespace} failed in ${cwd}: ${describe(error)}`);
  }

  const [gitDirLine, storageLine] = reported.split("\n").map((line) => line.trim());
  if (gitDirLine === undefined || gitDirLine === "" || storageLine === undefined || storageLine === "") {
    throw unresolved(`git rev-parse --git-dir --git-path ${namespace} printed no path in ${cwd}`);
  }

  const gitDir = await physicalPath(path.resolve(cwd, gitDirLine));
  const storageRoot = await physicalPath(path.resolve(cwd, storageLine));
  if (!isInside(storageRoot, gitDir)) {
    throw unresolved(
      `storageNamespace ${JSON.stringify(namespace)} resolves to ${storageRoot}, which is outside this worktree's git directory ${gitDir}`,
    );
  }
  return storageRoot;
}

/**
 * The one resolver. `workspaceId` is the digest of the **namespace root**, not
 * of the leaf, so records and preparation receipts — different directories —
 * agree on which workspace they belong to. Deriving it per leaf would give one
 * worktree two workspace identities and quietly break every cross-leaf
 * comparison built on it.
 */
export async function resolveRecordStorage(
  rootDir: string,
  options: RecordStorageOptions = {},
): Promise<WorkspaceStorage> {
  const storageRoot = await resolveStorageRoot(rootDir, options);
  return {
    storageRoot,
    storageDir: path.join(storageRoot, options.leaf ?? RECORDS_LEAF),
    workspaceId: digestCanonical(storageRoot),
  };
}

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * The SUB-4 identity tuple, in whichever of its two spellings applies.
 *
 * The evidence spelling names the run that produced the evidence, so re-running
 * a provider yields a new record rather than overwriting the old one. The
 * waiver spelling binds the attributed approval. Repeating identical approval
 * is idempotent; a different human, reason or scope yields a distinct record.
 */
export { recordIdentity, computeRecordId } from "./record-identity.ts";
/**
 * Slot characters are restricted rather than trusted. Gate and obligation ids
 * are already pattern-validated by the config loader, so this changes nothing
 * for a valid config — but the store is also reached by the admission adapter
 * with synthesized waiver coordinates, and a separator or a `..` arriving in a
 * filename is not a failure mode worth leaving open for that.
 */
function safeSlot(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function recordFileName(gateId: string, obligationId: string, recordId: string): string {
  return `${safeSlot(gateId)}--${safeSlot(obligationId)}--${recordId}.json`;
}

function slotPrefix(gateId: string, obligationId: string): string {
  return `${safeSlot(gateId)}--${safeSlot(obligationId)}--`;
}

// ── Parsing ────────────────────────────────────────────────────────────────

class RecordShapeError extends Error {
  readonly reason: RecordQuarantineReason;

  constructor(reason: RecordQuarantineReason, message: string) {
    super(message);
    this.name = "RecordShapeError";
    this.reason = reason;
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Members are checked *exhaustively*, in both directions: every expected member
 * must be present and well-shaped, and no unexpected member may be. The closed
 * check is what makes the content comparison on republication meaningful — an
 * extra member smuggled onto a record would otherwise be invisible to identity,
 * survive the comparison, and be served to the evaluator as evidence.
 */
function requireExactMembers(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((member) => !actual.includes(member));
  const unexpected = actual.filter((member) => !wanted.includes(member));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new RecordShapeError(
      "malformed_shape",
      `${where} has the wrong members${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}${
        unexpected.length > 0 ? ` (unexpected: ${unexpected.join(", ")})` : ""
      }`,
    );
  }
}

const BINDING_MEMBERS = [
  "treeSha",
  "deliverableDigest",
  "identityToken",
  "baseRef",
  "baseTipSha",
  "mergeBaseSha",
  "workspaceId",
] as const;

const RECORD_MEMBERS = [
  "schemaVersion",
  "recordId",
  "workspaceId",
  "gateId",
  "obligationId",
  "candidateBinding",
  "resolution",
] as const;

const EVIDENCE_MEMBERS = ["kind", "providerId", "runId", "finalPassId", "manifestDigest"] as const;

const WAIVER_MEMBERS = ["kind", "scope", "author", "reason", "findingCodes", "policyDigest"] as const;

function parseBinding(value: unknown): RecordCandidateBinding {
  if (!isRecordObject(value)) throw new RecordShapeError("malformed_shape", "candidateBinding must be an object");
  requireExactMembers(value, BINDING_MEMBERS, "candidateBinding");
  for (const member of BINDING_MEMBERS) {
    if (!isNonEmptyString(value[member])) {
      throw new RecordShapeError("malformed_shape", `candidateBinding.${member} must be a non-empty string`);
    }
  }
  return value as unknown as RecordCandidateBinding;
}

function parseResolution(value: unknown): EvidenceRecord["resolution"] {
  if (!isRecordObject(value)) throw new RecordShapeError("malformed_shape", "resolution must be an object");
  const kind = value["kind"];
  if (kind === "evidence") {
    requireExactMembers(value, [...EVIDENCE_MEMBERS, ...(value["checkBinding"] === undefined ? [] : ["checkBinding"]), ...(value["resourceBinding"] === undefined ? [] : ["resourceBinding"]), ...(value["portable"] === undefined ? [] : ["portable"])], "resolution");
    if (value["resourceBinding"] !== undefined && (!isResourceApplicabilityBinding(value["resourceBinding"]) || value["checkBinding"] !== undefined)) {
      throw new RecordShapeError("malformed_shape", "resourceBinding requires a closed installed-data binding without checkBinding");
    }
    if (value["checkBinding"] !== undefined) {
      const binding = value["checkBinding"];
      const members = ["definitionDigest", "validationDigest", "policyDigest", "wiringFingerprint", "outputsDigest"];
      if (!isRecordObject(binding)) throw new RecordShapeError("malformed_shape", "checkBinding must be an object");
      if (binding["scopedInputDigest"] !== undefined) members.push("scopedInputDigest", "scopedAttemptDigest", "scopedProfileDigest");
      requireExactMembers(binding, members, "checkBinding");
      if (members.some(key => typeof binding[key] !== "string" || !/^[a-f0-9]{64}$/.test(binding[key] as string))) throw new RecordShapeError("malformed_shape", "checkBinding requires sha256 digests");
    }
    if (value["portable"] !== undefined && (!isRecordObject(value["portable"]) || value["portable"]["version"] !== "portable-evidence/1")) {
      throw new RecordShapeError("malformed_shape", "resolution.portable must carry a supported portable evidence payload");
    }
    for (const member of ["providerId", "runId", "finalPassId", "manifestDigest"] as const) {
      if (!isNonEmptyString(value[member])) {
        throw new RecordShapeError("malformed_shape", `resolution.${member} must be a non-empty string`);
      }
    }
  } else if (kind === "waiver") {
    requireExactMembers(value, WAIVER_MEMBERS, "resolution");
    if (!WAIVER_SCOPES.includes(value["scope"] as never)) {
      throw new RecordShapeError("malformed_shape", `resolution.scope must be one of ${WAIVER_SCOPES.join(", ")}`);
    }
    for (const [member, limit] of [["author", 256], ["reason", 4096]] as const) {
      if (typeof value[member] !== "string" || value[member].trim().length === 0 || value[member].length > limit) {
        throw new RecordShapeError("malformed_shape", `resolution.${member} must be bounded non-empty text`);
      }
    }
    const codes = value["findingCodes"];
    if (!Array.isArray(codes) || codes.length === 0 || new Set(codes).size !== codes.length ||
        codes.some((code) => typeof code !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(code))) {
      throw new RecordShapeError("malformed_shape", "resolution.findingCodes must name unique bounded finding codes");
    }
    if (typeof value["policyDigest"] !== "string" || !/^[0-9a-f]{64}$/.test(value["policyDigest"])) {
      throw new RecordShapeError("malformed_shape", "resolution.policyDigest must be a sha256 digest");
    }
  } else {
    throw new RecordShapeError("malformed_shape", `resolution.kind must be "evidence" or "waiver"`);
  }
  return value as unknown as EvidenceRecord["resolution"];
}

/**
 * Shape first, then identity. The order is what keeps the quarantine classes
 * meaningful: a file that is not a record at all is reported as malformed, and
 * `identity_mismatch` is reserved for a file that *is* a record and is filed
 * under an id its contents do not produce.
 */
function parseRecord(value: unknown): EvidenceRecord {
  if (!isRecordObject(value)) throw new RecordShapeError("malformed_shape", "a record must be an object");
  requireExactMembers(value, RECORD_MEMBERS, "record");
  if (value["schemaVersion"] !== RECORD_SCHEMA_VERSION) {
    throw new RecordShapeError(
      "malformed_shape",
      `unsupported schemaVersion ${JSON.stringify(value["schemaVersion"])}; this harness writes ${RECORD_SCHEMA_VERSION}`,
    );
  }
  for (const member of ["recordId", "workspaceId", "gateId", "obligationId"] as const) {
    if (!isNonEmptyString(value[member])) {
      throw new RecordShapeError("malformed_shape", `${member} must be a non-empty string`);
    }
  }
  const record: EvidenceRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: value["recordId"] as string,
    workspaceId: value["workspaceId"] as string,
    gateId: value["gateId"] as string,
    obligationId: value["obligationId"] as string,
    candidateBinding: parseBinding(value["candidateBinding"]),
    resolution: parseResolution(value["resolution"]),
  };
  const derived = computeRecordId(record.workspaceId, record);
  if (derived !== record.recordId) {
    throw new RecordShapeError(
      "identity_mismatch",
      `recordId ${record.recordId} does not match the identity its contents produce (${derived})`,
    );
  }
  return record;
}

function parseStoredText(text: string): EvidenceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RecordShapeError("corrupt_json", `not parseable as JSON: ${describe(error)}`);
  }
  return parseRecord(parsed);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

// ── Publication ────────────────────────────────────────────────────────────

/**
 * Records are stored pretty-printed. The bytes are not the identity — the
 * canonical form is — so a human-readable file costs nothing, and an operator
 * looking at a quarantined record by hand is the case that benefits.
 */
function renderRecord(record: EvidenceRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * fsync through a read handle. Directory syncs are best-effort: the platforms
 * that refuse to open a directory for reading are the same ones whose rename
 * semantics this scheme does not target, and a failed durability hint must not
 * fail a publication that already succeeded.
 */
async function syncPath(target: string, required: boolean): Promise<void> {
  try {
    const handle = await open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (required) throw error;
  }
}

function unwritable(target: string, error: unknown): BlockedError {
  return blocked(
    storeBlocker(
      "record_store_unwritable",
      "The evidence store could not be written.",
      `${target}: ${describe(error)}`,
      {
        id: "restore-store-permissions",
        kind: "manual_action",
        summary: "Make the git directory writable by the account running the harness, then re-run.",
      },
    ),
  );
}

function unreadableStore(target: string, error: unknown): BlockedError {
  return blocked(
    storeBlocker(
      "record_store_unreadable",
      "The evidence store could not be read.",
      `${target}: ${describe(error)}`,
      {
        id: "restore-store-readability",
        kind: "manual_action",
        summary: "Make the evidence store readable by the account running the harness, then re-run.",
      },
    ),
  );
}

/**
 * Quarantine diagnostics quote a file the store has just refused to trust, so
 * they are untrusted bytes on an operator-facing path. They go through the
 * blocker contract's own redaction chain — at construction, like every other
 * retained diagnostic — rather than a second one written here. Neutralization
 * is not applied: that belongs to the renderer, which is the last thing before
 * a display surface and is not always this process.
 */
function quarantineDetail(text: string): string {
  return sanitizedDetail(text, "Quarantine detail");
}

function conflict(destination: string, reason: string): BlockedError {
  return blocked(
    storeBlocker(
      "record_conflict",
      "A different record is already stored under this identity.",
      `${destination}: ${reason}`,
      {
        id: "inspect-conflicting-record",
        kind: "manual_action",
        summary: "Inspect the stored record; delete it only if you can account for how it got there.",
      },
    ),
  );
}

/**
 * Derives the identity, builds the record, and proves the store's own reader
 * would accept it — under one guard, because all three steps consume the same
 * untrusted input and every one of them can throw on it. Identity derivation
 * canonicalizes, so a cyclic binding or a hostile `toJSON` fails there; reading
 * a member off a missing resolution fails during construction; a member that is
 * merely wrong fails the round trip. Splitting the guard is what let the first
 * two escape as raw `CanonicalizationError`s and `TypeError`s — bypassing the
 * constructor's redaction on the way out, and arriving at a surface coded as an
 * internal error rather than as the bad input it is.
 *
 * The round trip is over JSON rather than over the object: the record is
 * checked in the form it will be *stored* in, so a value that serializes into
 * something the reader would quarantine is caught here rather than at a gate,
 * attributed to the wrong layer.
 */
function prepareRecord(workspaceId: string, input: PublishRecordInput): EvidenceRecord {
  try {
    const record: EvidenceRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      recordId: computeRecordId(workspaceId, input),
      workspaceId,
      gateId: input.gateId,
      obligationId: input.obligationId,
      candidateBinding: input.candidateBinding,
      resolution: input.resolution,
    };
    parseRecord(JSON.parse(JSON.stringify(record)));
    return record;
  } catch (error) {
    throw blocked(
      storeBlocker(
        "record_input_invalid",
        "The record to publish is not a well-formed evidence record.",
        describe(error),
        { id: "fix-record-input", kind: "code_change", summary: "Correct the record the recorder is publishing." },
      ),
    );
  }
}

/**
 * Publishes one record, atomically, and reports whether it created the entry or
 * found its own content already there.
 *
 * The two success statuses are not interchangeable to a caller that cares: a
 * recorder writing one record per claim expects `published`, and an idempotent
 * re-run of a completed submission expects `idempotent`. Both mean the store
 * now holds exactly this record; neither means anything was overwritten,
 * because nothing here ever overwrites.
 */
export async function publishRecord(
  rootDir: string,
  input: PublishRecordInput,
  options: PublishOptions = {},
): Promise<PublishedRecord> {
  const { storageDir, workspaceId } = await resolveRecordStorage(rootDir, options);
  const record = prepareRecord(workspaceId, input);
  const recordId = record.recordId;

  const destination = path.join(storageDir, recordFileName(record.gateId, record.obligationId, recordId));
  const rendered = renderRecord(record);

  try {
    await mkdir(storageDir, { recursive: true, mode: DIRECTORY_MODE });
    // Explicit, because `mkdir`'s mode is masked by the process umask and
    // because the directory may predate this harness version.
    await chmod(storageDir, DIRECTORY_MODE);
  } catch (error) {
    throw unwritable(storageDir, error);
  }

  // Dot-prefixed and `.tmp`-suffixed so no reader will serve it, and unique per
  // process and per attempt so an orphan left by a crash blocks nobody.
  const temporary = path.join(storageDir, `.${recordId}.${process.pid}.${randomUUID()}.tmp`);

  try {
    try {
      await writeFile(temporary, rendered, { mode: RECORD_MODE, flag: "wx" });
      await chmod(temporary, RECORD_MODE);
    } catch (error) {
      if (UNWRITABLE_CODES.has(errorCode(error) ?? "")) throw unwritable(temporary, error);
      throw error;
    }
    await syncPath(temporary, true);
    if (options.beforeLink !== undefined) await options.beforeLink();

    try {
      await link(temporary, destination);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        if (UNWRITABLE_CODES.has(errorCode(error) ?? "")) throw unwritable(destination, error);
        throw error;
      }
      return { status: "idempotent", path: destination, record: await reconcile(destination, record), workspaceId };
    }
    await syncPath(storageDir, false);
    return { status: "published", path: destination, record, workspaceId };
  } finally {
    // Only a publisher that returns cleans up after itself. A process killed
    // between the fsync and the link leaves its temporary behind — one file per
    // crash, mode 0600, dot-prefixed so no reader will serve it and no later
    // publisher will collide with it. That accumulation is accepted, not
    // overlooked: there is deliberately no reaper, because a reaper cannot tell
    // an abandoned temporary from one a concurrent publisher is mid-way through
    // writing, and deleting the second is a data race introduced to tidy up
    // after the first.
    await rm(temporary, { force: true });
  }
}

/**
 * The `EEXIST` decision, and the whole of SUB-4's second half.
 *
 * Identity alone is not enough to call a republication idempotent: the identity
 * tuple deliberately excludes the payload, so two records that disagree about
 * `manifestDigest` — or a waiver re-issued at a different scope — share an id
 * and must not share a slot. The comparison is therefore over the canonical
 * form of the whole record, and anything the store cannot parse is a conflict
 * rather than an invitation to overwrite.
 */
async function reconcile(destination: string, intended: EvidenceRecord): Promise<EvidenceRecord> {
  let existingText: string;
  try {
    existingText = await readFile(destination, "utf8");
  } catch (error) {
    throw conflict(destination, `a record is already stored here and could not be read: ${describe(error)}`);
  }

  let existing: EvidenceRecord;
  try {
    existing = parseStoredText(existingText);
  } catch (error) {
    throw conflict(destination, `the stored record is not usable: ${describe(error)}`);
  }

  if (digestCanonical(existing) !== digestCanonical(intended)) {
    throw conflict(destination, "the stored record shares this identity but carries different content");
  }
  return existing;
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Reads every record filed under one gate and obligation in this workspace.
 *
 * Discovery never throws on a bad file. A store with one unreadable record in
 * it still has to answer the question "what evidence exists for this
 * obligation", and the evaluator has to be able to tell "no evidence" from
 * "evidence I refuse to trust" — so unusable files come back as quarantine
 * entries carrying their class, and the caller decides what that means.
 */
export async function discoverRecords(rootDir: string, selector: RecordSelector): Promise<RecordDiscovery> {
  const { storageDir, workspaceId } = await resolveRecordStorage(rootDir, selector);
  const records: EvidenceRecord[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const ignored: IgnoredStoreEntry[] = [];

  let entries: readonly string[];
  try {
    // Code-unit order, not locale order: the same store must enumerate the same
    // way on every machine, which is the same reason JCS is the canonicalizer.
    entries = (await readdir(storageDir)).sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { storageDir, workspaceId, records, quarantined, ignored };
    throw unreadableStore(storageDir, error);
  }

  const prefix = slotPrefix(selector.gateId, selector.obligationId);

  for (const entry of entries) {
    const filePath = path.join(storageDir, entry);
    if (entry.startsWith(".") && entry.endsWith(".tmp")) {
      ignored.push({ path: filePath, reason: "in_progress" });
      continue;
    }
    if (!entry.endsWith(".json") || !entry.startsWith(prefix)) {
      ignored.push({ path: filePath, reason: "foreign" });
      continue;
    }

    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      quarantined.push({ path: filePath, reason: "unreadable", detail: quarantineDetail(describe(error)) });
      continue;
    }

    let record: EvidenceRecord;
    try {
      record = parseStoredText(text);
    } catch (error) {
      const reason = error instanceof RecordShapeError ? error.reason : "malformed_shape";
      quarantined.push({ path: filePath, reason, detail: quarantineDetail(describe(error)) });
      continue;
    }

    // Three ways a well-formed record can still be in the wrong place: another
    // workspace's store copied in, a mislabelled slot, or a filename that does
    // not carry the id its contents produce. All three are the same class —
    // the record does not belong to the identity it is filed under.
    const misfiling =
      record.workspaceId !== workspaceId
        ? `record belongs to workspace ${record.workspaceId}, this store is ${workspaceId}`
        : record.gateId !== selector.gateId || record.obligationId !== selector.obligationId
          ? `record is for ${record.gateId}/${record.obligationId}, filed under ${selector.gateId}/${selector.obligationId}`
          : entry !== recordFileName(record.gateId, record.obligationId, record.recordId)
            ? `filename does not carry recordId ${record.recordId}`
            : undefined;
    if (misfiling !== undefined) {
      quarantined.push({ path: filePath, reason: "identity_mismatch", detail: quarantineDetail(misfiling) });
      continue;
    }

    records.push(record);
  }

  return { storageDir, workspaceId, records, quarantined, ignored };
}
