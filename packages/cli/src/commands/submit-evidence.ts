/**
 * `submit-evidence` — validate a provider manifest and publish per-claim records.
 *
 * A thin caller over the recorder: the SUB rules, the run-root containment and
 * artifact digest checks, and the record writes all live in the kernel. The
 * command's only jobs are to find the manifest path in argv and to map the three
 * submission outcomes onto exit codes. Rejections and blocks both surface their
 * typed blockers; an acceptance reports the digest and the records it wrote.
 */
import { submitManifest } from "@agent-delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";
import { oneLine } from "../run-surface.ts";
import { ScopedChecks } from "../scoped-checks.ts";

function manifestPathsFrom(args: readonly string[]): string[] | undefined {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--manifest") {
      const value = args[++index];
      if (value === undefined || value === "") return undefined;
      paths.push(value);
    } else if (!token.startsWith("-")) paths.push(token);
  }
  return paths;
}

/**
 * The one flag this command has, and everything else that looks like a flag.
 * `--manifest`'s VALUE is skipped rather than scanned, so a path that happens
 * to begin with a hyphen is still that flag's value and not an unknown flag —
 * rejecting legitimate arguments generically is the failure mode this guard
 * has to avoid while it closes the silently-ignored one.
 */
function unknownFlagIn(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--manifest") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return token;
  }
  return undefined;
}

export const submitEvidenceCommand: CommandDescriptor = {
  capturesCandidate: true,
  name: "submit-evidence",
  sourceId: "delivery-harness.cli.submit-evidence",
  summary: "Validate a provider manifest and publish its evidence records.",
  usage: "Usage: delivery-harness submit-evidence --manifest <path>",
  async run(context: CommandContext): Promise<CommandResult> {
    // An unrecognized flag is refused before the manifest is looked for, so a
    // mistyped flag can never be ignored into a positional read of the argv.
    const unknown = unknownFlagIn(context.args);
    if (unknown !== undefined) {
      return { kind: "usage", message: `Unknown flag ${oneLine(unknown, 64)}.\n${submitEvidenceCommand.usage}` };
    }
    const paths = manifestPathsFrom(context.args);
    if (paths === undefined) {
      return { kind: "usage", message: "submit-evidence requires --manifest <path>." };
    }
    if (paths.length > 1) {
      return { kind: "usage", message: `submit-evidence requires one manifest path; received ${paths.map(value => oneLine(value, 256)).join(", ")}.` };
    }
    const manifestPath = paths[0];
    if (manifestPath === undefined || manifestPath === "") {
      return { kind: "usage", message: "submit-evidence requires --manifest <path>." };
    }

    const wiring = await context.wire();
    // Scoped check bindings are captured for every manifest, so a scoped
    // provider needs the plan rebuilt for the current candidate and base, as
    // the gate builds it. The kernel still refuses a plan that is not current.
    let session: ScopedChecks | undefined;
    let outcome: Awaited<ReturnType<typeof submitManifest>>;
    try {
      if (context.config.providers.some(p => p.check?.scope)) {
        const capture = await wiring.captureCandidate();
        if (capture.ok) session = await ScopedChecks.create(context, capture.candidate);
      }
      outcome = await submitManifest(
        { rootDir: context.rootDir, manifestPath, config: context.config },
        { captureCandidate: wiring.captureCandidate, artifacts: context.artifacts, ...wiring.storageOptions,
          ...(session ? { scopedPlan: await session.plan(), readOutput: session.readOutput } : {}) },
      );
    } finally { await session?.cleanup(); }

    if (outcome.status === "accepted") {
      const lines = outcome.records.map(
        (record) => `  ${record.obligationId}: ${record.status} ${record.recordId}`,
      );
      return {
        kind: "ok",
        summary: [`accepted (manifestDigest ${outcome.manifestDigest}):`, ...lines].join("\n"),
      };
    }
    return { kind: "blocked", blockers: [...outcome.blockers] };
  },
};
