import { captureCheckBindings } from "./checks.ts";
/**
 * The submission flow: spec §8.3, from a manifest on disk to published records.
 *
 * WHAT THIS MODULE IS FOR. The validator answers "is this manifest internally
 * coherent, and does it agree with the candidate observation I was handed".
 * That is a judgement about a value. Submission is a judgement about the
 * *world*: the candidate as it is right now, the run root this harness
 * allocated, the bytes actually sitting in it, and a store that may already
 * hold a record under this identity. Those five SUB rules exist because the
 * transport is part of the trust model — a provider that could choose its own
 * run root, or submit against a candidate it prepared an hour ago, would make
 * every downstream guarantee decorative.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER.
 *
 *   1. Read the manifest through the fs port.
 *   2. When a provider caller supplies its allocated attempt, bind that one
 *      snapshot to the expected provider, run, and run root.
 *   3. Re-capture the candidate through the injected port (SUB-1, SUB-2).
 *   4. Require a current preparation receipt for that candidate — the
 *      preparation receipt's ordering mechanism.
 *   5. Derive the run root from the provider coordinates, and observe every
 *      declared artifact inside it (ENV-10's realpath clause, ENV-11).
 *   6. Validate the manifest, handing it the re-captured candidate and the
 *      artifact bytes read in step 5.
 *   7. Aggregate: the validator's rejections and this module's, in one
 *      response (SUB-5), with no record written if there is a single one
 *      (GEN-3).
 *   8. Publish one record per claim, stamped with the manifest digest (SUB-4).
 *
 * Capture precedes the receipt check because the receipt is evaluated *against*
 * a candidate: there is nothing to compare a receipt to until something has
 * been observed. The receipt check precedes everything else because a stale
 * receipt means the wiring or the tree that produced this candidate is not the
 * one in front of us, and validating a manifest against it would answer a
 * question nobody asked.
 *
 * NO RECEIPT IS A BLOCKER, NEVER A BYPASS. A missing, invalid, wiring-mismatched
 * or stale receipt ends the submission with the receipt's own typed blockers.
 * There is deliberately no option to skip the check and no code path that
 * substitutes the captured candidate for a receipt: the ordering is a mechanism
 * precisely because there is nothing else to consult.
 *
 * WHAT IS NOT DECIDED HERE. Whether an obligation is *satisfied* — that is the
 * gate's question, asked later against the records this writes. This module
 * accepts or rejects a submission; it never resolves an obligation, and it
 * never reads a clock. Freshness in this system is content identity (GEN-5),
 * and `recordedAt` is data whose grammar the validator checks and whose value
 * nothing consults.
 */
import { BlockedError, createBlocker, sanitizedDetail, type Blocker, type NonEmptyTuple, type Remediation } from "./blockers.ts";
import { createArtifactsPort } from "./artifacts.ts";
import type { ArtifactObservation, ArtifactsPort, RunRoot, RunRootRefusalReason, RunRootResolution } from "./artifacts.types.ts";
import { capturePortableEvidenceContext, repositoryEvidenceReader, retainPortableEvidence, verifyPortableEvidence } from "./portable-evidence.ts";
import {
  classifyCandidateDrift,
  type CandidateBinding,
  type CandidateDriftClass,
  type CaptureCandidate,
  type CapturedCandidate,
} from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import { digestCanonical, manifestDigest as computeManifestDigest } from "./digest.ts";
import { evaluatePreparationReceipt } from "./preparation.ts";
import { computeRecordId, discoverRecords, publishRecord, recordFileName, resolveRecordStorage, type RecordStorageOptions } from "./records.ts";
import type { EvidenceRecord, PortableEvidence, PublishRecordInput, PublishedRecord, RecordCandidateBinding } from "./records.types.ts";
import type { ManifestRejection } from "./validator/codes.ts";
import { declaredArtifacts, judgeArtifact } from "./validator/artifacts.ts";
import { validateManifest, type DeliveryEvidenceManifest } from "./validator/envelope.ts";

// ── The submission's inputs ────────────────────────────────────────────────

export interface SubmissionInput {
  /** The repository the evidence store and the receipt store belong to. */
  readonly rootDir: string;
  /** Where the submitted manifest file is. SUB-3 is about this path. */
  readonly manifestPath: string;
  readonly config: HarnessConfig;
}

export interface ExpectedProviderAttempt {
  /** Provider selected by the harness for this invocation. */
  readonly providerId: string;
  /** Request/run identity allocated by the harness for this invocation. */
  readonly runId: string;
  /** Run root allocated by the harness before the provider was started. */
  readonly runRootPath: string;
}

export interface SubmissionOptions extends RecordStorageOptions {
  readonly scopedPlan?: import("./records.types.ts").ScopedCheckPlan;
  readonly readOutput?: (repoPath: string, providerId: string) => Promise<Uint8Array>;
  /**
   * How the current candidate is observed (SUB-1). Injected rather than
   * defaulted to the git capture: the recorder must not own a repository
   * dependency, and a conformance run drives this whole path from declared
   * values with no repository at all.
   */
  readonly captureCandidate: CaptureCandidate;
  /** The filesystem port. Defaults to one rooted in the system temp directory. */
  readonly artifacts?: ArtifactsPort;
  /**
   * Optional caller authority for provider-driven submissions. When present,
   * the recorder binds the one manifest snapshot it reads to this invocation
   * before any validation or publication. Ordinary submission paths omit it.
   */
  readonly expectedProviderAttempt?: ExpectedProviderAttempt;
  /** Passed through to the receipt evaluation. Tests use it; callers do not. */
  readonly harnessVersion?: string;
}

// ── The submission's outcome ───────────────────────────────────────────────

export interface SubmissionRecord {
  readonly obligationId: string;
  readonly recordId: string;
  readonly path: string;
  /** `published` on first write, `idempotent` when this exact record was already stored. */
  readonly status: PublishedRecord["status"];
  readonly record: EvidenceRecord;
}

/**
 * Three outcomes, not two.
 *
 * `rejected` means the submission was judged and failed: every violated rule is
 * named, and the codes are the spec's. `blocked` means it could not be judged —
 * no receipt, an unreadable manifest, a store that will not answer — and there
 * is no spec code for that, because the spec's codes describe manifests. A
 * caller that collapsed the two would have to invent a rejection code for "the
 * harness could not look", which is exactly the fabrication a fail-closed
 * design is trying to avoid.
 *
 * Both failing shapes carry blockers, and blockers are what a surface renders.
 * No caller formats a rejection or a preparation reason itself.
 */
export type SubmissionOutcome =
  | {
      readonly status: "accepted";
      readonly manifestDigest: string;
      readonly records: NonEmptyTuple<SubmissionRecord>;
    }
  | {
      readonly status: "rejected";
      readonly rejections: NonEmptyTuple<ManifestRejection>;
      readonly blockers: NonEmptyTuple<Blocker>;
    }
  | {
      readonly status: "blocked";
      readonly blockers: NonEmptyTuple<Blocker>;
    };

// ── SUB-1: the enumerated comparison ───────────────────────────────────────

/**
 * The fields SUB-1 compares, named rather than derived from whatever a capture
 * happens to carry.
 *
 * `headSha` is in the set and is compared strictly when the manifest declares
 * one: §5.3 calls it informational because evidence binds to *trees*, and that
 * note governs gate-time freshness, where a rebase preserving the tree
 * preserves the evidence. SUB-1 is the other end of the system — it says
 * "every field" and the recorded id is an audit anchor — so a head that moved
 * under an identical tree is rejected here and re-preparation is the remedy.
 *
 * `vcs` is constant under ENV-4 and compared anyway, because "every field"
 * means the enumeration, not the fields that could plausibly differ.
 */
export const SUBMISSION_CANDIDATE_FIELDS: readonly string[] = Object.freeze([
  "vcs",
  "treeSha",
  "headSha",
  "deliverable.digest",
  "deliverable.identity",
  "base.ref",
  "base.tipSha",
  "base.mergeBaseSha",
  "workspaceId",
]);

export interface CandidateComparison {
  readonly matches: boolean;
  /** Enumerated field paths that differ, in declaration order. */
  readonly mismatchedFields: readonly string[];
  /**
   * The drift classes the difference falls into, for the fields that describe
   * movement in the repository. A mismatch on `base.ref`, `deliverable.identity`
   * or `vcs` produces no class by design — those are configuration
   * disagreements, and telling an operator to re-prepare would be wrong advice.
   */
  readonly driftClasses: readonly CandidateDriftClass[];
}

function readMember(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, name) ? (value as Record<string, unknown>)[name] : undefined;
}

function readPath(value: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, name) => readMember(current, name), value);
}

/**
 * Compares a submitted candidate binding against the one just captured, on the
 * enumerated field set.
 *
 * The submitted side is read defensively — it is a manifest member, so it may
 * be any value at all — and a member that is absent or of the wrong type is a
 * mismatch rather than a skipped comparison. The single exception is `headSha`,
 * which the envelope makes optional: a manifest that declares none is compared
 * on the other eight.
 */
export function compareSubmissionCandidate(submitted: unknown, captured: CapturedCandidate): CandidateComparison {
  const capturedValues: Readonly<Record<string, unknown>> = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    "deliverable.digest": captured.deliverable.digest,
    "deliverable.identity": captured.deliverable.identity,
    "base.ref": captured.base.ref,
    "base.tipSha": captured.base.tipSha,
    "base.mergeBaseSha": captured.base.mergeBaseSha,
    workspaceId: captured.workspaceId,
  };

  const mismatchedFields: string[] = [];
  for (const field of SUBMISSION_CANDIDATE_FIELDS) {
    const declared = readPath(submitted, field);
    if (field === "headSha" && declared === undefined) continue;
    if (declared !== capturedValues[field]) mismatchedFields.push(field);
  }

  const submittedBinding = bindingFromSubmitted(submitted);
  const driftClasses =
    submittedBinding === null ? [] : classifyCandidateDrift(submittedBinding, capturedBinding(captured));

  return { matches: mismatchedFields.length === 0, mismatchedFields, driftClasses };
}

function capturedBinding(captured: CapturedCandidate): CandidateBinding {
  return {
    treeSha: captured.treeSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };
}

/**
 * The submitted candidate in the shape the drift classifier compares, or `null`
 * when the submitted value does not carry the four members a classification
 * needs. A partially-shaped candidate is still a mismatch — the field-level
 * comparison above says so — it simply has no drift *class* to name.
 */
function bindingFromSubmitted(submitted: unknown): CandidateBinding | null {
  const treeSha = readPath(submitted, "treeSha");
  const digest = readPath(submitted, "deliverable.digest");
  const identity = readPath(submitted, "deliverable.identity");
  const tipSha = readPath(submitted, "base.tipSha");
  const mergeBaseSha = readPath(submitted, "base.mergeBaseSha");
  const ref = readPath(submitted, "base.ref");
  const workspaceId = readPath(submitted, "workspaceId");
  const strings = [treeSha, digest, identity, tipSha, mergeBaseSha, ref, workspaceId];
  if (strings.some((value) => typeof value !== "string")) return null;
  return {
    treeSha: treeSha as string,
    deliverable: { digest: digest as string, identity: identity as string },
    base: { ref: ref as string, tipSha: tipSha as string, mergeBaseSha: mergeBaseSha as string },
    workspaceId: workspaceId as string,
  };
}

/**
 * What the validator is handed as the current candidate: the capture, projected
 * into the envelope's candidate shape.
 *
 * The projection is what makes SUB-1 the *validator's* rejection rather than a
 * second one raised here. It carries `headSha` only when the manifest declares
 * one, which is how "compared when present" is expressed to a comparison that
 * is otherwise whole-value — and it carries nothing the envelope does not
 * define, so a manifest with an extra member inside `candidate` fails both the
 * closed grammar and this comparison, which is correct on both counts.
 */
function projectCapturedCandidate(captured: CapturedCandidate, submitted: unknown): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };
  if (readPath(submitted, "headSha") !== undefined) projected["headSha"] = captured.headSha;
  return projected;
}

// ── Blockers ───────────────────────────────────────────────────────────────

const RESUBMIT: Remediation = {
  id: "resubmit-after-fixing-the-manifest",
  kind: "manual_action",
  summary: "Fix what the codes name, prepare the candidate again if it moved, and resubmit.",
};

const CHECK_MANIFEST_PATH: Remediation = {
  id: "submit-from-the-run-root",
  kind: "manual_action",
  summary: "Submit the manifest from the run root the harness allocated for this run.",
};

const RETRY_PROVIDER_ATTEMPT: Remediation = {
  id: "retry-provider-attempt",
  kind: "retry",
  summary: "Run the selected provider again with the harness-allocated request and run root.",
};

function submissionBlocker(code: string, summary: string, details: string, remediation: Remediation): Blocker {
  return createBlocker({
    // A runtime-checked code: this module builds one from a rejection code,
    // which is a registry value rather than a literal the type system can see.
    // `createBlocker` still applies the grammar at runtime.
    code,
    source: { kind: "gate", id: "delivery-harness.submission" },
    summary,
    details: sanitizedDetail(details, "Submission detail"),
    remediations: [remediation],
  });
}

/**
 * One blocker per rejection, in emission order.
 *
 * The rejection's own message is a constant string from the validator and the
 * pointer is an RFC 6901 pointer into the submitted manifest; neither
 * interpolates provider-authored text. Rendering — truncation, redaction,
 * §11.2 neutralization — belongs to the shared renderer, which is the last
 * thing before a display surface. Nothing here formats for a screen.
 *
 * `candidate_mismatch` gets one addition: the fields that actually differ and
 * the drift class they fall into. The code alone says "this is not the
 * candidate you prepared", which is true of a rebase, a moved base ref and a
 * config pointed at a different branch alike — and the operator's next action
 * is different for each. The added text is this module's own vocabulary
 * (enumerated field names and taxonomy classes), never a submitted value.
 */
function rejectionBlockers(rejections: readonly ManifestRejection[], candidateDetail: string | null): Blocker[] {
  return rejections.map((rejection) => {
    const detail = `${rejection.pointer === "" ? "/" : rejection.pointer}: ${rejection.message}`;
    return submissionBlocker(
      rejection.code,
      `The submission violates ${rejection.rule}.`,
      rejection.code === "candidate_mismatch" && candidateDetail !== null ? `${detail} (${candidateDetail})` : detail,
      rejection.code === "manifest_outside_run_root" ? CHECK_MANIFEST_PATH : RESUBMIT,
    );
  });
}

/**
 * The comparison in one line, or `null` when there is nothing to add — either
 * nothing was captured to compare against, or the enumerated fields all agree
 * and the mismatch is in a member the envelope does not define.
 */
function describeComparison(comparison: CandidateComparison | null): string | null {
  if (comparison === null || comparison.matches) return null;
  const drift = comparison.driftClasses.length === 0 ? "" : `; drift: ${comparison.driftClasses.join(", ")}`;
  return `differing fields: ${comparison.mismatchedFields.join(", ")}${drift}`;
}

function nonEmpty<T>(values: readonly T[], what: string): NonEmptyTuple<T> {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error(`${what} must not be empty.`);
  return [first, ...rest];
}

function blockedOutcome(blockers: readonly Blocker[]): SubmissionOutcome {
  return { status: "blocked", blockers: nonEmpty(blockers, "blockers") };
}

async function expectedProviderAttemptBlockers(
  manifest: unknown,
  manifestPath: string,
  expected: ExpectedProviderAttempt,
  artifacts: ArtifactsPort,
): Promise<readonly Blocker[]> {
  const blockers: Blocker[] = [];
  try {
    if (!(await artifacts.isInsideRunRoot(expected.runRootPath, manifestPath))) {
      blockers.push(
        submissionBlocker(
          "provider_manifest_outside_attempt_root",
          "The provider manifest is outside the run root allocated for this attempt.",
          "The manifest path does not resolve inside the caller-bound provider run root.",
          RETRY_PROVIDER_ATTEMPT,
        ),
      );
    }
  } catch (error) {
    if (error instanceof BlockedError) return error.blockers;
    blockers.push(
      submissionBlocker(
        "provider_attempt_binding_failed",
        "The provider manifest could not be bound to its allocated run root.",
        error instanceof Error ? error.message : String(error),
        RETRY_PROVIDER_ATTEMPT,
      ),
    );
  }

  if (readPath(manifest, "provider.id") !== expected.providerId || readPath(manifest, "provider.runId") !== expected.runId) {
    blockers.push(
      submissionBlocker(
        "provider_attempt_mismatch",
        "The provider manifest belongs to a different invocation.",
        "The manifest provider or run identity differs from the caller-bound provider attempt.",
        RETRY_PROVIDER_ATTEMPT,
      ),
    );
  }
  return blockers;
}

function rejectedOutcome(rejections: readonly ManifestRejection[], comparison: CandidateComparison | null = null): SubmissionOutcome {
  const listed = nonEmpty(rejections, "rejections");
  return {
    status: "rejected",
    rejections: listed,
    blockers: nonEmpty(rejectionBlockers(listed, describeComparison(comparison)), "blockers"),
  };
}

// ── The recorder's own rules ───────────────────────────────────────────────

const RECORDER_MESSAGES = {
  manifest_outside_run_root: "the manifest does not reside inside the run root allocated for this provider run",
  artifact_outside_run_root: "the artifact resolves to a location outside the run root",
  artifact_missing: "no file is present at the declared path inside the run root",
  artifact_not_a_file: "the declared path names a directory or another non-regular entry, which has no bytes to digest",
  artifact_unreadable: "the artifact could not be read at submission",
  artifact_digest_mismatch: "the artifact's bytes at submission do not have the declared digest",
} as const;

// ── The submission ─────────────────────────────────────────────────────────

/**
 * Submits one manifest: §8.3 end to end.
 *
 * Every rule runs before anything is written. That is GEN-3 — validation is
 * atomic across claims, and a manifest with one good claim and one bad one
 * writes nothing at all — and it is also why SUB-5 aggregation is possible:
 * the recorder's own filesystem findings join the validator's list rather than
 * short-circuiting it.
 */
export async function submitManifest(input: SubmissionInput, options: SubmissionOptions): Promise<SubmissionOutcome> {
  const artifacts = options.artifacts ?? createArtifactsPort();

  let manifest: unknown;
  try {
    manifest = JSON.parse(await artifacts.readTextFile(input.manifestPath));
  } catch (error) {
    if (error instanceof BlockedError) return blockedOutcome(error.blockers);
    return blockedOutcome([
      submissionBlocker(
        "manifest_unparseable",
        "The submitted manifest is not parseable JSON.",
        `${input.manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
        RESUBMIT,
      ),
    ]);
  }

  if (options.expectedProviderAttempt !== undefined) {
    const attemptBlockers = await expectedProviderAttemptBlockers(
      manifest,
      input.manifestPath,
      options.expectedProviderAttempt,
      artifacts,
    );
    if (attemptBlockers.length > 0) return blockedOutcome(attemptBlockers);
  }

  // ── SUB-1 and SUB-2: what is actually prepared, right now ──
  const capture = await options.captureCandidate();
  if (!capture.ok && capture.code !== "candidate_unprepared") {
    // Every other capture failure is a repository the harness could not read
    // the way it needs to. There is no manifest rule for that, and inventing
    // one would report a comparison nobody performed.
    return blockedOutcome(capture.blockers);
  }
  const captured = capture.ok ? capture.candidate : null;

  // ── The receipt gate ──
  let preparationFingerprint: string | undefined;
  if (captured !== null) {
    const preparation = await evaluatePreparationReceipt(
      input.rootDir,
      { config: input.config, candidate: captured },
      { ...storageOptions(options), ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }) },
    );
    if (!preparation.prepared) return blockedOutcome(preparation.blockers);
    preparationFingerprint = preparation.receipt.preparationFingerprint;
  }

  const rejections: ManifestRejection[] = [];

  // ── The run root, and everything decided inside it ──
  const allocation = await allocateRunRootFor(manifest, artifacts);
  if (!allocation.ok && allocation.blocker !== null) return blockedOutcome([allocation.blocker]);
  const runRoot = allocation.ok ? allocation.runRoot : null;
  const artifactContents = new Map<string, string>();
  const observations = new Map<string, ArtifactObservation>();

  if (runRoot !== null) {
    // SUB-3. Run roots are recorder-allocated, so "inside the run root" is a
    // statement about a directory this process created, not about one the
    // manifest named.
    if (!(await artifacts.isInsideRunRoot(runRoot.path, input.manifestPath))) {
      rejections.push({
        code: "manifest_outside_run_root",
        rule: "SUB-3",
        pointer: "",
        message: RECORDER_MESSAGES.manifest_outside_run_root,
      });
    }

    for (const entry of declaredArtifacts(manifest)) {
      const observation = await artifacts.observeArtifact(runRoot, entry.path);
      observations.set(entry.path, observation);
      if (observation.status === "readable" && observation.contents !== null) {
        artifactContents.set(entry.path, observation.contents);
      }
      const rejection = judgeArtifact(entry, observation);
      if (rejection !== null) rejections.push(rejection);
    }
  }

  // ── The manifest's own rules ──
  const checkBindings = captured === null ? {} : await captureCheckBindings(input.rootDir, input.config, captured, options);
  const validation = validateManifest(manifest, {
    config: input.config,
    // A candidate that could not be captured matches nothing: SUB-1 requires
    // equality with the current prepared candidate, and an unobserved candidate
    // supplies no side to be equal to. Failing closed here is what keeps an
    // unprepared workspace from also being an unchecked one.
    currentCandidate: captured === null ? undefined : projectCapturedCandidate(captured, readMember(manifest, "candidate")),
    prepared: captured !== null,
    artifactContents,
    checkBindings,
  });
  if (!validation.ok) rejections.push(...validation.rejections);

  // GEN-3: nothing is written while a single rule is unsatisfied, whichever
  // claim it belongs to and whichever of the two judges found it.
  if (!validation.ok || rejections.length > 0) {
    return rejectedOutcome(rejections, captured === null ? null : compareSubmissionCandidate(readMember(manifest, "candidate"), captured));
  }

  // ── SUB-4 ──
  try {
    const context = await capturePortableEvidenceContext(input.config, repositoryEvidenceReader(input.rootDir, artifacts), preparationFingerprint!, captured!.deliverable.digest);
    const portable = retainPortableEvidence(validation.manifest, observations, context);
    const blockers = verifyPortableEvidence(input.config, portable, recordBinding(validation.manifest), context, checkBindings);
    if (blockers.length > 0) return blockedOutcome(blockers);
    return publishClaims(input, options, validation.manifest, portable);
  } catch (error) {
    if (error instanceof BlockedError) return blockedOutcome(error.blockers);
    return blockedOutcome([submissionBlocker("portable_context_invalid", "The accepted evidence inputs could not be retained.", error instanceof Error ? error.message : String(error), RESUBMIT)]);
  }
}

function storageOptions(options: SubmissionOptions): RecordStorageOptions {
  return {
    ...(options.storageNamespace === undefined ? {} : { storageNamespace: options.storageNamespace }),
    ...(options.storageRoot === undefined ? {} : { storageRoot: options.storageRoot }),
    ...(options.runGit === undefined ? {} : { runGit: options.runGit }),
  };
}

/**
 * Refusals the manifest validator independently names, under ENV-1 and ENV-2.
 *
 * The distinction decides whether a refusal may be skipped. A `runId` of
 * `"../run-a"` or `"."` never reaches the filesystem, and skipping the
 * run-root rules for it loses nothing: the submission is already rejected for
 * the id, and emitting `manifest_outside_run_root` for a run root that was
 * never allocated would claim a containment check that could not be performed.
 *
 * Every other refusal is the opposite case. An over-long provider id is legal
 * under ENV-1 and a planted run root is legal everywhere — nothing else in the
 * system rejects either — so skipping there would accept a submission whose
 * containment and artifact digests were never checked at all. Those fail
 * closed, as blockers: there is no manifest rule for "the harness's own
 * directory is not its own", and inventing one would put a spec code on a check
 * that did not happen.
 */
const VALIDATOR_NAMED_REFUSALS: readonly RunRootRefusalReason[] = ["unsafe_provider_id", "unsafe_run_id"];

const RUN_ROOT_REFUSAL_SUMMARIES: Readonly<Record<RunRootRefusalReason, string>> = {
  unsafe_provider_id: "The provider id cannot be a run-root path component.",
  unsafe_run_id: "The run id cannot be a run-root path component.",
  provider_id_too_long: "The provider id is too long to be a run-root path component.",
  run_root_outside_base: "The run root for this provider run is not inside the pool the harness allocates from.",
};

const REALLOCATE_RUN_ROOT: Remediation = {
  id: "let-the-harness-allocate-the-run-root",
  kind: "manual_action",
  summary: "Remove the run-root path, re-run the provider so the harness allocates it, and resubmit.",
};

type RunRootAllocation =
  | { readonly ok: true; readonly runRoot: RunRoot }
  /** `blocker: null` means the validator names this one, so the rules are skipped. */
  | { readonly ok: false; readonly blocker: Blocker | null };

/**
 * The run root for this manifest's provider run.
 *
 * The port's own failure is caught here rather than allowed to propagate. It
 * raises a typed blocker for a filesystem it cannot use, and this is the one
 * call in the submission that reaches the filesystem outside a guard — an
 * over-long path or an unwritable pool would otherwise leave `submitManifest`
 * by throwing, which is not a shape any caller of this function handles.
 */
async function allocateRunRootFor(manifest: unknown, artifacts: ArtifactsPort): Promise<RunRootAllocation> {
  const providerId = readPath(manifest, "provider.id");
  const runId = readPath(manifest, "provider.runId");
  // Not strings at all: the closed grammar rejects that, so there is nothing
  // for a run-root rule to add.
  if (typeof providerId !== "string" || typeof runId !== "string") return { ok: false, blocker: null };

  let allocation: RunRootResolution;
  try {
    allocation = await artifacts.allocateRunRoot({ providerId, runId });
  } catch (error) {
    if (!(error instanceof BlockedError)) throw error;
    const [first] = error.blockers;
    return { ok: false, blocker: first ?? runRootBlocker("run_root_outside_base", `${providerId}/${runId}`) };
  }

  if (allocation.ok) return { ok: true, runRoot: allocation.runRoot };
  if (VALIDATOR_NAMED_REFUSALS.includes(allocation.reason)) return { ok: false, blocker: null };
  return { ok: false, blocker: runRootBlocker(allocation.reason, `${providerId}/${runId}`) };
}

function runRootBlocker(reason: RunRootRefusalReason, coordinates: string): Blocker {
  return submissionBlocker(reason, RUN_ROOT_REFUSAL_SUMMARIES[reason], coordinates, REALLOCATE_RUN_ROOT);
}

// ── Publication ────────────────────────────────────────────────────────────

/**
 * The record's candidate binding, taken from the manifest — which SUB-1 has
 * just proved describes the candidate that exists.
 *
 * TWO WORKSPACE IDS MEET HERE, AND THEY COME FROM DIFFERENT PLACES. The
 * `workspaceId` on this binding is the *candidate's*, carried by the capture;
 * the one in the record's identity tuple is the *store's*, derived by the
 * storage resolver from the namespace root it resolved. They are normally
 * equal and the store deliberately does not require it, so that a candidate
 * that moved workspaces stays visible as one. The consequence for whoever
 * wires the command surface: capture and store must be pointed at the same
 * repository, or a record can be filed in one workspace while claiming
 * another, and nothing here will say so.
 */
function recordBinding(manifest: DeliveryEvidenceManifest): RecordCandidateBinding {
  const candidate = manifest.candidate;
  return {
    treeSha: candidate.treeSha,
    deliverableDigest: candidate.deliverable.digest,
    identityToken: candidate.deliverable.identity,
    baseRef: candidate.base.ref,
    baseTipSha: candidate.base.tipSha,
    mergeBaseSha: candidate.base.mergeBaseSha,
    workspaceId: candidate.workspaceId,
  };
}

/**
 * Writes one record per claim, each stamped with the shared manifest digest.
 *
 * TWO PASSES AND A ROLLBACK, AND WHY EACH IS NEEDED.
 *
 * The store's own publication is atomic per record and decides
 * idempotency-versus-conflict at the moment it links one into place. That is
 * the authority on *whether* a record may be written, and nothing here replaces
 * it — but it is an authority over one record, and GEN-3 is a claim about a
 * whole submission.
 *
 * So conflicts are looked for across every claim first, and publication starts
 * only once none was found. That makes the ordinary case atomic. It does not
 * make the concurrent case atomic: two submissions for the same provider run
 * can both preflight clean, and the one that reaches a taken slot second is
 * rejected with its earlier claims already linked into place. The store closes
 * *detection* of that collision, not the atomicity of the submission that lost
 * it.
 *
 * The rollback is what closes the rest. A rejection undoes the records this
 * submission published — only those it created, never one it found already
 * there, which belongs to whoever wrote it — so a rejected submission leaves
 * the store as it found it. What remains uncovered is a crash between the two,
 * which leaves records with no submission to speak for them; that is the record
 * store's own orphan story and not something a caller can close from here.
 */
async function publishClaims(
  input: SubmissionInput,
  options: SubmissionOptions,
  manifest: DeliveryEvidenceManifest,
  portable: PortableEvidence,
): Promise<SubmissionOutcome> {
  const storage = storageOptions(options);
  const artifacts = options.artifacts ?? createArtifactsPort();
  const digest = computeManifestDigest(manifest);
  const binding = recordBinding(manifest);

  const inputs: readonly PublishRecordInput[] = manifest.claims.map((claim) => ({
    gateId: input.config.gateId,
    obligationId: claim.obligation,
    candidateBinding: binding,
    resolution: {
      kind: "evidence" as const,
      providerId: manifest.provider.id,
      runId: manifest.provider.runId,
      finalPassId: manifest.provider.finalPassId,
      manifestDigest: digest,
      ...(claim.payloadSpec === "checks.passed/1" ? { checkBinding: claim.payload["binding"] as unknown as import("./records.types.ts").CheckBinding } : {}),
      portable,
    },
  }));

  const records: SubmissionRecord[] = [];

  try {
    const conflicts = await findConflicts(input, storage, inputs);
    if (conflicts.length > 0) return rejectedOutcome(conflicts);

    for (const publishInput of inputs) {
      const published = await publishRecord(input.rootDir, publishInput, storage);
      records.push({
        obligationId: published.record.obligationId,
        recordId: published.record.recordId,
        path: published.path,
        status: published.status,
        record: published.record,
      });
    }
    return { status: "accepted", manifestDigest: digest, records: nonEmpty(records, "records") };
  } catch (error) {
    if (!(error instanceof BlockedError)) throw error;
    await rollBack(records, artifacts);
    // The store raised it, so it is the authority: a conflict is SUB-4's
    // rejection, and anything else the store refuses — an unwritable directory,
    // a namespace it will not resolve — is a blocker, because no manifest rule
    // describes it.
    if (!error.blockers.some((blocker) => blocker.code === "record_conflict")) return blockedOutcome(error.blockers);
    return rejectedOutcome([{ code: "record_conflict", rule: "SUB-4", pointer: "", message: CONFLICT_MESSAGE }]);
  }
}

/**
 * Removes the records this submission created, so a rejection leaves the store
 * as it found it (GEN-3).
 *
 * ONLY THE ONES IT CREATED. A record the store reported as `idempotent` was
 * already on disk when this submission ran: it is another submission's, it is
 * byte-identical to what this one would have written, and deleting it would
 * make a failed submission destroy an accepted one's evidence.
 *
 * Best-effort by construction. The rejection it is cleaning up after is the
 * answer the caller needs, and a cleanup that threw would replace that answer
 * with its own failure.
 */
async function rollBack(records: readonly SubmissionRecord[], artifacts: ArtifactsPort): Promise<void> {
  for (const record of records) {
    if (record.status !== "published") continue;
    await artifacts.removeFile(record.path);
  }
}

const CONFLICT_MESSAGE = "a record with this identity is already stored and carries different content";

/**
 * Every claim whose record identity is already taken by different content.
 *
 * Identity alone decides nothing: the SUB-4 tuple excludes the payload, so a
 * second submission of the same run against the same candidate *should* find
 * its own record there and succeed idempotently. What makes it a conflict is
 * the content — here, the binding and the resolution, which together are
 * everything a record carries that the store does not derive.
 *
 * A quarantined file in the slot counts as a conflict too. The store cannot
 * parse it, so it cannot be shown to be this record; treating an unreadable
 * neighbour as absent would let a publication overwrite something nobody has
 * accounted for.
 */
async function findConflicts(
  input: SubmissionInput,
  storage: RecordStorageOptions,
  inputs: readonly PublishRecordInput[],
): Promise<readonly ManifestRejection[]> {
  const { workspaceId } = await resolveRecordStorage(input.rootDir, storage);
  const conflicts: ManifestRejection[] = [];

  for (const publishInput of inputs) {
    const recordId = computeRecordId(workspaceId, publishInput);
    const fileName = recordFileName(publishInput.gateId, publishInput.obligationId, recordId);
    const discovery = await discoverRecords(input.rootDir, {
      ...storage,
      gateId: publishInput.gateId,
      obligationId: publishInput.obligationId,
    });

    const quarantined = discovery.quarantined.some((entry) => entry.path.endsWith(fileName));
    const existing = discovery.records.find((record) => record.recordId === recordId);
    const differs =
      existing !== undefined &&
      digestCanonical({ binding: existing.candidateBinding, resolution: existing.resolution }) !==
        digestCanonical({ binding: publishInput.candidateBinding, resolution: publishInput.resolution });

    if (quarantined || differs) {
      conflicts.push({ code: "record_conflict", rule: "SUB-4", pointer: "", message: CONFLICT_MESSAGE });
    }
  }

  return conflicts;
}
