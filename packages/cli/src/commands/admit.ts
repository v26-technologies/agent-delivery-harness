/**
 * `admit` — carry a concluded host review through the existing admission path.
 *
 * The command does not run reviewers and does not construct an approval. The
 * supplied review-outcome/1 document must already name the digest of the exact
 * review-context/1 document the current prepared candidate produces. Rebuilding
 * that deterministic context after preparation lets the existing emitter retain
 * it with the supplied outcome while refusing any candidate, base, policy,
 * wiring, release, or charter drift.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { commandBlocker, type CommandContext, type CommandDescriptor, type CommandResult } from "../boundary.ts";
import { emitReviewEvidence, OutcomeError } from "../review-evidence.ts";
import { gateCommand } from "./gate.ts";
import { prepareCommand } from "./prepare.ts";
import { recordCommand } from "./record.ts";
import { reviewContextCommand } from "./review-context.ts";
import { submitEvidenceCommand } from "./submit-evidence.ts";

const USAGE = [
  "Usage: delivery-harness admit --outcome <review-outcome.json>",
  "Prepares the candidate, binds the concluded outcome to its exact current review context, submits it, gates it, and writes the tracked record.",
  "The command never runs reviewers or commits the record.",
].join("\n");

function withArgs(context: CommandContext, args: readonly string[]): CommandContext {
  return { ...context, args };
}

function report(context: CommandContext, label: string, result: CommandResult): CommandResult | undefined {
  if (result.kind !== "ok") return result;
  if (result.summary !== undefined && result.summary !== "") context.write(`${label}: ${result.summary}`);
  return undefined;
}

function invalidOutcome(message: string): CommandResult {
  return {
    kind: "blocked",
    blockers: [commandBlocker({
      code: "review_outcome_invalid",
      sourceId: "delivery-harness.cli.admit",
      summary: message,
      remediations: [{
        id: "supply-reviewed-current-context",
        kind: "manual_action",
        summary: "Prepare the candidate, retain review-context --json before independent review, and supply the concluded outcome naming that exact digest.",
      }],
    })],
  };
}

export const admitCommand: CommandDescriptor = {
  capturesCandidate: true,
  name: "admit",
  sourceId: "delivery-harness.cli.admit",
  summary: "Prepare and admit a concluded review outcome through the tracked record write.",
  usage: USAGE,
  async run(context: CommandContext): Promise<CommandResult> {
    if (context.args.length !== 2 || context.args[0] !== "--outcome" || !context.args[1] || context.args[1].startsWith("-")) {
      return { kind: "usage", message: `admit requires --outcome <review-outcome.json>.\n${USAGE}` };
    }

    let outcome: unknown;
    try {
      outcome = JSON.parse(await readFile(path.resolve(context.rootDir, context.args[1]), "utf8"));
    } catch {
      return { kind: "usage", message: `The review outcome must be a readable JSON document.\n${USAGE}` };
    }

    const prepared = await prepareCommand.run(withArgs(context, []));
    const stoppedAfterPrepare = report(context, "prepared", prepared);
    if (stoppedAfterPrepare !== undefined) return stoppedAfterPrepare;

    const reviewed = await reviewContextCommand.run(withArgs(context, ["--json"]));
    if (reviewed.kind !== "ok") return reviewed;
    if (reviewed.summary === undefined) return invalidOutcome("the prepared candidate produced no review context");

    let originalContext: unknown;
    try {
      originalContext = JSON.parse(reviewed.summary);
    } catch {
      return invalidOutcome("the prepared candidate produced an unreadable review context");
    }

    let manifestPath: string;
    try {
      const emitted = await emitReviewEvidence(context, originalContext, outcome);
      manifestPath = emitted.manifestPath;
    } catch (error) {
      if (!(error instanceof OutcomeError)) throw error;
      return invalidOutcome(error.message);
    }
    context.write(`review evidence: ${manifestPath}`);

    const submitted = await submitEvidenceCommand.run(withArgs(context, ["--manifest", manifestPath]));
    const stoppedAfterSubmission = report(context, "submitted", submitted);
    if (stoppedAfterSubmission !== undefined) return stoppedAfterSubmission;

    const gated = await gateCommand.run(withArgs(context, []));
    const stoppedAfterGate = report(context, "gate", gated);
    if (stoppedAfterGate !== undefined) return stoppedAfterGate;

    return recordCommand.run(withArgs(context, []));
  },
};
