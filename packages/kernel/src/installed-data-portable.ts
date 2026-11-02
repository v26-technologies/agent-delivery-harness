/** Reconstruct applicability from retained native observations and Git inputs.
 * No importing-host dependency tree or native attempt store is consulted. */
import { digestCanonical, sha256Hex } from "./digest.ts";
import { captureInstalledDataBinding, type InstalledDataSourceTree } from "./installed-data-source.ts";
import { normalizeInstalledDataResourceRequests, validateResourceApplicabilityProjection, type InstalledDataAttemptOrigin } from "./installed-data-resources.ts";
import { createResourceApplicabilityBinding } from "./installed-data-evidence.ts";
import { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-limits.ts";
import { scopedCheckIdentity, type ScopedRuntimeObservation } from "./scoped-inputs.ts";
import type { CapturedCandidate } from "./candidate.types.ts";
import { recordOutputProvider } from "./record-output.ts";
import { deliveryRecordPathFor, isScopedCheckDefinition, type HarnessConfig, type ProviderRegistration } from "./config.ts";
import type { ScopedCheckAttempt, RecordCandidateBinding } from "./records.types.ts";
import type { ReviewInputReader } from "./review-inputs.ts";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (): never => { throw new Error("Retained installed resource origin or current source authority is invalid."); };
export async function reconstructResourceApplicability(
  config: HarnessConfig, provider: ProviderRegistration, candidate: CapturedCandidate, proof: unknown,
  sourceTree: (tree: string) => Promise<InstalledDataSourceTree>, readEvidence: ReviewInputReader,
) {
  if (!object(proof) || Object.keys(proof).sort().join(",") !== "observation,origin,version" || proof["version"] !== "installed-data-proof/1" || !object(proof["origin"])) refuse();
  const row = proof["origin"] as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "attempt,executionHeadSha,payload" || !object(row["attempt"]) || !object(row["payload"])) refuse();
  const attempt = row["attempt"] as unknown as ScopedCheckAttempt;
  const payload = row["payload"] as Record<string, unknown>;
  const observation = proof["observation"] as unknown as ScopedRuntimeObservation;
  const projection = validateResourceApplicabilityProjection(payload["resourceApplicability"]);
  const diagnostic = payload["diagnostic"];
  if (!object(diagnostic) || diagnostic["phase"] !== "complete" || diagnostic["availability"] !== "available" || !object(diagnostic["command"]) || diagnostic["command"]["exitCode"] !== 0 || !object(diagnostic["failure"]) || Object.keys(diagnostic["failure"]).join() !== "unavailable" || diagnostic["failure"]["unavailable"] !== "not-failed") refuse();
  if (attempt.version !== "scoped-attempt/1" || attempt.status !== "passed" || attempt.providerId !== provider.id || !object(attempt.origin) || !object(attempt.origin.candidate)) refuse();
  const origin: InstalledDataAttemptOrigin = { providerId: attempt.providerId, runId: attempt.origin.runId, attemptId: attempt.attemptId, generation: attempt.generation,
    inputDigest: attempt.inputDigest, profileDigest: attempt.profileDigest, source: { headSha: row["executionHeadSha"] as string, treeSha: attempt.origin.candidate.treeSha }, status: "passed", superseded: false };
  if (digestCanonical(origin) !== digestCanonical(projection.origin)) refuse();
  const original = attempt.origin.candidate;
  if (original.workspaceId !== candidate.workspaceId || original.identityToken !== candidate.deliverable.identity) refuse();
  const originalCandidate = { headSha: origin.source.headSha, treeSha: original.treeSha, base: { ref: original.baseRef, tipSha: original.baseTipSha, mergeBaseSha: original.mergeBaseSha }, deliverable: { digest: original.deliverableDigest, identity: original.identityToken } };
  const originalTree = await sourceTree(original.treeSha);
  // Ordinary planning can grow its broad selected paths after an unrelated
  // edit. Recompute the actual old selection, never a current-frame substitute.
  // Its original input/profile digests still authenticate every retained field.
  let originalProvider = provider;
  if (payload["resourceScope"] !== undefined) {
    const retained = payload["resourceScope"], current = provider.check?.scope;
    if (!isScopedCheckDefinition(retained) || Buffer.byteLength(JSON.stringify(retained), "utf8") > MAX_PORTABLE_ARTIFACT_BYTES || !current ||
        retained.cwd !== current.cwd || retained.profile !== current.profile ||
        digestCanonical(retained.environment) !== digestCanonical(current.environment)) refuse();
    originalProvider = { ...provider, check: { ...provider.check!, scope: retained } };
  }
  const identity = await scopedCheckIdentity(config, originalProvider, originalTree.inventory, originalTree.read, observation, originalCandidate, readEvidence);
  if (!identity.reusable || identity.inputDigest !== attempt.inputDigest || identity.profileDigest !== attempt.profileDigest) refuse();
  const originalSource = await captureInstalledDataBinding(config, provider, originalCandidate, observation, { base: await sourceTree(original.mergeBaseSha), candidate: originalTree }, readEvidence);
  if (originalSource.declarationDigest !== projection.declarationDigest || originalSource.sourceApplicabilityDigest !== projection.sourceApplicabilityDigest || digestCanonical(originalSource.context) !== digestCanonical(projection.capture.context)) refuse();
  const outputs = payload["outputs"];
  if (!Array.isArray(outputs) || outputs.length !== (provider.check?.outputs ?? []).length) refuse();
  outputs.forEach((output, index) => {
    if (!object(output) || Object.keys(output).sort().join(",") !== "base64,path,sha256" || output["path"] !== provider.check!.outputs![index] || typeof output["base64"] !== "string") refuse();
    const bytes = Buffer.from(output["base64"] as string, "base64");
    if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== output["base64"] || sha256Hex(bytes) !== output["sha256"]) refuse();
  });
  const current = await captureInstalledDataBinding(config, provider, candidate, observation, { base: await sourceTree(candidate.base.mergeBaseSha), candidate: await sourceTree(candidate.treeSha) }, readEvidence);
  const capture = projection.capture;
  if (projection.consumerId !== current.declaration.consumerId || digestCanonical(capture.requests) !== digestCanonical(normalizeInstalledDataResourceRequests(current.declaration.requests)) || digestCanonical(capture.context) !== digestCanonical(current.context)) refuse();
  const bindingCandidate: RecordCandidateBinding = { treeSha: candidate.treeSha, deliverableDigest: candidate.deliverable.digest, identityToken: candidate.deliverable.identity, baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: candidate.workspaceId };
  return { binding: createResourceApplicabilityBinding({ candidateDigest: digestCanonical(bindingCandidate), definitionDigest: digestCanonical(recordOutputProvider(provider, deliveryRecordPathFor(config, candidate.deliverable.digest)).check), declarationDigest: current.declarationDigest, sourceApplicabilityDigest: current.sourceApplicabilityDigest, capture, projection, originAttempt: origin }), observation };
}
