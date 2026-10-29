import { ScopedChecks } from "../scoped-checks.ts";
import { CheckSnapshotError } from "../check-snapshot.ts";
import { commandBlocker } from "../boundary.ts";
import { runDeclaredCheck } from "../declared-checks.ts";
/**
 * `gate` — evaluate the delivery gate and, under a TTY, offer a scoped waiver.
 *
 * The command classifies the execution context from this invocation's env and
 * TTY, then runs the admission adapter. The waiver prompt is the one piece of
 * interactive I/O the CLI owns: it is handed to admission only when the boundary
 * saw a real TTY (the boundary already gated `context.promptForWaiver` on that),
 * so a non-interactive run can never be prompted — it blocks. Admission itself
 * only ever offers a waiver to a `human` context, all-or-nothing over waivable
 * findings; the CLI adds no waiver logic of its own.
 */
import { computeDeliverableIdentity, runAdmission, type AdmissionResult, type Blocker, type LiveProviderResult } from "@agent-delivery-harness/kernel";
import { CliInterruption, type CommandContext, type CommandDescriptor, type CommandResult } from "../boundary.ts";
import { oneLine } from "../run-surface.ts";

const scopedCheckBlocker = (error: CheckSnapshotError): Blocker => commandBlocker({ code: error.code, sourceId: "delivery-harness.cli.gate", summary: error.message, remediations: [{ id: "repair-scoped-check", kind: "manual_action", summary: "Repair the declared scoped check or its execution profile and run the gate again." }] });

/**
 * Runs the ordinary admission first, invokes only configured providers that can
 * answer the resulting missing-evidence/live-result blocks, then re-evaluates
 * through the same admission adapter. Configs without provider commands take
 * the pre-existing path unchanged.
 */
async function providerAdmission(
  context: CommandContext,
  options: { readonly allowPrompt: boolean; readonly includeInjectedLiveResults: boolean },
  session?: ScopedChecks,
): Promise<AdmissionResult & { readonly observedLiveResults?: readonly LiveProviderResult[] }> {
  const admit = async (input: Parameters<typeof runAdmission>[0], options: Parameters<typeof runAdmission>[1]) => runAdmission(input, { ...options, ...(session ? { scopedPlan: await session.plan(), readOutput: session.readOutput } : {}) });
  if (session) {
    await session.fenceNonReusable(context.config.providers.filter(p => p.check?.scope).map(p => p.id));
  }
  const wiring = await context.wire();
  const admissionOptions = {
    captureCandidate: wiring.captureCandidate,
    projectActivation: wiring.projectActivation,
    ...wiring.storageOptions,
  };
  const input = {
    rootDir: context.rootDir,
    config: context.config,
    context: context.classifyContext(),
    ...(options.includeInjectedLiveResults && context.liveResults !== undefined ? { liveResults: context.liveResults } : {}),
  };
  const finalAdmissionOptions = {
    ...admissionOptions,
    ...(options.allowPrompt && context.promptForWaiver !== undefined ? { promptForWaiver: context.promptForWaiver } : {}),
  };

  if (!context.config.providers.some((provider) => provider.command !== undefined || provider.check !== undefined)) {
    return admit(input, finalAdmissionOptions);
  }

  const liveResults: LiveProviderResult[] = options.includeInjectedLiveResults ? [...(context.liveResults ?? [])] : [];
  const attempted = new Set<string>();
  const attemptBlockers: Blocker[] = [];
  let admission = await admit(input, admissionOptions);
  await session?.explainReuse((admission.decision?.resolutions ?? []).flatMap(r => r.kind === "satisfied_evidence" ? [r.providerId] : []));

  while (!admission.admitted && admission.decision !== undefined && admission.candidate !== undefined) {
    const requested = new Map<string, { obligationIds: string[]; requiresEvidence: boolean; needsLiveResult: boolean }>();
    for (const resolution of admission.decision.resolutions) {
      if (resolution.kind !== "blocked") continue;
      const obligation = context.config.obligations.find((entry) => entry.id === resolution.obligationId);
      if (obligation === undefined) continue;
      const missingCode = obligation.freshness === "live" ? "live_provider_missing" : "review_evidence_missing";
      for (const finding of resolution.providerFindings ?? []) {
        if (finding.code !== missingCode || finding.providerId === undefined || attempted.has(finding.providerId)) continue;
        const registration = context.config.providers.find((provider) => provider.id === finding.providerId);
        if (registration === undefined || (registration.command === undefined && registration.check === undefined) || !obligation.providers.includes(registration.id)) continue;
        if (registration.check !== undefined && (obligation.freshness !== "exact_candidate" || !obligation.acceptedPayloadSpecs.includes("checks.passed/1") || admission.decision.resolutions.some(resolution => resolution.kind !== "satisfied_evidence" && resolution.kind !== "not_applicable" && resolution.kind !== "waived" && context.config.obligations.find(entry => entry.id === resolution.obligationId)?.acceptedPayloadSpecs.includes("review.green/1")))) continue;
        const entry = requested.get(registration.id) ?? { obligationIds: [], requiresEvidence: false, needsLiveResult: false };
        entry.obligationIds.push(obligation.id);
        entry.requiresEvidence ||= obligation.freshness === "exact_candidate";
        entry.needsLiveResult ||= obligation.freshness === "live";
        requested.set(registration.id, entry);
      }
    }

    // A pool runs every requested scoped check at once; a single worker keeps the one-at-a-time loop below.
    const scoped = session !== undefined && session.concurrency > 1 ? [...requested].filter(([id]) => context.config.providers.find(p => p.id === id)!.check?.scope) : [];
    if (session !== undefined && scoped.length > 0) {
      for (const [id] of scoped) attempted.add(id);
      const failures = await session.executeAll(scoped.map(([id, request]) => ({ provider: context.config.providers.find(p => p.id === id)!, obligationIds: request.obligationIds })));
      attemptBlockers.push(...failures.map(scopedCheckBlocker));
      admission = await admit({ ...input, ...(liveResults.length === 0 ? {} : { liveResults }) }, admissionOptions);
      continue;
    }
    const next = requested.entries().next().value as
      | [string, { obligationIds: string[]; requiresEvidence: boolean; needsLiveResult: boolean }]
      | undefined;
    if (next === undefined) break;
    const [providerId, request] = next;
    attempted.add(providerId);
    const registration = context.config.providers.find(provider => provider.id === providerId)!;
    if (registration.check !== undefined) {
      if (registration.check.scope && session) {
        try { await session.execute(registration, request.obligationIds); }
        catch (error) {
          if (!(error instanceof CheckSnapshotError)) throw error;
          attemptBlockers.push(scopedCheckBlocker(error));
        }
      } else attemptBlockers.push(...await runDeclaredCheck(context, registration, request.obligationIds, admission.candidate, session ? { scopedPlan: await session.plan(), readOutput: session.readOutput } : {}));
      admission = await admit({ ...input, ...(liveResults.length === 0 ? {} : { liveResults }) }, admissionOptions);
      continue;
    }
    const result = await context.invokeProvider?.({
      providerId,
      requiresEvidence: request.requiresEvidence,
      payload: {
        gateId: context.config.gateId,
        providerId,
        obligationIds: [...new Set(request.obligationIds)].sort(),
        candidate: admission.candidate,
      },
    });
    if (result === undefined) continue;
    if (result.kind === "interrupted") throw new CliInterruption("Provider invocation interrupted before a trustworthy terminal outcome.");
    if (result.kind === "blocked") {
      attemptBlockers.push(...result.blockers);
      if (request.needsLiveResult) {
        liveResults.push({ providerId, runId: result.runId, status: "failed", findings: [] });
      }
    } else if (request.needsLiveResult) {
      liveResults.push(result.liveResult);
    }

    admission = await admit(
      { ...input, ...(liveResults.length === 0 ? {} : { liveResults }) },
      admissionOptions,
    );
  }

  if (admission.admitted) return { ...admission, observedLiveResults: liveResults };
  const final = await admit(
    { ...input, ...(liveResults.length === 0 ? {} : { liveResults }) },
    finalAdmissionOptions,
  );
  return attemptBlockers.length === 0 || final.admitted
    ? { ...final, observedLiveResults: liveResults }
    : { ...final, observedLiveResults: liveResults, blockers: [...attemptBlockers, ...final.blockers] };
}

export async function runProviderBackedAdmission(context: CommandContext, options: { readonly allowPrompt: boolean; readonly includeInjectedLiveResults: boolean }): Promise<AdmissionResult & { readonly observedLiveResults?: readonly LiveProviderResult[] }> {
  let session: ScopedChecks | undefined;
  try {
    if (context.config.providers.some(p => p.check?.scope)) {
      const capture = await (await context.wire()).captureCandidate();
      if (capture.ok) session = await ScopedChecks.create(context, capture.candidate);
    }
    return await providerAdmission(context, options, session);
  } finally { await session?.cleanup(); }
}

export const gateCommand: CommandDescriptor = {
  capturesCandidate: true,
  name: "gate",
  sourceId: "delivery-harness.cli.gate",
  summary: "Evaluate the delivery gate for the current candidate.",
  usage: "Usage: delivery-harness gate\nTakes no arguments; a waiver is offered only under a real TTY.",
  async run(context: CommandContext): Promise<CommandResult> {
    // Arguments before admission: `gate` accepts none, and a call it cannot
    // honour is answered about the call rather than performed approximately.
    const unexpected = context.args[0];
    if (unexpected !== undefined) {
      return { kind: "usage", message: `gate takes no arguments, and ${oneLine(unexpected, 64)} is one.\n${gateCommand.usage}` };
    }
    const result = await runProviderBackedAdmission(context, { allowPrompt: true, includeInjectedLiveResults: true });

    if (result.admitted) {
      const waiverNote =
        result.waiver === "accepted"
          ? ` (waived: ${result.waivedObligationIds.join(", ")})`
          : "";
      const kinds = (result.decision?.resolutions ?? []).map((resolution) => `${resolution.obligationId}=${resolution.kind}`);
      // This observation describes the admitted immutable tree. Failure to
      // observe it cannot change admission; the run journal is not evidence.
      let digest: string | undefined;
      if (result.candidate !== undefined) {
        try {
          digest = await computeDeliverableIdentity({ rootDir: context.rootDir, treeSha: result.candidate.treeSha,
            config: { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral } });
        } catch { /* Best-effort observability, like the completion append. */ }
      }
      return { kind: "ok", summary: `admitted${waiverNote}: ${kinds.join(", ")}`, ...(digest === undefined ? {} : { digest }) };
    }
    return { kind: "blocked", blockers: [...result.blockers] };
  },
};
