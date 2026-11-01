/**
 * The pure gate evaluator: what a candidate's obligations resolve to, and why.
 *
 * SIX OUTCOMES, NEVER INTERCHANGEABLE. Each says something different about how
 * the obligation came to be settled, and collapsing any pair would destroy the
 * only record of that difference:
 *
 *   satisfied_live_fact — a provider result observed for this invocation. In
 *                         v1 these arrive as caller-supplied results; the gate
 *                         never spawns anything.
 *   satisfied_evidence  — a stored record bound to this candidate's identity.
 *   waived              — an interactive human accepted the risk, on an
 *                         obligation whose config allows it, for findings the
 *                         config classifies as waivable.
 *   delegated           — a declared CI policy answers for it, and the run is
 *                         that policy's job.
 *   not_applicable      — the candidate does not activate the obligation.
 *   blocked             — anything else. Never something policy grants.
 *
 * FRESHNESS IS DELIVERABLE IDENTITY, AND THIS IS THE ONLY PLACE THAT IS TRUE.
 * The recorder compares the *enumerated* candidate field set, raw `treeSha`
 * included, because at submission time the raw tree is what was reviewed. At
 * gate time the raw tree is deliberately ignored: writing the delivery record,
 * a solution note, or any other narration moves the tree without moving the
 * reviewable content, and a freshness rule that could not tell those apart
 * would deadlock the very process that satisfies it. Everything else in the
 * tuple stays: identity token, deliverable digest, base ref, base tip, merge
 * base, and workspace. An unknown identity token fails closed — a record that
 * predates the identity, or claims one this config does not accept, is stale
 * rather than a match on absent fields.
 *
 * The leniency has a price, and it is paid here rather than hidden: two records
 * that agree on the deliverable but disagree on the raw tree are two
 * content-addressed ids in one provider run slot. The gate cannot choose
 * between them, so it reports `ambiguous_records` and blocks.
 *
 * NO I/O, NO CLOCK, NO AMBIENT ANYTHING. Records arrive as shapes from
 * `records.types.ts`, the candidate as a shape from `candidate.types.ts`, the
 * environment already classified by `context.ts`. Identity is compared as
 * strings, so `identity.ts` — which runs git — is not imported at all. The
 * purity sensor's d1 rule enforces every part of that by static analysis.
 *
 * `deliveryRecordVerification.baseMovement` IS INVISIBLE HERE, BY DESIGN. It is
 * read by the delivery-record verifier and by nothing else. If the evaluator
 * consulted it, an `"allow"` config would make the local gate more permissive
 * than the Action that re-checks the same record in CI, and a gate that is
 * easier to pass locally than remotely teaches people to skip it. The negative
 * claim is asserted in the tests rather than merely written here.
 *
 * WHAT THE PORT FROM ATHENA DROPPED. Two things, both deliberately:
 *
 *   - The attested-waiver record kind. Athena admits a GitHub-attested waiver
 *     across execution contexts because its adapter has already proven a human
 *     issuer. The standalone record grammar has no attested variant, and the
 *     human-review-process adapter that would produce one is out of v1 scope,
 *     so a waiver here is exactly one thing: an interactive human's decision.
 *   - `preventedCostClass` on the decision. It is registry metadata in Athena
 *     with no counterpart in the config surface, and a member nothing reads is
 *     policy that drifts out of truth unnoticed.
 *
 * AND WHAT IT CANNOT REACH. `evidence_not_green` and
 * `unresolved_actionable_findings` are in the shared structural registry, but a
 * stored record carries no verdict and no finding count to decide them from:
 * a non-green manifest is rejected by the payload validator (RG-1) and never
 * becomes a record at all. They are emitted at acceptance time, not gate time.
 * Configs still classify them, which is correct — the partition is over what an
 * obligation's *universe* contains, not over what one module happens to emit.
 */
import { createBlocker, type Blocker, type NonEmptyTuple, type Remediation } from "./blockers.ts";
import { isObligationActive, type CandidateBinding, type ReviewActivationProjection } from "./candidate.types.ts";
import { NON_WAIVABLE_INTEGRITY_CODES, type HarnessConfig, type ObligationPolicy } from "./config.ts";
import { digestCanonical } from "./digest.ts";
import type { ExecutionContext } from "./context.ts";
import type { EvidenceRecord, EvidenceResolution, QuarantinedRecord, RecordCandidateBinding, WaiverScope, WaiverResolution } from "./records.types.ts";

/** Completion order never overrides allocation order; ambiguous generations fail closed. */
export function selectScopedCheckAttempt(providerId: string, inputDigest: string, profileDigest: string, attempts: readonly import("./records.types.ts").ScopedCheckAttempt[]): import("./records.types.ts").ScopedCheckAttempt | undefined {
  const relevant = attempts.filter(a => a.providerId === providerId && a.inputDigest === inputDigest && a.profileDigest === profileDigest);
  const generations = new Set<number>();
  const ids = new Set<string>();
  for (const a of relevant) {
    if (a.version !== "scoped-attempt/1" || !Number.isSafeInteger(a.generation) || a.generation < 1 || !a.attemptId || !a.origin?.runId ||
      !["running", "passed", "failed", "interrupted"].includes(a.status) || generations.has(a.generation) || ids.has(a.attemptId)) throw new Error("Invalid or ambiguous scoped attempt generation");
    generations.add(a.generation); ids.add(a.attemptId);
  }
  return [...relevant].sort((a, b) => b.generation - a.generation)[0];
}

/**
 * The five kinds a config may permit, plus the one it cannot. Kept in this
 * order so the coherence check against `RESOLUTION_KINDS` reads as an equality
 * rather than as a set comparison.
 */
export const RESOLUTION_OUTCOMES = [
  "satisfied_live_fact",
  "satisfied_evidence",
  "waived",
  "delegated",
  "not_applicable",
  "blocked",
] as const;

export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

/**
 * A provider's own account of what it found.
 *
 * Both fields are provider-authored, and the `code` is the one that lands
 * somewhere structural: it becomes a blocker code, which has a grammar, and it
 * is what an obligation's waivable / non-waivable partition is applied to. So
 * it is checked rather than trusted — only a code the *registered* provider
 * declares in its `findingCodes` is carried through as a code. Anything else,
 * including a well-formed code the config never declared and a summary with no
 * text in it, becomes a structural `live_provider_failed` blocker with the
 * reported text kept as detail. See `providerFinding` below for why.
 */
export interface LiveProviderFinding {
  readonly code: string;
  readonly summary: string;
  readonly details?: string;
}

/**
 * A result the caller observed and is handing to the pure evaluator. Process
 * invocation belongs to a command boundary, so this remains the evaluator's
 * only road to `satisfied_live_fact`.
 */
export interface LiveProviderResult {
  readonly providerId: string;
  readonly runId: string;
  readonly status: "green" | "failed";
  readonly findings: readonly LiveProviderFinding[];
}

/**
 * A file the store refused to serve, attributed to an obligation by the caller.
 *
 * Attribution is the caller's job because it comes from the filename, and a
 * pure evaluator that parsed store filenames would be reimplementing the store.
 * What is *not* the caller's job is deciding whether it matters: an unreadable
 * file inside the evidence store is the store saying it cannot account for its
 * own contents, and that is a gate decision.
 */
export interface UnreadableRecordInput {
  readonly gateId: string;
  readonly obligationId: string;
  /** False when the file could not be tied to the candidate under evaluation. */
  readonly appliesToCandidate: boolean;
  readonly quarantined: QuarantinedRecord;
}

/**
 * One thing found wrong, with the typed blocker that says it. The code and the
 * blocker are both carried because callers partition on the code (waivable or
 * not) and render the blocker — and neither is derivable from the other.
 */
export interface ObligationFinding {
  readonly code: string;
  readonly obligationId: string;
  readonly providerId?: string;
  readonly recordId?: string;
  readonly blocker: Blocker;
}

interface ResolutionBase {
  readonly gateId: string;
  readonly obligationId: string;
}

export interface SatisfiedLiveFactResolution extends ResolutionBase {
  readonly kind: "satisfied_live_fact";
  readonly providerId: string;
  readonly runId: string;
}

export interface SatisfiedEvidenceResolution extends ResolutionBase {
  readonly kind: "satisfied_evidence";
  readonly providerId: string;
  readonly recordId: string;
  /** Every provider record supporting an all-provider obligation. */
  readonly supportingRecordIds?: readonly string[];
  readonly runId: string;
  readonly finalPassId: string;
  readonly candidateBinding: RecordCandidateBinding;
}

export interface WaivedResolution extends ResolutionBase {
  readonly kind: "waived";
  readonly waiverRecordId: string;
  readonly scope: WaiverScope;
  readonly waiver: WaiverResolution;
  readonly candidateBinding: RecordCandidateBinding;
}

export interface DelegatedResolution extends ResolutionBase {
  readonly kind: "delegated";
  readonly ciPolicyId: string;
}

export interface NotApplicableResolution extends ResolutionBase {
  readonly kind: "not_applicable";
  /** The projection that failed to activate it, echoed so the answer is auditable. */
  readonly activation: ReviewActivationProjection;
}

/**
 * A blocked resolution carries at least one blocker by construction. A block
 * with nothing to show for it is the failure mode where an operator is stopped
 * and told nothing, so the type makes it unconstructible.
 */
export interface BlockedResolution extends ResolutionBase {
  readonly kind: "blocked";
  /** Structured unresolved findings only for providers with opt-in CLI commands. */
  readonly providerFindings?: NonEmptyTuple<ObligationFinding>;
  readonly blockers: NonEmptyTuple<Blocker>;
}

export type ObligationResolution =
  | SatisfiedLiveFactResolution
  | SatisfiedEvidenceResolution
  | WaivedResolution
  | DelegatedResolution
  | NotApplicableResolution
  | BlockedResolution;

export interface EvaluateGateInput {
  readonly resourceBindings?: Readonly<Record<string, import("./records.types.ts").ResourceApplicabilityBinding>>;
  readonly checkBindings?: Readonly<Record<string, import("./records.types.ts").CheckBinding>>;
  readonly config: HarnessConfig;
  readonly candidate: CandidateBinding;
  readonly projection: ReviewActivationProjection;
  /**
   * Supplied by the admission adapter, which obtains it from `context.ts` —
   * this is a classification the harness computed, never a value that crossed a
   * process boundary. A caller who could forge a `human` context here could
   * already have called `classifyExecutionContext` with a snapshot of their
   * choosing, so this member widens nothing: it is the same trust boundary,
   * named in one place instead of two.
   */
  readonly context: ExecutionContext;
  /** Well-formed records the store served, of both resolution kinds. */
  readonly records: readonly EvidenceRecord[];
  /** Files the store quarantined, attributed to an obligation by the caller. */
  readonly unreadable?: readonly UnreadableRecordInput[];
  readonly liveResults?: readonly LiveProviderResult[];
  /**
   * The ids of the invocation-scoped waivers *this* invocation granted.
   *
   * Records are content-addressed and durable, so an invocation-scoped waiver
   * written during an earlier run is still on disk during this one. Athena
   * distinguished the two with an `invocation:` id prefix, which a
   * content-addressed id cannot carry, so the invocation's own grants are named
   * explicitly instead. Absent means "this invocation granted none", which is
   * the fail-closed reading: an unlisted invocation waiver is inert.
   *
   * SUPPLIER AND TRUST BOUNDARY. The admission adapter's second pass, and only
   * it: these are the ids it minted a moment earlier when it published the
   * waivers a human accepted. Nothing external reaches this member, and a
   * forged entry buys very little — an id here does not create a waiver, it
   * only stops one that is *already stored* from being treated as a leftover.
   * That stored record still has to name this gate and this obligation, still
   * has to pass the same freshness comparison as every other record, and still
   * cannot cover a finding the config classifies non-waivable. The one thing an
   * attacker gains is the ability to re-use a waiver they already held for this
   * exact candidate — which is precisely what a `durable` waiver grants openly.
   */
  readonly invocationWaiverRecordIds?: readonly string[];
}

export interface GateDecision {
  readonly gateId: string;
  readonly candidate: CandidateBinding;
  readonly admitted: boolean;
  readonly resolutions: readonly ObligationResolution[];
  /** Findings that did not block. Kept so a passed gate is still auditable. */
  readonly diagnostics: readonly ObligationFinding[];
  readonly blockers: readonly Blocker[];
}

// ── Remediations and findings ──────────────────────────────────────────────

/**
 * Unreachable by construction: the config loader rejects an empty default
 * catalog and an empty per-code catalog alike. Kept because the blocker
 * constructor refuses to build a blocker with no way forward, and the evaluator
 * throwing from inside a failure path would replace a policy block with a
 * crash — the one substitution this contract exists to prevent.
 */
const LAST_RESORT_REMEDIATION: NonEmptyTuple<Remediation> = [
  {
    id: "declare-a-remediation",
    kind: "code_change",
    summary: "Declare a remediation for this obligation in the harness config.",
  },
];

function remediationsFor(obligation: ObligationPolicy, code: string): NonEmptyTuple<Remediation> {
  const keyed = obligation.remediation.byCode?.[code];
  const chosen = keyed !== undefined && keyed.length > 0 ? keyed : obligation.remediation.default;
  const [first, ...rest] = chosen;
  return first === undefined ? LAST_RESORT_REMEDIATION : [first, ...rest];
}

interface FindingDetails {
  readonly providerId?: string;
  readonly recordId?: string;
  readonly details?: string;
  /** Provider findings are attributed to the provider, not to the obligation. */
  readonly fromProvider?: string;
}

function finding(obligation: ObligationPolicy, code: string, summary: string, details: FindingDetails = {}): ObligationFinding {
  return {
    code,
    obligationId: obligation.id,
    ...(details.providerId === undefined ? {} : { providerId: details.providerId }),
    ...(details.recordId === undefined ? {} : { recordId: details.recordId }),
    blocker: createBlocker({
      code,
      source: details.fromProvider === undefined ? { kind: "obligation", id: obligation.id } : { kind: "provider", id: details.fromProvider },
      summary,
      ...(details.details === undefined ? {} : { details: details.details }),
      remediations: remediationsFor(obligation, code),
    }),
  };
}

function blockedWith(
  config: HarnessConfig,
  gateId: string,
  obligation: ObligationPolicy,
  findings: readonly ObligationFinding[],
  fallback: ObligationFinding,
): BlockedResolution {
  const source = findings.length > 0 ? findings : [fallback];
  const [first, ...rest] = source.map((entry) => entry.blocker);
  const commandProviders = new Set(config.providers.filter((provider) => provider.command !== undefined || provider.check !== undefined).map((provider) => provider.id));
  const providerFindings = source.filter(
    (entry): entry is ObligationFinding & { readonly providerId: string } =>
      entry.providerId !== undefined && commandProviders.has(entry.providerId),
  );
  const [firstProviderFinding, ...restProviderFindings] = providerFindings;
  return {
    kind: "blocked",
    gateId,
    obligationId: obligation.id,
    ...(firstProviderFinding === undefined
      ? {}
      : { providerFindings: [firstProviderFinding, ...restProviderFindings] }),
    blockers: [first as Blocker, ...rest],
  };
}

// ── Freshness ──────────────────────────────────────────────────────────────

/**
 * Whether a record's candidate binding names the candidate now under
 * evaluation, under the gate-time reading of "the same candidate".
 *
 * `treeSha` is absent from the comparison and that absence is the whole point;
 * see the header. Both sides must name an identity token this config accepts
 * and the same one, and the digest must be non-empty — a record written before
 * the identity existed carries an empty digest, and comparing two empty strings
 * would make every such record match every candidate.
 */
export function isRecordFreshForCandidate(config: HarnessConfig, recorded: RecordCandidateBinding, candidate: CandidateBinding): boolean {
  const accepted = config.identityVersions;
  if (!accepted.includes(recorded.identityToken)) return false;
  if (!accepted.includes(candidate.deliverable.identity)) return false;
  if (recorded.identityToken !== candidate.deliverable.identity) return false;
  if (recorded.deliverableDigest === "" || candidate.deliverable.digest === "") return false;
  return (
    recorded.deliverableDigest === candidate.deliverable.digest &&
    recorded.baseRef === candidate.base.ref &&
    recorded.baseTipSha === candidate.base.tipSha &&
    recorded.mergeBaseSha === candidate.base.mergeBaseSha &&
    recorded.workspaceId === candidate.workspaceId
  );
}

// ── The provider quantifier ────────────────────────────────────────────────

/**
 * Which of an obligation's providers are still unaccounted for, given the set
 * that produced something acceptable.
 *
 * THE QUANTIFIER LIVES HERE AND NOWHERE ELSE, AND THE CONFIG SELECTS IT.
 * `ObligationPolicy.providerPolicy` is the member: `"all"` — and its absence,
 * which reads the same — demands every approved provider, exactly the behavior
 * this function had while the quantifier was still hardcoded. That default is
 * the fail-closed one: an obligation that names two providers is not satisfied
 * by one of them, because the reverse default would silently admit a candidate
 * on half the evidence its config asked for. `"existential"` is the opt-in:
 * any one covered provider clears the residue.
 *
 * The shape is a residue rather than a boolean switch on purpose. Both call
 * sites ask the same question — who is missing — so neither carries a branch:
 * an existential obligation with at least one covered provider simply has no
 * residue, and everything downstream (the satisfied checks, the missing-
 * provider findings) follows from that without consulting the policy again.
 */
function unsatisfiedProviders(obligation: ObligationPolicy, covered: ReadonlySet<string>): readonly string[] {
  const missing = obligation.providers.filter((providerId) => !covered.has(providerId));
  const someCovered = missing.length < obligation.providers.length;
  if ((obligation.providerPolicy ?? "all") === "existential" && someCovered) return [];
  return missing;
}

/**
 * Whether a provider may report under this code.
 *
 * A live result is provider-authored, and its `code` is applied to two closed
 * vocabularies: the blocker grammar, which throws on a violation, and the
 * obligation's waivable / non-waivable partition, which is computed over the
 * codes the config declares. An unchecked code therefore has two ways to do
 * damage — it can turn a policy block into a crash, and it can arrive at the
 * waiver check classified as neither waivable nor non-waivable, escaping a
 * partition the config loader went to some trouble to make exact.
 *
 * So the config's own declaration is the gate. A code the registered provider
 * lists is well-formed by construction (the loader validates `findingCodes`
 * against the same grammar the blocker contract enforces) and is inside the
 * partition by construction (the universe is built from exactly these lists).
 * Everything else is data, not vocabulary.
 */
function providerDeclaresCode(config: HarnessConfig, providerId: string, code: unknown): boolean {
  if (typeof code !== "string") return false;
  const registered = config.providers.find((provider) => provider.id === providerId);
  return registered !== undefined && registered.findingCodes.includes(code);
}

/** Operator-facing text needs text in it; a blank summary is not a diagnostic. */
function hasReportableSummary(summary: unknown): boolean {
  return typeof summary === "string" && summary.trim() !== "";
}

// ── Live obligations ───────────────────────────────────────────────────────

interface Evaluation {
  readonly resolution: ObligationResolution;
  readonly diagnostics: readonly ObligationFinding[];
}

function evaluateLiveObligation(input: EvaluateGateInput, obligation: ObligationPolicy): Evaluation {
  const gateId = input.config.gateId;
  const results = input.liveResults ?? [];
  const findings: ObligationFinding[] = [];
  const green: LiveProviderResult[] = [];

  for (const providerId of obligation.providers) {
    const matching = results.filter((result) => result.providerId === providerId);
    if (matching.length === 0) {
      findings.push(finding(obligation, "live_provider_missing", `Live provider ${providerId} returned no result for this invocation.`, { providerId }));
      continue;
    }
    if (matching.length > 1) {
      findings.push(
        finding(obligation, "ambiguous_live_provider", `Live provider ${providerId} returned more than one result for this invocation.`, { providerId }),
      );
      continue;
    }
    const result = matching[0] as LiveProviderResult;
    // A green status carrying findings is not green. The two members can only
    // disagree if the provider is confused about its own verdict, and the
    // fail-closed reading of that is the findings.
    if (result.status !== "green" || result.findings.length > 0) {
      if (result.findings.length === 0) {
        findings.push(finding(obligation, "live_provider_failed", `Live provider ${providerId} failed without reporting a structured finding.`, { providerId }));
        continue;
      }
      for (const reported of result.findings) {
        if (providerDeclaresCode(input.config, providerId, reported.code) && hasReportableSummary(reported.summary)) {
          findings.push(
            finding(obligation, reported.code, reported.summary, {
              providerId,
              fromProvider: providerId,
              ...(reported.details === undefined ? {} : { details: reported.details }),
            }),
          );
          continue;
        }
        // Refused as vocabulary, kept as evidence. The operator still reads
        // exactly what the provider said — one indent below the structural code
        // that vouches for it — and the blocker contract's own redaction and
        // bounding apply to it on the way through.
        findings.push(
          finding(obligation, "live_provider_failed", `Live provider ${providerId} reported a finding this config does not declare.`, {
            providerId,
            details: `Reported code: ${JSON.stringify(reported.code)}\nReported summary: ${String(reported.summary)}${
              reported.details === undefined ? "" : `\nReported details: ${String(reported.details)}`
            }`,
          }),
        );
      }
      continue;
    }
    green.push(result);
  }

  const covered = new Set(green.map((result) => result.providerId));
  const satisfied = obligation.providers.length > 0 && unsatisfiedProviders(obligation, covered).length === 0;

  if (satisfied) {
    const first = green[0] as LiveProviderResult;
    return {
      resolution: { kind: "satisfied_live_fact", gateId, obligationId: obligation.id, providerId: first.providerId, runId: first.runId },
      diagnostics: findings,
    };
  }

  const fallback = finding(obligation, "live_provider_missing", `Obligation ${obligation.id} has no green live result for this invocation.`);
  const pending = findings.length > 0 ? findings : [fallback];
  const waived = waiverFor(input, obligation, pending);
  if (waived !== undefined) return { resolution: waived, diagnostics: pending };
  return { resolution: blockedWith(input.config, gateId, obligation, pending, fallback), diagnostics: [] };
}

// ── Recorded obligations ───────────────────────────────────────────────────

type StoredEvidence = EvidenceRecord & { readonly resolution: EvidenceResolution };

function isStoredEvidence(record: EvidenceRecord): record is StoredEvidence {
  return record.resolution.kind === "evidence";
}

/**
 * The semantic slot a record occupies: one provider's one run's one final pass.
 * NUL-separated because no id may contain one, so two different triples cannot
 * collide into a single key.
 */
function evidenceSlot(record: StoredEvidence): string {
  return `${record.resolution.providerId}\u0000${record.resolution.runId}\u0000${record.resolution.finalPassId}`;
}

interface EvidenceScan {
  readonly evidence: StoredEvidence | undefined;
  readonly supportingRecordIds?: readonly string[];
  readonly blocking: readonly ObligationFinding[];
  readonly diagnostics: readonly ObligationFinding[];
  /** A subset of `blocking`, kept apart because it blocks ahead of everything. */
  readonly malformed: readonly ObligationFinding[];
  readonly ambiguous: boolean;
}

function scanEvidence(input: EvaluateGateInput, obligation: ObligationPolicy): EvidenceScan {
  const gateId = input.config.gateId;
  const invalid: ObligationFinding[] = [];
  const malformed: ObligationFinding[] = [];
  const fresh: StoredEvidence[] = [];

  for (const entry of input.unreadable ?? []) {
    if (entry.gateId !== gateId || entry.obligationId !== obligation.id) continue;
    // A file the store could not attribute to this candidate is not this
    // candidate's problem; a file it could is, whatever the file contains.
    if (!entry.appliesToCandidate) continue;
    const found = finding(obligation, "malformed_record", `The evidence store quarantined ${entry.quarantined.path} (${entry.quarantined.reason}).`, {
      details: entry.quarantined.detail,
    });
    invalid.push(found);
    malformed.push(found);
  }

  for (const record of input.records) {
    if (record.gateId !== gateId || record.obligationId !== obligation.id) continue;
    if (!isStoredEvidence(record)) continue;
    const providerId = record.resolution.providerId;
    if (!obligation.providers.includes(providerId)) {
      invalid.push(
        finding(obligation, "unknown_provider", `Record ${record.recordId} names provider ${providerId}, which obligation ${obligation.id} does not approve.`, {
          providerId,
          recordId: record.recordId,
        }),
      );
      continue;
    }
    const check = input.config.providers.find(provider => provider.id === providerId)?.check;
    const expectedScoped = input.checkBindings?.[providerId];
    const scoped = record.resolution.resourceBinding === undefined && check?.scope !== undefined && expectedScoped?.scopedInputDigest !== undefined && record.resolution.checkBinding?.scopedInputDigest !== undefined &&
      record.candidateBinding.workspaceId === input.candidate.workspaceId && record.candidateBinding.identityToken === input.candidate.deliverable.identity;
    if (!scoped && !isRecordFreshForCandidate(input.config, record.candidateBinding, input.candidate)) {
      invalid.push(
        finding(obligation, "stale_evidence", `Record ${record.recordId} is bound to a different candidate than the one under evaluation.`, {
          providerId,
          recordId: record.recordId,
        }),
      );
      continue;
    }
    if (record.resolution.resourceBinding !== undefined) {
      const expected = input.resourceBindings?.[providerId];
      if (!obligation.acceptedPayloadSpecs.includes("installed-data.applicable/1") || record.resolution.checkBinding !== undefined ||
          expected === undefined || digestCanonical(expected) !== digestCanonical(record.resolution.resourceBinding)) continue;
    } else if (obligation.acceptedPayloadSpecs.every(spec => spec === "installed-data.applicable/1")) {
      continue;
    } else if (input.config.providers.find(provider => provider.id === providerId)?.check !== undefined) {
      const expected = input.checkBindings?.[providerId];
      if (expected === undefined || record.resolution.checkBinding === undefined ||
          digestCanonical(expected) !== digestCanonical(record.resolution.checkBinding)) continue;
    }
    fresh.push(record);
  }

  const bySlot = new Map<string, StoredEvidence[]>();
  for (const record of fresh) {
    const slot = evidenceSlot(record);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), record]);
  }
  for (const slotRecords of bySlot.values()) {
    if (new Set(slotRecords.map((record) => record.recordId)).size > 1) {
      return {
        evidence: undefined,
        blocking: [finding(obligation, "ambiguous_records", `Fresh evidence records disagree within one provider run slot for obligation ${obligation.id}.`)],
        diagnostics: invalid,
        malformed: [],
        ambiguous: true,
      };
    }
  }

  // Deterministic order, so which record a satisfied obligation names does not
  // depend on the order the store happened to read its directory in.
  fresh.sort((left, right) => left.resolution.providerId.localeCompare(right.resolution.providerId) || left.recordId.localeCompare(right.recordId));

  const covered = new Set(fresh.map((record) => record.resolution.providerId));
  const missing = unsatisfiedProviders(obligation, covered).map((providerId) =>
    finding(obligation, "review_evidence_missing", `Approved provider ${providerId} has no fresh final-green evidence for this candidate.`, { providerId }),
  );

  const satisfied = missing.length === 0 && fresh.length > 0;
  return {
    evidence: satisfied ? fresh[0] : undefined,
    ...(satisfied && new Set(fresh.map(record => record.resolution.providerId)).size > 1 ? {
      supportingRecordIds: [...new Map([...fresh].reverse().map(record => [record.resolution.providerId, record.recordId])).values()].sort(),
    } : {}),
    blocking: satisfied ? [] : [...invalid, ...missing],
    diagnostics: satisfied ? invalid : [],
    malformed: satisfied ? [] : malformed,
    ambiguous: false,
  };
}

function delegationFor(input: EvaluateGateInput, obligation: ObligationPolicy): DelegatedResolution | undefined {
  const context = input.context;
  if (context.kind !== "ci") return undefined;
  // Three agreements, all required: the config declares the policy, the run
  // matched it, and *this obligation* names it. The third is the per-obligation
  // recheck — a policy authorizing the run says nothing about which obligations
  // that run answers for.
  const declared = input.config.ciPolicies.find((policy) => policy.id === context.policyId);
  if (declared === undefined) return undefined;
  if (!obligation.ciDelegationPolicyIds.includes(declared.id)) return undefined;
  return { kind: "delegated", gateId: input.config.gateId, obligationId: obligation.id, ciPolicyId: declared.id };
}

function evaluateRecordedObligation(input: EvaluateGateInput, obligation: ObligationPolicy): Evaluation {
  const gateId = input.config.gateId;
  const scan = scanEvidence(input, obligation);

  if (scan.evidence !== undefined) {
    const record = scan.evidence;
    return {
      resolution: {
        kind: "satisfied_evidence",
        gateId,
        obligationId: obligation.id,
        providerId: record.resolution.providerId,
        recordId: record.recordId,
        ...(scan.supportingRecordIds === undefined ? {} : { supportingRecordIds: scan.supportingRecordIds }),
        runId: record.resolution.runId,
        finalPassId: record.resolution.finalPassId,
        candidateBinding: record.candidateBinding,
      },
      diagnostics: scan.diagnostics,
    };
  }

  const fallback = finding(obligation, "review_evidence_missing", `The candidate has no fresh approved final-green evidence for obligation ${obligation.id}.`);

  // Ambiguity and quarantine both mean the store cannot account for itself, and
  // neither is something a CI policy promised to handle or a human was offered
  // a choice about. They block ahead of delegation and the waiver rather than
  // taking their place in the queue.
  if (scan.ambiguous) {
    return { resolution: blockedWith(input.config, gateId, obligation, scan.blocking, fallback), diagnostics: scan.diagnostics };
  }
  if (scan.malformed.length > 0) {
    return {
      resolution: blockedWith(input.config, gateId, obligation, scan.malformed, fallback),
      diagnostics: scan.blocking.filter((entry) => !scan.malformed.includes(entry)),
    };
  }

  const delegated = delegationFor(input, obligation);
  if (delegated !== undefined) return { resolution: delegated, diagnostics: scan.blocking };

  const pending = scan.blocking.length > 0 ? scan.blocking : [fallback];
  const waived = waiverFor(input, obligation, pending);
  if (waived !== undefined) return { resolution: waived, diagnostics: pending };

  return { resolution: blockedWith(input.config, gateId, obligation, pending, fallback), diagnostics: [] };
}

// ── Waivers ────────────────────────────────────────────────────────────────

/**
 * The narrowest door in the gate, and the one worth stating as a list of
 * conjunctions rather than as prose. A waiver applies only when *all* of:
 *
 *   - the obligation's config permits waiving it at all;
 *   - the run is an interactive human — never CI, never an agent, never an
 *     anonymous shell. An agent that could waive could waive its own review;
 *   - every pending finding is classified waivable by this obligation. This is
 *     all-or-nothing on purpose: a waiver covering "most of it" is a waiver
 *     whose holder was never told what they were accepting. An unclassified
 *     code counts as non-waivable, which is the fail-closed reading of a
 *     partition the loader should have rejected;
 *   - a waiver record exists that is bound to this candidate and whose scope
 *     covers this invocation. A `durable` record settles a candidate-bound
 *     obligation; a `live` obligation is re-evaluated from scratch every run,
 *     so only a waiver granted *during this invocation* can settle it —
 *     otherwise one "yes" to a missing artifact would silently admit a
 *     different failure, including codes the offer deliberately excluded, on
 *     every later run against the same candidate.
 */
function waiverFor(input: EvaluateGateInput, obligation: ObligationPolicy, pending: readonly ObligationFinding[]): WaivedResolution | undefined {
  if (!obligation.humanWaiverAllowed) return undefined;
  if (input.context.kind !== "human") return undefined;
  if (pending.length === 0) return undefined;

  const waivable = new Set(obligation.waivableCodes);
  const nonWaivable = new Set(obligation.nonWaivableCodes);
  if (pending.some((entry) => NON_WAIVABLE_INTEGRITY_CODES.includes(entry.code) || nonWaivable.has(entry.code) || !waivable.has(entry.code))) return undefined;

  const granted = new Set(input.invocationWaiverRecordIds ?? []);
  const invocationOnly = obligation.freshness === "live";
  const honored = input.records
    .filter((record) => record.gateId === input.config.gateId && record.obligationId === obligation.id)
    .filter((record) => {
      if (record.resolution.kind !== "waiver") return false;
      const waiver = record.resolution;
      if (waiver.policyDigest !== digestCanonical(input.config) ||
          record.candidateBinding.treeSha !== input.candidate.treeSha ||
          !waiver.author?.trim() || !waiver.reason?.trim() ||
          !Array.isArray(waiver.findingCodes) ||
          waiver.findingCodes.some((code) => NON_WAIVABLE_INTEGRITY_CODES.includes(code) || nonWaivable.has(code) || !waivable.has(code)) ||
          pending.some((finding) => !waiver.findingCodes.includes(finding.code))) return false;
      if (record.resolution.scope === "invocation") return granted.has(record.recordId);
      return !invocationOnly;
    })
    .filter((record) => isRecordFreshForCandidate(input.config, record.candidateBinding, input.candidate))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));

  const chosen = honored[0];
  if (chosen === undefined || chosen.resolution.kind !== "waiver") return undefined;
  return {
    kind: "waived",
    gateId: input.config.gateId,
    obligationId: obligation.id,
    waiverRecordId: chosen.recordId,
    scope: chosen.resolution.scope,
    waiver: chosen.resolution,
    candidateBinding: chosen.candidateBinding,
  };
}

// ── Policy enforcement ─────────────────────────────────────────────────────

/**
 * The last gate on the gate: a resolution an obligation's config does not
 * permit becomes a block, whatever produced it.
 *
 * This exists because every path above answers a different question — is there
 * evidence, did a provider pass, does a policy cover this — and none of them
 * has any reason to consult `allowedResolutionKinds`. Without this step, an
 * obligation that declares itself undelegatable is undelegatable only for as
 * long as nobody writes a delegation path that forgets to ask.
 */
export function enforceAllowedResolution(obligation: ObligationPolicy, resolution: ObligationResolution): ObligationResolution {
  if (resolution.kind === "blocked") return resolution;
  if ((obligation.allowedResolutionKinds as readonly string[]).includes(resolution.kind)) return resolution;
  const rejected = finding(obligation, "resolution_not_allowed", `Resolution ${resolution.kind} is not permitted by obligation ${obligation.id}.`);
  return {
    kind: "blocked",
    gateId: resolution.gateId,
    obligationId: obligation.id,
    blockers: [rejected.blocker],
  };
}

// ── The gate ───────────────────────────────────────────────────────────────

export function evaluateGate(input: EvaluateGateInput): GateDecision {
  const resolutions: ObligationResolution[] = [];
  const diagnostics: ObligationFinding[] = [];

  for (const obligation of input.config.obligations) {
    if (!isObligationActive(obligation.activation, input.projection, input.config.activationThreshold)) {
      const inactive: NotApplicableResolution = {
        kind: "not_applicable",
        gateId: input.config.gateId,
        obligationId: obligation.id,
        activation: input.projection,
      };
      resolutions.push(enforceAllowedResolution(obligation, inactive));
      continue;
    }

    const evaluation = obligation.freshness === "live" ? evaluateLiveObligation(input, obligation) : evaluateRecordedObligation(input, obligation);
    resolutions.push(enforceAllowedResolution(obligation, evaluation.resolution));
    diagnostics.push(...evaluation.diagnostics);
  }

  const blockers = resolutions.flatMap((resolution) => (resolution.kind === "blocked" ? [...resolution.blockers] : []));
  return {
    gateId: input.config.gateId,
    candidate: input.candidate,
    admitted: blockers.length === 0,
    resolutions,
    diagnostics,
    blockers,
  };
}
