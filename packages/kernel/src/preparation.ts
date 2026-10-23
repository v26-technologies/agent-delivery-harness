/**
 * Preparation receipts — the kernel's ordering mechanism.
 *
 * WHAT A RECEIPT IS FOR. Preparation is the point at which a candidate is
 * declared ready to be reviewed. Everything downstream — review context,
 * evidence, admission — is about *that* candidate under *that* wiring, so the
 * receipt is what lets a later step ask whether it is still talking about the
 * same thing. No receipt means no review context and no admission; that is the
 * whole ordering, and it is enforced by there being nothing else to consult.
 *
 * WHAT IT BINDS. The candidate's coordinates, and a `preparationFingerprint`
 * over the harness's own version plus the bytes of every wiring path the config
 * declares. The fingerprint is what makes "the gate itself changed" a distinct
 * answer from "your branch moved": a config edit, a rewritten preparation
 * script or a harness upgrade all invalidate a receipt, and they invalidate it
 * with a class that says so rather than looking like drift.
 *
 * FAIL-CLOSED ON UNRESOLVABLE WIRING. A declared wiring path that is not a
 * readable file is a typed blocker, never a hashed absence. Hashing "missing"
 * would make deleting a wiring file a *stable* fingerprint input — delete the
 * script, prepare, and the receipt is happily current for a gate whose wiring
 * is not there. The blocker is raised before anything is written, so a failed
 * preparation leaves no receipt at all.
 *
 * WHERE RECEIPTS LIVE. Under the record store's namespace root, in a leaf of
 * their own. The resolver is `records.ts`'s, reused rather than re-derived, and
 * the sharing is deliberate on both sides: receipts inherit the store's
 * git-private, worktree-local, untracked-by-construction placement, and they
 * inherit its `workspaceId` — which is the digest of the *namespace root*, not
 * of a leaf — so a receipt and the evidence recorded after it agree about which
 * workspace they belong to. Deriving a second workspace id here would silently
 * break every cross-leaf comparison built on the first.
 *
 * ONE RECEIPT PER GATE, REPLACED IN PLACE. Records are content-addressed and
 * immutable; a receipt is the opposite — it names the *current* preparation,
 * and preparing again supersedes it. So the file is `<gateId>.json` and
 * publication is an atomic rename rather than the store's `link()`-and-reconcile
 * dance. There is no idempotency question to answer: the second preparation
 * wins on purpose.
 *
 * NO TIMESTAMP. Athena's receipt carried `preparedAt`; this one does not.
 * Nothing here is decided by comparing times — every class is decided by
 * comparing values — and a member no decision reads is a member a later
 * decision will eventually be tempted to read, which is exactly what the
 * spec's clock ban exists to prevent.
 */
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BlockedError, createBlocker, sanitizedDetail, type Blocker, type NonEmptyTuple, type Remediation } from "./blockers.ts";
import { CANDIDATE_MODES, classifyCandidateDrift, type CandidateBinding, type CandidateMode } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import { digestCanonical } from "./digest.ts";
import { recordOutputConfiguration } from "./record-output.ts";
import { computeDeliverableIdentity } from "./identity.ts";
import { resolveRecordStorage, type RecordStorageOptions } from "./records.ts";
import type { WorkspaceStorage } from "./records.types.ts";

/**
 * Stored on every receipt so a reader can refuse a shape it does not
 * understand rather than guess at one. An unrecognised version is `invalid`,
 * not `stale`: the receipt is not a receipt this harness can read at all, and
 * saying "your candidate moved" about it would send an operator to look at
 * their branch.
 */
export const PREPARATION_RECEIPT_SCHEMA_VERSION = 1;

/** The leaf this module owns, beside the record store's under one root. */
export const PREPARATION_RECEIPT_LEAF = "preparation";

/**
 * The harness's own version, as a fingerprint input.
 *
 * Declared here rather than read from a package manifest at run time. An
 * installed package's manifest is not reliably reachable from the module that
 * would want it, and reading one at import time is exactly the ambient-file
 * dependency the import boundary exists to keep out. The cost is that this
 * constant can drift from the manifest, so a test asserts the two agree — the
 * drift is caught mechanically instead of being trusted.
 *
 * THE RELEASE WORKFLOW MUST BUMP THIS IN LOCKSTEP WITH
 * `packages/kernel/package.json`. Publishing a version whose fingerprint input
 * still names the previous one would let a receipt survive the upgrade it is
 * supposed to be invalidated by; the manifest-equality test is what makes the
 * omission a red run rather than a silent one.
 */
export const HARNESS_VERSION = "0.7.7";

/**
 * The five ways a receipt can fail to authorise the candidate in front of it,
 * in the order they are decided. The order is the contract, not an
 * implementation detail:
 *
 *   `missing`         — nothing to read. Every later question is unanswerable.
 *   `invalid`         — something is there and it is not a receipt this
 *                       harness wrote. Comparing its fields would be comparing
 *                       against arbitrary content.
 *   `wiring_mismatch` — the gate itself changed. The receipt was published by a
 *                       different harness or against different wiring, so what
 *                       it attests to is not what would be attested now.
 *   `base_changed`    — the base moved under the candidate. Reported ahead of
 *                       `stale` because the operator's action differs: the work
 *                       did not move, the ground under it did.
 *   `stale`           — the candidate moved.
 *
 * Each class is decided only once every earlier class has been ruled out, which
 * is what makes the ordering observable: a tree in two of these states reports
 * the earlier one, and the tests pin that pair by pair.
 */
export const PREPARATION_FAILURE_CLASSES = ["missing", "invalid", "wiring_mismatch", "base_changed", "stale"] as const;

export type PreparationFailureClass = (typeof PREPARATION_FAILURE_CLASSES)[number];

/**
 * What preparation needs to know about a candidate: the binding evidence will
 * carry, plus the two fields that are not part of it.
 *
 * `headSha` is compared because a head move with an identical tree is still a
 * different candidate to have prepared — the same decision the recorder makes
 * at submission. `mode` is compared because a receipt published for a staged
 * index does not authorise the same tree reached from a clean worktree; the
 * trees are equal and the claims about them are not.
 *
 * A `CapturedCandidate` satisfies this structurally, so capture's own output
 * can be handed straight in.
 */
export type PreparationCandidate = CandidateBinding & {
  readonly headSha: string;
  readonly mode: CandidateMode;
};

/**
 * The stored receipt. Flat, mirroring the record store's binding spelling
 * rather than the capture's nested one, so the two stored forms under one root
 * read the same way.
 *
 * `workspaceId` is the store the receipt belongs to; `candidateWorkspaceId` is
 * the workspace the candidate was captured in. They are normally equal, and the
 * redundancy is the same one the record store keeps for the same reason: making
 * them one field would turn a candidate that moved workspaces into a candidate
 * that did not.
 */
export interface PreparationReceipt {
  readonly schemaVersion: number;
  readonly gateId: string;
  readonly workspaceId: string;
  readonly treeSha: string;
  readonly headSha: string;
  readonly mode: CandidateMode;
  readonly deliverableDigest: string;
  readonly identityToken: string;
  readonly baseRef: string;
  readonly baseTipSha: string;
  readonly mergeBaseSha: string;
  readonly candidateWorkspaceId: string;
  readonly preparationFingerprint: string;
  /** Present on command-driven receipts; identifies the latest preparation attempt. */
  readonly attemptId?: string;
  /** CLI mechanical success binding; absent on legacy receipts. */
  readonly validationDigest?: string;
  readonly policyDigest?: string;
}

export interface PreparationOptions extends RecordStorageOptions {
  /** Only prepare may refresh a receipt after strict validation-equivalent movement. */
  readonly allowValidationEquivalent?: boolean;
  /** Portable verification reads declared wiring from the verified candidate tree. */
  readonly readWiring?: (repoPath: string) => Promise<Uint8Array>;
  /** Overrides the declared harness version. Tests use it; callers do not. */
  readonly harnessVersion?: string;
}

export interface PreparationInput {
  /** Supplied by CLI prepare after successful mechanics or proven receipt reuse. */
  readonly validationDigest?: string;
  readonly config: HarnessConfig;
  readonly candidate: PreparationCandidate;
  readonly attemptId?: string;
}

export interface PublishedPreparationReceipt {
  readonly path: string;
  readonly receipt: PreparationReceipt;
  readonly workspaceId: string;
}

export type PreparationEvaluation =
  | {
      readonly prepared: true;
      readonly receipt: PreparationReceipt;
      readonly receiptPath: string;
      readonly workspaceId: string;
    }
  | {
      readonly prepared: false;
      readonly failure: PreparationFailureClass;
      readonly reason: string;
      readonly receiptPath: string;
      readonly workspaceId: string;
      readonly blockers: NonEmptyTuple<Blocker>;
    };

// ── Blockers ───────────────────────────────────────────────────────────────

const DIRECTORY_MODE = 0o700;
const RECEIPT_MODE = 0o600;

/**
 * The one remediation every failure class carries. It is a `manual_action`
 * rather than a `command` because the command that publishes a receipt is a
 * consumer's, not the kernel's — the kernel does not know what the caller
 * spelled its prepare entry point, and inventing one here would print guidance
 * that does not run.
 */
const PREPARE_AGAIN: Remediation = {
  id: "prepare-current-candidate",
  kind: "manual_action",
  summary: "Prepare the current candidate again so a fresh receipt is published.",
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function preparationBlocker(
  code: "preparation_wiring_unresolvable" | "preparation_store_unwritable",
  id: string,
  summary: string,
  details: string,
  remediation: Remediation,
): BlockedError {
  const blocker = createBlocker({
    code,
    source: { kind: "preparation", id },
    summary,
    details,
    remediations: [remediation],
  });
  return new BlockedError([blocker], blocker.summary);
}

function wiringUnresolvable(repoPath: string, reason: string): BlockedError {
  return preparationBlocker(
    "preparation_wiring_unresolvable",
    "wiring",
    "A declared preparation wiring path could not be read.",
    `${repoPath}: ${reason}`,
    {
      id: "restore-declared-wiring-path",
      kind: "manual_action",
      summary: "Restore the declared wiring file, or remove the path from preparationWiringPaths — it is never hashed as absent.",
    },
  );
}

function storeUnwritable(target: string, error: unknown): BlockedError {
  return preparationBlocker(
    "preparation_store_unwritable",
    "store",
    "The preparation receipt could not be written.",
    `${target}: ${describe(error)}`,
    {
      id: "restore-store-permissions",
      kind: "manual_action",
      summary: "Make the git directory writable by the account running the harness, then prepare again.",
    },
  );
}

/**
 * The class-carrying blocker. Its code and its source id both name the class,
 * so a surface that only renders one of the two still says which of the five
 * happened — the classes are not interchangeable to an operator, and a blocker
 * that collapsed them would be a blocker that never told anyone what to do.
 */
function failureBlocker(failure: PreparationFailureClass, reason: string): Blocker {
  return createBlocker({
    code: `preparation_${failure}` as const,
    source: { kind: "preparation", id: failure },
    summary: FAILURE_SUMMARIES[failure],
    details: reason,
    remediations: [PREPARE_AGAIN],
  });
}

const FAILURE_SUMMARIES: Readonly<Record<PreparationFailureClass, string>> = {
  missing: "This candidate has no preparation receipt.",
  invalid: "The preparation receipt is not one this harness can read.",
  wiring_mismatch: "The harness wiring changed after the receipt was published.",
  base_changed: "The base moved after the candidate was prepared.",
  stale: "The candidate changed after it was prepared.",
};

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * One receipt per gate, named after it. The gate id is already part of the
 * record store's filename grammar and is validated at config load, so no
 * additional escaping is introduced here; a gate whose id would not make a
 * filename is a config the loader rejects.
 */
export function receiptFileName(gateId: string): string {
  return `${gateId}.json`;
}

/**
 * The record store's resolver, with this module's leaf.
 *
 * Everything that makes the store worktree-private — the `--git-path`
 * resolution, the containment check that refuses a namespace git would root in
 * the common directory, the physical-path normalisation the workspace id
 * depends on — is inherited rather than restated. There is deliberately no
 * second copy of that reasoning: a receipt that resolved its own directory
 * could disagree with the store about which worktree it is in, and the
 * disagreement would surface as evidence that looked fresh.
 */
export function resolveReceiptStorage(rootDir: string, options: PreparationOptions = {}): Promise<WorkspaceStorage> {
  return resolveRecordStorage(rootDir, { ...options, leaf: PREPARATION_RECEIPT_LEAF });
}

// ── Fingerprint ────────────────────────────────────────────────────────────

/**
 * The digest of the harness version and the declared wiring bytes.
 *
 * SORTED AND DEDUPLICATED. The fingerprint is a statement about a *set* of
 * files, so two configs that declare the same paths in a different order — or
 * that name one twice — describe the same wiring and must agree. Order
 * sensitivity would make a cosmetic config edit read as a wiring change, which
 * is a real answer given for a non-reason.
 *
 * HASHED THROUGH THE CANONICALIZER, not through ad-hoc framing. Each path
 * contributes its own name and its own content digest, and the pairs are
 * digested as a canonical-JSON object. Framing raw file bytes with a NUL
 * separator instead is not injective: `path1\0abc\0path2\0def` reads two ways
 * the moment a wiring file contains a NUL of its own, so two different wirings
 * could produce one fingerprint. Pairing each digest with its declared path
 * also keeps two identical files distinguishable — moving a gate's wiring
 * between declared paths is a wiring change.
 *
 * NO VERSION MEMBER RIDES IN THE INPUT. A receipt this harness cannot read is
 * rejected at the `invalid` step, which is decided before any fingerprint is
 * compared, so a schema version inside the digest would be a second copy of a
 * check that has already run — with bump semantics nothing would define.
 *
 * A path that cannot be read as a file throws. See the module note — a hashed
 * absence would make deletion a stable input.
 */
export async function computePreparationFingerprint(
  rootDir: string,
  config: HarnessConfig,
  options: PreparationOptions = {},
): Promise<string> {
  const declared = [...new Set(config.preparationWiringPaths)].sort();
  const wiring: { readonly path: string; readonly digest: string }[] = [];

  for (const repoPath of declared) {
    const target = path.resolve(rootDir, repoPath);
    let contents: Buffer;
    try {
      if (options.readWiring !== undefined) contents = Buffer.from(await options.readWiring(repoPath));
      else {
        const info = await stat(target);
        if (!info.isFile()) throw wiringUnresolvable(repoPath, `${target} is not a regular file`);
        contents = await readFile(target);
      }
    } catch (error) {
      if (error instanceof BlockedError) throw error;
      throw wiringUnresolvable(repoPath, errorCode(error) === "ENOENT" ? `${target} does not exist` : describe(error));
    }
    wiring.push({ path: repoPath, digest: digestCanonical(contents.toString("base64")) });
  }

  return digestCanonical({ harnessVersion: options.harnessVersion ?? HARNESS_VERSION, wiring,
    ...(config.preparationCommands?.length ? { preparationCommands: config.preparationCommands } : {}),
  });
}

/**
 * Replace the current attempt token before removing the previous receipt.
 * Publication and evaluation both check this token: an older command still
 * running cannot restore authority after a newer attempt starts or fails.
 */
export async function invalidatePreparationReceipt(
  rootDir: string, config: HarnessConfig, options: PreparationOptions = {},
): Promise<string> {
  const { storageDir } = await resolveReceiptStorage(rootDir, options);
  const receiptPath = path.join(storageDir, receiptFileName(config.gateId));
  const attemptId = randomUUID();
  const temporary = path.join(storageDir, `.${attemptId}.tmp`);
  try {
    await mkdir(storageDir, { recursive: true, mode: DIRECTORY_MODE });
    await writeFile(temporary, attemptId, { flag: "wx", mode: RECEIPT_MODE });
    await syncFile(temporary);
    await rename(temporary, `${receiptPath}.attempt`);
    await rm(receiptPath, { force: true });
    return attemptId;
  } catch (error) {
    throw storeUnwritable(receiptPath, error);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Revoke unsuccessful preparation without replacing a newer attempt. Open the existing
 * token before checking its value, then mutate that same inode: if ordinary
 * preparation replaces the pathname meanwhile, its new token is untouched.
 * The receipt remains on disk but cannot authorize against a revoked token.
 */
export async function revokePreparationAttempt(
  rootDir: string, config: HarnessConfig, attemptId: string, options: PreparationOptions = {},
): Promise<void> {
  const { storageDir } = await resolveReceiptStorage(rootDir, options);
  const receiptPath = path.join(storageDir, receiptFileName(config.gateId));
  let handle;
  try {
    handle = await open(`${receiptPath}.attempt`, "r+");
    if (await handle.readFile("utf8") !== attemptId) return;
    await handle.write(randomUUID(), 0, "utf8");
    await handle.sync();
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw storeUnwritable(receiptPath, error);
  } finally {
    await handle?.close();
  }
}

async function currentAttempt(receiptPath: string): Promise<string | undefined> {
  try {
    return await readFile(`${receiptPath}.attempt`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function requireCurrentAttempt(receiptPath: string, attemptId: string | undefined): Promise<void> {
  if (await currentAttempt(receiptPath) !== attemptId) {
    throw new BlockedError([failureBlocker("stale", "A newer preparation attempt superseded this receipt; prepare again.")]);
  }
}

// ── Publication ────────────────────────────────────────────────────────────

function buildReceipt(
  workspaceId: string,
  gateId: string,
  candidate: PreparationCandidate,
  preparationFingerprint: string,
): PreparationReceipt {
  return {
    schemaVersion: PREPARATION_RECEIPT_SCHEMA_VERSION,
    gateId,
    workspaceId,
    treeSha: candidate.treeSha,
    headSha: candidate.headSha,
    mode: candidate.mode,
    deliverableDigest: candidate.deliverable.digest,
    identityToken: candidate.deliverable.identity,
    baseRef: candidate.base.ref,
    baseTipSha: candidate.base.tipSha,
    mergeBaseSha: candidate.base.mergeBaseSha,
    candidateWorkspaceId: candidate.workspaceId,
    preparationFingerprint,
  };
}

/**
 * Publishes the current receipt, replacing whatever was there.
 *
 * The caller invalidates the previous receipt before starting checks. This
 * publication computes the fingerprint before writing, so unreadable wiring
 * cannot produce a new receipt.
 *
 * Write-temp-then-rename, not write-in-place: a reader that opened the receipt
 * while a second preparation was mid-write would otherwise see a truncated file
 * and call it `invalid`, which is a real class being reported for a race.
 */
export async function publishPreparationReceipt(
  rootDir: string,
  input: PreparationInput,
  options: PreparationOptions = {},
): Promise<PublishedPreparationReceipt> {
  const fingerprint = await computePreparationFingerprint(rootDir, input.config, options);
  const { storageDir, workspaceId } = await resolveReceiptStorage(rootDir, options);
  const receipt = {
    ...buildReceipt(workspaceId, input.config.gateId, input.candidate, fingerprint),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.validationDigest === undefined ? {} : { validationDigest: input.validationDigest, policyDigest: digestCanonical(recordOutputConfiguration(input.config, input.candidate.deliverable.digest)) }),
  };
  const destination = path.join(storageDir, receiptFileName(input.config.gateId));
  await requireCurrentAttempt(destination, input.attemptId);

  try {
    await mkdir(storageDir, { recursive: true, mode: DIRECTORY_MODE });
    // Explicit, because `mkdir`'s mode is masked by the process umask and
    // because the directory may predate this harness version.
    await chmod(storageDir, DIRECTORY_MODE);
  } catch (error) {
    throw storeUnwritable(storageDir, error);
  }

  // Dot-prefixed and unique per process and per attempt, so a crashed
  // preparation leaves nothing a reader would serve and blocks no later one.
  const temporary = path.join(storageDir, `.${randomUUID()}.tmp`);
  try {
    try {
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: RECEIPT_MODE });
      await chmod(temporary, RECEIPT_MODE);
    } catch (error) {
      throw storeUnwritable(temporary, error);
    }
    await syncFile(temporary);
    await requireCurrentAttempt(destination, input.attemptId);
    try {
      await rename(temporary, destination);
    } catch (error) {
      throw storeUnwritable(destination, error);
    }
    await requireCurrentAttempt(destination, input.attemptId);
    return { path: destination, receipt, workspaceId };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** fsync through a read handle, so the bytes are on disk before the rename. */
async function syncFile(target: string): Promise<void> {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ── Evaluation ─────────────────────────────────────────────────────────────

const RECEIPT_MEMBERS = [
  "schemaVersion",
  "gateId",
  "workspaceId",
  "treeSha",
  "headSha",
  "mode",
  "deliverableDigest",
  "identityToken",
  "baseRef",
  "baseTipSha",
  "mergeBaseSha",
  "candidateWorkspaceId",
  "preparationFingerprint",
] as const;

/**
 * A total shape check: exact members, no extras, every string non-empty.
 *
 * Rejecting unknown members matters more here than it looks. A receipt written
 * by a *newer* harness that added a field would otherwise be read by this one
 * as a receipt it fully understands, and the field it cannot see is by
 * construction a field the newer harness thought was worth binding.
 */
function parseReceipt(value: unknown): PreparationReceipt | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the receipt is not a JSON object";
  const record = value as Record<string, unknown>;

  const extra = Object.keys(record).filter((key) => !["attemptId", "validationDigest", "policyDigest"].includes(key) && !(RECEIPT_MEMBERS as readonly string[]).includes(key));
  if (extra.length > 0) return `the receipt carries unknown members: ${extra.sort().join(", ")}`;
  if (record["attemptId"] !== undefined && (typeof record["attemptId"] !== "string" || record["attemptId"] === "")) {
    return "the receipt attemptId is not a non-empty string";
  }

  if ((record["validationDigest"] === undefined) !== (record["policyDigest"] === undefined) ||
      ["validationDigest", "policyDigest"].some(key => record[key] !== undefined && (typeof record[key] !== "string" || !/^[a-f0-9]{64}$/.test(record[key] as string)))) {
    return "the receipt validation and policy digests must be a pair of SHA-256 digests";
  }

  if (record["schemaVersion"] !== PREPARATION_RECEIPT_SCHEMA_VERSION) {
    return `the receipt declares schema version ${String(record["schemaVersion"])}, and this harness reads ${PREPARATION_RECEIPT_SCHEMA_VERSION}`;
  }
  // The candidate vocabulary itself, never a local restatement of it: a subset
  // literal would typecheck clean forever and start rejecting legitimate
  // receipts as `invalid` the day a mode is added next door.
  if (!(CANDIDATE_MODES as readonly string[]).includes(record["mode"] as string)) {
    return `the receipt declares an unsupported mode ${JSON.stringify(record["mode"])}`;
  }
  for (const member of RECEIPT_MEMBERS) {
    if (member === "schemaVersion" || member === "mode") continue;
    const held = record[member];
    if (typeof held !== "string" || held === "") return `the receipt member ${member} is not a non-empty string`;
  }

  return {
    schemaVersion: PREPARATION_RECEIPT_SCHEMA_VERSION,
    gateId: record["gateId"] as string,
    workspaceId: record["workspaceId"] as string,
    treeSha: record["treeSha"] as string,
    headSha: record["headSha"] as string,
    mode: record["mode"] as CandidateMode,
    deliverableDigest: record["deliverableDigest"] as string,
    identityToken: record["identityToken"] as string,
    baseRef: record["baseRef"] as string,
    baseTipSha: record["baseTipSha"] as string,
    mergeBaseSha: record["mergeBaseSha"] as string,
    candidateWorkspaceId: record["candidateWorkspaceId"] as string,
    preparationFingerprint: record["preparationFingerprint"] as string,
    ...(record["attemptId"] === undefined ? {} : { attemptId: record["attemptId"] as string }),
    ...(record["validationDigest"] === undefined ? {} : { validationDigest: record["validationDigest"] as string, policyDigest: record["policyDigest"] as string }),
  };
}

/**
 * Every reason below quotes bytes that came off disk — a gate id, a base ref,
 * an identity token, a parser's complaint about the file it was handed — and a
 * receipt is a file anything on the machine can write. So the reason is
 * sanitized here, once, and the *same* string becomes both the returned member
 * and the blocker's detail.
 *
 * Once matters in both directions. Sanitizing only inside the blocker leaves
 * the raw bytes on `reason`, which is a public member surfaces read directly:
 * an unbounded gate id becomes an unbounded reason, and a credential planted in
 * a receipt survives in whichever copy a caller happens to log. Sanitizing
 * twice — separately for each — would be two chains to keep in step, and the
 * weaker one would be the one that mattered.
 *
 * Neutralization is deliberately not applied here. It belongs to the renderer,
 * which is the last thing before a display surface; what this guarantees is
 * that the member and the blocker carry identical text, so neither can be the
 * unprotected copy.
 */
function failed(
  failure: PreparationFailureClass,
  reason: string,
  receiptPath: string,
  workspaceId: string,
): PreparationEvaluation {
  const sanitized = sanitizedDetail(reason, `Preparation ${failure} reason`);
  return {
    prepared: false,
    failure,
    reason: sanitized,
    receiptPath,
    workspaceId,
    blockers: [failureBlocker(failure, sanitized)],
  };
}

/**
 * The binding the receipt attests to, in the shape the drift classifier
 * compares. Reusing that classifier rather than restating its comparisons is
 * what keeps one definition of "the candidate moved" in the kernel; the split
 * of its classes across the two failure classes is this module's own policy,
 * and it is written out below rather than left to the reader.
 */
function receiptBinding(receipt: PreparationReceipt): CandidateBinding {
  return {
    treeSha: receipt.treeSha,
    deliverable: { digest: receipt.deliverableDigest, identity: receipt.identityToken },
    base: { ref: receipt.baseRef, tipSha: receipt.baseTipSha, mergeBaseSha: receipt.mergeBaseSha },
    workspaceId: receipt.candidateWorkspaceId,
  };
}

/**
 * Decides the five classes, in the declared order, stopping at the first that
 * holds.
 *
 * The order is not a series of early returns that happen to be arranged this
 * way — each step is unanswerable until the one before it has passed. There is
 * nothing to parse until there is a file; nothing to compare until the parse
 * succeeded; and comparing candidate coordinates against a receipt published
 * under different wiring answers a question nobody asked, because the wiring
 * that produced those coordinates is not the wiring in front of us.
 *
 * Two comparisons deliberately do not use the drift classifier: `baseRef` and
 * `identityToken` are configuration disagreements rather than movement — the
 * classifier says so itself — but a receipt published against a different base
 * ref or a different identity function does not authorise this candidate
 * either. The ref lands in `base_changed` and the token in `stale`, next to the
 * digest it names the meaning of.
 */
export async function evaluatePreparationReceipt(
  rootDir: string,
  input: PreparationInput,
  options: PreparationOptions = {},
): Promise<PreparationEvaluation> {
  const { storageDir, workspaceId } = await resolveReceiptStorage(rootDir, options);
  const receiptPath = path.join(storageDir, receiptFileName(input.config.gateId));

  // ── missing ──
  let text: string;
  try {
    text = await readFile(receiptPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return failed("missing", `no preparation receipt was found at ${receiptPath}`, receiptPath, workspaceId);
    }
    return failed("invalid", `the preparation receipt could not be read: ${describe(error)}`, receiptPath, workspaceId);
  }

  // ── invalid ──
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failed("invalid", `the preparation receipt is not parseable as JSON: ${describe(error)}`, receiptPath, workspaceId);
  }
  const receipt = parseReceipt(parsed);
  if (typeof receipt === "string") return failed("invalid", receipt, receiptPath, workspaceId);
  if (receipt.gateId !== input.config.gateId) {
    return failed(
      "invalid",
      `the receipt was published for gate ${receipt.gateId} and this run is gate ${input.config.gateId}`,
      receiptPath,
      workspaceId,
    );
  }
  // A receipt whose workspace is not this store's did not come from this
  // worktree. Reporting it as drift would tell an operator to prepare again,
  // which would work and would leave the reason it was there unexamined.
  if (receipt.workspaceId !== workspaceId) {
    return failed("invalid", "the receipt belongs to a different workspace than the store it was read from", receiptPath, workspaceId);
  }

  try {
    if (await currentAttempt(receiptPath) !== receipt.attemptId) {
      return failed("stale", "A newer preparation attempt superseded this receipt", receiptPath, workspaceId);
    }
  } catch (error) {
    return failed("invalid", `the preparation attempt could not be read: ${describe(error)}`, receiptPath, workspaceId);
  }

  // ── wiring_mismatch ──
  const fingerprint = await computePreparationFingerprint(rootDir, input.config, options);
  if (receipt.preparationFingerprint !== fingerprint) {
    return failed(
      "wiring_mismatch",
      "the harness version or the declared wiring files changed after the receipt was published",
      receiptPath,
      workspaceId,
    );
  }

  const expected = receiptBinding(receipt);
  const drift = new Set(classifyCandidateDrift(expected, input.candidate));

  // ── base_changed ──
  if (receipt.baseRef !== input.candidate.base.ref) {
    return failed(
      "base_changed",
      `the receipt was prepared against ${receipt.baseRef} and this candidate is against ${input.candidate.base.ref}`,
      receiptPath,
      workspaceId,
    );
  }
  if (drift.has("base_tip_moved") || drift.has("merge_base_moved")) {
    return failed("base_changed", `${receipt.baseRef} moved after the candidate was prepared`, receiptPath, workspaceId);
  }

  // Only preparation refresh may reuse mechanical success. Admission still
  // requires the exact receipt coordinates. The narrower projection keeps
  // report/solution changes significant even when review identity excludes them.
  if (options.allowValidationEquivalent && receipt.validationDigest !== undefined &&
      receipt.policyDigest === digestCanonical(recordOutputConfiguration(input.config, input.candidate.deliverable.digest)) && !drift.has("workspace_changed") &&
      receipt.identityToken === input.candidate.deliverable.identity &&
      receipt.validationDigest === await computeDeliverableIdentity({ rootDir, treeSha: input.candidate.treeSha,
        config: { ...input.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: input.config.recordNeutral } })) {
    return { prepared: true, receipt, receiptPath, workspaceId };
  }

  // ── stale ──
  if (drift.has("raw_tree_changed") || drift.has("deliverable_identity_changed") || drift.has("workspace_changed")) {
    return failed("stale", `the candidate changed after preparation: ${[...drift].sort().join(", ")}`, receiptPath, workspaceId);
  }
  if (receipt.identityToken !== input.candidate.deliverable.identity) {
    return failed(
      "stale",
      `the receipt's digest was computed by ${receipt.identityToken} and this candidate's by ${input.candidate.deliverable.identity}`,
      receiptPath,
      workspaceId,
    );
  }
  if (receipt.headSha !== input.candidate.headSha) {
    return failed("stale", "the head moved after preparation, even though the tree did not", receiptPath, workspaceId);
  }
  if (receipt.mode !== input.candidate.mode) {
    return failed(
      "stale",
      `the receipt was prepared in ${receipt.mode} mode and this candidate is ${input.candidate.mode}`,
      receiptPath,
      workspaceId,
    );
  }

  if (options.allowValidationEquivalent) {
    return failed("stale", "Mechanical success has no matching strict validation and policy binding", receiptPath, workspaceId);
  }
  return { prepared: true, receipt, receiptPath, workspaceId };
}
