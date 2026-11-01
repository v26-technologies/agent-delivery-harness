import { validateInstalledDataApplicable } from "./installed-data-applicable.ts";
import type { ResourceApplicabilityBinding } from "../records.types.ts";
import { validateChecksPassed } from "./checks-passed.ts";
/**
 * The normative `delivery-evidence/1` envelope validator (spec §8).
 *
 * WHAT THIS IS. A total function from a submitted value, a repository
 * configuration, and the candidate observation the caller made, to one verdict
 * carrying every violated rule. It is the normative implementation: the
 * published JSON Schemas beside this file describe shape, and shape is
 * necessary but not sufficient — closed grammar, cross-field re-derivation, and
 * the code registry are what conformance is defined by.
 *
 * WHERE IT STOPS. Four rejection codes belong to the recorder's surface rather
 * than to this module: the run root it allocates (SUB-3), the record store it
 * publishes into (SUB-4), and the artifact bytes it reads and hashes through its
 * fs port (ENV-10's realpath clause, ENV-11). RG-4 is handed approval-stamp
 * contents as values because it reads their *meaning*; whether those bytes are
 * the bytes at the declared path is a filesystem question, and answering it from
 * a caller-assembled map would report a check that never ran. What this module
 * does judge from caller-supplied observation is SUB-1 and SUB-2, because a
 * candidate capture and a preparation state are values, not file handles.
 *
 * REPORTING. Every rule runs. Nothing short-circuits on a first failure, which
 * is what SUB-5 requires and what makes the conformance kit's multi-code
 * vectors meaningful. Guards exist only where a later rule would otherwise read
 * a value whose shape it already knows is wrong.
 *
 * TIME. No rule reads `recordedAt`. It is informational (§5.8), GEN-5 forbids
 * any admissibility decision from depending on it, and the import-boundary
 * sensor enforces that mechanically over this directory. The member is still
 * part of the closed grammar — its absence is a rejection and its presence
 * changes the manifest digest — which is exactly the distinction GEN-5 draws.
 */
import type { HarnessConfig, ObligationPolicy } from "../config.ts";
import {
  CONFORMING_ATTESTATION_LEVEL,
  REVIEW_GREEN_1,
  REVIEW_GREEN_2,
  SUPPORTED_ENVELOPE_SPECS,
  SUPPORTED_PAYLOAD_SPECS,
  type ManifestRejection,
  type ManifestValidation,
} from "./codes.ts";
import {
  ARTIFACT_ROLE,
  GEN_1_UNKNOWN,
  GEN_4_MISSING,
  GIT_OBJECT_ID,
  OBLIGATION_ID,
  PROVIDER_ID,
  RUN_ID,
  SHA256_HEX,
  canonicallyEqual,
  checkMembers,
  createCollector,
  isNonEmptyString,
  isRecord,
  member,
  pointer,
  type Collector,
} from "./grammar.ts";
import { validateReviewGreenClaim, validateReviewGreenClaimV2 } from "./review-green.ts";

// ── The validated shapes ───────────────────────────────────────────────────

export interface ManifestDeliverable {
  readonly digest: string;
  readonly identity: string;
}

export interface ManifestBase {
  readonly ref: string;
  readonly tipSha: string;
  readonly mergeBaseSha: string;
}

export interface ManifestCandidate {
  readonly vcs: "git";
  readonly treeSha: string;
  readonly headSha?: string;
  readonly deliverable: ManifestDeliverable;
  readonly base: ManifestBase;
  readonly workspaceId: string;
}

export interface ManifestProvider {
  readonly id: string;
  readonly version?: string;
  readonly runId: string;
  readonly finalPassId: string;
}

export interface RunHistoryEntry {
  readonly preparedTreeSha: string;
  readonly evaluatedInPassId: string;
}

export interface ManifestArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly role: string;
}

/**
 * An artifact entry that survived the shape rules, carrying the index it was
 * declared at so a payload rule can point back at the entry rather than at the
 * pool.
 */
export interface DeclaredArtifact extends ManifestArtifact {
  readonly index: number;
}

export interface ManifestAttestation {
  readonly level: string;
  readonly signatures: readonly unknown[];
}

export interface ManifestClaim {
  readonly obligation: string;
  readonly payloadSpec: string;
  readonly payload: Record<string, unknown>;
}

/** A manifest that passed §8 and §9.3 in full. */
export interface DeliveryEvidenceManifest {
  readonly spec: string;
  readonly provider: ManifestProvider;
  readonly candidate: ManifestCandidate;
  readonly repository?: string | null;
  readonly runHistory: readonly RunHistoryEntry[];
  readonly artifacts: readonly ManifestArtifact[];
  readonly attestation: ManifestAttestation;
  readonly recordedAt: string;
  readonly claims: readonly ManifestClaim[];
}

// ── The caller's observations ──────────────────────────────────────────────

export interface ManifestValidationContext {
  readonly resourceBindings?: Readonly<Record<string, ResourceApplicabilityBinding>>;
  readonly checkBindings?: Readonly<Record<string, import("../records.types.ts").CheckBinding>>;
  /** Repository gate configuration: accepted specs, identity versions, obligations, providers. */
  readonly config: HarnessConfig;
  /**
   * What candidate capture reports at submission time (SUB-1). A value, not a
   * repository: whoever captured it owns the git work, and this module compares.
   */
  readonly currentCandidate: unknown;
  /** Whether the workspace is in a prepared state at submission time (SUB-2). */
  readonly prepared: boolean;
  /**
   * Artifact file contents, keyed by the path the manifest declares. RG-4 reads
   * approval stamps from here. An entry absent from this map is an artifact the
   * caller could not produce bytes for, which no rule may treat as satisfied.
   */
  readonly artifactContents: ReadonlyMap<string, string>;
}

// ── Grammar tables ─────────────────────────────────────────────────────────

const ENVELOPE_MEMBERS = {
  required: ["spec", "provider", "candidate", "runHistory", "artifacts", "attestation", "recordedAt", "claims"],
  optional: ["repository"],
} as const;

const PROVIDER_MEMBERS = { required: ["id", "runId", "finalPassId"], optional: ["version"] } as const;

const CANDIDATE_MEMBERS = {
  required: ["vcs", "treeSha", "deliverable", "base", "workspaceId"],
  optional: ["headSha"],
} as const;

const DELIVERABLE_MEMBERS = { required: ["digest", "identity"] } as const;

const BASE_MEMBERS = { required: ["ref", "tipSha", "mergeBaseSha"] } as const;

const RUN_HISTORY_MEMBERS = { required: ["preparedTreeSha", "evaluatedInPassId"] } as const;

const ARTIFACT_MEMBERS = { required: ["path", "sha256", "role"] } as const;

const ATTESTATION_MEMBERS = { required: ["level", "signatures"] } as const;

const CLAIM_MEMBERS = { required: ["obligation", "payloadSpec", "payload"] } as const;

// ── Entry point ────────────────────────────────────────────────────────────

export function validateManifest(
  submitted: unknown,
  context: ManifestValidationContext,
): ManifestValidation<DeliveryEvidenceManifest> {
  const collector = createCollector();

  if (!isRecord(submitted)) {
    collector.emit("malformed_field", "GEN-4", "", "manifest is not a JSON object");
    return finish(collector, submitted);
  }

  checkMembers(submitted, "", ENVELOPE_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

  checkSpec(submitted, context.config, collector);
  const providerIdentity = checkProvider(submitted, collector);
  checkCandidate(submitted, context, collector);
  checkAttestationAndRepository(submitted, collector);
  const runHistoryLength = checkRunHistory(submitted, collector);
  const artifacts = checkArtifacts(submitted, collector);
  checkTimestamp(submitted, collector);
  checkClaims(submitted, {
    context,
    collector,
    providerIdentity,
    artifacts,
    runHistoryLength,
  });
  checkPreparation(context, collector);

  return finish(collector, submitted);
}

function finish(collector: Collector, submitted: unknown): ManifestValidation<DeliveryEvidenceManifest> {
  const rejections = collector.list();
  const [first, ...rest] = rejections;
  if (first === undefined) {
    return { ok: true, manifest: submitted as DeliveryEvidenceManifest };
  }
  const all: readonly [ManifestRejection, ...ManifestRejection[]] = [first, ...rest];
  return { ok: false, rejections: all };
}

// ── GEN-2 ──────────────────────────────────────────────────────────────────

function checkSpec(root: Record<string, unknown>, config: HarnessConfig, collector: Collector): void {
  const spec = member(root, "spec");
  if (spec === undefined) return;
  // Fail closed in both directions: a spec this validator does not implement is
  // a rejection even if a config accepts it, and a spec it implements is a
  // rejection if the repository has not accepted it.
  if (!isNonEmptyString(spec) || !SUPPORTED_ENVELOPE_SPECS.includes(spec) || !config.acceptedEnvelopeSpecs.includes(spec)) {
    collector.emit("unsupported_envelope_spec", "GEN-2", "/spec", "envelope spec is not one this repository accepts and this validator implements");
  }
}

// ── ENV-1, ENV-2, ENV-3 ────────────────────────────────────────────────────

interface ProviderIdentity {
  readonly id: unknown;
  readonly runId: unknown;
  readonly finalPassId: unknown;
}

function checkProvider(root: Record<string, unknown>, collector: Collector): ProviderIdentity {
  const provider = member(root, "provider");
  if (!isRecord(provider)) {
    if (provider !== undefined) collector.emit("malformed_field", "GEN-4", "/provider", "provider is not an object");
    return { id: undefined, runId: undefined, finalPassId: undefined };
  }

  checkMembers(provider, "/provider", PROVIDER_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

  const id = member(provider, "id");
  if (id !== undefined && (!isNonEmptyString(id) || !PROVIDER_ID.test(id))) {
    collector.emit("invalid_provider_id", "ENV-1", "/provider/id", "provider id does not match the required slug grammar");
  }

  const runId = member(provider, "runId");
  if (runId !== undefined) {
    const legal = isNonEmptyString(runId) && runId.length <= 128 && RUN_ID.test(runId) && runId !== "." && runId !== "..";
    if (!legal) {
      collector.emit("invalid_run_id", "ENV-2", "/provider/runId", "run id is not a single safe path component");
    }
  }

  const finalPassId = member(provider, "finalPassId");
  if (finalPassId !== undefined && !isNonEmptyString(finalPassId)) {
    collector.emit("invalid_pass_id", "ENV-3", "/provider/finalPassId", "final pass id is empty or not a string");
  }

  const version = member(provider, "version");
  if (version !== undefined && !isNonEmptyString(version)) {
    collector.emit("malformed_field", "GEN-4", "/provider/version", "provider version is empty or not a string");
  }

  return { id, runId, finalPassId };
}

// ── ENV-4, ENV-5, ENV-6, ENV-7, SUB-1 ──────────────────────────────────────

function checkCandidate(root: Record<string, unknown>, context: ManifestValidationContext, collector: Collector): void {
  const candidate = member(root, "candidate");
  if (!isRecord(candidate)) {
    if (candidate !== undefined) collector.emit("malformed_field", "GEN-4", "/candidate", "candidate is not an object");
    return;
  }

  checkMembers(candidate, "/candidate", CANDIDATE_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

  const vcs = member(candidate, "vcs");
  if (vcs !== undefined && vcs !== "git") {
    collector.emit("unsupported_vcs", "ENV-4", "/candidate/vcs", "only git is supported in this version");
  }

  checkObjectId(candidate, "treeSha", "/candidate/treeSha", collector);
  checkObjectId(candidate, "headSha", "/candidate/headSha", collector);

  const deliverable = member(candidate, "deliverable");
  if (isRecord(deliverable)) {
    checkMembers(deliverable, "/candidate/deliverable", DELIVERABLE_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

    const digest = member(deliverable, "digest");
    if (digest !== undefined && (!isNonEmptyString(digest) || !SHA256_HEX.test(digest))) {
      collector.emit("malformed_field", "GEN-4", "/candidate/deliverable/digest", "deliverable digest is not 64-hex lowercase");
    }

    const identity = member(deliverable, "identity");
    if (identity !== undefined && (!isNonEmptyString(identity) || !context.config.identityVersions.includes(identity))) {
      // An unknown identity version fails closed: a different definition of
      // "what was reviewed" must never silently match (§10).
      collector.emit("unsupported_identity_version", "ENV-6", "/candidate/deliverable/identity", "deliverable identity version is not one this repository implements");
    }
  } else if (deliverable !== undefined) {
    collector.emit("malformed_field", "GEN-4", "/candidate/deliverable", "deliverable is not an object");
  }

  const base = member(candidate, "base");
  if (isRecord(base)) {
    checkMembers(base, "/candidate/base", BASE_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);
    const ref = member(base, "ref");
    if (ref !== undefined && !isNonEmptyString(ref)) {
      collector.emit("malformed_field", "GEN-4", "/candidate/base/ref", "base ref is empty or not a string");
    }
    checkObjectId(base, "tipSha", "/candidate/base/tipSha", collector);
    checkObjectId(base, "mergeBaseSha", "/candidate/base/mergeBaseSha", collector);
  } else if (base !== undefined) {
    collector.emit("malformed_field", "GEN-4", "/candidate/base", "base is not an object");
  }

  const workspaceId = member(candidate, "workspaceId");
  if (workspaceId !== undefined && !isNonEmptyString(workspaceId)) {
    collector.emit("malformed_field", "ENV-7", "/candidate/workspaceId", "workspace id is empty or not a string");
  }

  // SUB-1: every field, including the raw tree. The recorded id is an audit
  // anchor, so recording is strict where later gate freshness is identity-based.
  if (!canonicallyEqual(candidate, context.currentCandidate)) {
    collector.emit("candidate_mismatch", "SUB-1", "/candidate", "candidate does not match the currently prepared candidate");
  }
}

function checkObjectId(holder: Record<string, unknown>, name: string, at: string, collector: Collector): void {
  const value = member(holder, name);
  // Absence is the member table's business; shape is this function's.
  if (value === undefined) return;
  if (!isNonEmptyString(value) || !GIT_OBJECT_ID.test(value)) {
    collector.emit("invalid_object_id", "ENV-5", at, "value is not a 40-hex lowercase git object id");
  }
}

// ── ENV-8, ENV-12, ENV-13 ──────────────────────────────────────────────────

function checkAttestationAndRepository(root: Record<string, unknown>, collector: Collector): void {
  const attestation = member(root, "attestation");
  let level: unknown;

  if (isRecord(attestation)) {
    checkMembers(attestation, "/attestation", ATTESTATION_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);
    level = member(attestation, "level");

    // ENV-12 and ENV-13 collapse into one conforming shape in this version:
    // level `self` with an empty signature array. The other two levels are
    // defined but unimplementable until a signing profile exists, and accepting
    // an unverifiable signature would launder self-attested evidence as
    // something stronger (§11.4).
    if (level !== undefined && level !== CONFORMING_ATTESTATION_LEVEL) {
      collector.emit("unsupported_attestation", "ENV-12", "/attestation/level", "only self-attested evidence conforms to this version");
    }

    const signatures = member(attestation, "signatures");
    if (signatures !== undefined && (!Array.isArray(signatures) || signatures.length > 0)) {
      collector.emit("unsupported_attestation", "ENV-13", "/attestation/signatures", "signatures must be the empty array until a signing profile exists");
    }
  } else if (attestation !== undefined) {
    collector.emit("malformed_field", "GEN-4", "/attestation", "attestation is not an object");
  }

  const repository = member(root, "repository");
  if (repository !== undefined && repository !== null && !isNonEmptyString(repository)) {
    collector.emit("malformed_field", "GEN-4", "/repository", "repository is neither null nor a non-empty string");
  }
  // ENV-8 is about portability, not about whether the level is conforming:
  // signed evidence travels, so it must name its subject.
  if (level !== undefined && level !== CONFORMING_ATTESTATION_LEVEL && (repository === undefined || repository === null)) {
    collector.emit("repository_required", "ENV-8", "/repository", "evidence above level self must name the repository it is about");
  }
}

// ── ENV-9 (with ENV-3 and ENV-5 over the entries) ──────────────────────────

function checkRunHistory(root: Record<string, unknown>, collector: Collector): number {
  const runHistory = member(root, "runHistory");
  if (!Array.isArray(runHistory)) {
    if (runHistory !== undefined) collector.emit("malformed_field", "GEN-4", "/runHistory", "runHistory is not an array");
    return 0;
  }

  runHistory.forEach((entry, index) => {
    const at = pointer("/runHistory", index);
    if (!isRecord(entry)) {
      collector.emit("malformed_field", "GEN-4", at, "run history entry is not an object");
      return;
    }
    checkMembers(entry, at, RUN_HISTORY_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);
    checkObjectId(entry, "preparedTreeSha", pointer(at, "preparedTreeSha"), collector);
    const passId = member(entry, "evaluatedInPassId");
    if (passId !== undefined && !isNonEmptyString(passId)) {
      collector.emit("invalid_pass_id", "ENV-3", pointer(at, "evaluatedInPassId"), "pass id is empty or not a string");
    }
  });

  // The anti-smuggling invariant: whatever landed last was prepared and
  // evaluated in the final pass. An empty history asserts nothing, so it fails
  // the same rule rather than a softer one.
  const provider = member(root, "provider");
  const candidate = member(root, "candidate");
  const finalPassId = isRecord(provider) ? member(provider, "finalPassId") : undefined;
  const treeSha = isRecord(candidate) ? member(candidate, "treeSha") : undefined;
  const last = runHistory.at(-1);

  const bound =
    isRecord(last) && member(last, "preparedTreeSha") === treeSha && treeSha !== undefined && member(last, "evaluatedInPassId") === finalPassId && finalPassId !== undefined;

  if (!bound) {
    collector.emit("run_history_final_mismatch", "ENV-9", "/runHistory", "run history's final entry does not name the candidate tree and the final pass");
  }

  return runHistory.length;
}

// ── ENV-10 (path shape and uniqueness) ─────────────────────────────────────

function checkArtifacts(root: Record<string, unknown>, collector: Collector): readonly DeclaredArtifact[] {
  const artifacts = member(root, "artifacts");
  if (!Array.isArray(artifacts)) {
    if (artifacts !== undefined) collector.emit("malformed_field", "GEN-4", "/artifacts", "artifacts is not an array");
    return [];
  }

  const declared: DeclaredArtifact[] = [];
  const seen = new Set<string>();

  artifacts.forEach((entry, index) => {
    const at = pointer("/artifacts", index);
    if (!isRecord(entry)) {
      collector.emit("malformed_field", "GEN-4", at, "artifact entry is not an object");
      return;
    }
    checkMembers(entry, at, ARTIFACT_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

    const declaredPath = member(entry, "path");
    if (declaredPath !== undefined) {
      if (!isNonEmptyString(declaredPath) || !isSafeRelativePath(declaredPath)) {
        collector.emit("artifact_path_invalid", "ENV-10", pointer(at, "path"), "artifact path is absolute, empty, or escapes the run root");
      } else if (seen.has(declaredPath)) {
        collector.emit("artifact_path_duplicate", "ENV-10", pointer(at, "path"), "artifact path is declared more than once");
      } else {
        seen.add(declaredPath);
      }
    }

    const sha256 = member(entry, "sha256");
    if (sha256 !== undefined && (!isNonEmptyString(sha256) || !SHA256_HEX.test(sha256))) {
      collector.emit("malformed_field", "GEN-4", pointer(at, "sha256"), "artifact digest is not 64-hex lowercase");
    }

    const role = member(entry, "role");
    if (role !== undefined && (!isNonEmptyString(role) || !ARTIFACT_ROLE.test(role))) {
      collector.emit("malformed_field", "GEN-4", pointer(at, "role"), "artifact role does not match the required slug grammar");
    }

    if (isNonEmptyString(declaredPath) && isNonEmptyString(sha256) && isNonEmptyString(role)) {
      declared.push({ index, path: declaredPath, sha256, role });
    }
  });

  return declared;
}

/**
 * Path shape only: relative, no traversal, no drive-absolute or UNC form. The
 * realpath clause of ENV-10 — that a resolved location stays inside the
 * recorder-allocated run root — is a filesystem question, and lives with the
 * recorder that allocated the root.
 *
 * `artifacts.ts` carries the same predicate, because the port must be safe for
 * a caller that never ran this validator. The two are kept character-for-
 * character identical and a test pins them over a shared table: a path one
 * accepted and the other refused would be an artifact the recorder never
 * digests and no rule ever rejects. A NUL is refused by both — no filesystem
 * admits one in a path segment, and letting it through turns the port's
 * classification into an argument-validation throw.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.includes("\u0000")) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const segments = value.split(/[/\\]/);
  return !segments.includes("..") && !segments.includes("");
}

// ── §5.8 shape (never a decision input) ────────────────────────────────────

function checkTimestamp(root: Record<string, unknown>, collector: Collector): void {
  // Grammar only, and the sensor's one registered timestamp-read site: GEN-5
  // forbids *consulting* this value, not knowing that the closed grammar
  // requires it. Nothing below compares it, orders it, or derives anything from
  // it — it is checked for being a non-empty string and dropped. Its bytes
  // participate in the manifest digest like any other member.
  const value = member(root, "recordedAt");
  if (value !== undefined && !isNonEmptyString(value)) {
    collector.emit("malformed_field", "GEN-4", "/recordedAt", "member is empty or not a string");
  }
}

// ── ENV-14 and payload dispatch ────────────────────────────────────────────

interface ClaimCheckInput {
  readonly context: ManifestValidationContext;
  readonly collector: Collector;
  readonly providerIdentity: ProviderIdentity;
  readonly artifacts: readonly DeclaredArtifact[];
  readonly runHistoryLength: number;
}

function checkClaims(root: Record<string, unknown>, input: ClaimCheckInput): void {
  const { collector, context } = input;
  const claims = member(root, "claims");

  if (!Array.isArray(claims)) {
    if (claims !== undefined) collector.emit("malformed_field", "GEN-4", "/claims", "claims is not an array");
    return;
  }
  if (claims.length === 0) {
    collector.emit("no_claims", "ENV-14", "/claims", "a manifest with no claims asserts nothing");
    return;
  }

  const seen = new Set<string>();

  claims.forEach((claim, index) => {
    const at = pointer("/claims", index);
    if (!isRecord(claim)) {
      collector.emit("malformed_field", "GEN-4", at, "claim is not an object");
      return;
    }
    checkMembers(claim, at, CLAIM_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

    const obligationId = member(claim, "obligation");
    let obligation: ObligationPolicy | undefined;

    if (obligationId !== undefined) {
      if (!isNonEmptyString(obligationId) || !OBLIGATION_ID.test(obligationId)) {
        collector.emit("malformed_field", "GEN-4", pointer(at, "obligation"), "obligation id does not match the required grammar");
      } else {
        if (seen.has(obligationId)) {
          collector.emit("duplicate_claim", "ENV-14", pointer(at, "obligation"), "obligation is claimed more than once in one manifest");
        }
        seen.add(obligationId);
        obligation = context.config.obligations.find((entry) => entry.id === obligationId);
        if (obligation === undefined) {
          collector.emit("obligation_not_configured", "ENV-14", pointer(at, "obligation"), "repository configuration declares no such obligation");
        }
      }
    }

    // ENV-1's registration half is per claimed obligation: a provider is
    // allowed for obligations, not in general. An unconfigured obligation
    // carries no allowlist to judge against, so registration is not decided
    // there — the obligation itself is already the rejection.
    const providerId = input.providerIdentity.id;
    if (obligation !== undefined && isNonEmptyString(providerId) && !obligation.providers.includes(providerId)) {
      collector.emit("unregistered_provider", "ENV-1", "/provider/id", "provider is not registered for an obligation this manifest claims");
    }

    const payloadSpec = member(claim, "payloadSpec");
    let payloadSpecUsable = false;
    if (payloadSpec !== undefined) {
      const named = isNonEmptyString(payloadSpec) ? payloadSpec : undefined;
      // Fail closed on both halves: a spec the repository has not accepted, and
      // a spec no rule in this validator has ever read.
      const acceptedHere = named !== undefined && (obligation === undefined || obligation.acceptedPayloadSpecs.includes(named));
      const implemented = named !== undefined && SUPPORTED_PAYLOAD_SPECS.includes(named);
      if (!implemented || !acceptedHere) {
        collector.emit("unsupported_payload_spec", "ENV-14", pointer(at, "payloadSpec"), "payload spec is not one this repository accepts and this validator implements");
      } else {
        payloadSpecUsable = true;
      }
    }

    const payload = member(claim, "payload");
    if (payload !== undefined && !isRecord(payload)) {
      collector.emit("malformed_field", "GEN-4", pointer(at, "payload"), "payload is not an object");
      return;
    }

    if (payloadSpecUsable && payloadSpec === "installed-data.applicable/1" && isRecord(payload)) {
      validateInstalledDataApplicable(payload, pointer(at, "payload"), input.providerIdentity, input.artifacts, context, collector);
    }
    if (payloadSpecUsable && payloadSpec === "checks.passed/1" && isRecord(payload)) {
      validateChecksPassed(payload, pointer(at, "payload"), input.providerIdentity, input.artifacts, context, collector);
    }
    if (payloadSpecUsable && payloadSpec === REVIEW_GREEN_1 && isRecord(payload)) {
      validateReviewGreenClaim(
        {
          payload,
          at: pointer(at, "payload"),
          provider: input.providerIdentity,
          candidate: member(root, "candidate"),
          artifacts: input.artifacts,
          artifactContents: context.artifactContents,
          runHistoryLength: input.runHistoryLength,
        },
        collector,
      );
    }
    if (payloadSpecUsable && payloadSpec === REVIEW_GREEN_2 && isRecord(payload)) {
      validateReviewGreenClaimV2(
        {
          payload,
          at: pointer(at, "payload"),
          provider: input.providerIdentity,
          candidate: member(root, "candidate"),
          artifacts: input.artifacts,
          artifactContents: context.artifactContents,
          runHistoryLength: input.runHistoryLength,
        },
        collector,
      );
    }
  });
}

// ── SUB-2 ──────────────────────────────────────────────────────────────────

function checkPreparation(context: ManifestValidationContext, collector: Collector): void {
  if (!context.prepared) {
    collector.emit("candidate_unprepared", "SUB-2", "/candidate", "the candidate is not in a prepared state at submission");
  }
}
