/** Fresh observations only. Selection and execution reuse existing policy and provider rails. */
import { randomUUID } from "node:crypto";
import { BlockedError, createBlocker, type Blocker } from "./blockers.ts";
import { captureGitCandidate, type CandidateCommandRunner } from "./candidate.ts";
import { isObligationActive, type CapturedCandidate, type ReviewActivationProjection } from "./candidate.types.ts";
import { computeCheckWiringFingerprint } from "./checks.ts";
import type { PortableEvidenceContext } from "./records.types.ts";
import type { HarnessConfig } from "./config.ts";
import { digestCanonical } from "./digest.ts";
import type { LiveProviderResult } from "./evaluator.ts";
import { withDeliverableIdentity } from "./identity.ts";
import { invokeProviderRail, openProviderRailProcess } from "./provider-rails.ts";

export interface CollectLiveProviderInput {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  readonly candidate: CapturedCandidate;
  readonly projection: ReviewActivationProjection;
  readonly evidenceContext: Pick<PortableEvidenceContext, "preparationFingerprint" | "release">;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly run?: CandidateCommandRunner;
}

export interface LiveProviderCollection {
  readonly liveResults: readonly LiveProviderResult[];
  readonly blockers: readonly Blocker[];
}

function refusal(code: string, summary: string): Blocker {
  return createBlocker({
    code,
    source: { kind: "gate", id: "delivery-harness.live-verification" },
    summary,
    remediations: [{
      id: "rerun-live-verification",
      kind: "manual_action",
      summary: "Use the exact candidate checkout, restore its policy and wiring, and rerun verification.",
    }],
  });
}

function candidateKey(candidate: CapturedCandidate): string {
  return digestCanonical({
    treeSha: candidate.treeSha,
    headSha: candidate.headSha,
    base: candidate.base,
    deliverable: candidate.deliverable,
  });
}

/** No stored result or injection port: every green value comes from this bounded invocation. */
export async function collectLiveProviderResults(input: CollectLiveProviderInput): Promise<LiveProviderCollection> {
  const requested = new Map<string, string[]>();
  for (const obligation of input.config.obligations) {
    if (obligation.freshness !== "live" ||
        !isObligationActive(obligation.activation, input.projection, input.config.activationThreshold)) continue;
    for (const id of obligation.providers) {
      requested.set(id, [...(requested.get(id) ?? []), obligation.id]);
    }
  }
  if (requested.size === 0) return { liveResults: [], blockers: [] };

  const liveResults: LiveProviderResult[] = [];
  const blockers: Blocker[] = [];
  try {
    const current = () => captureGitCandidate({
      rootDir: input.rootDir,
      config: input.config,
      workspaceId: input.candidate.workspaceId,
      computeIdentity: withDeliverableIdentity(input.run === undefined ? {} : { run: input.run }),
      ...(input.run === undefined ? {} : { run: input.run }),
    });
    const before = await current();
    if (!before.ok) return { liveResults: [], blockers: before.blockers };
    if (candidateKey(before.candidate) !== candidateKey(input.candidate)) {
      return {
        liveResults: [],
        blockers: [refusal("live_provider_candidate_mismatch", "The provider workspace is not the candidate being verified.")],
      };
    }
    const wiring = await computeCheckWiringFingerprint(input.rootDir, input.config);
    const expectedWiring = digestCanonical({
      preparation: input.evidenceContext.preparationFingerprint,
      release: input.evidenceContext.release,
    });
    if (wiring !== expectedWiring) {
      return {
        liveResults: [],
        blockers: [refusal("live_provider_wiring_mismatch", "The provider workspace wiring or installed release differs from the candidate being verified.")],
      };
    }
    for (const [providerId, obligationIds] of requested) {
      if (input.signal?.aborted) {
        return { liveResults: [], blockers: [refusal("live_provider_cancelled", "Live verification was cancelled.")] };
      }
      const registration = input.config.providers.find(provider => provider.id === providerId);
      const command = registration?.command;
      // Missing registrations remain absent observations. The existing evaluator
      // decides whether that absence blocks this obligation's provider coverage.
      if (command === undefined) continue;
      const requestId = randomUUID();
      const result = await invokeProviderRail({
        providerId,
        requestId,
        idempotencyKey: randomUUID(),
        requiresEvidence: false,
        payload: {
          gateId: input.config.gateId,
          providerId,
          obligationIds: [...new Set(obligationIds)].sort(),
          candidate: before.candidate,
        },
      }, {
        // The provider's own declaration, as at the gate and record boundary.
        open: () => openProviderRailProcess({ command, cwd: input.rootDir, env: input.env,
          ...(registration?.inheritDescriptors ? { inheritDescriptors: registration.inheritDescriptors } : {}) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (result.kind === "success") {
        liveResults.push(result.liveResult);
      } else {
        blockers.push(...result.blockers);
        liveResults.push({ providerId, runId: result.runId, status: "failed", findings: [] });
      }
    }
    const after = await current();
    if (!after.ok) return { liveResults: [], blockers: [...blockers, ...after.blockers] };
    if (candidateKey(after.candidate) !== candidateKey(before.candidate) ||
        wiring !== await computeCheckWiringFingerprint(input.rootDir, input.config)) {
      return {
        liveResults: [],
        blockers: [...blockers, refusal(
          "live_provider_candidate_changed",
          "The candidate, base, policy wiring or installed release changed during live verification.",
        )],
      };
    }
    return { liveResults, blockers };
  } catch (error) {
    return {
      liveResults: [],
      blockers: error instanceof BlockedError ? error.blockers : [refusal(
        "live_provider_observation_failed",
        `Live verification could not capture trustworthy inputs: ${error instanceof Error ? error.message : String(error)}`,
      )],
    };
  }
}
