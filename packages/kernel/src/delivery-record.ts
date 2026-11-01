/**
 * The tracked delivery record — `delivery-record/2` — and the pure verification
 * core the CLI `verify` command and the GitHub Action both call.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. The delivery record is a product-layer
 * projection that lives *outside* the delivery-evidence/1 spec. The git-private
 * evidence store (records.ts) is the gate's evidence; this is the one sanctioned
 * artifact that crosses out of the workspace into the tracked tree, so that a
 * reviewer — and a CI job in a different workspace — can see that a gate was
 * satisfied without re-running it. At L0 it proves process discipline and
 * freshness, not provenance.
 *
 * PRODUCE-ONLY (sensor rule d2). This module BUILDS the record object and its
 * canonical bytes; it never writes them. The CLI `record` command performs the
 * one write, through the artifacts fs port, so the only place in the kernel that
 * opens a file for the submission/record path stays the artifacts port.
 *
 * NO CLOCK (sensor rule e). Nothing here reads a clock or a `recordedAt`: the
 * record's identity is the candidate it attests, never the moment it was
 * written, and its freshness is judged against a recomputed deliverable
 * identity, never against elapsed time.
 *
 * WHY THE RECORD IS NEUTRAL TO ITS OWN PATH. `config.deliveryRecordPath` is
 * required by the config loader to satisfy *both* neutral predicates. Because it
 * is review-neutral, writing it does not change the deliverable identity the
 * record attests — the record cannot invalidate itself. Because it is
 * record-neutral, it is not part of any candidate binding — a candidate is never
 * bound to the presence of its own record. The self-neutrality proof in the test
 * suite is exactly this property, exercised end to end.
 */
import {
  BASE_MOVEMENT_POLICIES,
  NON_WAIVABLE_INTEGRITY_CODES,
  V1_ATTESTATION_LEVEL,
  type AttestationLevel,
  type BaseMovementPolicy,
  type HarnessConfig,
} from "./config.ts";
import {
  createBlocker,
  type Blocker,
  type BlockerSource,
  type NonEmptyTuple,
  type Remediation,
} from "./blockers.ts";
import { canonicalize } from "./canonical.ts";
import { digestCanonical } from "./digest.ts";
import type { CandidateBinding } from "./candidate.types.ts";
import type { EvidenceRecord, RecordCandidateBinding, WaiverResolution, PortableEvidenceContext, CheckBinding, ResourceApplicabilityBinding } from "./records.types.ts";
import { effectiveHostedChecksPolicy, verifyCompiledPolicy, type CompiledPolicy } from "./policy/compile.ts";
import { isHostedCheckExemption, isHostedCheckInstant, type HostedCheckExemption } from "./policy/document.ts";
// TYPE ONLY, DELIBERATELY. The row is echoed, never evaluated, so this module
// takes the shape and nothing that could read one.
import type { RunJournalRow } from "./checkpoint/run-journal-completeness.ts";
import { evaluateGate, RESOLUTION_OUTCOMES, type EvaluateGateInput, type GateDecision, type ResolutionOutcome } from "./evaluator.ts";

import { verifyPortableEvidence, portableArtifactContents, MAX_PORTABLE_RECORD_BYTES, portableBlocker } from "./portable-evidence.ts";
import { computeRecordId } from "./record-identity.ts";
import { manifestDigest as computeManifestDigest } from "./digest.ts";
// ── Constants ────────────────────────────────────────────────────────────────

/** The product-layer version token. Not a delivery-evidence/1 spec value. */
export const DELIVERY_RECORD_VERSION = "delivery-record/2";

/**
 * The honest attestation label. L0 is workspace-scoped process discipline and
 * freshness — never provenance. Surfaced verbatim by every verification summary.
 */
export const ATTESTATION_LABEL =
  "self / workspace-scoped — process discipline and freshness, not provenance";

/**
 * The drift classes a verification can name. `deliverable_identity_changed` is
 * the identity mismatch; the three base classes are the base-movement drift the
 * policy either stales on or names as relaxed.
 */
export const DELIVERY_RECORD_DRIFT_CLASSES = [
  "deliverable_identity_changed",
  "base_ref_changed",
  "base_tip_moved",
  "merge_base_moved",
] as const;

export type DeliveryRecordDriftClass = (typeof DELIVERY_RECORD_DRIFT_CLASSES)[number];

/**
 * The two closed, delivery-owned path sets that may never appear in a
 * candidate tree: the receipted run-pinned projection subtree, and the
 * binding-written host discovery configuration. Inside a run the compiled
 * execution grant protects them; here — in the compiled external verifier a
 * reviewer or a CI job runs, with no product state to consult — a committed
 * path inside either set is a protected-authority-path violation on its own
 * evidence. The two lists are held identical by a sensor in the test suite.
 *
 * Membership is by path SEGMENT, never by string prefix: `src/managed-
 * projection-notes.md` names one of these and is nothing to do with it. It is
 * also CASE-FOLDED, and the prefix itself counts — the same two rules the
 * in-run deny side applies, because on a case-insensitive checkout a case
 * alias still lands inside the protected path, and the prefix committed as a
 * single entry is a symlink pointing wherever its author chose.
 */
export const DELIVERY_OWNED_TREE_PREFIXES: readonly string[] = Object.freeze([".managed-projection", ".claude"]);

/**
 * The one exception to the frozen `.claude` prefix, and its two anchors.
 *
 * The `agent-skills` generation install exposes its skills to Claude Code as
 * relative symlinks under `.claude/skills/` pointing into the tracked, receipted
 * generation at `.agent-skills/current/skills/`. That exposure carries no skill
 * text of its own: every byte a host would read lives in the generation the
 * candidate already tracks, under a prefix this rule does not own. Committing it
 * is therefore not the thing the rule forbids — planting authority text under
 * the host's directory — and an adopter that installs the generation should not
 * have to track the exposure differently from the way the product does.
 *
 * The exception is deliberately the narrowest shape that admits that install and
 * nothing else, and it is decidable from the committed tree alone: the entry's
 * git mode must be a symlink, and its target — resolved against the entry's own
 * directory and normalized — must name something strictly inside the receipted
 * skills root. No filesystem is read, no configuration is consulted, and no
 * other delivery-owned prefix is affected. Everything else under `.claude`,
 * including a regular file under `skills/` and a case alias of either anchor,
 * stays a protected-authority-path violation.
 */
export const CLAUDE_SKILL_EXPOSURE_PREFIX = ".claude/skills/";

/** The receipted generation's skills root a Claude skill exposure may name. */
export const RECEIPTED_SKILLS_ROOT = ".agent-skills/current/skills/";

/** The git tree mode of a symlink; the only mode the exception admits. */
const SYMLINK_MODE = "120000";

const DELIVERY_RECORD_SOURCE: BlockerSource = { kind: "delivery-record", id: "delivery-harness.delivery-record" };

const RERECORD: Remediation = {
  id: "re-run-the-loop",
  kind: "manual_action",
  summary: "Re-prepare, re-run the gate, and re-record for the current candidate.",
};

function drBlocker(code: string, summary: string, details?: string, remediation: Remediation = RERECORD): Blocker {
  return createBlocker({
    code,
    source: DELIVERY_RECORD_SOURCE,
    summary,
    ...(details === undefined ? {} : { details }),
    remediations: [remediation],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ── The record shape ─────────────────────────────────────────────────────────

/**
 * One obligation's outcome as promoted into the tracked record. Never `blocked`
 * — a blocked obligation means the gate did not admit and no record is written.
 */
export interface DeliveryRecordClaim {
  readonly obligationId: string;
  readonly outcome: ResolutionOutcome;
  readonly providerId?: string;
  readonly recordId?: string;
  readonly runId?: string;
  readonly finalPassId?: string;
  readonly manifestDigest?: string;
  readonly scope?: string;
  readonly waiver?: WaiverResolution & { readonly candidateBinding: RecordCandidateBinding };
  readonly ciPolicyId?: string;
  readonly evidence?: EvidenceRecord;
  readonly supportingEvidence?: readonly EvidenceRecord[];
}

export interface DeliveryRecordAttestation {
  readonly level: AttestationLevel;
}

/** The owner declaration projected into a candidate-bound tracked record. */
export interface RecordedHostedCheckExemption extends HostedCheckExemption {
  readonly policyDigest: string;
}

export interface DeliveryRecordHostedChecks {
  readonly required: true;
  readonly exemption?: RecordedHostedCheckExemption;
}

/**
 * The tracked `delivery-record/2` artifact. `workspaceId` is recorded for audit
 * but is deliberately *excluded* from verification: CI verifies from a different
 * workspace by construction, so binding on it would fail every real PR.
 */
export interface DeliveryRecord {
  readonly version: typeof DELIVERY_RECORD_VERSION | "delivery-record/1";
  readonly gateId: string;
  readonly identityToken: string;
  readonly candidateBinding: RecordCandidateBinding;
  readonly claims: readonly DeliveryRecordClaim[];
  readonly manifestDigest: string | null;
  readonly workspaceId: string;
  readonly attestation: DeliveryRecordAttestation;
  readonly context?: PortableEvidenceContext;
  readonly hostedChecks?: DeliveryRecordHostedChecks;
  readonly runSpan?: DeliveryRecordRunSpan;
  readonly integrityDigest?: string;
}

/**
 * How long the delivery had taken when it recorded, as its run journal says.
 *
 * WHY IT IS ONE MEMBER AND NOT TWO. The pair is only ever meaningful together:
 * an `endedAt` with no start measures nothing, and a record carrying one of
 * them would have to be given a meaning by every reader separately. Nesting
 * them makes both-or-neither a property of the shape rather than a rule each
 * consumer re-implements, and leaves the obvious room for a second span — a
 * tracker's own — beside this one.
 *
 * THIS IS NOT A CLOCK READING (sensor rule e). Nothing here or in the build
 * below reads a clock: the two instants are the journal's own first and last
 * `at`, supplied by the boundary that read the journal, exactly as `observedAt`
 * is supplied rather than taken. The record's identity remains the candidate it
 * attests, and no freshness or admission decision reads this member — it is a
 * cycle-time figure that travels with the record so that "how long did this
 * take" survives the workspace the run happened in.
 */
export interface DeliveryRecordRunSpan {
  readonly startedAt: string;
  readonly endedAt: string;
}

/** Both instants well formed, in order, and nothing else in the member. */
export function isDeliveryRecordRunSpan(value: unknown): value is DeliveryRecordRunSpan {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "endedAt" || keys[1] !== "startedAt") return false;
  if (!isHostedCheckInstant(value["startedAt"]) || !isHostedCheckInstant(value["endedAt"])) return false;
  // Lexicographic order is chronological order for this fixed-width UTC shape,
  // which is why the shape is fixed: a record claiming it ended before it
  // started is malformed on its own face, with no clock and no parsing.
  return (value["startedAt"] as string) <= (value["endedAt"] as string);
}

// ── Build (produce-only) ─────────────────────────────────────────────────────

export interface BuildDeliveryRecordInput {
  readonly config: HarnessConfig;
  readonly decision: GateDecision;
  /** The evidence records backing the decision, used to stamp manifest digests. */
  readonly evidenceRecords: readonly EvidenceRecord[];
  readonly context?: PortableEvidenceContext;
  /** Current compiled owner policy plus a boundary-supplied observation time. */
  readonly compiledPolicy?: CompiledPolicy;
  readonly observedAt?: string;
  /**
   * The delivery's span as the boundary read it off the run journal. Omitted
   * where no journal describes this delivery, so a record written outside a run
   * is the record it always was rather than one carrying invented time.
   */
  readonly runSpan?: DeliveryRecordRunSpan;
}

export type BuildDeliveryRecordResult =
  | { readonly ok: true; readonly record: DeliveryRecord }
  | { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> };

function activeHostedCheckExemption(
  compiledPolicy: CompiledPolicy,
  binding: Pick<RecordCandidateBinding, "baseRef">,
  observedAt: string | undefined,
): { readonly ok: true; readonly exemption?: RecordedHostedCheckExemption } | { readonly ok: false; readonly blocker: Blocker } {
  const structural = verifyCompiledPolicy(compiledPolicy);
  if (!structural.ok) {
    return { ok: false, blocker: drBlocker("hosted_check_policy_invalid", "The compiled hosted-check policy is malformed.") };
  }
  const policy = effectiveHostedChecksPolicy(compiledPolicy);
  const scoped = policy.exemptions.find((entry) =>
    entry.scope.repositoryId === compiledPolicy.snapshot.repositoryId && entry.scope.baseRef === binding.baseRef);
  if (scoped === undefined) return { ok: true };
  if (!isHostedCheckInstant(observedAt)) {
    return { ok: false, blocker: drBlocker("hosted_check_time_missing", "An explicit current UTC instant is required to evaluate the hosted-check exemption.") };
  }
  if (observedAt >= scoped.until) return { ok: true };
  return { ok: true, exemption: { ...scoped, scope: { ...scoped.scope }, policyDigest: compiledPolicy.compiledDigest } };
}

/** Maps the evaluator's candidate shape onto the record's flat binding. */
export function bindingOf(candidate: CandidateBinding): RecordCandidateBinding {
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

function claimedManifestDigests(claims: readonly DeliveryRecordClaim[]): string[] {
  return [...new Set(claims.flatMap(claim => [claim.manifestDigest, ...(Array.isArray(claim.supportingEvidence) ? claim.supportingEvidence.map((record: EvidenceRecord) => record?.resolution?.kind === "evidence" ? record.resolution.manifestDigest : undefined) : [])]).filter((digest): digest is string => typeof digest === "string"))];
}

function claimOf(
  resolution: GateDecision["resolutions"][number],
  evidenceByRecordId: ReadonlyMap<string, EvidenceRecord>,
): DeliveryRecordClaim {
  switch (resolution.kind) {
    case "satisfied_evidence": {
      const evidence = evidenceByRecordId.get(resolution.recordId);
      const manifestDigest = evidence?.resolution.kind === "evidence" ? evidence.resolution.manifestDigest : undefined;
      return {
        obligationId: resolution.obligationId,
        outcome: resolution.kind,
        providerId: resolution.providerId,
        recordId: resolution.recordId,
        runId: resolution.runId,
        finalPassId: resolution.finalPassId,
        ...(manifestDigest === undefined ? {} : { manifestDigest }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(resolution.supportingRecordIds === undefined ? {} : { supportingEvidence: resolution.supportingRecordIds.filter(id => id !== resolution.recordId).map(id => evidenceByRecordId.get(id)!).filter(record => record !== undefined) }),
      };
    }
    case "satisfied_live_fact":
      return { obligationId: resolution.obligationId, outcome: resolution.kind, providerId: resolution.providerId, runId: resolution.runId };
    case "waived":
      return { obligationId: resolution.obligationId, outcome: resolution.kind, recordId: resolution.waiverRecordId, scope: resolution.scope,
        waiver: { ...resolution.waiver, candidateBinding: resolution.candidateBinding } };
    case "delegated":
      return { obligationId: resolution.obligationId, outcome: resolution.kind, ciPolicyId: resolution.ciPolicyId };
    case "not_applicable":
      return { obligationId: resolution.obligationId, outcome: resolution.kind };
    case "blocked":
      // Unreachable: the caller refuses a decision carrying a blocked obligation.
      return { obligationId: resolution.obligationId, outcome: resolution.kind };
  }
}

/**
 * Builds the tracked record from an *admitted* gate decision. Refuses (returns
 * blockers) when the decision did not admit or carries a blocked obligation —
 * a record is a statement that the gate passed, and there is nothing truthful
 * to write otherwise.
 */
export function buildDeliveryRecord(input: BuildDeliveryRecordInput): BuildDeliveryRecordResult {
  const { config, decision, evidenceRecords } = input;
  if (!decision.admitted) {
    return {
      ok: false,
      blockers: [drBlocker("record_gate_not_admitted", "The gate did not admit; there is nothing to record.")],
    };
  }
  const blocked = decision.resolutions.find((resolution) => resolution.kind === "blocked");
  if (blocked !== undefined) {
    return {
      ok: false,
      blockers: [
        drBlocker(
          "record_blocked_obligation",
          "The gate result carries a blocked obligation; a record would misrepresent it.",
          `obligation ${blocked.obligationId} is blocked`,
        ),
      ],
    };
  }

  const evidenceByRecordId = new Map(evidenceRecords.map((record) => [record.recordId, record]));
  const claims = decision.resolutions.map((resolution) => claimOf(resolution, evidenceByRecordId));
  const context = input.context;
  if (context === undefined) return { ok: false, blockers: [portableBlocker("portable_context_missing", "Recording requires current policy, wiring and compatible release inputs.")] };
  for (const claim of claims) {
    if (claim.outcome !== "satisfied_evidence") continue;
    if (claim.evidence?.resolution.kind !== "evidence" || claim.evidence.resolution.portable === undefined) {
      return { ok: false, blockers: [portableBlocker("portable_evidence_missing", "Older summary-only evidence must be acquired and submitted again before recording.")] };
    }
  }
  const distinctManifestDigests = claimedManifestDigests(claims);

  let hostedChecks: DeliveryRecordHostedChecks | undefined;
  if (input.compiledPolicy !== undefined) {
    const active = activeHostedCheckExemption(input.compiledPolicy, bindingOf(decision.candidate), input.observedAt);
    if (!active.ok) return { ok: false, blockers: [active.blocker] };
    hostedChecks = { required: true, ...(active.exemption === undefined ? {} : { exemption: active.exemption }) };
  }

  const record: DeliveryRecord = {
    version: DELIVERY_RECORD_VERSION,
    gateId: config.gateId,
    identityToken: config.computingIdentityVersion,
    candidateBinding: bindingOf(decision.candidate),
    claims,
    manifestDigest: distinctManifestDigests.length === 1 ? (distinctManifestDigests[0] as string) : null,
    workspaceId: decision.candidate.workspaceId,
    attestation: { level: V1_ATTESTATION_LEVEL },
    context,
    ...(hostedChecks === undefined ? {} : { hostedChecks }),
    // Taken only when it is well formed. A malformed span is dropped rather
    // than refused: the span is a cycle-time reading no decision rests on, and
    // an unreadable journal must not stop a delivery from recording.
    ...(isDeliveryRecordRunSpan(input.runSpan) ? { runSpan: input.runSpan } : {}),
  };
  const sealed = { ...record, integrityDigest: digestCanonical(record) };
  if (Buffer.byteLength(JSON.stringify(sealed)) > MAX_PORTABLE_RECORD_BYTES) return { ok: false, blockers: [portableBlocker("portable_record_oversized", "The portable record exceeds its size limit.")] };
  return { ok: true, record: sealed };
}

/**
 * The canonical bytes of a record: RFC 8785 JCS plus a trailing newline. Two
 * `record` runs over one candidate produce byte-identical files, which is what
 * makes a re-record a no-op rather than a spurious diff.
 */
export function deliveryRecordBytes(record: DeliveryRecord): string {
  return `${canonicalize(record)}\n`;
}

/**
 * The candidate-keyed path for a record: `config.deliveryRecordPath` with the
 * deliverable digest spliced in before its extension. Keying on the digest is
 * what makes the name both merge-conflict-free across parallel branches (a
 * different deliverable is a different file) and exactly recomputable by the
 * Action from the PR head (the digest is a pure function of the tree under the
 * config's identity token).
 *
 * The derivation itself lives in `config.ts` and is re-exported here. It has to:
 * the *derived* path is the one that gets written, so it is the one that must be
 * neutral to both predicates, and the config loader — which cannot import this
 * d2 module — validates exactly that. Splice-preservation is therefore an
 * enforced load-time invariant rather than a property of the string operation.
 */
export { deliveryRecordPathFor } from "./config.ts";

// ── Parse + select ───────────────────────────────────────────────────────────

export type ParseDeliveryRecordResult =
  | { readonly ok: true; readonly record: DeliveryRecord }
  | { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> };

/**
 * Parses a tracked record's bytes into a well-formed `DeliveryRecord`, or a
 * typed finding. A malformed record is a finding, never a skip: a verifier that
 * silently ignored a record it could not read would pass a PR whose evidence it
 * never actually inspected.
 */
const BINDING_FIELDS: readonly (keyof RecordCandidateBinding)[] = [
  "treeSha",
  "deliverableDigest",
  "identityToken",
  "baseRef",
  "baseTipSha",
  "mergeBaseSha",
  "workspaceId",
];

function malformed(detail: string): { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> } {
  return { ok: false, blockers: [drBlocker("delivery_record_malformed", "The delivery record could not be read.", detail)] };
}

function isAttributedWaiver(value: unknown): value is NonNullable<DeliveryRecordClaim["waiver"]> {
  if (!isRecord(value) || value["kind"] !== "waiver" || !["invocation", "durable"].includes(String(value["scope"]))) return false;
  for (const [field, limit] of [["author", 256], ["reason", 4096]] as const) {
    const text = value[field];
    if (typeof text !== "string" || !text.trim() || text.length > limit) return false;
  }
  const codes = value["findingCodes"];
  const candidate = value["candidateBinding"];
  return typeof value["policyDigest"] === "string" && /^[a-f0-9]{64}$/.test(value["policyDigest"]) &&
    Array.isArray(codes) && codes.length > 0 && new Set(codes).size === codes.length &&
    codes.every((code) => typeof code === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(code)) &&
    isRecord(candidate) && BINDING_FIELDS.every((field) => isNonEmptyString(candidate[field]));
}

function isRecordedHostedCheckExemption(value: unknown): value is RecordedHostedCheckExemption {
  if (!isRecord(value)) return false;
  const { policyDigest, ...exemption } = value;
  return Object.keys(value).sort().join("\u0000") === ["grantedBy", "policyDigest", "reason", "scope", "until"].join("\u0000") &&
    typeof policyDigest === "string" && /^[a-f0-9]{64}$/.test(policyDigest) && isHostedCheckExemption(exemption);
}

function isDeliveryRecordHostedChecks(value: unknown): value is DeliveryRecordHostedChecks {
  if (!isRecord(value) || value["required"] !== true) return false;
  const keys = Object.keys(value).sort().join("\u0000");
  return (keys === "required" || keys === "exemption\u0000required") &&
    (value["exemption"] === undefined || isRecordedHostedCheckExemption(value["exemption"]));
}

export function parseDeliveryRecord(text: string): ParseDeliveryRecordResult {
  if (Buffer.byteLength(text) > MAX_PORTABLE_RECORD_BYTES) return malformed("the record exceeds the portable size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return malformed(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return malformed("the record is not a JSON object");
  if (parsed["version"] !== DELIVERY_RECORD_VERSION && parsed["version"] !== "delivery-record/1") {
    return malformed(`unsupported version token ${JSON.stringify(parsed["version"])}; expected ${DELIVERY_RECORD_VERSION}`);
  }
  if (!isNonEmptyString(parsed["gateId"])) return malformed("missing gateId");
  if (!isNonEmptyString(parsed["identityToken"])) return malformed("missing identityToken");
  if (!isNonEmptyString(parsed["workspaceId"])) return malformed("missing workspaceId");

  const binding = parsed["candidateBinding"];
  if (!isRecord(binding)) return malformed("missing candidateBinding");
  for (const field of BINDING_FIELDS) {
    if (!isNonEmptyString(binding[field])) return malformed(`candidateBinding is missing ${field}`);
  }
  if (parsed["identityToken"] !== binding["identityToken"]) {
    return malformed("identityToken disagrees with candidateBinding.identityToken");
  }

  const claims = parsed["claims"];
  if (!Array.isArray(claims)) return malformed("claims must be an array");
  const obligationIds = new Set<string>();
  for (const claim of claims) {
    if (!isRecord(claim) || !isNonEmptyString(claim["obligationId"]) || !isNonEmptyString(claim["outcome"])) {
      return malformed("a claim is missing its obligation id or outcome");
    }
    if (obligationIds.has(claim["obligationId"])) return malformed("claims repeat an obligation id");
    obligationIds.add(claim["obligationId"]);
    // An outcome is the vocabulary the verifier reasons about, not free-form
    // text. A committed record is editable, so a value outside the resolution
    // universe — `rubber_stamped`, or anything else invented — has to be a
    // malformed record. Accepting "some non-empty string" would let a tampered
    // record verify clean on an outcome that means nothing to the evaluator.
    if (!(RESOLUTION_OUTCOMES as readonly string[]).includes(claim["outcome"] as string)) {
      return malformed(
        `claim for ${JSON.stringify(claim["obligationId"])} carries outcome ${JSON.stringify(claim["outcome"])}, which is not a resolution outcome`,
      );
    }
    if (claim["outcome"] === "waived" && (!isAttributedWaiver(claim["waiver"]) || claim["scope"] !== claim["waiver"].scope)) {
      return malformed("a waived claim requires attributed, scoped approval bound to its policy and candidate");
    }
  }

  const attestation = parsed["attestation"];
  if (!isRecord(attestation) || !isNonEmptyString(attestation["level"])) return malformed("missing attestation.level");

  const manifestDigest = parsed["manifestDigest"];
  if (manifestDigest !== null && typeof manifestDigest !== "string") return malformed("manifestDigest must be a string or null");

  if (parsed["hostedChecks"] !== undefined && !isDeliveryRecordHostedChecks(parsed["hostedChecks"])) {
    return malformed("hostedChecks must keep checks required and carry only a complete attributed exemption");
  }

  // A committed record is editable, so the span is checked on its own face here
  // — both instants, well formed, in order — exactly as a claim's outcome is.
  // Whether those instants agree with a journal is a different question, asked
  // by the boundary that can see one; this only refuses a span that could not
  // have been read off any journal at all.
  if (parsed["runSpan"] !== undefined && !isDeliveryRecordRunSpan(parsed["runSpan"])) {
    return malformed("runSpan must carry exactly a startedAt and an endedAt UTC instant, in order");
  }

  return { ok: true, record: parsed as unknown as DeliveryRecord };
}

export interface DeliveryRecordFile {
  readonly path: string;
  readonly record: DeliveryRecord;
}

export interface RecomputedIdentity {
  readonly deliverableDigest: string;
  readonly identityToken: string;
}

/**
 * Selects the record bound to a recomputed identity from a set of discovered
 * records. A record bound to any other candidate — a foreign record — can never
 * win; two records with only one matching head resolves to that one.
 */
export function selectDeliveryRecordForIdentity(
  records: readonly DeliveryRecordFile[],
  identity: RecomputedIdentity,
): DeliveryRecordFile | undefined {
  const matches = records
    .filter(
      (entry) =>
        entry.record.candidateBinding.deliverableDigest === identity.deliverableDigest &&
        entry.record.candidateBinding.identityToken === identity.identityToken,
    )
    // Deterministic when more than one file keys to the same identity.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return matches[0];
}

// ── Verify (pure core) ───────────────────────────────────────────────────────

/** The base state the record's base coordinates are compared against. */
export interface VerificationBase {
  readonly ref: string;
  readonly tipSha: string;
  readonly mergeBaseSha: string;
}

export interface DeliveryRecordCheck {
  readonly ok: boolean;
  readonly blockers: readonly Blocker[];
  readonly baseMovement: BaseMovementPolicy;
  /** True when base drift occurred but the `allow` policy let it pass. */
  readonly baseMovementRelaxed: boolean;
  /** Base drift classes the `allow` policy relaxed — named in the summary. */
  readonly relaxedDriftClasses: readonly DeliveryRecordDriftClass[];
  readonly attestationLabel: string;
  readonly claims: readonly DeliveryRecordClaim[];
  readonly hostedChecks: {
    readonly status: "required" | "exempted";
    readonly exemption?: RecordedHostedCheckExemption;
  };
  /**
   * Raw trees whose review rounds the verified record actually carries. The
   * record tree is always present. An earlier tree appears only after the
   * retained review-neutral projection has passed portable verification.
   */
  readonly reviewedCandidateTreeShas: readonly string[];
  /**
   * The caller's self-attested run-journal row, echoed verbatim and absent when
   * the caller supplied none — which is every caller but the local `verify`.
   *
   * ECHOED, NEVER JUDGED. Nothing in this core reads the row: it does not raise
   * a blocker, it does not touch `ok`, and no member of it appears in any
   * decision above. A run journal is observability, and the moment a verifier
   * consulted one, a store that anyone who can execute in the repository may
   * append to would be deciding admission. The Action never supplies it, so the
   * check it computes is byte-for-byte the check it computed before.
   */
  readonly runJournal?: RunJournalRow;
}

/**
 * The pure verification core shared by the CLI `verify` command and the Action.
 *
 * Reads `config.deliveryRecordVerification.baseMovement` — the ONLY reader of
 * that policy in the whole kernel, so the local gate is never more permissive
 * than CI. `recomputedIdentity` is the deliverable identity the caller recomputed
 * from the PR head (never the synthetic merge commit); `base` is the current base
 * state. `workspaceId` is never consulted.
 */
export interface VerifyDeliveryRecordOptions {
  /** Fresh equality of approved and target trees under only recordNeutral exclusions. */
  readonly waiverCandidateMatches?: boolean;
  readonly evidenceContext?: PortableEvidenceContext;
  readonly projection?: EvaluateGateInput["projection"];
  readonly executionContext?: EvaluateGateInput["context"];
  readonly resourceBindings?: Readonly<Record<string, ResourceApplicabilityBinding>>;
  readonly checkBindings?: Readonly<Record<string, CheckBinding>>;
  /** Fresh caller-observed results; never reconstructed from a recorded live claim. */
  readonly liveResults?: EvaluateGateInput["liveResults"];
  /**
   * The candidate tree's entries, when the caller can enumerate them. Supplied,
   * the verifier independently rejects any tree carrying a projection or
   * discovery-configuration path; omitted, that check simply does not run —
   * this core never reads a repository itself.
   *
   * A caller that reads the mode and, for a symlink, the committed target may
   * pass `CandidateTreeEntry` instead of a bare path; only that richer form can
   * witness the admitted Claude skill exposure. A bare path is judged on its
   * path alone and stays blocked.
   */
  readonly candidateTreePaths?: readonly (string | CandidateTreeEntry)[];
  /**
   * A self-attested run-journal completeness row the caller resolved for this
   * record's candidate. Echoed onto the check and never read — see
   * {@link DeliveryRecordCheck.runJournal}. Only a caller that can reach the
   * repository's run store has one, and only the local `verify` does; whether
   * an incomplete row should fail is that caller's decision, taken behind its
   * own opt-in, never this core's.
   */
  readonly runJournal?: RunJournalRow;
  /** Exact current owner policy and one boundary-observed instant. */
  readonly compiledPolicy?: CompiledPolicy;
  readonly observedAt?: string;
}

/**
 * One committed tree entry, as `git ls-tree -r` reports it. A caller that can
 * read the mode and — for a symlink — the target out of the committed blob
 * passes this form; a caller that can only enumerate names passes the bare path
 * string, which can never reach the Claude skill-exposure exception because it
 * witnesses neither of the two facts that exception turns on.
 */
export interface CandidateTreeEntry {
  readonly path: string;
  /** The git tree mode, e.g. `100644` for a file or `120000` for a symlink. */
  readonly mode?: string;
  /** The link target read from the committed blob, when the entry is a symlink. */
  readonly symlinkTarget?: string;
}

function pathOf(entry: string | CandidateTreeEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

/** True when the path IS one of the delivery-owned sets, or lies inside one. */
export function isDeliveryOwnedTreePath(repoPath: string): boolean {
  const folded = repoPath.toLowerCase();
  return DELIVERY_OWNED_TREE_PREFIXES.some((prefix) => folded === prefix || folded.startsWith(`${prefix}/`));
}

/**
 * Resolves `target` against the directory of `fromPath` and normalizes it, or
 * returns `undefined` when the target is absolute or walks above the repository
 * root. Pure string work over the committed tree's POSIX paths — a `..` that
 * escapes is a refusal, never a clamp to the root, because clamping is exactly
 * how an outward link would be read as an inward one.
 */
function resolveTreeSymlink(fromPath: string, target: string): string | undefined {
  if (target.length === 0 || target.startsWith("/")) return undefined;
  const lastSlash = fromPath.lastIndexOf("/");
  const segments = lastSlash === -1 ? [] : fromPath.slice(0, lastSlash).split("/");
  const resolved: string[] = [];
  for (const segment of segments) if (segment.length > 0 && segment !== ".") resolved.push(segment);
  for (const segment of target.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return undefined;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  // A target resolving to nothing names no entry. One ending in a separator
  // normalizes to the directory it names; when that directory is the skills
  // root itself, the strictly-inside test refuses it a step later.
  return resolved.length === 0 ? undefined : resolved.join("/");
}

/**
 * True when the entry is the one admitted Claude skill exposure: a symlink
 * anywhere under `.claude/skills/` whose resolved target lies strictly inside
 * `.agent-skills/current/skills/`. Both anchors are matched literally, never
 * case-folded: the exception is granted to the exact shape the `agent-skills`
 * generation install writes, and a case alias is not that shape.
 *
 * WHAT THIS DECIDES, AND WHAT IT DOES NOT. It decides the committed shape of
 * the entry: its mode, and where its own target resolves as a path. It does
 * not follow that path through any further committed symlink, does not require
 * the target to exist in the tree, and does not re-check the receipt inside the
 * generation. It cannot: `.agent-skills/current` is itself a tracked symlink
 * pinning the active, digest-named generation, so following the path would
 * reject the very install this admits.
 *
 * So what this admits is a POINTER, and the bytes it points at are reviewed the
 * way every other tracked byte is — in the diff. A committed exposure is read
 * by a host on checkout, with no install step in between, so the generation's
 * own receipt is not what stops a candidate writing skill text there: the
 * change lands under `.agent-skills/`, in the pull request, where a reviewer
 * sees it. That is the trade this exception makes, deliberately.
 */
function isAdmittedClaudeSkillExposure(entry: string | CandidateTreeEntry): boolean {
  if (typeof entry === "string") return false;
  if (entry.mode !== SYMLINK_MODE) return false;
  if (!entry.path.startsWith(CLAUDE_SKILL_EXPOSURE_PREFIX)) return false;
  if (entry.path.length === CLAUDE_SKILL_EXPOSURE_PREFIX.length) return false;
  if (entry.symlinkTarget === undefined) return false;
  const resolved = resolveTreeSymlink(entry.path, entry.symlinkTarget);
  if (resolved === undefined) return false;
  return resolved.startsWith(RECEIPTED_SKILLS_ROOT) && resolved.length > RECEIPTED_SKILLS_ROOT.length;
}

/**
 * True when the committed entry lands in a delivery-owned set AND is not the
 * one admitted Claude skill exposure. This is the whole tree-side rule.
 */
export function isDeliveryOwnedTreeEntry(entry: string | CandidateTreeEntry): boolean {
  if (!isDeliveryOwnedTreePath(pathOf(entry))) return false;
  return !isAdmittedClaudeSkillExposure(entry);
}

/** One line of a `git ls-tree -r -z --full-tree` listing, already split out. */
export interface ListedTreeEntry extends CandidateTreeEntry {
  readonly mode: string;
  readonly objectSha: string;
}

/**
 * Parses a NUL-separated `git ls-tree -r -z --full-tree <ref>` listing into its
 * entries. Pure string work, so the one reading of git's tree format is stated
 * once and every verifier shares it.
 *
 * A record git could not format as `<mode> <type> <object>\t<path>` is skipped
 * rather than guessed at, and skipping is a real cost, not a free one: a
 * skipped record is judged by nothing — neither the protected-path rule nor
 * the Action's record discovery, both of which read this list — so it would be
 * missed rather than blocked. It is accepted because `-z` output cannot
 * produce one: git never quotes under NUL separation, the mode, type and
 * object fields never contain a tab or a space, and the split takes the FIRST
 * tab, so a path containing tabs still parses whole.
 *
 * NUL separation, never newline splitting: git quotes a path containing a
 * newline, and the quoted form no longer starts with the prefix it is inside.
 */
export function parseCandidateTreeListing(nulSeparated: string): readonly ListedTreeEntry[] {
  const entries: ListedTreeEntry[] = [];
  for (const line of nulSeparated.split("\u0000")) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const fields = line.slice(0, tab).split(" ").filter((field) => field.length > 0);
    if (fields.length < 3) continue;
    const [mode, , objectSha] = fields as [string, string, string];
    entries.push({ path: line.slice(tab + 1), mode, objectSha });
  }
  return entries;
}

/**
 * True when this entry's committed link target must be read for the
 * delivery-owned rule to be decidable — a symlink inside a delivery-owned
 * prefix, the only entry the exception could ever admit. Stating it here keeps
 * every verifier reading the same, minimal set of blobs.
 */
export function needsCommittedSymlinkTarget(entry: ListedTreeEntry): boolean {
  return entry.mode === SYMLINK_MODE && isDeliveryOwnedTreePath(entry.path);
}

export function verifyDeliveryRecord(
  config: HarnessConfig,
  record: DeliveryRecord,
  recomputedIdentity: RecomputedIdentity,
  base: VerificationBase,
  options: VerifyDeliveryRecordOptions = {},
): DeliveryRecordCheck {
  const policy = config.deliveryRecordVerification.baseMovement;
  const blockers: Blocker[] = [];
  const relaxedDriftClasses: DeliveryRecordDriftClass[] = [];
  const binding = record.candidateBinding;
  let hostedChecks: DeliveryRecordCheck["hostedChecks"] = { status: "required" };

  if (record.version !== DELIVERY_RECORD_VERSION) {
    blockers.push(drBlocker("record_version_unsupported", `The record's version ${JSON.stringify(record.version)} is not ${DELIVERY_RECORD_VERSION}.`));
  }
  if (record.gateId !== config.gateId) {
    blockers.push(
      drBlocker("record_gate_mismatch", `The record is for gate ${JSON.stringify(record.gateId)}, not ${JSON.stringify(config.gateId)}.`),
    );
  }
  if (record.attestation.level !== V1_ATTESTATION_LEVEL) {
    blockers.push(
      drBlocker(
        "record_attestation_unsupported",
        `The record declares attestation level ${JSON.stringify(record.attestation.level)}; v1 verifies only ${JSON.stringify(V1_ATTESTATION_LEVEL)}.`,
      ),
    );
  }
  if (!config.identityVersions.includes(binding.identityToken)) {
    blockers.push(
      drBlocker("record_identity_token_unknown", `The record's identity token ${JSON.stringify(binding.identityToken)} is not accepted by this config.`),
    );
  }

  // A hosted-check exemption is a projection of owner policy, not a CLI grant.
  // The current compiled policy and current time are supplied by the caller;
  // this pure core never reads either from ambient process state. A missing
  // legacy policy is strict, and can verify only a record with no exemption.
  const recordedExemption = isDeliveryRecordHostedChecks(record.hostedChecks)
    ? record.hostedChecks.exemption
    : undefined;
  if (record.hostedChecks !== undefined && !isDeliveryRecordHostedChecks(record.hostedChecks)) {
    blockers.push(drBlocker("hosted_check_record_invalid", "The recorded hosted-check posture is malformed or disables required checks."));
  } else if (options.compiledPolicy === undefined) {
    if (recordedExemption !== undefined) {
      blockers.push(drBlocker("hosted_check_exemption_unrecognized", "The record claims a hosted-check exemption without current compiled owner policy."));
    }
  } else {
    const active = activeHostedCheckExemption(options.compiledPolicy, binding, options.observedAt);
    if (!active.ok) {
      blockers.push(active.blocker);
    } else if (active.exemption === undefined) {
      if (recordedExemption !== undefined) {
        const declared = effectiveHostedChecksPolicy(options.compiledPolicy).exemptions.find((entry) =>
          entry.scope.repositoryId === options.compiledPolicy!.snapshot.repositoryId && entry.scope.baseRef === binding.baseRef);
        const exactPolicyDeclaration = declared !== undefined && recordedExemption.policyDigest === options.compiledPolicy.compiledDigest &&
          digestCanonical(declared) === digestCanonical((({ policyDigest: _policyDigest, ...rest }) => rest)(recordedExemption));
        blockers.push(drBlocker(
          exactPolicyDeclaration && isHostedCheckInstant(options.observedAt) && options.observedAt >= recordedExemption.until
            ? "hosted_check_exemption_expired"
            : "hosted_check_exemption_unrecognized",
          exactPolicyDeclaration
            ? "The recorded hosted-check exemption has expired."
            : "The recorded hosted-check exemption is not an exact current owner declaration for this repository and base ref.",
        ));
      }
    } else if (recordedExemption === undefined) {
      blockers.push(drBlocker("hosted_check_exemption_missing", "The record omits the active hosted-check exemption declared for this repository and base ref."));
    } else if (digestCanonical(recordedExemption) !== digestCanonical(active.exemption)) {
      blockers.push(drBlocker("hosted_check_exemption_unrecognized", "The recorded hosted-check exemption is not an exact current owner declaration for this repository and base ref."));
    } else {
      hostedChecks = { status: "exempted", exemption: recordedExemption };
    }
  }

  // Deliverable identity: the record must describe the tree at the PR head. This
  // is the mismatch a foreign record fails on, and it is never relaxed.
  if (binding.deliverableDigest !== recomputedIdentity.deliverableDigest || binding.identityToken !== recomputedIdentity.identityToken) {
    blockers.push(
      drBlocker(
        "deliverable_identity_changed",
        "The record's deliverable identity does not match the recomputed identity of the head.",
        `record ${binding.deliverableDigest} (${binding.identityToken}) but head ${recomputedIdentity.deliverableDigest} (${recomputedIdentity.identityToken})`,
      ),
    );
  }

  // Base movement: staled by default, relaxed and named under the `allow` policy.
  const baseDrift: DeliveryRecordDriftClass[] = [];
  if (binding.baseRef !== base.ref) baseDrift.push("base_ref_changed");
  if (binding.baseTipSha !== base.tipSha) baseDrift.push("base_tip_moved");
  if (binding.mergeBaseSha !== base.mergeBaseSha) baseDrift.push("merge_base_moved");
  for (const driftClass of baseDrift) {
    if (policy === "allow") {
      relaxedDriftClasses.push(driftClass);
    } else {
      blockers.push(drBlocker(
        driftClass,
        `The base moved (${driftClass}); the record is stale under the "stale" base-movement policy.`,
        `recorded base ${binding.baseRef} at ${binding.baseTipSha} (merge base ${binding.mergeBaseSha}); ` +
          `observed base ${base.ref} at ${base.tipSha} (merge base ${base.mergeBaseSha})`,
        {
          id: "reconcile-base-movement",
          kind: "manual_action",
          summary: "Confirm whether the observed base includes this delivery's own confirmed merge. " +
            "If so, retain the pre-merge verification and merge evidence; no new delivery loop is required. " +
            "Otherwise, refresh the candidate, preparation, review evidence, gate, and record within the same run while it remains open. " +
            "If that run already ended, link the retry with predecessorRunId. This stale-record result does not authorize a merge.",
        },
      ));
    }
  }

  // A claim can only carry an admitting outcome; a blocked one is a malformed
  // record, not a pass.
  for (const claim of record.claims) {
    if (claim.outcome === "blocked") {
      blockers.push(drBlocker("record_claim_blocked", `Claim for ${claim.obligationId} carries a blocked outcome; a record must not.`));
    }
    if (claim.outcome === "waived") {
      const waiver = claim.waiver;
      const obligation = config.obligations.find((entry) => entry.id === claim.obligationId);
      if (options.waiverCandidateMatches !== true || !isAttributedWaiver(waiver) || claim.scope !== waiver.scope ||
          !obligation?.humanWaiverAllowed || !obligation.allowedResolutionKinds.includes("waived") ||
          (obligation.freshness === "live" && waiver.scope !== "invocation") ||
          waiver.policyDigest !== digestCanonical(config) ||
          BINDING_FIELDS.some((field) => waiver.candidateBinding[field] !== binding[field]) ||
          waiver.findingCodes.some((code) => NON_WAIVABLE_INTEGRITY_CODES.includes(code) ||
            obligation.nonWaivableCodes.includes(code) || !obligation.waivableCodes.includes(code))) {
        blockers.push(drBlocker("record_waiver_invalid", `The human exception for ${claim.obligationId} does not match its attribution, scope, policy, or candidate.`));
      }
    }
  }

  blockers.push(...verifyRecordEvidence(config, record, options));

  // The delivery-owned path sets, judged on the tree's own evidence. This is
  // the verifier's independent half of the protected-authority-path rule: no
  // product state, no journal, no grant — just the committed paths.
  for (const entry of options.candidateTreePaths ?? []) {
    if (!isDeliveryOwnedTreeEntry(entry)) continue;
    blockers.push(
      drBlocker(
        "record_protected_authority_path",
        `The candidate tree carries ${JSON.stringify(pathOf(entry))}, inside a delivery-owned projection or discovery-configuration path.`,
        `delivery-owned prefixes: ${DELIVERY_OWNED_TREE_PREFIXES.join(", ")}; the only admitted exception is a ${SYMLINK_MODE} symlink under ${CLAUDE_SKILL_EXPOSURE_PREFIX} resolving inside ${RECEIPTED_SKILLS_ROOT}`,
      ),
    );
  }

  // Coverage: every declared obligation must be accounted for by a claim.
  const claimed = new Set(record.claims.map((claim) => claim.obligationId));
  for (const obligation of config.obligations) {
    if (!claimed.has(obligation.id)) {
      blockers.push(
        drBlocker("obligation_uncovered", `Obligation ${JSON.stringify(obligation.id)} has no claim in the record.`),
      );
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    baseMovement: policy,
    baseMovementRelaxed: relaxedDriftClasses.length > 0,
    relaxedDriftClasses,
    attestationLabel: ATTESTATION_LABEL,
    claims: record.claims,
    hostedChecks,
    reviewedCandidateTreeShas: blockers.length === 0 ? projectedReviewTreeShas(record) : [binding.treeSha],
    ...(options.runJournal === undefined ? {} : { runJournal: options.runJournal }),
  };
}

/**
 * Read projection coordinates only after the verifier has accepted all of the
 * retained portable bytes. This function is deliberately private: an
 * unverified record cannot ask the journal reader to bless another tree.
 */
function projectedReviewTreeShas(record: DeliveryRecord): readonly string[] {
  const trees = new Set<string>([record.candidateBinding.treeSha]);
  const evidence = record.claims.flatMap((claim) => [
    ...(claim.evidence === undefined ? [] : [claim.evidence]),
    ...(claim.supportingEvidence ?? []),
  ]);
  for (const entry of evidence) {
    if (entry.resolution.kind !== "evidence" || entry.resolution.portable === undefined) continue;
    const portable = entry.resolution.portable;
    const manifest = portable.manifest;
    if (portable.context.reviewerCharters.length === 0 || !isRecord(manifest) || !Array.isArray(manifest["artifacts"]) ||
        !Array.isArray(manifest["claims"]) || !manifest["claims"].some((claim) => isRecord(claim) &&
          claim["obligation"] === entry.obligationId &&
          (claim["payloadSpec"] === "review.green/1" || claim["payloadSpec"] === "review.green/2"))) continue;
    // A verified review can precede record-neutral telemetry staging even when
    // its initial acquisition needed no explicit review-context projection.
    trees.add(entry.candidateBinding.treeSha);
    const contents = portableArtifactContents(portable.artifacts).artifacts;
    for (const declared of manifest["artifacts"]) {
      if (!isRecord(declared) || declared["role"] !== "review-context-projection" || typeof declared["path"] !== "string") continue;
      try {
        const projection: unknown = JSON.parse(contents.get(declared["path"]) ?? "null");
        if (!isRecord(projection) || projection["spec"] !== "review-context-projection/1" || !isRecord(projection["reviewedCandidate"]) ||
            !isRecord(projection["preparedCandidate"]) || projection["reviewRoundAdded"] !== false ||
            projection["preparedCandidate"]["treeSha"] !== entry.candidateBinding.treeSha) continue;
        const reviewedTreeSha = projection["reviewedCandidate"]["treeSha"];
        if (typeof reviewedTreeSha === "string" && /^[a-f0-9]{40}$/.test(reviewedTreeSha)) trees.add(reviewedTreeSha);
      } catch {
        // Portable verification would already have rejected malformed bytes;
        // a defensive parse failure contributes no observational coordinate.
      }
    }
  }
  return [...trees];
}

/** Reconstruct admission from retained evidence using the existing evaluator. */
function verifyRecordEvidence(config: HarnessConfig, record: DeliveryRecord, options: VerifyDeliveryRecordOptions): readonly Blocker[] {
  const blockers: Blocker[] = [];
  const { integrityDigest, ...unsigned } = record;
  if (integrityDigest !== digestCanonical(unsigned)) blockers.push(portableBlocker("portable_record_integrity", "The serialized record changed after it was built."));
  if (record.context === undefined || options.evidenceContext === undefined ||
      digestCanonical(record.context) !== digestCanonical(options.evidenceContext)) {
    return [...blockers, portableBlocker("portable_context_mismatch", "Current policy, wiring, release and reviewer inputs must match the portable record.")];
  }
  if (options.projection === undefined || options.executionContext === undefined) {
    return [...blockers, portableBlocker("portable_activation_missing", "Verification requires activation recomputed from the target candidate.")];
  }
  const distinctDigests = claimedManifestDigests(record.claims);
  if (record.manifestDigest !== (distinctDigests.length === 1 ? distinctDigests[0] : null)) blockers.push(portableBlocker("portable_manifest_summary", "The record manifest summary differs from its actual claims."));
  const records: EvidenceRecord[] = [];
  const ids = new Set<string>();
  const b = record.candidateBinding;
  if (record.workspaceId !== b.workspaceId || record.identityToken !== b.identityToken) blockers.push(portableBlocker("portable_record_binding", "The record's audit binding is internally inconsistent."));
  for (const claim of record.claims) {
    if (ids.has(claim.obligationId)) blockers.push(portableBlocker("portable_claim_duplicate", "An obligation is claimed more than once."));
    ids.add(claim.obligationId);
    if (claim.outcome === "satisfied_live_fact") {
      const obligation = config.obligations.find(entry => entry.id === claim.obligationId);
      if (obligation?.freshness !== "live" || claim.providerId === undefined || !obligation.providers.includes(claim.providerId) || !isNonEmptyString(claim.runId)) blockers.push(portableBlocker("portable_live_claim_invalid", "The historical live claim names no configured live provider and run."));
    }
  }
  const expandedClaims: DeliveryRecordClaim[] = record.claims.flatMap(claim => [claim, ...(Array.isArray(claim.supportingEvidence) ? claim.supportingEvidence.map((evidence: EvidenceRecord) => ({
    ...claim, evidence, recordId: evidence?.recordId,
    ...(evidence?.resolution?.kind === "evidence" ? { providerId: evidence.resolution.providerId, runId: evidence.resolution.runId,
      finalPassId: evidence.resolution.finalPassId, manifestDigest: evidence.resolution.manifestDigest } : {}),
  })) : [])]);
  for (const claim of expandedClaims) {
    if (claim.outcome === "satisfied_evidence") {
      const evidence = claim.evidence;
      if (!isRecord(evidence) || !isRecord(evidence.resolution) || evidence.resolution.kind !== "evidence" ||
          evidence.resolution.portable === undefined || !isRecord(evidence.candidateBinding)) {
        blockers.push(portableBlocker("portable_evidence_missing", "The claim carries no original accepted manifest and artifact bytes.")); continue;
      }
      const resolution = evidence.resolution;
      const eb = evidence.candidateBinding;
      const scoped = resolution.resourceBinding === undefined && config.providers.some(p => p.id === resolution.providerId && p.check?.scope !== undefined) &&
        resolution.checkBinding?.scopedInputDigest !== undefined && options.checkBindings?.[resolution.providerId]?.scopedInputDigest !== undefined &&
        digestCanonical(resolution.checkBinding) === digestCanonical(options.checkBindings[resolution.providerId]);
      if (evidence.schemaVersion !== 1 || evidence.recordId !== computeRecordId(evidence.workspaceId, evidence) || evidence.workspaceId !== eb.workspaceId ||
          evidence.gateId !== config.gateId || evidence.obligationId !== claim.obligationId ||
          evidence.recordId !== claim.recordId || resolution.providerId !== claim.providerId || resolution.runId !== claim.runId ||
          resolution.finalPassId !== claim.finalPassId || resolution.manifestDigest !== claim.manifestDigest ||
          BINDING_FIELDS.filter(field => scoped ? field === "workspaceId" || field === "identityToken" : field !== "treeSha").some(field => eb[field] !== b[field])) {
        blockers.push(portableBlocker("portable_claim_binding", "The claim differs from its original accepted evidence binding.")); continue;
      }
      blockers.push(...verifyPortableEvidence(config, resolution.portable!, eb, options.evidenceContext, options.checkBindings, options.resourceBindings));
      const manifest = resolution.portable!.manifest;
      if (!isRecord(manifest) || !isRecord(manifest["provider"]) || !Array.isArray(manifest["claims"]) ||
          resolution.manifestDigest !== computeManifestDigest(manifest) || manifest["provider"]["id"] !== resolution.providerId ||
          manifest["provider"]["runId"] !== resolution.runId || manifest["provider"]["finalPassId"] !== resolution.finalPassId ||
          !manifest["claims"].some(value => isRecord(value) && value["obligation"] === claim.obligationId &&
            (resolution.resourceBinding === undefined ? value["payloadSpec"] !== "installed-data.applicable/1" :
              value["payloadSpec"] === "installed-data.applicable/1" && isRecord(value["payload"]) &&
              digestCanonical(value["payload"]["binding"]) === digestCanonical(resolution.resourceBinding)))) {
        blockers.push(portableBlocker("portable_manifest_binding", "The accepted manifest does not substantiate this claim.")); continue;
      }
      records.push(evidence);
    } else if (claim.outcome === "waived" && isAttributedWaiver(claim.waiver) && claim.recordId !== undefined) {
      const { candidateBinding, ...waiver } = claim.waiver;
      records.push({ schemaVersion: 1, recordId: claim.recordId, workspaceId: b.workspaceId, gateId: config.gateId,
        obligationId: claim.obligationId, candidateBinding, resolution: waiver });
    }
  }
  if (blockers.length > 0) return blockers;
  const decision = evaluateGate({ config, candidate: { treeSha: b.treeSha,
    deliverable: { digest: b.deliverableDigest, identity: b.identityToken },
    base: { ref: b.baseRef, tipSha: b.baseTipSha, mergeBaseSha: b.mergeBaseSha }, workspaceId: b.workspaceId },
    projection: options.projection, context: options.executionContext, records,
    ...(options.checkBindings === undefined ? {} : { checkBindings: options.checkBindings }),
    ...(options.resourceBindings === undefined ? {} : { resourceBindings: options.resourceBindings }),
    ...(options.liveResults === undefined ? {} : { liveResults: options.liveResults }),
  });
  for (const actual of decision.resolutions) {
    const claim = record.claims.find(entry => entry.obligationId === actual.obligationId);
    // A portable exception is validated as the original human decision, never
    // as CI or an agent gaining a human execution context. The existing gate
    // supplies the complete current finding set it would otherwise block on.
    if (claim?.outcome === "waived" && actual.kind === "blocked" && isAttributedWaiver(claim.waiver) &&
        claim.waiver.scope === "durable" && actual.blockers.length > 0 &&
        actual.blockers.every(blocker => claim.waiver!.findingCodes.includes(blocker.code))) continue;
    if (claim?.outcome !== actual.kind || (actual.kind === "satisfied_evidence" && claim.recordId !== actual.recordId)) {
      blockers.push(portableBlocker("portable_claim_outcome", "The actual evidence and current activation do not produce the claimed gate outcome."));
      if (actual.kind === "blocked") blockers.push(...actual.blockers);
    }
  }
  return blockers;
}
