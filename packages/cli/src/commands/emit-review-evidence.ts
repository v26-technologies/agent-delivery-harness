import { readFile } from "node:fs/promises";
import path from "node:path";
import { commandBlocker, type CommandDescriptor } from "../boundary.ts";
import { emitReviewEvidence, OutcomeError } from "../review-evidence.ts";

export const emitReviewEvidenceCommand: CommandDescriptor = {
  capturesCandidate: true,
  name: "emit-review-evidence",
  sourceId: "delivery-harness.cli.emit-review-evidence",
  summary: "Bind concluded review outcomes to their original prepared context.",
  usage: "Usage: delivery-harness emit-review-evidence --context <review-context.json>\nReads a review-outcome/1 document on stdin.",
  async run(context) {
    if (context.args.length !== 2 || context.args[0] !== "--context" || !context.args[1] || context.args[1].startsWith("-")) {
      return { kind: "usage", message: "emit-review-evidence requires --context <review-context.json> and a review-outcome/1 document on stdin." };
    }
    let original: unknown;
    let document: unknown;
    try {
      original = JSON.parse(await readFile(path.resolve(context.rootDir, context.args[1]), "utf8"));
      const raw = await context.readStdin?.() ?? "";
      if (!raw.trim()) return { kind: "usage", message: "The review-outcome/1 document is required on stdin." };
      document = JSON.parse(raw);
    } catch {
      return { kind: "usage", message: "The original context and review outcome must be readable JSON documents." };
    }
    try {
      const result = await emitReviewEvidence(context, original, document);
      return { kind: "ok", summary: result.manifestPath };
    } catch (error) {
      if (!(error instanceof OutcomeError)) throw error;
      return { kind: "blocked", blockers: [commandBlocker({
        code: "review_outcome_invalid",
        sourceId: "delivery-harness.cli.emit-review-evidence",
        summary: error.message,
        remediations: [{ id: "supply-reviewed-context", kind: "manual_action", summary: "Use the original review-context --json output and concluded outcomes naming its digest; acquire a new review if the deliverable or review inputs changed." }],
      })] };
    }
  },
};
