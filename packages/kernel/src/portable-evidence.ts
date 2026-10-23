/** Portable transport of accepted bytes; every evidence judgment remains in the existing validators. */
import { BlockedError, createBlocker, type Blocker } from "./blockers.ts";
import { digestCanonical, sha256Hex } from "./digest.ts";
import type { HarnessConfig } from "./config.ts";
import { recordOutputConfiguration } from "./record-output.ts";
import type { ArtifactObservation, ArtifactsPort } from "./artifacts.types.ts";
import type { PortableEvidence, PortableEvidenceContext, RecordCandidateBinding, CheckBinding } from "./records.types.ts";
import { readWorkflowRelease, resolveReviewCharters, type ReviewInputReader } from "./review-inputs.ts";
import { validateReviewedContext, parseReviewOutcome, reviewerLists, deriveTelemetry, type ReviewContextDocument } from "./review-outcome.ts";
import { REVIEW_GREEN_1, REVIEW_GREEN_2 } from "./validator/codes.ts";
import { declaredArtifacts, judgeArtifact } from "./validator/artifacts.ts";
import { isSafeRelativePath, validateManifest, type DeliveryEvidenceManifest } from "./validator/envelope.ts";

import { MAX_PORTABLE_ARTIFACT_BYTES, MAX_PORTABLE_EVIDENCE_BYTES, MAX_PORTABLE_ARTIFACTS } from "./portable-limits.ts";
export { MAX_PORTABLE_ARTIFACT_BYTES, MAX_PORTABLE_EVIDENCE_BYTES, MAX_PORTABLE_RECORD_BYTES, MAX_PORTABLE_ARTIFACTS } from "./portable-limits.ts";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function portableBlocker(code: string, summary: string): Blocker {
  return createBlocker({ code, source: { kind: "delivery-record", id: "delivery-harness.portable-evidence" }, summary,
    remediations: [{ id: "retain-current-evidence", kind: "manual_action", summary: "Prepare, acquire and submit current evidence, then record it with this product version." }] });
}
function refuse(code: string, summary: string): never { throw new BlockedError([portableBlocker(code, summary)]); }

/** Read bounded repository inputs through the existing observation port. */
export function repositoryEvidenceReader(rootDir: string, artifacts: ArtifactsPort): ReviewInputReader {
  return async (relativePath) => {
    const observation = await artifacts.observeArtifact(rootDir, relativePath);
    if (observation.status === "missing") return null;
    if (observation.status !== "readable" || observation.contents === null) refuse("portable_context_unreadable", "A declared evidence input could not be read inside the repository.");
    const bytes = observation.base64 === undefined ? Buffer.from(observation.contents, "utf8") : Buffer.from(observation.base64, "base64");
    if (bytes.length > MAX_PORTABLE_ARTIFACT_BYTES || sha256Hex(bytes) !== observation.sha256) refuse("portable_context_invalid", "A declared evidence input is oversized or its exact bytes are unavailable.");
    return bytes;
  };
}

export async function capturePortableEvidenceContext(
  config: HarnessConfig, read: ReviewInputReader, preparationFingerprint: string, deliverableDigest?: string,
): Promise<PortableEvidenceContext> {
  const policy = await read(".agents/policy/compiled-snapshot.json");
  const release = await readWorkflowRelease(read);
  if (policy !== null && release === null) refuse("portable_context_incomplete", "Compiled review policy requires its installed workflow release.");
  if (policy === null && config.additionalReviewLenses?.length) refuse("portable_context_incomplete", "Additional review lenses require the installed activated review set.");
  const reviewerCharters = policy === null ? [] : await resolveReviewCharters(read, config);
  const graph = release === null ? null : await read(".agent-skills/current/workflows/delivery-v1.json");
  if (policy !== null && graph === null) refuse("portable_context_incomplete", "The installed workflow graph is missing.");
  return { configurationDigest: digestCanonical(recordOutputConfiguration(config, deliverableDigest)), preparationFingerprint, policyDigest: policy === null ? null : sha256Hex(policy),
    release, workflowGraphSha256: graph === null ? null : sha256Hex(graph), reviewerCharters };
}

/** Called before publication, from the same observations the recorder just validated. */
export function retainPortableEvidence(manifest: DeliveryEvidenceManifest, observations: ReadonlyMap<string, ArtifactObservation>, context: PortableEvidenceContext): PortableEvidence {
  if (manifest.artifacts.length > MAX_PORTABLE_ARTIFACTS) refuse("portable_evidence_oversized", "The evidence references too many artifacts to retain.");
  const artifacts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of manifest.artifacts) {
    const observed = observations.get(entry.path);
    if (observed?.status !== "readable" || observed.contents === null) refuse("portable_evidence_incomplete", "Accepted evidence has no retained artifact bytes.");
    const bytes = observed.base64 === undefined ? Buffer.from(observed.contents, "utf8") : Buffer.from(observed.base64, "base64");
    if (bytes.length > MAX_PORTABLE_ARTIFACT_BYTES) refuse("portable_evidence_oversized", "An evidence artifact exceeds the portable size limit.");
    if (sha256Hex(bytes) !== entry.sha256) refuse("portable_evidence_corrupt", "The exact accepted artifact bytes could not be retained.");
    artifacts[entry.path] = bytes.toString("base64");
  }
  const retained: PortableEvidence = { version: "portable-evidence/1", manifest, artifacts, context };
  if (Buffer.byteLength(JSON.stringify(retained), "utf8") > MAX_PORTABLE_EVIDENCE_BYTES) refuse("portable_evidence_oversized", "The accepted evidence exceeds the portable size limit.");
  return retained;
}

/** Pure observation of transported bytes; no original path is opened or trusted. */
export function portableArtifactContents(value: unknown): { readonly artifacts: ReadonlyMap<string, string>; readonly observations: ReadonlyMap<string, ArtifactObservation>; readonly blockers: readonly Blocker[] } {
  const artifacts = new Map<string, string>();
  const observations = new Map<string, ArtifactObservation>();
  const blockers: Blocker[] = [];
  if (!isRecord(value) || Object.keys(value).length > MAX_PORTABLE_ARTIFACTS) return { artifacts, observations, blockers: [portableBlocker("portable_evidence_incomplete", "The portable artifact map is missing or oversized.")] };
  for (const [declaredPath, encoded] of Object.entries(value)) {
    if (!isSafeRelativePath(declaredPath) || typeof encoded !== "string" || encoded.length > Math.ceil(MAX_PORTABLE_ARTIFACT_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      blockers.push(portableBlocker("portable_artifact_invalid", "A portable artifact has an invalid path, encoding or size.")); continue;
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > MAX_PORTABLE_ARTIFACT_BYTES) {
      blockers.push(portableBlocker("portable_artifact_invalid", "A portable artifact is not canonical bounded base64.")); continue;
    }
    const contents = bytes.toString("utf8");
    artifacts.set(declaredPath, contents);
    observations.set(declaredPath, { declaredPath, status: "readable", resolvedPath: null, sha256: sha256Hex(bytes), contents, base64: encoded, detail: null });
  }
  return { artifacts, observations, blockers };
}

/** The same manifest validator, with a portable artifact reader supplying ENV-11 and RG-4 bytes. */
export function verifyPortableEvidence(config: HarnessConfig, portable: PortableEvidence, binding: RecordCandidateBinding, expected: PortableEvidenceContext, checkBindings?: Readonly<Record<string, CheckBinding>>): readonly Blocker[] {
  const blockers: Blocker[] = [];
  if (!isRecord(portable) || portable.version !== "portable-evidence/1" || Object.keys(portable).sort().join(",") !== "artifacts,context,manifest,version" ||
      Buffer.byteLength(JSON.stringify(portable), "utf8") > MAX_PORTABLE_EVIDENCE_BYTES) return [portableBlocker("portable_evidence_invalid", "The portable evidence is missing, unsupported or oversized.")];
  const manifestValue = portable.manifest;
  const manifestProvider = isRecord(manifestValue) && isRecord(manifestValue["provider"]) ? manifestValue["provider"]["id"] : undefined;
  const scoped = isRecord(manifestValue) && Array.isArray(manifestValue["claims"]) && manifestValue["claims"].length > 0 &&
    config.providers.some(p => p.id === manifestProvider && p.check?.scope !== undefined) &&
    manifestValue["claims"].every(c => isRecord(c) && c["payloadSpec"] === "checks.passed/1" && isRecord(c["payload"]) && isRecord(c["payload"]["binding"]) && c["payload"]["binding"]["scopedInputDigest"] !== undefined);
  if (!isRecord(portable.context) || (scoped ? digestCanonical(portable.context.release) !== digestCanonical(expected.release) : digestCanonical(portable.context) !== digestCanonical(expected))) blockers.push(portableBlocker("portable_context_mismatch", "Evidence policy, wiring, compatible release or resolved reviewer inputs changed."));
  const read = portableArtifactContents(portable.artifacts);
  blockers.push(...read.blockers);
  const declared = declaredArtifacts(portable.manifest);
  if (read.observations.size !== declared.length) blockers.push(portableBlocker("portable_evidence_incomplete", "The retained artifact set differs from the accepted manifest."));
  for (const entry of declared) {
    const observation = read.observations.get(entry.path) ?? { declaredPath: entry.path, status: "missing" as const, resolvedPath: null, sha256: null, contents: null, detail: null };
    const rejection = judgeArtifact(entry, observation);
    if (rejection !== null) blockers.push(portableBlocker(rejection.code, rejection.message));
  }
  const candidate = isRecord(portable.manifest) && isRecord(portable.manifest["candidate"]) ? portable.manifest["candidate"] : {};
  const validation = validateManifest(portable.manifest, { config, prepared: true, artifactContents: read.artifacts, ...(checkBindings === undefined ? {} : { checkBindings }),
    currentCandidate: { vcs: "git", treeSha: binding.treeSha, ...(candidate["headSha"] === undefined ? {} : { headSha: candidate["headSha"] }),
      deliverable: { digest: binding.deliverableDigest, identity: binding.identityToken },
      base: { ref: binding.baseRef, tipSha: binding.baseTipSha, mergeBaseSha: binding.mergeBaseSha }, workspaceId: binding.workspaceId } });
  if (!validation.ok) blockers.push(...validation.rejections.map((rejection) => portableBlocker(rejection.code, rejection.message)));
  else {
    for (const claim of validation.manifest.claims) {
      if (claim.payloadSpec !== REVIEW_GREEN_1 && claim.payloadSpec !== REVIEW_GREEN_2) continue;
      if (expected.reviewerCharters.length > 0) blockers.push(...verifyOriginalReview(validation.manifest, claim, read.artifacts, expected));
      const reviewers = isRecord(claim.payload["reviewers"]) ? claim.payload["reviewers"]["selected"] : undefined;
      if (!Array.isArray(reviewers) || expected.reviewerCharters.some((charter) => !reviewers.includes(charter.reviewerId))) {
        blockers.push(portableBlocker("portable_review_lens_missing", "Actual reviewer evidence does not cover every activated and additional review lens."));
      }
    }
  }
  return blockers;
}

/** Original outcomes use the emitter's parser; green remains the manifest validator's decision. */
function verifyOriginalReview(manifest: DeliveryEvidenceManifest, claim: DeliveryEvidenceManifest["claims"][number], artifacts: ReadonlyMap<string, string>, expected: PortableEvidenceContext): readonly Blocker[] {
  try {
    const artifact = (role: string): unknown => {
      const entries = manifest.artifacts.filter(entry => entry.role === role);
      if (entries.length !== 1) throw new Error(`expected one ${role} artifact`);
      return JSON.parse(artifacts.get(entries[0]!.path)!);
    };
    const original = artifact("review-context");
    const rawOutcome = artifact("review-outcome");
    const binding = { gate: { obligationId: claim.obligation, providerId: manifest.provider.id }, candidate: manifest.candidate,
      preparationFingerprint: expected.preparationFingerprint, configurationDigest: expected.configurationDigest,
      policyDigest: expected.policyDigest, release: expected.release, workflowGraphSha256: expected.workflowGraphSha256,
      charters: expected.reviewerCharters };
    validateReviewedContext(original, { spec: "review-context/1", digest: digestCanonical(binding), binding } as ReviewContextDocument, rawOutcome);
    const reviewed = original as ReviewContextDocument;
    const ids = expected.reviewerCharters.map(charter => charter.reviewerId).sort();
    const outcome = parseReviewOutcome(rawOutcome, ids);
    const lists = reviewerLists(ids, outcome);
    const approvals = manifest.artifacts.filter(entry => entry.role === "reviewer-approval").map(entry => {
      const stamp: unknown = JSON.parse(artifacts.get(entry.path)!);
      return isRecord(stamp) ? stamp["reviewerId"] : undefined;
    });
    if (digestCanonical(approvals.sort()) !== digestCanonical([...lists.approved].sort())) throw new Error("approval artifacts differ from the reviewers who actually approved");
    const finalPassId = outcome.finalPassId ?? "pass-1";
    const originalRunHistory = outcome.runHistory ?? [{ preparedTreeSha: reviewed.binding.candidate.treeSha, evaluatedInPassId: finalPassId }];
    const final = originalRunHistory.at(-1)!;
    if (final["preparedTreeSha"] !== reviewed.binding.candidate.treeSha || final["evaluatedInPassId"] !== finalPassId || finalPassId !== manifest.provider.finalPassId) throw new Error("original final pass differs");
    const runHistory = originalRunHistory.map((entry, index) => index === originalRunHistory.length - 1 ? { ...entry, preparedTreeSha: manifest.candidate.treeSha } : entry);
    const expectedPayload = { verdict: outcome.verdict, finalized: true, editedAfterFinalPass: false,
      reviewers: { selected: lists.selected, completed: lists.completed, failed: lists.failed, timedOut: lists.timedOut },
      findings: outcome.findings, telemetry: { ...deriveTelemetry(outcome.findings, runHistory.length), ...(outcome.cost === undefined ? {} : { cost: outcome.cost }) } };
    if (digestCanonical(expectedPayload) !== digestCanonical(claim.payload) || digestCanonical(runHistory) !== digestCanonical(manifest.runHistory)) throw new Error("manifest differs from original host outcomes or history");
    const projected = digestCanonical(reviewed.binding.candidate) !== digestCanonical(manifest.candidate);
    const projections = manifest.artifacts.filter(entry => entry.role === "review-context-projection");
    if (projected) {
      const expectedProjection = { spec: "review-context-projection/1", basis: "unchanged-deliverable-and-review-inputs", originalContextDigest: reviewed.digest,
        reviewedCandidate: reviewed.binding.candidate, preparedCandidate: manifest.candidate, originalRunHistory, reviewRoundAdded: false };
      if (digestCanonical(artifact("review-context-projection")) !== digestCanonical(expectedProjection)) throw new Error("neutral projection differs from original review history");
    } else if (projections.length > 0) throw new Error("unexpected neutral projection");
    return [];
  } catch (error) { return [portableBlocker("portable_review_outcome_invalid", `The retained original review does not substantiate its manifest: ${error instanceof Error ? error.message : "invalid input"}`)]; }
}
