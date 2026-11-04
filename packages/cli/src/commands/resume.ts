import { classifyCandidateDrift, digestCanonical, evaluatePreparationReceipt, runAdmission, type CandidateBinding } from "@agent-delivery-harness/kernel";
import { installedRelease, policyDigest, reconciliationActions, recoveryBlocker, recoveryRun } from "../ordinary-context.ts";
import { focusedOutcome } from "../delivery-posture.ts";
import type { CommandDescriptor } from "../boundary.ts";

const USAGE = "Usage: delivery-harness resume [--run <run-id>]";

export const resumeCommand: CommandDescriptor = {
  name: "resume", sourceId: "delivery-harness.cli.resume",
  summary: "Read saved ordinary context and recheck evidence without executing or replaying work.",
  usage: USAGE,
  async run(context) {
    if (context.args.length !== 0 && (context.args.length !== 2 || context.args[0] !== "--run")) return { kind: "usage", message: USAGE };
    const focused = await focusedOutcome(context);
    if (focused !== undefined) return focused;
    const run = await recoveryRun(context.rootDir, context.args[1]);
    if (!run.ok) return { kind: "blocked", blockers: [run.blocker] };
    const saved = [...run.events].reverse().find(event => event.kind === "context.saved");
    if (!saved) return { kind: "blocked", blockers: [recoveryBlocker("resume_context_missing", "This run has no saved ordinary context. Recover the contract from its work item and save it explicitly.")] };
    const p = saved.payload;
    const actions = reconciliationActions(run.events);
    const blockers = actions.some(action => action.outcome === "unknown" || action.inconsistent)
      ? [recoveryBlocker("resume_action_unreconciled", "An external action has no consistent observed outcome. Reconcile its reference with host tools before any repeat.")] : [];
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    const drift: string[] = [];
    if (p["policyDigest"] !== policyDigest(context)) drift.push("policy_changed");
    try { if (digestCanonical(p["release"]) !== digestCanonical(await installedRelease(context.rootDir))) drift.push("release_changed"); }
    catch { drift.push("release_unreadable"); }
    if (capture.ok) {
      const binding = p["candidateBinding"] as Record<string, string>;
      const expected: CandidateBinding = { treeSha: saved.candidateTreeSha!, deliverable: { digest: binding["deliverableDigest"]!, identity: binding["identity"]! },
        base: { ref: binding["baseRef"]!, tipSha: binding["baseTipSha"]!, mergeBaseSha: binding["mergeBaseSha"]! }, workspaceId: binding["workspaceId"]! };
      drift.push(...classifyCandidateDrift(expected, capture.candidate));
      if (expected.deliverable.identity !== capture.candidate.deliverable.identity) drift.push("identity_changed");
      if (expected.base.ref !== capture.candidate.base.ref) drift.push("base_ref_changed");
    } else blockers.push(...capture.blockers);
    // Reuse the ordinary sensors, with no prompt, live-result injection, or
    // provider invocation. They read receipts/evidence; this journal grants nothing.
    const preparation = capture.ok ? await evaluatePreparationReceipt(context.rootDir, { config: context.config, candidate: capture.candidate }, wiring.storageOptions) : undefined;
    const admission = capture.ok ? await runAdmission({ rootDir: context.rootDir, config: context.config, context: context.classifyContext() },
      { captureCandidate: wiring.captureCandidate, projectActivation: wiring.projectActivation, ...wiring.storageOptions }) : undefined;
    if (capture.ok && admission?.candidate && classifyCandidateDrift(capture.candidate, admission.candidate).length > 0) drift.push("candidate_observation_changed");
    try { if (digestCanonical(p["release"]) !== digestCanonical(await installedRelease(context.rootDir)) && !drift.includes("release_changed")) drift.push("release_changed"); }
    catch { if (!drift.includes("release_unreadable")) drift.push("release_unreadable"); }
    if (admission) blockers.push(...admission.blockers);
    // Raw-tree movement alone is reported, but existing sensors decide whether
    // the change is neutral. No new identity or freshness rule is introduced.
    if (drift.some(item => item !== "raw_tree_changed")) blockers.push(recoveryBlocker("resume_context_stale", "Saved candidate, policy, or release bindings changed; revalidate the contract and affected work before saving fresh context."));
    const reuseAllowed = blockers.length === 0 && admission?.admitted === true;
    context.write(JSON.stringify({ spec: "ordinary-resume/1", runId: run.runId,
      observationOnly: true, automaticReplay: false, savedContext: p, actions, drift,
      preparation: preparation ?? { prepared: false }, admission: admission ?? { admitted: false }, reuseAllowed }));
    return blockers.length > 0 ? { kind: "blocked", blockers } : { kind: "ok" };
  },
};
