/**
 * `verify` — recompute the deliverable identity and check the tracked record.
 *
 * The command captures the current candidate, derives the candidate-keyed record
 * path from the recomputed deliverable identity (the same exact lookup the
 * Action performs from the PR head), reads and parses the record, and hands it to
 * the pure `verifyDeliveryRecord` core. A missing record names the command that
 * writes it; a failed check surfaces the named drift class. When the base-movement
 * policy is `allow`, a passing check that relaxed base drift names the relaxation.
 *
 * THE RUN-JOURNAL ROW, AND WHY IT IS LOCAL ONLY. `verify` is the one caller
 * that holds both halves of the question "was this candidate journaled": a
 * record binding an exact tree sha, and a repository whose run store it can
 * scan for a journal bound to the same one. So it resolves the row and reports
 * it — and reporting is all it does by default. The row changes no exit code
 * unless the operator asks for that with `--require-run-journal`, a LOCAL
 * opt-in: it is not passed by the GitHub Action, not read by the gate, and not
 * consulted by admission. A run journal is self-attested observability that
 * anything the owner executes can append to, so a delivery that could be
 * admitted or refused on one would be resting its gate on a file its own
 * candidate scripts can write.
 *
 * `--mandated-lens <id>` is the second half of the same opt-in: supplied, the
 * evaluator checks the journal's declared mandated pair against these ids
 * rather than merely checking that it declared two non-empty ones. Repeatable,
 * separate-argument form, and bounded to the run family's own id charset before
 * it reaches the kernel.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_RUN_PROVIDER_ID,
  RUN_PROVIDER_ID,
  deliveryRecordPathFor,
  needsCommittedSymlinkTarget,
  parseCandidateTreeListing,
  parseDeliveryRecord,
  runGitCommand,
  verifyDeliveryRecord,
  capturePortableVerificationInputs,
  collectLiveProviderResults,
  type CandidateTreeEntry,
  type RunJournalRow,
} from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";
import { RUN_JOURNAL_ADMISSION_ROW, oneLine, resolveRunJournalRow, resolveRunSpan, runJournalRows } from "../run-surface.ts";
import { durationLabel } from "../run-projection.ts";

const USAGE = "Usage: delivery-harness verify [--require-run-journal] [--mandated-lens <id>]...";

interface ParsedArgs {
  readonly requireRunJournal: boolean;
  readonly mandatedLensIds: readonly string[];
}

type ArgParse = { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly message: string };

/**
 * The separate-argument form every other command's flags take: `--flag value`,
 * never `--flag=value`. The joined form is not silently split, because a
 * `--mandated-lens=x` that quietly worked here and nowhere else would be a
 * second grammar for the same CLI. It falls through to the unknown-flag arm,
 * which is a usage error naming the token.
 */
function parseArgs(args: readonly string[]): ArgParse {
  let requireRunJournal = false;
  const mandatedLensIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--require-run-journal") {
      requireRunJournal = true;
      continue;
    }
    if (token === "--mandated-lens") {
      const value = args[index + 1];
      if (value === undefined) return { ok: false, message: `${token} needs a value.\n${USAGE}` };
      // Bounded before the kernel sees it: an id is compared against journal
      // content, and an unbounded one would be echoed into the row it produces.
      if (value.length > MAX_RUN_PROVIDER_ID || !RUN_PROVIDER_ID.test(value)) {
        return { ok: false, message: `${token} takes a bounded lens id, not ${oneLine(value, 64)}.\n${USAGE}` };
      }
      mandatedLensIds.push(value);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.\n${USAGE}` };
    return { ok: false, message: `verify takes no positional arguments, and ${oneLine(token, 64)} is one.\n${USAGE}` };
  }
  return { ok: true, args: { requireRunJournal, mandatedLensIds } };
}

/**
 * The opt-in's refusal. It names the status, the missing entries, and the
 * violated constraints, all of them product-defined names from the evaluator's
 * two closed sets — never journal-derived text.
 */
function runJournalBlocker(row: RunJournalRow) {
  const missing = row.missing.length === 0 ? "(none)" : row.missing.join(", ");
  const violations = row.violations === undefined || row.violations.length === 0 ? "(none)" : row.violations.join(", ");
  // The same per-violation reasons the row prints. A refusal that named only
  // the identifiers would make the operator run the command again with the
  // flag dropped just to read why.
  //
  // EVERYTHING THE REMEDIATION NAMES COMES FIRST, BECAUSE A DETAIL IS CUT FROM
  // THE END. A blocker's detail reaches a terminal through `renderBlockers`,
  // which bounds it at 600 characters, so a journal with several warnings
  // pushes whatever is last off the end. Two things must never be the
  // casualty: the line saying none of this blocks admission, because a
  // truncated list of violated constraints with no such line reads as a
  // verdict; and the `missing:` list, because the remediation tells the
  // operator to emit the run events this delivery did not journal and that
  // list is the only place this refusal says which ones. So the identifiers,
  // the missing list and the admission sentence all precede the per-warning
  // reasons, which are the right thing to lose to the cap — the row on stdout,
  // which is written line by line and is not bounded this way, always carries
  // all of them. Inside a warning's own segment the `(a consequence of …)`
  // clause goes before the reason for the same arithmetic: the reason is the
  // long part, so a clause written after it is the first thing the cap
  // destroys. With the clause after the reason it vanished from the
  // reproduction shape once the run id reached 36 characters, and `runId` is
  // accepted up to 128; with it before, it survives at every run id length
  // through 128, as do the missing list and the admission sentence. Two
  // warnings that restate one fact, printed as peers with nothing saying so,
  // are the exact misreading this row exists to prevent.
  //
  // Do not read the 120 as making the whole detail fit. It never does on a
  // journal with more than one warning: the reproduction's two render 733
  // characters at this bound (753 at 130, 813 at 160, and 1045 at 400 and at
  // every larger bound — the longer of its two reasons is 315 characters, so
  // nothing above that is binding) against a 600-character cut, and the later
  // warnings' reasons are lost at every one of them — that is what the
  // unbounded stdout row is for.
  //
  // What 120 buys is narrower than it looks, and the narrowness is the point,
  // because two earlier rounds of this delivery each shipped a confident and
  // wrong statement about this budget. Measured on the reproduction's two
  // warnings at the run id this store actually mints (`run-` + 16 hex = 20
  // characters), the second warning's identifier begins inside the cut — as
  // `round-not-bou…`, 13 of its 25 characters — and at 121 and above it does
  // not. That is the whole of it. The margin is one character: at a 21-
  // character run id, which `isLegalRunId` admits up to 128, it is already
  // gone, and a journal carrying a third warning loses the later segments
  // whatever the bound is. What a larger bound costs is a later warning's own
  // SEGMENT, never its name: the `violations:` list and any `(a consequence
  // of …)` clause naming it are ahead of the cut and survive regardless.
  const why = (row.explanations ?? []).map(
    (explanation) =>
      `; ${oneLine(explanation.violation, 64)}${explanation.consequenceOf === undefined ? "" : ` (a consequence of ${oneLine(explanation.consequenceOf, 64)})`}: ${oneLine(explanation.because, 120)}`,
  ).join("");
  return commandBlocker({
    code: "run_journal_incomplete",
    sourceId: "delivery-harness.cli.verify",
    summary: "The run journal for this candidate is not complete, and --require-run-journal was given.",
    details: `status ${row.status}${row.runId === undefined ? "" : ` (run ${oneLine(row.runId, 128)})`}; violations: ${violations}; missing: ${missing}; ${RUN_JOURNAL_ADMISSION_ROW}${why}`,
    remediations: [
      {
        id: "emit-the-missing-run-events",
        kind: "manual_action",
        summary: "Emit the run events this delivery did not journal, or drop --require-run-journal: the row is observability, not evidence.",
      },
    ],
  });
}

/**
 * The record's own span, checked against the journal that binds its candidate.
 *
 * WHAT IS CHECKED, AND WHY THOSE TWO THINGS. `startedAt` must EQUAL the
 * journal's first instant: a journal is append-only, so its first event never
 * moves and a record that disagrees about when the delivery began is describing
 * some other run. `endedAt` must lie inside the journal's span, because the
 * journal keeps growing after the record is written — `verify`, `pr.opened` and
 * `run.ended` all land later — so equality there would fail on every honest
 * record, while an `endedAt` after the journal's last instant or before its
 * first could not have been read off it at all.
 *
 * WHY A MISS IS NOT A REFUSAL. A journal is self-attested observability that
 * anything the owner executes can append to, and this command runs in CI over
 * checkouts that carry no run store whatever. So the refusal is available only
 * where a journal BINDS this record's candidate — never on whichever run is
 * current in the checkout someone verified from, and never as a demand that a
 * journal exist. Where none binds it the span is reported unchecked, which is
 * what `verify` could honestly say before this member existed too.
 */
async function runSpanRows(
  rootDir: string,
  record: { readonly runSpan?: { readonly startedAt: string; readonly endedAt: string }; readonly candidateBinding: { readonly treeSha: string } },
): Promise<{ readonly rows: readonly string[]; readonly blocker?: ReturnType<typeof commandBlocker> }> {
  const span = record.runSpan;
  if (span === undefined) return { rows: [] };
  const spent = (Date.parse(span.endedAt) - Date.parse(span.startedAt)) / 1000;
  const recorded = `recorded run span: ${span.startedAt} to ${span.endedAt} (${durationLabel(spent)})`;
  // `preferStartedAt` is what keeps a SECOND run in the same worktree — the one
  // this verify is itself running under, say — from refusing a record whose own
  // run reports exactly this span. A refusal stands only where no journal
  // binding this candidate starts where the record says it did.
  const journal = await resolveRunSpan({
    cwd: rootDir,
    treeSha: record.candidateBinding.treeSha,
    preferStartedAt: span.startedAt,
  });
  if (journal === undefined) {
    return { rows: [`${recorded}; unchecked: no run journal in this repository binds this candidate`] };
  }
  const disagreement =
    span.startedAt !== journal.startedAt
      ? `the record starts at ${span.startedAt} but run ${oneLine(journal.runId, 128)} starts at ${journal.startedAt}`
      : span.endedAt > journal.endedAt
        ? `the record ends at ${span.endedAt}, after the last instant run ${oneLine(journal.runId, 128)} reached (${journal.endedAt})`
        : undefined;
  if (disagreement === undefined) {
    return { rows: [`${recorded}; checked against run ${oneLine(journal.runId, 128)}`] };
  }
  return {
    rows: [],
    blocker: commandBlocker({
      code: "record_run_span_mismatch",
      sourceId: "delivery-harness.cli.verify",
      summary: "The delivery record's run span disagrees with the run journal that binds its candidate.",
      details: disagreement,
      remediations: [
        {
          id: "re-record-the-span",
          kind: "command",
          command: ["delivery-harness", "record"],
          summary: "Re-record this candidate so its span is the one its own run journal reports.",
        },
      ],
    }),
  };
}

export const verifyCommand: CommandDescriptor = {
  capturesCandidate: true,
  name: "verify",
  sourceId: "delivery-harness.cli.verify",
  summary: "Verify the tracked delivery record against the current candidate.",
  usage: USAGE,
  async run(context: CommandContext): Promise<CommandResult> {
    const observedAt = `${new Date().toISOString().slice(0, 19)}Z`;
    // Arguments first: a malformed invocation is a usage error and captures
    // nothing, exactly as `emit` and `submit-evidence` order it.
    const parsedArgs = parseArgs(context.args);
    if (!parsedArgs.ok) return { kind: "usage", message: parsedArgs.message };

    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const identity = {
      deliverableDigest: capture.candidate.deliverable.digest,
      identityToken: capture.candidate.deliverable.identity,
    };
    const base = {
      ref: capture.candidate.base.ref,
      tipSha: capture.candidate.base.tipSha,
      mergeBaseSha: capture.candidate.base.mergeBaseSha,
    };

    const relativePath = deliveryRecordPathFor(context.config, identity.deliverableDigest);
    const absolutePath = path.join(context.rootDir, relativePath);

    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "delivery_record_missing",
            sourceId: "delivery-harness.cli.verify",
            summary: "No delivery record describes the current candidate.",
            details: `expected ${relativePath}`,
            remediations: [
              {
                id: "run-record",
                kind: "command",
                command: ["delivery-harness", "record"],
                summary: "Record the admitted gate for this candidate.",
              },
            ],
          }),
        ],
      };
    }

    const parsed = parseDeliveryRecord(text);
    if (!parsed.ok) {
      return { kind: "blocked", blockers: [...parsed.blockers] };
    }

    // The tracked tree's own entries, so this command rejects a candidate
    // carrying a projection or discovery-configuration path exactly as the
    // Action does. An unreadable listing supplies no entries rather than a
    // false clean bill: the check simply does not run.
    //
    // Mode and object, not just the name: the one admitted exception under
    // `.claude/skills/` turns on the entry being a symlink and on where its
    // committed target resolves, and both facts live in the tree.
    const listing = await runGitCommand(["git", "ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
      cwd: context.rootDir,
    });
    const candidateTreePaths: CandidateTreeEntry[] = [];
    if (listing.exitCode === 0) {
      for (const entry of parseCandidateTreeListing(listing.stdout)) {
        if (!needsCommittedSymlinkTarget(entry)) {
          candidateTreePaths.push(entry);
          continue;
        }
        // The target read out of the committed blob, never off the filesystem:
        // the working tree's link may differ from the one under review. A blob
        // that will not read leaves the target absent, and an entry with no
        // target cannot reach the exception.
        const blob = await runGitCommand(["git", "cat-file", "blob", entry.objectSha], { cwd: context.rootDir });
        candidateTreePaths.push(blob.exitCode === 0 ? { ...entry, symlinkTarget: blob.stdout } : entry);
      }
    }

    const inputs = await capturePortableVerificationInputs(context.rootDir, context.config, capture.candidate, parsed.record);
    const live = await collectLiveProviderResults({rootDir:context.rootDir,config:context.config,candidate:capture.candidate,
      projection:inputs.projection,evidenceContext:inputs.evidenceContext,env:context.env,...(context.signal===undefined?{}:{signal:context.signal})});
    // Verify the portable record before letting any retained projection widen
    // the observational tree coordinates. Corrupt or invented projection bytes
    // therefore fail as record evidence and never influence journal matching.
    const verified = verifyDeliveryRecord(context.config, parsed.record, identity, base,
      { candidateTreePaths, ...inputs, observedAt, liveResults:live.liveResults, executionContext: context.classifyContext() });
    if (!verified.ok) {
      return { kind: "blocked", blockers: [...live.blockers, ...verified.blockers] };
    }

    // The record tree remains the primary coordinate. A product-validated
    // review-neutral projection may additionally name the earlier raw tree the
    // reviewers actually read; the journal stays observational either way.
    const runJournal = await resolveRunJournalRow({
      cwd: context.rootDir,
      treeSha: parsed.record.candidateBinding.treeSha,
      reviewedCandidateTreeShas: verified.reviewedCandidateTreeShas,
      ...(parsedArgs.args.mandatedLensIds.length === 0 ? {} : { mandatedLensIds: parsedArgs.args.mandatedLensIds }),
    });
    const check = verifyDeliveryRecord(context.config, parsed.record, identity, base,
      { candidateTreePaths, runJournal, ...inputs, observedAt, liveResults:live.liveResults, executionContext: context.classifyContext() });

    // The opt-in is judged AFTER the record's own verification, so a delivery
    // whose record is bad is never told its journal is the problem.
    if (parsedArgs.args.requireRunJournal && runJournal.status !== "complete") {
      return { kind: "blocked", blockers: [runJournalBlocker(runJournal)] };
    }

    // Judged in the same place and for the same reason: a record that fails its
    // own verification is never told its span is the problem.
    const span = await runSpanRows(context.rootDir, parsed.record);
    if (span.blocker !== undefined) return { kind: "blocked", blockers: [span.blocker] };

    const relaxation = check.baseMovementRelaxed
      ? ` (base movement relaxed by policy: ${check.relaxedDriftClasses.join(", ")})`
      : "";
    const exemption = check.hostedChecks.exemption;
    const hostedCheckRow = exemption === undefined ? [] : [
      `hosted checks: exempted for ${oneLine(exemption.scope.repositoryId, 128)} at ${oneLine(exemption.scope.baseRef, 256)}; granted by ${oneLine(exemption.grantedBy, 256)}; until ${exemption.until}; reason: ${oneLine(exemption.reason, 512)}`,
    ];
    return {
      kind: "ok",
      summary: [
        `verified ${relativePath}${relaxation}; attestation: ${check.attestationLabel}`,
        `recorded base: ${oneLine(parsed.record.candidateBinding.baseRef, 256)} at ${parsed.record.candidateBinding.baseTipSha}`,
        `observed base: ${oneLine(base.ref, 256)} at ${base.tipSha}`,
        ...span.rows,
        ...hostedCheckRow,
        ...runJournalRows(runJournal),
      ].join("\n"),
    };
  },
};
