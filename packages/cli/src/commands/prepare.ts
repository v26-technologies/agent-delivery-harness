import { ScopedChecks } from "../scoped-checks.ts";
import { CheckSnapshotError } from "../check-snapshot.ts";
/**
 * `prepare` — capture the candidate and publish its preparation receipt.
 *
 * The receipt is the ordering mechanism: no receipt, no review context, no
 * admission. Capturing an unprepared tree (dirty or with untracked files) is a
 * typed block, not a silent skip.
 */
import {
  classifyCandidateDrift,
  computePreparationFingerprint,
  computeDeliverableIdentity,
  evaluatePreparationReceipt,
  createBlocker,
  createExecPort,
  invalidatePreparationReceipt,
  revokePreparationAttempt,
  publishPreparationReceipt,
  type RunPreparationObservation,
} from "@agent-delivery-harness/kernel";
import { CliInterruption, type CommandContext, type CommandDescriptor, type CommandResult } from "../boundary.ts";

const USAGE = "Usage: delivery-harness prepare [--refresh-record-neutral]";

export const prepareCommand: CommandDescriptor = {
  name: "prepare",
  sourceId: "delivery-harness.cli.prepare",
  summary: "Run preparation checks; --refresh-record-neutral permits proven artifact-only receipt refresh.",
  // The text prepare has always answered `--help` with, unchanged; the
  // boundary is what prints it now, for every command rather than this one.
  usage: `${USAGE}\nOrdinary prepare always runs mechanical checks. The refresh flag reuses prior success only when strict validation, policy, wiring and base are unchanged; otherwise it runs the checks.\nScoped mechanical checks run the first declared check first and the rest cheapest first by recorded duration, one dependency setup at a time, stopping at the first failure.`,
  async run(context: CommandContext): Promise<CommandResult> {
    if (context.args.length > 1 || (context.args.length === 1 && context.args[0] !== "--refresh-record-neutral")) {
      return { kind: "usage", message: USAGE };
    }
    if (context.config.providers.some(p => p.check?.scope) && !context.config.scopedExecution) throw new CheckSnapshotError("scoped_executor_required", "Scoped execution profiles are required before preparation commands may run.");
    let scoped: ScopedChecks | undefined;
    const refreshRecordNeutral = context.args[0] === "--refresh-record-neutral";
    const wiring = await context.wire();
    let retainedAttemptId: string | undefined;
    let ownedAttemptId: string | undefined;
    let refreshed = false;
    try {
      let capture: Awaited<ReturnType<typeof wiring.captureCandidate>>;
      // A refresh continues the successful attempt it evaluated. It cannot
      // transfer that success to new ownership after another attempt revokes it.
      let reusableFingerprint: string | undefined;
      let attemptId: string;
      try {
        capture = await wiring.captureCandidate();
        if (capture.ok && refreshRecordNeutral) {
          const previous = await evaluatePreparationReceipt(context.rootDir,
            { config: context.config, candidate: capture.candidate }, { ...wiring.storageOptions, allowValidationEquivalent: true });
          if (previous.prepared && previous.receipt.attemptId !== undefined) {
            reusableFingerprint = previous.receipt.preparationFingerprint;
            retainedAttemptId = previous.receipt.attemptId;
          }
        }
        if (retainedAttemptId === undefined && context.config.scopedExecution?.repairCommands?.length) {
          ownedAttemptId = await invalidatePreparationReceipt(context.rootDir, context.config, wiring.storageOptions);
          const beforeRepair = await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions);
          for (const repair of context.config.scopedExecution.repairCommands) {
            context.write(`repairing ${repair.id}`);
            const result = await createExecPort().run({ command: repair.command[0], args: repair.command.slice(1), cwd: context.rootDir,
              env: Object.fromEntries(Object.entries(context.env).filter((e): e is [string, string] => e[1] !== undefined)), timeoutMs: repair.timeoutMs, maxBuffer: 1024 * 1024, ...(context.signal ? { signal: context.signal } : {}) });
            if (context.signal?.aborted) throw new CliInterruption();
            if (result.code !== 0) throw new CheckSnapshotError("preparation_repair_failed", `Source repair ${repair.id} failed; fix it and prepare again.`);
          }
          if (beforeRepair !== await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions)) throw new CheckSnapshotError("preparation_candidate_changed", "Repair changed preparation wiring; reload the configuration and prepare again.");
          capture = await wiring.captureCandidate();
        }
      } finally {
        attemptId = retainedAttemptId ?? ownedAttemptId ?? await invalidatePreparationReceipt(context.rootDir, context.config, wiring.storageOptions);
        ownedAttemptId = attemptId;
      }
      if (!capture.ok) {
        return { kind: "blocked", blockers: [...capture.blockers] };
      }
      const fingerprint = await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions);
      const reusable = reusableFingerprint === fingerprint;
      const preparation: RunPreparationObservation = reusable
        ? { checks: "reused", reason: "validation-equivalent" }
        : { checks: "executed", reason: !refreshRecordNeutral ? "ordinary"
          : retainedAttemptId === undefined ? "receipt-not-reusable" : "preparation-fingerprint-changed" };
      if (!reusable && retainedAttemptId !== undefined) {
        attemptId = await invalidatePreparationReceipt(context.rootDir, context.config, wiring.storageOptions);
        ownedAttemptId = attemptId;
        retainedAttemptId = undefined;
      }
      let validationDigest = await computeDeliverableIdentity({ rootDir: context.rootDir, treeSha: capture.candidate.treeSha,
        config: { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral } });
      if (reusable) context.write("reusing preparation checks: strict validation projection, base, policy and wiring unchanged");
      const exec = createExecPort();
      const env = Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      for (const check of reusable ? [] : context.config.preparationCommands ?? []) {
        context.write(`preparing ${check.id}`);
        const result = await exec.run({
          command: check.command[0], args: check.command.slice(1), cwd: context.rootDir,
          env, timeoutMs: check.timeoutMs, maxBuffer: 1024 * 1024,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        if (result.code !== 0 || context.signal?.aborted) {
          return {
            kind: "blocked",
            blockers: [createBlocker({
              code: "preparation_command_failed", source: { kind: "command", id: "delivery-harness.cli.prepare" },
              summary: `Preparation check ${check.id} failed; no receipt was published.`,
              details: `exit ${result.code}${result.errorCode === undefined ? "" : ` (${result.errorCode})`}\n${`${result.stdout}\n${result.stderr}`.slice(-4000)}`,
              remediations: [{ id: "repair-preparation-check", kind: "manual_action", summary: `Fix ${check.id}, then run prepare again.` }],
            })],
          };
        }
      }
      if (context.signal?.aborted) throw new CliInterruption();
      const finalCapture = await wiring.captureCandidate();
      if (!finalCapture.ok) return { kind: "blocked", blockers: [...finalCapture.blockers] };
      const after = finalCapture.candidate;
      if (classifyCandidateDrift(capture.candidate, after).length > 0 ||
          capture.candidate.headSha !== after.headSha || capture.candidate.mode !== after.mode ||
          fingerprint !== await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions)) {
        return {
          kind: "blocked",
          blockers: [createBlocker({
            code: "preparation_candidate_changed", source: { kind: "command", id: "delivery-harness.cli.prepare" },
            summary: "The candidate, base, or preparation wiring changed while checks ran; no receipt was published.",
            remediations: [{ id: "prepare-stable-candidate", kind: "manual_action", summary: "Commit any intended changes and prepare the stable candidate again." }],
          })],
        };
      }
      if (context.config.scopedExecution) {
        capture = finalCapture;
        validationDigest = await computeDeliverableIdentity({ rootDir: context.rootDir, treeSha: capture.candidate.treeSha, config: { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral } });
        scoped = await ScopedChecks.create(context, capture.candidate);
        await scoped?.satisfyMechanical();
      }
      const published = await publishPreparationReceipt(
        context.rootDir,
        { config: context.config, candidate: capture.candidate, attemptId, validationDigest },
        wiring.storageOptions,
      );
      if (context.signal?.aborted) throw new CliInterruption();
      await scoped?.submitMechanical();
      await scoped?.cleanup();
      refreshed = true;
      // The labelled line exists so a reader — an operator or a review round
      // about to bind itself to this candidate — has one unambiguous token to
      // copy. It is the same value the record carries as `treeSha` and the same
      // value `review-context` reports as `candidate tree`.
      return {
        kind: "ok",
        preparation,
        summary: [
          `prepared ${context.config.gateId}: tree ${capture.candidate.treeSha} (${capture.candidate.mode}); receipt ${published.path}`,
          `  treeSha ${capture.candidate.treeSha}`,
        ].join("\n"),
      };
    } finally {
      try { await scoped?.cleanup(); }
      finally {
        if (ownedAttemptId !== undefined && !refreshed) await revokePreparationAttempt(context.rootDir, context.config, ownedAttemptId, wiring.storageOptions);
      }
    }
  },
};
