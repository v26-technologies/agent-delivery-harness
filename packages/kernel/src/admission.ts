import { captureCheckBindings } from "./checks.ts";
/**
 * The admission adapter: the effectful seam between the store, the classified
 * execution context, the caller-supplied live results, and the *pure* gate
 * evaluator.
 *
 * WHAT LIVES HERE, AND WHY IT IS NOT IN THE EVALUATOR. `evaluateGate` is a total
 * function of values — it opens no file, runs no git, and reads no clock. That
 * is what lets it be exercised as a decision table. But something has to turn a
 * repository into those values: capture the candidate, resolve the git-private
 * store, read the records filed under each obligation, map the store's
 * quarantine into the evaluator's diagnostic union, and translate the classified
 * context. That is this module, and the purity sensor's d2 rule holds it to the
 * bargain — every filesystem effect it performs is routed through `records.ts`
 * or `preparation.ts` (each of which owns its own fs), never a direct `node:fs`.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER.
 *
 *   1. Capture the candidate through the injected port. Everything downstream is
 *      about *this* candidate, so there is nothing to do until one is observed.
 *   2. Prove capture and store name the same workspace. The adapter both
 *      assembles the candidate binding and synthesizes waiver records filed
 *      under the store's workspace id; if those two workspaces disagreed, a
 *      waiver would be filed where the candidate does not live and still pass
 *      the freshness comparison, which is exactly the silent hazard the recorder
 *      flagged for "the CLI". This is the place that can see both, so this is the
 *      place that asserts it.
 *   3. Require a current preparation receipt. No receipt is a blocker, never a
 *      bypass — and it is decided before the gate runs, so a missing receipt can
 *      never reach a waiver prompt.
 *   4. Project activation, read the store, evaluate.
 *   5. Two-pass waiver, only if the first pass blocked on nothing but waivable
 *      findings and the run is an interactive human with a prompt wired.
 *
 * appliesToCandidate IS DECIDED HERE. The evaluator judges freshness, but it is
 * the adapter that decides which discovered records are even *about* this
 * candidate. Scoped check records from the same workspace and identity version
 * reach the evaluator for its per-check freshness decision. A legacy record whose binding is not fresh for the candidate
 * under evaluation is excluded — it resolves as absent, not as stale evidence,
 * because a record for another candidate is not this candidate's stale evidence,
 * it is simply not its evidence. A quarantined file is the opposite case: its
 * binding cannot be parsed, so it cannot be shown to belong to another
 * candidate, and the fail-closed reading is that it applies (a store that cannot
 * account for its own contents is a gate decision).
 *
 * THE TWO-PASS WAIVER EVALUATION. A blocked first pass whose every finding an
 * interactive human may waive earns exactly one prompt, naming every obligation
 * that one "yes" covers. On acceptance the candidate is re-captured — a change
 * while the prompt was open voids the offer — and then candidate-bound waiver
 * records are written to disk and the gate is evaluated a second time, with
 * those record ids handed in as this invocation's grants. The write happens only
 * after an accepted prompt and a clean re-capture, so a decline or a drift
 * leaves the store exactly as it found it: zero waiver records.
 *
 * WHAT THE PORT FROM ATHENA DROPPED. Athena's admission wrote gate-decision
 * telemetry events, spawned private validation providers inside admission, and
 * mapped two Athena-only providers (documentation and delivery-run telemetry).
 * None of those is in this adapter's scope: admission itself never spawns, there
 * is no decision-event stream, and the neutral CLI rail invokes only opt-in
 * provider commands before handing their ordinary evidence/live results back
 * here. And Athena's
 * `toEvaluatorContext` remapped the classifier's kinds onto the evaluator's;
 * here `context.ts` already emits the evaluator's `ExecutionContext` union, so
 * the translation is the identity and the classified context is consumed
 * directly. Athena's `invocation:`-prefixed waiver ids are likewise gone: a
 * content-addressed id cannot carry a prefix, so this invocation's grants are
 * named explicitly through `invocationWaiverRecordIds` instead.
 */
import { BlockedError, createBlocker, type Blocker, type NonEmptyTuple, type Remediation } from "./blockers.ts";
import { classifyCandidateDrift, type CandidateBinding, type CandidateCapture, type CapturedCandidate, type CaptureCandidate, type ReviewActivationProjection } from "./candidate.types.ts";
import { NON_WAIVABLE_INTEGRITY_CODES, type HarnessConfig, type ObligationPolicy } from "./config.ts";
import { digestCanonical } from "./digest.ts";
import type { ExecutionContext } from "./context.ts";
import { evaluateGate, isRecordFreshForCandidate, type BlockedResolution, type EvaluateGateInput, type GateDecision, type LiveProviderResult, type UnreadableRecordInput } from "./evaluator.ts";
import { evaluatePreparationReceipt, type PreparationEvaluation } from "./preparation.ts";
import { discoverRecords as defaultDiscoverRecords, publishRecord, resolveRecordStorage, type RecordStorageOptions } from "./records.ts";
import type { EvidenceRecord, PublishedRecord, RecordCandidateBinding, RecordDiscovery, WaiverResolution } from "./records.types.ts";

/** Live obligations must obtain approval during each invocation. */
export const INVOCATION_WAIVER_SCOPE = "invocation" as const;

/**
 * The interactive waiver prompt, injected. The adapter never detects a TTY and
 * never renders — the command surface wires an implementation over its own I/O,
 * and a run with none supplied simply cannot be offered a waiver.
 */
export type WaiverApproval = { readonly author: string; readonly reason: string };
export type WaiverPrompt = (decision: GateDecision, obligationIds: readonly string[]) => Promise<false | WaiverApproval>;

/** How the interactive waiver offer resolved, for a caller that reports it. */
export type WaiverPromptOutcome = "not_offered" | "accepted" | "declined" | "candidate_changed" | "scope_changed";

export interface AdmissionInput {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  /**
   * The already-classified context. `context.ts` emits exactly the union the
   * evaluator consumes, so there is nothing to translate — the same trust
   * boundary the classifier established, named in one place.
   */
  readonly context: ExecutionContext;
  /** Caller-supplied live-provider results — the v1 source of `satisfied_live_fact`. */
  readonly liveResults?: readonly LiveProviderResult[];
}

export interface AdmissionOptions extends RecordStorageOptions {
  readonly resourceBindings?: Readonly<Record<string, import("./records.types.ts").ResourceApplicabilityBinding>>;
  readonly scopedPlan?: import("./records.types.ts").ScopedCheckPlan;
  readonly readOutput?: (repoPath: string, providerId: string) => Promise<Uint8Array>;
  /** How the candidate is observed. Injected: the adapter owns no repository dependency. */
  readonly captureCandidate: CaptureCandidate;
  /** The reviewable-change projection for the captured candidate. Injected for the same reason. */
  readonly projectActivation: (candidate: CapturedCandidate) => Promise<ReviewActivationProjection>;
  /** Absent means "this run cannot ask a human", so no waiver is ever offered. */
  readonly promptForWaiver?: WaiverPrompt;
  readonly evaluatePreparation?: (rootDir: string, config: HarnessConfig, candidate: CapturedCandidate) => Promise<PreparationEvaluation>;
  readonly discoverRecords?: (rootDir: string, gateId: string, obligationId: string) => Promise<RecordDiscovery>;
  readonly publishWaiver?: (rootDir: string, binding: RecordCandidateBinding, obligationId: string, resolution: WaiverResolution) => Promise<PublishedRecord>;
  /** Passed through to receipt evaluation. Tests use it; callers do not. */
  readonly harnessVersion?: string;
}

export interface AdmissionResult {
  readonly admitted: boolean;
  readonly blockers: readonly Blocker[];
  /** The final pure evaluation. Absent only when capture, coherence, or the receipt stopped the run before the gate ran. */
  readonly decision?: GateDecision;
  readonly context?: ExecutionContext;
  readonly candidate?: CandidateBinding;
  readonly waiver: WaiverPromptOutcome;
  /** The obligations one "yes" would cover (or did cover). Empty unless a waiver was offerable. */
  readonly waivedObligationIds: readonly string[];
  /** The waiver records written this run. Non-empty only on an accepted waiver. */
  readonly waiverRecordIds: readonly string[];
}

// ── Storage plumbing ─────────────────────────────────────────────────────────

function storageOptions(options: AdmissionOptions): RecordStorageOptions {
  return {
    ...(options.storageNamespace === undefined ? {} : { storageNamespace: options.storageNamespace }),
    ...(options.leaf === undefined ? {} : { leaf: options.leaf }),
    ...(options.storageRoot === undefined ? {} : { storageRoot: options.storageRoot }),
    ...(options.runGit === undefined ? {} : { runGit: options.runGit }),
  };
}

// ── Blockers ─────────────────────────────────────────────────────────────────

const PREPARE_AGAIN: Remediation = {
  id: "prepare-current-candidate",
  kind: "manual_action",
  summary: "Prepare the current candidate again so a fresh receipt is published, then re-run the gate.",
};

function candidateChangedBlocker(): Blocker {
  return createBlocker({
    code: "candidate_changed_during_prompt",
    source: { kind: "candidate", id: "candidate-drift" },
    summary: "The candidate changed while the waiver prompt was open, so the offered waiver no longer describes it.",
    remediations: [PREPARE_AGAIN],
  });
}

function waiverDeclinedBlocker(gateId: string, obligationIds: readonly string[]): Blocker {
  return createBlocker({
    code: "waiver_declined",
    source: { kind: "gate", id: gateId },
    summary: `The interactive human declined the offered waiver for: ${obligationIds.join(", ")}.`,
    remediations: [
      {
        id: "satisfy-the-declined-obligations",
        kind: "manual_action",
        summary: "Produce real evidence for the obligations whose waiver was declined, then re-run the gate.",
      },
    ],
  });
}

/**
 * The workspace-coherence guard. The adapter both assembles the candidate
 * binding (from the capture's workspace) and synthesizes waiver records (filed
 * under the store's workspace). If those disagreed, a waiver record's identity
 * tuple would name the store's workspace while its candidate binding named the
 * capture's — and the freshness comparison, which reads the binding, would still
 * pass, honoring a waiver filed in a store the candidate does not belong to. So
 * the two are proven equal before any record is read or written.
 */
function workspaceIncoherentBlocker(gateId: string, candidateWorkspaceId: string, storeWorkspaceId: string): Blocker {
  return createBlocker({
    code: "workspace_incoherent",
    source: { kind: "gate", id: gateId },
    summary: "The captured candidate and the evidence store resolve to different workspaces.",
    details: `candidate workspace ${candidateWorkspaceId} != store workspace ${storeWorkspaceId}`,
    remediations: [
      {
        id: "point-capture-and-store-at-one-repository",
        kind: "manual_action",
        summary: "Run the candidate capture and the evidence store against the same repository, then re-run the gate.",
      },
    ],
  });
}

function nonEmpty(blockers: readonly Blocker[]): NonEmptyTuple<Blocker> {
  const [first, ...rest] = blockers;
  if (first === undefined) throw new Error("An admission block must carry at least one blocker.");
  return [first, ...rest];
}

function blocked(partial: Omit<AdmissionResult, "admitted" | "blockers"> & { readonly blockers: readonly Blocker[] }): AdmissionResult {
  return { admitted: false, ...partial, blockers: nonEmpty(partial.blockers) };
}

// ── Record mapping ───────────────────────────────────────────────────────────

interface MappedStore {
  readonly resourceBindings?: Readonly<Record<string, import("./records.types.ts").ResourceApplicabilityBinding>>;
  readonly checkBindings: Readonly<Record<string, import("./records.types.ts").CheckBinding>>;
  readonly records: readonly EvidenceRecord[];
  readonly unreadable: readonly UnreadableRecordInput[];
}

/**
 * Reads the store for every obligation that binds to evidence, and maps what it
 * finds into the evaluator's two input channels.
 *
 * Only `exact_candidate` obligations are read: a `live` obligation's evidence is
 * a caller-supplied result, and a prior run's invocation-scope waiver for a live
 * obligation is inert on this invocation by construction — reading it would cost
 * a store round-trip for a record that can never be honored.
 */
async function mapStore(input: AdmissionInput, options: AdmissionOptions, candidate: CapturedCandidate): Promise<MappedStore> {
  const discover = options.discoverRecords ?? ((rootDir, gateId, obligationId) => defaultDiscoverRecords(rootDir, { ...storageOptions(options), gateId, obligationId }));
  const records: EvidenceRecord[] = [];
  const unreadable: UnreadableRecordInput[] = [];

  for (const obligation of input.config.obligations) {
    if (obligation.freshness === "live") continue;
    const discovery = await discover(input.rootDir, input.config.gateId, obligation.id);

    for (const record of discovery.records) {
      // appliesToCandidate. Legacy records are forwarded only when their
      // binding is fresh; foreign or stale records resolve as absent rather
      // than stale evidence. (Falsification: force this to `true` and a foreign-
      // candidate record surfaces as `stale_evidence`.)
      // Scoped evidence reaches the evaluator across source changes. Its current
      // input/profile/attempt binding is checked there; legacy evidence retains
      // the strict candidate filter.
      const providerId = record.resolution.kind === "evidence" ? record.resolution.providerId : undefined;
      const scoped = record.resolution.kind === "evidence" && record.resolution.resourceBinding === undefined && providerId !== undefined &&
        input.config.providers.some(p => p.id === providerId && p.check?.scope !== undefined) &&
        record.candidateBinding.workspaceId === candidate.workspaceId && record.candidateBinding.identityToken === candidate.deliverable.identity;
      const appliesToCandidate = scoped || isRecordFreshForCandidate(input.config, record.candidateBinding, candidate);
      if (appliesToCandidate) records.push(record);
    }

    for (const quarantined of discovery.quarantined) {
      // A file the store could not parse cannot be tied to another candidate, so
      // the fail-closed reading is that it applies: the store cannot account for
      // its own contents, and that is a gate decision, never a dropped file.
      unreadable.push({ gateId: input.config.gateId, obligationId: obligation.id, appliesToCandidate: true, quarantined });
    }
  }

  return { records, unreadable, ...(options.resourceBindings === undefined ? {} : { resourceBindings: options.resourceBindings }), checkBindings: await captureCheckBindings(input.rootDir, input.config, candidate, options) };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function gateInput(
  input: AdmissionInput,
  candidate: CapturedCandidate,
  projection: ReviewActivationProjection,
  store: MappedStore,
  extraRecords: readonly EvidenceRecord[],
  invocationWaiverRecordIds: readonly string[],
): EvaluateGateInput {
  const records = dedupeRecords([...store.records, ...extraRecords]);
  return {
    config: input.config,
    candidate,
    projection,
    context: input.context,
    records,
    checkBindings: store.checkBindings,
    ...(store.resourceBindings === undefined ? {} : { resourceBindings: store.resourceBindings }),
    unreadable: store.unreadable,
    ...(input.liveResults === undefined ? {} : { liveResults: input.liveResults }),
    invocationWaiverRecordIds,
  };
}

/** Records are content-addressed, so identity of `recordId` is identity of record. */
function dedupeRecords(records: readonly EvidenceRecord[]): readonly EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const record of records) if (!byId.has(record.recordId)) byId.set(record.recordId, record);
  return [...byId.values()];
}

// ── The waiver offer ─────────────────────────────────────────────────────────

/**
 * The obligations a single interactive waiver would cover, or none.
 *
 * The offer is all-or-nothing, and every condition is a conjunction: the run is
 * an interactive human; every blocked obligation permits waiving; and *every*
 * finding on *every* blocked obligation is one this obligation classifies
 * waivable. A single non-waivable finding — a malformed record, a
 * disallowed resolution, a code the config marks non-waivable — suppresses the
 * whole offer, because a waiver covering "most of it" is a waiver whose holder
 * was never told what the rest of it was.
 */
function waivableBlockedObligationIds(config: HarnessConfig, context: ExecutionContext, decision: GateDecision): readonly string[] {
  if (context.kind !== "human") return [];
  const blockedResolutions = decision.resolutions.filter((resolution): resolution is BlockedResolution => resolution.kind === "blocked");
  if (blockedResolutions.length === 0) return [];

  const obligationsById = new Map<string, ObligationPolicy>(config.obligations.map((obligation) => [obligation.id, obligation]));
  const fullyWaivable = blockedResolutions.every((resolution) => {
    const obligation = obligationsById.get(resolution.obligationId);
    if (obligation === undefined || !obligation.humanWaiverAllowed) return false;
    const waivable = new Set(obligation.waivableCodes);
    return resolution.blockers.every((blocker) => !NON_WAIVABLE_INTEGRITY_CODES.includes(blocker.code) && waivable.has(blocker.code));
  });

  return fullyWaivable ? blockedResolutions.map((resolution) => resolution.obligationId) : [];
}

/** The waiver binding: the candidate in the record store's flat spelling. */
function recordBindingOf(candidate: CapturedCandidate): RecordCandidateBinding {
  return {
    treeSha: candidate.treeSha,
    deliverableDigest: candidate.deliverable.digest,
    identityToken: candidate.deliverable.identity,
    baseRef: candidate.base.ref,
    baseTipSha: candidate.base.tipSha,
    mergeBaseSha: candidate.base.mergeBaseSha,
    workspaceId: candidate.workspaceId,
  };
}

/** The two captures name the same candidate — the freshness fields plus head and mode. */
function sameCandidate(expected: CapturedCandidate, observed: CapturedCandidate): boolean {
  return (
    classifyCandidateDrift(expected, observed).length === 0 &&
    expected.headSha === observed.headSha &&
    expected.mode === observed.mode &&
    expected.base.ref === observed.base.ref
  );
}

// ── The adapter ──────────────────────────────────────────────────────────────

const NOT_OFFERED = { waiver: "not_offered" as const, waivedObligationIds: [] as readonly string[], waiverRecordIds: [] as readonly string[] };

export async function runAdmission(input: AdmissionInput, options: AdmissionOptions): Promise<AdmissionResult> {
  try {
    return await admit(input, options);
  } catch (error) {
    // A store the harness could not resolve, read, or write raises a typed
    // BlockedError; anything else is an unexpected throw the command boundary
    // owns, so it propagates.
    if (!(error instanceof BlockedError)) throw error;
    return blocked({ ...NOT_OFFERED, blockers: error.blockers });
  }
}

async function admit(input: AdmissionInput, options: AdmissionOptions): Promise<AdmissionResult> {
  // ── 1. Capture ──
  const capture = await options.captureCandidate();
  if (!capture.ok) return blocked({ ...NOT_OFFERED, blockers: capture.blockers });
  const candidate = capture.candidate;

  // ── 2. Workspace coherence ──
  const storage = await resolveRecordStorage(input.rootDir, storageOptions(options));
  if (candidate.workspaceId !== storage.workspaceId) {
    return blocked({
      ...NOT_OFFERED,
      candidate,
      context: input.context,
      blockers: [workspaceIncoherentBlocker(input.config.gateId, candidate.workspaceId, storage.workspaceId)],
    });
  }

  // ── 3. The receipt gate ──
  const evaluateReceipt = options.evaluatePreparation ?? ((rootDir, config, current) =>
    evaluatePreparationReceipt(rootDir, { config, candidate: current }, { ...storageOptions(options), ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }) }));
  const preparation = await evaluateReceipt(input.rootDir, input.config, candidate);
  if (!preparation.prepared) {
    return blocked({ ...NOT_OFFERED, candidate, context: input.context, blockers: preparation.blockers });
  }

  // ── 4. Project, read, evaluate ──
  const projection = await options.projectActivation(candidate);
  const store = await mapStore(input, options, candidate);
  const firstPass = evaluateGate(gateInput(input, candidate, projection, store, [], []));

  if (firstPass.admitted) {
    return { admitted: true, blockers: [], decision: firstPass, context: input.context, candidate, ...NOT_OFFERED };
  }

  // ── 5. The two-pass waiver ──
  const covered = waivableBlockedObligationIds(input.config, input.context, firstPass);
  if (covered.length === 0 || options.promptForWaiver === undefined) {
    return blocked({ ...NOT_OFFERED, decision: firstPass, context: input.context, candidate, blockers: firstPass.blockers });
  }

  const accepted = await options.promptForWaiver(firstPass, covered);
  if (!accepted) {
    return blocked({
      waiver: "declined",
      waivedObligationIds: covered,
      waiverRecordIds: [],
      decision: firstPass,
      context: input.context,
      candidate,
      blockers: [...firstPass.blockers, waiverDeclinedBlocker(input.config.gateId, covered)],
    });
  }

  if (typeof accepted !== "object" || accepted === null ||
      typeof accepted.author !== "string" || !accepted.author.trim() || accepted.author.length > 256 ||
      typeof accepted.reason !== "string" || !accepted.reason.trim() || accepted.reason.length > 4096) {
    return blocked({ ...NOT_OFFERED, candidate, context: input.context, decision: firstPass,
      blockers: [...firstPass.blockers, createBlocker({ code: "waiver_attribution_invalid",
        source: { kind: "gate", id: input.config.gateId },
        summary: "A human exception requires an author and reason.",
        remediations: [{ id: "provide-attribution", kind: "manual_action", summary: "Provide bounded non-empty author and reason through the human waiver prompt." }],
      })] });
  }

  // The last observation before any write. A candidate that moved while the
  // prompt was open voids the offer, and nothing has been written yet.
  const recapture = await options.captureCandidate();
  const currentPreparation = recapture.ok ? await evaluateReceipt(input.rootDir, input.config, recapture.candidate) : undefined;
  if (!recapture.ok || !sameCandidate(candidate, recapture.candidate) || !currentPreparation?.prepared ||
      currentPreparation.receipt.preparationFingerprint !== preparation.receipt.preparationFingerprint) {
    return blocked({
      waiver: "candidate_changed",
      waivedObligationIds: covered,
      waiverRecordIds: [],
      decision: firstPass,
      context: input.context,
      candidate,
      blockers: [...firstPass.blockers, candidateChangedBlocker()],
    });
  }

  // Exact-candidate approvals survive the separate human `record` invocation.
  // Live obligations still require approval during each invocation.
  const currentStore = await mapStore(input, options, candidate);
  const currentPass = evaluateGate(gateInput(input, candidate, projection, currentStore, [], []));
  const findingScope = (decision: GateDecision) => decision.resolutions
    .filter((resolution): resolution is BlockedResolution => resolution.kind === "blocked")
    .map((resolution) => ({ obligationId: resolution.obligationId, codes: [...new Set(resolution.blockers.map((blocker) => blocker.code))].sort() }))
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  if (digestCanonical(findingScope(firstPass)) !== digestCanonical(findingScope(currentPass))) {
    return blocked({ waiver: "scope_changed", waivedObligationIds: [], waiverRecordIds: [], candidate, context: input.context, decision: currentPass,
      blockers: [...currentPass.blockers, createBlocker({ code: "waiver_scope_changed", source: { kind: "gate", id: input.config.gateId },
        summary: "The findings changed while the human exception was being approved.",
        remediations: [{ id: "reevaluate-waiver", kind: "manual_action", summary: "Run the gate again and review the current findings before approving an exception." }],
      })] });
  }
  const publishWaiver = options.publishWaiver ?? ((rootDir, binding, obligationId, resolution) =>
    publishRecord(rootDir, { gateId: input.config.gateId, obligationId, candidateBinding: binding, resolution }, storageOptions(options)));
  const binding = recordBindingOf(candidate);
  const published: EvidenceRecord[] = [];
  const grantedIds: string[] = [];
  for (const obligationId of covered) {
    const findingCodes = [...new Set(firstPass.resolutions.filter((r) => r.obligationId === obligationId && r.kind === "blocked")
      .flatMap((r) => r.kind === "blocked" ? r.blockers.map((b) => b.code) : []))].sort();
    const record = await publishWaiver(input.rootDir, binding, obligationId, {
      kind: "waiver", scope: input.config.obligations.find((o) => o.id === obligationId)?.freshness === "live" ? INVOCATION_WAIVER_SCOPE : "durable",
      author: accepted.author.trim(), reason: accepted.reason.trim(),
      findingCodes, policyDigest: digestCanonical(input.config),
    });
    published.push(record.record);
    grantedIds.push(record.record.recordId);
  }

  const finalStore = await mapStore(input, options, candidate);
  const secondPass = evaluateGate(gateInput(input, candidate, projection, finalStore, published, grantedIds));
  return {
    admitted: secondPass.admitted,
    blockers: secondPass.blockers,
    decision: secondPass,
    context: input.context,
    candidate,
    waiver: "accepted",
    waivedObligationIds: covered,
    waiverRecordIds: grantedIds,
  };
}
