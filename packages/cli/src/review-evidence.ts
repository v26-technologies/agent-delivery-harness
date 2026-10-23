/**
 * The shipped review-outcome evidence writer. It transcribes concluded host
 * results without running reviewers or upgrading their self-attestation.
 *
 * Capture `delivery-harness review-context --json` before review, then pass
 * that original document to `emit-review-evidence --context <path>` with a
 * review-outcome/1 document on stdin naming its contextDigest. Reviewer names
 * come from the resolved activated charters; for example a named result is
 * `{ "id": "outcome-correctness", "result": "rejected" }`.
 *
 * The raw context and outcome remain digest-bound artifacts. Submission is
 * still the authority on whether the resulting evidence satisfies the gate.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  resolveReviewCharters,
  validateReviewedContext, parseReviewOutcome, deriveTelemetry, reviewerLists,
  capturePortableEvidenceContext, repositoryEvidenceReader, createArtifactsPort,
  ReviewInputError as OutcomeError,
  BlockedError,
  digestCanonical,
  evaluatePreparationReceipt,
  sha256Hex,
  type CapturedCandidate,
  type PreparationReceipt,
  type HarnessConfig,
  REVIEW_GREEN_1,
  REVIEW_GREEN_2,
} from "@agent-delivery-harness/kernel";
import type { CommandContext } from "./boundary.ts";

// ── The charters the compiled policy activates ───────────────────────────────

/**
 * The compiled policy this repository is judged under, and the installed
 * generation whose archive carries the charters its lenses reference by
 * identity. One activated lens is one reviewer, and the basename of the
 * charter path the archive's manifest declares is the reviewer id the evidence
 * carries — the same two documents `policy-projection-check.ts` compiles the
 * projection from.
 */
export const COMPILED_SNAPSHOT_FILE = ".agents/policy/compiled-snapshot.json";
export const INSTALLED_ARCHIVE_DIR = ".agent-skills/current";

export const CHARTER_EXTENSION = ".md";

/** Review payloads this provider can emit, in preference order. */
export const REVIEW_PAYLOAD_SPECS = [REVIEW_GREEN_2, REVIEW_GREEN_1] as const;
export const REVIEW_PAYLOAD_SPEC = REVIEW_GREEN_2;

/** The envelope spec the manifest declares. */
export const ENVELOPE_SPEC = "delivery-evidence/1";

/** The outcome document this emitter reads. */
export const OUTCOME_SPEC = "review-outcome/1";

/** This emitter's own version, carried in the manifest's provider triple. */
export const EMITTER_VERSION = "1.0.0";

export type { ResolvedCharter } from "@agent-delivery-harness/kernel";
export async function resolveActivatedCharters(rootDir: string, config?: Pick<HarnessConfig, "additionalReviewLenses">) {
  return resolveReviewCharters(repositoryEvidenceReader(rootDir, createArtifactsPort()), config);
}
export async function resolveReviewerCharters(rootDir: string): Promise<string[]> {
  return (await resolveActivatedCharters(rootDir)).map((charter) => charter.reviewerId).sort();
}

/** Exact review input, retained by the host before acquiring any outcomes. */
export const REVIEW_CONTEXT_SPEC = "review-context/1";

function manifestCandidate(captured: CapturedCandidate) {
  return {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };
}

export async function buildReviewContext(
  rootDir: string,
  config: HarnessConfig,
  candidate: CapturedCandidate,
  receipt: PreparationReceipt,
) {
  const inputs = await capturePortableEvidenceContext(config, repositoryEvidenceReader(rootDir, createArtifactsPort()), receipt.preparationFingerprint, candidate.deliverable.digest);
  const charters = inputs.reviewerCharters;
  if (charters.length === 0 || inputs.release === null) throw new OutcomeError("the compiled policy activates no review lens or installed release");
  const binding = {
    gate: resolveGateBinding(config),
    candidate: manifestCandidate(candidate),
    preparationFingerprint: inputs.preparationFingerprint,
    configurationDigest: inputs.configurationDigest,
    policyDigest: inputs.policyDigest,
    release: inputs.release,
    workflowGraphSha256: inputs.workflowGraphSha256,
    charters,
  };
  return { spec: REVIEW_CONTEXT_SPEC, digest: digestCanonical(binding), binding };
}

export type ReviewContextDocument = Awaited<ReturnType<typeof buildReviewContext>>;

export { validateReviewedContext, parseReviewOutcome, deriveTelemetry, reviewerLists, REVIEWER_RESULTS } from "@agent-delivery-harness/kernel";
export type { ReviewOutcome, ReviewerOutcome, ReviewerResult } from "@agent-delivery-harness/kernel";
export { OutcomeError };
// ── The gate this provider serves ────────────────────────────────────────────

export interface GateBinding {
  readonly obligationId: string;
  readonly providerId: string;
}

/**
 * The obligation this manifest answers, and the provider it answers as, taken
 * from the config rather than from a constant — a provider id that has drifted
 * from the gate it serves is rejected as `unknown_provider` at evaluation, long
 * after the review it describes has been paid for.
 */
export function resolveGateBinding(config: HarnessConfig): GateBinding {
  const obligations = config.obligations.filter((obligation) =>
    REVIEW_PAYLOAD_SPECS.some((payloadSpec) => obligation.acceptedPayloadSpecs.includes(payloadSpec)),
  );
  if (obligations.length !== 1) {
    throw new OutcomeError(
      `the gate declares ${obligations.length} obligations accepting a supported review.green payload; this provider serves exactly one`,
    );
  }
  const obligation = obligations[0]!;
  if (obligation.providers.length !== 1) {
    throw new OutcomeError(
      `obligation ${obligation.id} names ${obligation.providers.length} providers; this provider serves exactly one`,
    );
  }
  return { obligationId: obligation.id, providerId: obligation.providers[0]! };
}

function resolveReviewPayloadSpec(
  config: HarnessConfig,
  obligationId: string,
): (typeof REVIEW_PAYLOAD_SPECS)[number] {
  const obligation = config.obligations.find((entry) => entry.id === obligationId);
  const payloadSpec = REVIEW_PAYLOAD_SPECS.find((candidate) => obligation?.acceptedPayloadSpecs.includes(candidate));
  if (payloadSpec === undefined) throw new OutcomeError(`obligation ${obligationId} accepts no supported review.green payload`);
  return payloadSpec;
}

// ── The manifest ─────────────────────────────────────────────────────────────

export interface EmitResult {
  readonly manifestPath: string;
  readonly runRoot: string;
}

/**
 * Capture the candidate, allocate the run root, stamp one approval per
 * approving reviewer, and write the manifest. The capture is deliberately the
 * same call the recorder makes at submission (same config, same workspace id,
 * same identity computation): anything else describes a tree the recorder will
 * refuse to recognise.
 */
export async function emitReviewEvidence(context: CommandContext, original: unknown, document: unknown): Promise<EmitResult> {
  const { rootDir, config } = context;
  const wiring = await context.wire();
  const capture = await wiring.captureCandidate();
  if (!capture.ok) throw new OutcomeError(`the candidate could not be captured: ${capture.code}`);
  const captured = capture.candidate;
  const preparation = await evaluatePreparationReceipt(rootDir, { config, candidate: captured }, wiring.storageOptions);
  if (!preparation.prepared) throw new BlockedError([...preparation.blockers]);
  const current = await buildReviewContext(rootDir, config, captured, preparation.receipt);
  validateReviewedContext(original, current, document);
  const charters = current.binding.charters.map((charter) => charter.reviewerId).sort();
  const outcome = parseReviewOutcome(document, charters);
  const binding = current.binding.gate;
  const payloadSpec = resolveReviewPayloadSpec(config, binding.obligationId);
  const candidate = manifestCandidate(captured);

  const provider = {
    id: binding.providerId,
    version: EMITTER_VERSION,
    // One emitter run is one evaluated pass over this candidate.
    runId: `r-${randomUUID()}`,
    finalPassId: outcome.finalPassId ?? "pass-1",
  };
  const reviewed = original as ReviewContextDocument;
  const originalRunHistory = outcome.runHistory ?? [{
    preparedTreeSha: reviewed.binding.candidate.treeSha,
    evaluatedInPassId: provider.finalPassId,
  }];
  const finalEntry = originalRunHistory.at(-1)!;
  if (finalEntry["preparedTreeSha"] !== reviewed.binding.candidate.treeSha ||
      finalEntry["evaluatedInPassId"] !== provider.finalPassId) {
    throw new OutcomeError("the supplied final review pass does not name the original reviewed candidate");
  }
  // ENV-9's final tree is a preparation coordinate. A proven neutral reuse
  // projects that coordinate without claiming the reviewers saw a new raw
  // tree, adding a round, or overwriting their original history.
  const runHistory = originalRunHistory.map((entry, index) => index === originalRunHistory.length - 1
    ? { ...entry, preparedTreeSha: captured.treeSha } : entry);

  const allocation = await context.artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
  if (!allocation.ok) throw new OutcomeError(`the run root was refused: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  const lists = reviewerLists(charters, outcome);
  await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
  const artifacts: { path: string; sha256: string; role: string }[] = [];
  for (const [name, value] of [["review-context", original], ["review-outcome", document]] as const) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(runRoot, `${name}.json`), bytes, "utf8");
    artifacts.push({ path: `${name}.json`, sha256: sha256Hex(bytes), role: name });
  }
  if (digestCanonical(reviewed.binding.candidate) !== digestCanonical(candidate)) {
    const bytes = `${JSON.stringify({
      spec: "review-context-projection/1",
      basis: "unchanged-deliverable-and-review-inputs",
      originalContextDigest: reviewed.digest,
      reviewedCandidate: reviewed.binding.candidate,
      preparedCandidate: candidate,
      originalRunHistory,
      reviewRoundAdded: false,
    }, null, 2)}\n`;
    await writeFile(path.join(runRoot, "review-context-projection.json"), bytes, "utf8");
    artifacts.push({ path: "review-context-projection.json", sha256: sha256Hex(bytes), role: "review-context-projection" });
  }
  for (const reviewerId of lists.approved) {
    // §9.2: the stamp re-states the whole binding, so each approval is
    // independently interpretable in an audit.
    const stamp = `${JSON.stringify(
      {
        schemaVersion: 1,
        reviewerId,
        result: "approved",
        provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
        workspaceId: candidate.workspaceId,
        candidate,
      },
      null,
      2,
    )}\n`;
    const relativePath = `reviewers/${reviewerId}.json`;
    await writeFile(path.join(runRoot, relativePath), stamp, "utf8");
    artifacts.push({ path: relativePath, sha256: sha256Hex(stamp), role: "reviewer-approval" });
  }

  const manifest = {
    spec: ENVELOPE_SPEC,
    provider,
    candidate,
    repository: null,
    runHistory,
    artifacts,
    attestation: { level: "self", signatures: [] },
    recordedAt: new Date().toISOString(),
    claims: [
      {
        obligation: binding.obligationId,
        payloadSpec,
        payload: {
          verdict: outcome.verdict,
          finalized: true,
          editedAfterFinalPass: false,
          reviewers: {
            selected: lists.selected,
            completed: lists.completed,
            failed: lists.failed,
            timedOut: lists.timedOut,
          },
          findings: outcome.findings,
          telemetry: { ...deriveTelemetry(outcome.findings, runHistory.length), ...(outcome.cost === undefined ? {} : { cost: outcome.cost }) },
        },
      },
    ],
  };

  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, runRoot };
}
