/**
 * `record` — promote an admitted gate into the tracked delivery record.
 *
 * The record is the one artifact that crosses out of the git-private workspace
 * into the tracked tree. The command runs the gate, refuses unless it admitted,
 * and refuses again if the deliverable identity moved between the gate and the
 * write — a record must describe the candidate it attests, so a re-capture
 * adjacent to the write is what makes "record after an edit" a refusal rather
 * than a lie. The record object and its bytes are produced by the kernel
 * (`delivery-record.ts`, produce-only); the single write goes through the fs
 * port, and the candidate-keyed path keeps parallel branches from colliding
 * while staying exactly recomputable by the Action.
 */
import {
  buildDeliveryRecord,
  candidateTreeEvidenceReader,
  computePreparationFingerprint, capturePortableEvidenceContext, repositoryEvidenceReader, capturePortableVerificationInputs, verifyDeliveryRecord,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  discoverRecords,
  type EvidenceRecord,
  readCompiledRepositoryPolicy,
} from "@agent-delivery-harness/kernel";
import path from "node:path";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";
import { oneLine, resolveRunSpan } from "../run-surface.ts";
import { applyDeliveryRecordRetention } from "../record-retention.ts";
import { runProviderBackedAdmission } from "./gate.ts";

interface RetentionOptions {
  readonly scope: string;
  readonly keepSuperseded: number;
}

function parseRetentionOptions(args: readonly string[]): RetentionOptions | undefined | string {
  if (args.length === 0) return undefined;
  let scope: string | undefined;
  let keepSuperseded: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) return `${flag ?? "record option"} requires a value`;
    if (flag === "--retention-scope" && scope === undefined) scope = value;
    else if (flag === "--keep-superseded" && keepSuperseded === undefined) {
      if (!/^\d+$/.test(value)) return "--keep-superseded must be an integer from 0 through 100";
      keepSuperseded = Number(value);
    } else return `${oneLine(flag ?? "record option", 64)} is not a valid record retention option`;
  }
  if (scope === undefined || keepSuperseded === undefined) {
    return "--retention-scope and --keep-superseded must be supplied together";
  }
  if (!Number.isSafeInteger(keepSuperseded) || keepSuperseded > 100) {
    return "--keep-superseded must be an integer from 0 through 100";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope)) {
    return "--retention-scope must be a plain 1-128 character delivery key";
  }
  return { scope, keepSuperseded };
}

export const recordCommand: CommandDescriptor = {
  capturesCandidate: true,
  name: "record",
  sourceId: "delivery-harness.cli.record",
  summary: "Write the tracked delivery record for an admitted gate.",
  usage: "Usage: delivery-harness record [--retention-scope <delivery-key> --keep-superseded <0-100>]\nRetention is opt-in; run gate first if a waiver is needed.",
  async run(context: CommandContext): Promise<CommandResult> {
    const observedAt = `${new Date().toISOString().slice(0, 19)}Z`;
    // Arguments before anything is wired, admitted, or written.
    const retention = parseRetentionOptions(context.args);
    if (typeof retention === "string") {
      return { kind: "usage", message: `${retention}.\n${recordCommand.usage}` };
    }
    const wiring = await context.wire();

    // The gate is run without a prompt: `record` is not the waiver surface. If a
    // waiver is needed, the operator runs `gate` first; here a non-admitting gate
    // is simply a refusal.
    const admission = await runProviderBackedAdmission(context, { allowPrompt: false, includeInjectedLiveResults: false });
    if (!admission.admitted || admission.decision === undefined) {
      return { kind: "blocked", blockers: [...admission.blockers] };
    }
    const decision = admission.decision;

    // Refuse when the gate result no longer describes the current deliverable
    // identity: a re-capture adjacent to the write.
    const recheck = await wiring.captureCandidate();
    if (!recheck.ok) {
      return { kind: "blocked", blockers: [...recheck.blockers] };
    }
    if (recheck.candidate.deliverable.digest !== decision.candidate.deliverable.digest) {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "record_identity_changed",
            sourceId: "delivery-harness.cli.record",
            summary: "The deliverable identity changed after the gate; nothing was recorded.",
            details: `gate ${decision.candidate.deliverable.digest} but current ${recheck.candidate.deliverable.digest}`,
            remediations: [
              {
                id: "reprepare-and-record",
                kind: "command",
                command: ["delivery-harness", "prepare"],
                summary: "Re-prepare the candidate and re-run the gate before recording.",
              },
            ],
          }),
        ],
      };
    }

    // Gather the evidence records backing the decision so each evidence claim can
    // be stamped with its manifest digest.
    const evidenceRecords: EvidenceRecord[] = [];
    for (const obligation of context.config.obligations) {
      const discovery = await discoverRecords(context.rootDir, {
        gateId: context.config.gateId,
        obligationId: obligation.id,
        ...wiring.storageOptions,
      });
      evidenceRecords.push(...discovery.records);
    }

    const evidenceReader = repositoryEvidenceReader(context.rootDir, context.artifacts);
    const evidenceContext = await capturePortableEvidenceContext(context.config, evidenceReader,
      await computePreparationFingerprint(context.rootDir, context.config), recheck.candidate.deliverable.digest);
    const compiledPolicy = context.policyBinding?.compiledPolicy ??
      await readCompiledRepositoryPolicy(await candidateTreeEvidenceReader(context.rootDir, recheck.candidate.treeSha));
    // The delivery's own span, read off the run journal rather than off a
    // clock: `startedAt` is the journal's first instant and `endedAt` the last
    // it had reached by this write, which is the time this delivery had spent
    // when it recorded. A delivery with no journal records exactly as it always
    // did — the member is simply absent — because the record is evidence about
    // a candidate and this is a cycle-time reading beside it, never a condition
    // on writing one.
    const runSpan = await resolveRunSpan({ cwd: context.rootDir, treeSha: recheck.candidate.treeSha, allowCurrentRun: true });
    const built = buildDeliveryRecord({ config: context.config, decision, evidenceRecords, context: evidenceContext,
      ...(runSpan === undefined ? {} : { runSpan: { startedAt: runSpan.startedAt, endedAt: runSpan.endedAt } }),
      ...(compiledPolicy === null ? {} : { compiledPolicy, observedAt }) });
    if (!built.ok) {
      return { kind: "blocked", blockers: [...built.blockers] };
    }

    const verificationInputs = await capturePortableVerificationInputs(context.rootDir, context.config, recheck.candidate, built.record);
    const checked = verifyDeliveryRecord(context.config, built.record,
      { deliverableDigest: recheck.candidate.deliverable.digest, identityToken: recheck.candidate.deliverable.identity }, recheck.candidate.base,
      { ...verificationInputs, observedAt, liveResults: admission.observedLiveResults ?? [], executionContext: context.classifyContext() });
    if (!checked.ok) return { kind: "blocked", blockers: [...checked.blockers] };
    const relativePath = deliveryRecordPathFor(context.config, decision.candidate.deliverable.digest);
    const absolutePath = path.join(context.rootDir, relativePath);
    const bytes = deliveryRecordBytes(built.record);
    if (retention === undefined) {
      await context.artifacts.writeTextFile(absolutePath, bytes);
      return { kind: "ok", summary: `recorded ${relativePath}` };
    }

    const retained = await applyDeliveryRecordRetention({
      rootDir: context.rootDir,
      storageNamespace: context.config.storageNamespace,
      scope: retention.scope,
      keepSuperseded: retention.keepSuperseded,
      recordBasePath: context.config.deliveryRecordPath,
      current: {
        relativePath,
        deliverableDigest: decision.candidate.deliverable.digest,
        bytes,
      },
      writeCurrent: () => context.artifacts.writeTextFile(absolutePath, bytes),
    });
    if (!retained.ok) {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: retained.code,
            sourceId: "delivery-harness.cli.record",
            summary: "Tracked delivery-record retention did not complete.",
            details: retained.detail,
            remediations: [
              {
                id: "repair-record-retention",
                kind: "manual_action",
                summary: "Preserve the exact owned record bytes in Git, repair the named ownership conflict, then retry record with the same scope and bound.",
              },
            ],
          }),
        ],
      };
    }

    return {
      kind: "ok",
      summary: `recorded ${relativePath}${retained.pruned.length === 0 ? "" : `; pruned Git-preserved ${retained.pruned.join(", ")}`}`,
    };
  },
};
