/**
 * The gate evaluator's decision table, written before `evaluator.ts` existed.
 *
 * The evaluator is a pure function, so this file is a table and nothing else —
 * no filesystem, no repository, no clock. What it pins:
 *
 *   1. SIX OUTCOMES, NEVER INTERCHANGEABLE. Every kind has a scenario naming
 *      the input state that produces it, and the distinctness pairs assert the
 *      collapses that would be easiest to write by accident: a stale record is
 *      `blocked` and never `not_applicable`; an inactive obligation is
 *      `not_applicable` and never `satisfied_*`; an injected live result is
 *      `satisfied_live_fact` and never `satisfied_evidence`.
 *   2. FRESHNESS IS DELIVERABLE IDENTITY, AND ONLY HERE. The positive leniency
 *      (a raw tree that moved under an unchanged deliverable is fresh) is
 *      asserted beside its negative (an unchanged raw tree under a moved
 *      deliverable is stale), because a rule that only ever loosens is not a
 *      rule. Every other member of the tuple — base ref, base tip, merge base,
 *      workspace, identity token — gets a row, and the workspace row carries
 *      its falsification.
 *   3. THE WAIVER IS THE NARROWEST DOOR IN THE GATE. It opens for an
 *      interactive human, on an obligation whose config allows it, for a
 *      record whose scope covers this invocation, when every pending finding
 *      is classified waivable — and the cross-product asserts it stays shut on
 *      every other combination.
 *   4. A STORE THE HARNESS CANNOT FULLY READ IS NOT AN EMPTY STORE. A
 *      quarantined file attributed to an active obligation blocks ahead of
 *      both delegation and waiver, and the blocker names the file and the
 *      reason it was quarantined.
 *   5. THE BASE-MOVEMENT POLICY IS INVISIBLE. It is read by the delivery-record
 *      verifier and by nothing else, so the same scenario under both policies
 *      must produce byte-identical decisions — the negative reader claim,
 *      asserted rather than asserted-in-prose.
 *
 * Falsifications are inline: each one implements the weakened rule and shows
 * the scenario beside it discriminates between the two.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "./digest.ts";
import { GATE_STRUCTURAL_FINDING_CODES, renderBlockers, type Blocker } from "./blockers.ts";
import type { CandidateBinding, ReviewActivationProjection } from "./candidate.types.ts";
import {
  RESOLUTION_KINDS,
  defineHarnessConfig,
  emittableFindingCodes,
  type HarnessConfig,
  type HarnessConfigInput,
  type ObligationPolicy,
} from "./config.ts";
import type { ExecutionContext } from "./context.ts";
import type { EvidenceRecord, QuarantinedRecord, RecordCandidateBinding, WaiverScope } from "./records.types.ts";
import {
  RESOLUTION_OUTCOMES,
  enforceAllowedResolution,
  evaluateGate,
  isRecordFreshForCandidate,
  type EvaluateGateInput,
  type GateDecision,
  type LiveProviderFinding,
  type LiveProviderResult,
  type ObligationResolution,
  type UnreadableRecordInput,
} from "./evaluator.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROVIDER_REGISTRY = [
  { id: "review.provider", findingCodes: ["review-incomplete"] },
  { id: "second.provider", findingCodes: ["second-incomplete"] },
] as const;

/**
 * The classification every fixture obligation carries unless a row says
 * otherwise. Structural codes that describe a store the harness cannot trust
 * are non-waivable; the rest are waivable, so the waiver rows exercise the
 * open door and the non-waivable rows exercise the shut one.
 */
const DEFAULT_NON_WAIVABLE = ["ambiguous_records", "malformed_record", "unknown_provider", "resolution_not_allowed"];

function codesFor(
  providerIds: readonly string[],
  nonWaivable: readonly string[] = DEFAULT_NON_WAIVABLE,
): { waivableCodes: string[]; nonWaivableCodes: string[] } {
  const providerCodes = providerIds.flatMap(
    (id) => PROVIDER_REGISTRY.find((provider) => provider.id === id)?.findingCodes ?? [],
  );
  const universe = [...GATE_STRUCTURAL_FINDING_CODES, ...providerCodes];
  return {
    waivableCodes: universe.filter((code) => !nonWaivable.includes(code)),
    nonWaivableCodes: universe.filter((code) => nonWaivable.includes(code)),
  };
}

interface ObligationSpec {
  readonly id?: string;
  readonly activation?: "always" | "relevant_change";
  readonly freshness?: "live" | "exact_candidate";
  readonly providers?: readonly string[];
  readonly humanWaiverAllowed?: boolean;
  readonly allowedResolutionKinds?: readonly ObligationPolicy["allowedResolutionKinds"][number][];
  readonly ciDelegationPolicyIds?: readonly string[];
  readonly providerPolicy?: ObligationPolicy["providerPolicy"];
  readonly nonWaivable?: readonly string[];
  readonly remediationByCode?: Readonly<Record<string, ObligationPolicy["remediation"]["default"]>>;
}

function obligation(spec: ObligationSpec = {}): ObligationPolicy {
  const providers = spec.providers ?? ["review.provider"];
  const humanWaiverAllowed = spec.humanWaiverAllowed ?? true;
  const allowed =
    spec.allowedResolutionKinds ??
    (["satisfied_live_fact", "satisfied_evidence", "delegated", "not_applicable", ...(humanWaiverAllowed ? (["waived"] as const) : [])] as const);
  return {
    id: spec.id ?? "review.green",
    activation: { kind: spec.activation ?? "always" },
    freshness: spec.freshness ?? "exact_candidate",
    providers,
    acceptedPayloadSpecs: ["review.green/1"],
    allowedResolutionKinds: [...allowed],
    humanWaiverAllowed,
    minimumAttestationLevel: "self",
    ciDelegationPolicyIds: [...(spec.ciDelegationPolicyIds ?? [])],
    ...(spec.providerPolicy === undefined ? {} : { providerPolicy: spec.providerPolicy }),
    remediation: {
      default: [{ id: "complete-the-review", kind: "manual_action", summary: "Complete a final green review." }],
      ...(spec.remediationByCode === undefined ? {} : { byCode: spec.remediationByCode }),
    },
    ...codesFor(providers, spec.nonWaivable),
  };
}

function testConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["test-tree/v1"],
    computingIdentityVersion: "test-tree/v1",
    reviewNeutral: [{ prefix: "docs/narration/" }, { prefix: "delivery/records/" }],
    recordNeutral: [{ prefix: "delivery/records/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [{ id: "auth", patterns: [{ kind: "prefix", value: "src/auth/" }] }],
    activationThreshold: 10,
    providers: PROVIDER_REGISTRY.map((provider) => ({ id: provider.id, findingCodes: [...provider.findingCodes] })),
    agentEnvSignals: ["TEST_AGENT"],
    ciPolicies: [
      { id: "pr-tests", requiredEnv: [{ variable: "TEST_CI", equals: "true" }] },
      { id: "nightly", requiredEnv: [{ variable: "TEST_NIGHTLY", equals: "true" }] },
    ],
    ciPolicyEnvKey: "TEST_HARNESS_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [obligation()],
    deliveryRecordPath: "delivery/records/record.json",
    ...overrides,
  });
}

const CANDIDATE: CandidateBinding = {
  treeSha: "a".repeat(40),
  deliverable: { digest: "d".repeat(64), identity: "test-tree/v1" },
  base: { ref: "origin/main", tipSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) },
  workspaceId: "w".repeat(64),
};

function boundTo(overrides: Partial<RecordCandidateBinding> = {}, candidate: CandidateBinding = CANDIDATE): RecordCandidateBinding {
  return {
    treeSha: candidate.treeSha,
    deliverableDigest: candidate.deliverable.digest,
    identityToken: candidate.deliverable.identity,
    baseRef: candidate.base.ref,
    baseTipSha: candidate.base.tipSha,
    mergeBaseSha: candidate.base.mergeBaseSha,
    workspaceId: candidate.workspaceId,
    ...overrides,
  };
}

function evidence(
  spec: {
    readonly recordId?: string;
    readonly gateId?: string;
    readonly obligationId?: string;
    readonly providerId?: string;
    readonly runId?: string;
    readonly finalPassId?: string;
    readonly binding?: RecordCandidateBinding;
  } = {},
): EvidenceRecord {
  return {
    schemaVersion: 1,
    recordId: spec.recordId ?? "record-1",
    workspaceId: CANDIDATE.workspaceId,
    gateId: spec.gateId ?? "test.gate",
    obligationId: spec.obligationId ?? "review.green",
    candidateBinding: spec.binding ?? boundTo(),
    resolution: {
      kind: "evidence",
      providerId: spec.providerId ?? "review.provider",
      runId: spec.runId ?? "run-1",
      finalPassId: spec.finalPassId ?? "pass-1",
      manifestDigest: "f".repeat(64),
    },
  };
}

function waiver(
  spec: {
    readonly recordId?: string;
    readonly gateId?: string;
    readonly obligationId?: string;
    readonly scope?: WaiverScope;
    readonly config?: HarnessConfig;
    readonly findingCodes?: readonly string[];
    readonly binding?: RecordCandidateBinding;
  } = {},
): EvidenceRecord {
  return {
    schemaVersion: 1,
    recordId: spec.recordId ?? "waiver-1",
    workspaceId: CANDIDATE.workspaceId,
    gateId: spec.gateId ?? "test.gate",
    obligationId: spec.obligationId ?? "review.green",
    candidateBinding: spec.binding ?? boundTo(),
    resolution: { kind: "waiver", scope: spec.scope ?? "durable", author: "Test Operator", reason: "Explicit exception", findingCodes: spec.findingCodes ?? ["review_evidence_missing", "live_provider_missing"], policyDigest: digestCanonical(spec.config ?? testConfig()) },
  };
}

const ACTIVE_PROJECTION: ReviewActivationProjection = {
  relevantLineCount: 40,
  relevantPaths: ["src/app.ts"],
  excludedPaths: [],
  binaryPaths: [],
  sensitivePathIds: [],
  hasRelevantBinaryChange: false,
  hasRelevantZeroLineChange: false,
  changedEntryCount: 1,
};

const INERT_PROJECTION: ReviewActivationProjection = {
  relevantLineCount: 0,
  relevantPaths: [],
  excludedPaths: ["generated/client.ts"],
  binaryPaths: [],
  sensitivePathIds: [],
  hasRelevantBinaryChange: false,
  hasRelevantZeroLineChange: false,
  changedEntryCount: 1,
};

const CI: ExecutionContext = { kind: "ci", policyId: "pr-tests", requiredEnv: [{ variable: "TEST_CI", equals: "true" }] };
const AGENT: ExecutionContext = { kind: "agent", signal: "TEST_AGENT" };
const HUMAN: ExecutionContext = { kind: "human", interactive: true };
const UNKNOWN: ExecutionContext = { kind: "unknown", reason: "noninteractive_unrecognized" };

function evaluate(overrides: Partial<EvaluateGateInput> & { readonly config: HarnessConfig }): GateDecision {
  return evaluateGate({
    candidate: CANDIDATE,
    projection: ACTIVE_PROJECTION,
    context: UNKNOWN,
    records: [],
    ...overrides,
  });
}

/** The single resolution of a single-obligation scenario. */
function only(decision: GateDecision): ObligationResolution {
  expect(decision.resolutions).toHaveLength(1);
  return decision.resolutions[0] as ObligationResolution;
}

function codesOf(decision: GateDecision): string[] {
  return decision.blockers.map((blocker: Blocker) => blocker.code);
}

const GREEN_RESULT: LiveProviderResult = {
  providerId: "review.provider",
  runId: "live-1",
  status: "green",
  findings: [],
};

describe("opt-in scoped freshness", () => {
  const scope = { version: "scoped-check/1" as const, files: ["src/app.ts"], memberships: ["tests/"], tests: [], cwd: ".", profile: "local", environment: [] };
  const binding = { definitionDigest: "a".repeat(64), validationDigest: "b".repeat(64), policyDigest: "c".repeat(64), wiringFingerprint: "d".repeat(64), outputsDigest: "e".repeat(64), scopedInputDigest: "b".repeat(64), scopedAttemptDigest: "f".repeat(64), scopedProfileDigest: "d".repeat(64) };
  function fixture(scoped = true) {
    const check = { command: ["test"] as [string], timeoutMs: 1000, ...(scoped ? { scope } : {}) };
    const config = testConfig({ providers: [{ id: "review.provider", findingCodes: ["review-incomplete"], check }], obligations: [{ ...obligation(), acceptedPayloadSpecs: ["checks.passed/1"] }] });
    const record = evidence({ binding: boundTo({ treeSha: "1".repeat(40), deliverableDigest: "2".repeat(64), baseTipSha: "3".repeat(40), mergeBaseSha: "4".repeat(40) }) });
    if (record.resolution.kind !== "evidence") throw new Error("fixture");
    return { config, record: { ...record, resolution: { ...record.resolution, checkBinding: binding } } };
  }
  it("reuses scoped evidence after candidate/base movement only with current matching bindings", () => {
    const { config, record } = fixture();
    expect(evaluate({ config, records: [record], checkBindings: { "review.provider": binding } }).admitted).toBe(true);
    expect(evaluate({ config, records: [record], checkBindings: {} }).admitted).toBe(false);
    for (const key of Object.keys(binding)) {
      expect(evaluate({ config, records: [record], checkBindings: { "review.provider": { ...binding, [key]: "0".repeat(64) } } }).admitted).toBe(false);
    }
    expect(evaluate({ config, records: [{ ...record, candidateBinding: { ...record.candidateBinding, workspaceId: "elsewhere" } }], checkBindings: { "review.provider": binding } }).admitted).toBe(false);
  });
  it("does not widen legacy or independent review freshness", () => {
    const { config, record } = fixture(false);
    expect(evaluate({ config, records: [record], checkBindings: { "review.provider": binding } }).admitted).toBe(false);
    expect(evaluate({ config: testConfig(), records: [record], checkBindings: { "review.provider": binding } }).admitted).toBe(false);
  });
});

// ── One scenario per outcome ───────────────────────────────────────────────

describe("the six outcomes", () => {
  it("resolves fresh approved evidence as satisfied_evidence", () => {
    const decision = evaluate({ config: testConfig(), records: [evidence()] });
    expect(only(decision)).toEqual({
      kind: "satisfied_evidence",
      gateId: "test.gate",
      obligationId: "review.green",
      providerId: "review.provider",
      recordId: "record-1",
      runId: "run-1",
      finalPassId: "pass-1",
      candidateBinding: boundTo(),
    });
    expect(decision.admitted).toBe(true);
  });

  it("resolves an injected green live result as satisfied_live_fact", () => {
    const config = testConfig({ obligations: [obligation({ freshness: "live" })] });
    const decision = evaluate({ config, liveResults: [GREEN_RESULT] });
    expect(only(decision)).toEqual({
      kind: "satisfied_live_fact",
      gateId: "test.gate",
      obligationId: "review.green",
      providerId: "review.provider",
      runId: "live-1",
    });
    expect(decision.admitted).toBe(true);
  });

  it("resolves an honored waiver as waived", () => {
    const decision = evaluate({ config: testConfig(), context: HUMAN, records: [waiver()] });
    expect(only(decision)).toEqual({
      kind: "waived",
      gateId: "test.gate",
      obligationId: "review.green",
      waiverRecordId: "waiver-1",
      scope: "durable",
      waiver: waiver().resolution,
      candidateBinding: boundTo(),
    });
    expect(decision.admitted).toBe(true);
  });

  it("resolves a declared CI policy as delegated", () => {
    const config = testConfig({ obligations: [obligation({ ciDelegationPolicyIds: ["pr-tests"] })] });
    const decision = evaluate({ config, context: CI });
    expect(only(decision)).toEqual({
      kind: "delegated",
      gateId: "test.gate",
      obligationId: "review.green",
      ciPolicyId: "pr-tests",
    });
    expect(decision.admitted).toBe(true);
  });

  it("resolves an unactivated obligation as not_applicable", () => {
    const config = testConfig({ obligations: [obligation({ activation: "relevant_change" })] });
    const decision = evaluate({ config, projection: INERT_PROJECTION });
    const resolution = only(decision);
    expect(resolution.kind).toBe("not_applicable");
    expect(resolution).toEqual({
      kind: "not_applicable",
      gateId: "test.gate",
      obligationId: "review.green",
      activation: INERT_PROJECTION,
    });
    expect(decision.admitted).toBe(true);
  });

  it("resolves an active obligation with nothing behind it as blocked", () => {
    const decision = evaluate({ config: testConfig() });
    const resolution = only(decision);
    expect(resolution.kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["review_evidence_missing"]);
    expect(decision.admitted).toBe(false);
  });

  it("declares exactly the config's resolution kinds plus blocked", () => {
    expect([...RESOLUTION_OUTCOMES]).toEqual([...RESOLUTION_KINDS, "blocked"]);
  });

  it("reaches every declared outcome across the scenarios above", () => {
    const reached = new Set<string>([
      only(evaluate({ config: testConfig(), records: [evidence()] })).kind,
      only(evaluate({ config: testConfig({ obligations: [obligation({ freshness: "live" })] }), liveResults: [GREEN_RESULT] })).kind,
      only(evaluate({ config: testConfig(), context: HUMAN, records: [waiver()] })).kind,
      only(evaluate({ config: testConfig({ obligations: [obligation({ ciDelegationPolicyIds: ["pr-tests"] })] }), context: CI })).kind,
      only(evaluate({ config: testConfig({ obligations: [obligation({ activation: "relevant_change" })] }), projection: INERT_PROJECTION })).kind,
      only(evaluate({ config: testConfig() })).kind,
    ]);
    expect([...RESOLUTION_OUTCOMES].filter((outcome) => !reached.has(outcome))).toEqual([]);
  });
});

// ── Distinctness ───────────────────────────────────────────────────────────

describe("outcomes never collapse into one another", () => {
  it("keeps a live fact distinct from recorded evidence", () => {
    const live = only(
      evaluate({ config: testConfig({ obligations: [obligation({ freshness: "live" })] }), liveResults: [GREEN_RESULT] }),
    );
    const recorded = only(evaluate({ config: testConfig(), records: [evidence()] }));
    expect(live.kind).toBe("satisfied_live_fact");
    expect(recorded.kind).toBe("satisfied_evidence");
    expect(live.kind).not.toBe(recorded.kind);
    expect(Object.keys(live)).not.toContain("recordId");
  });

  it("does not admit a live obligation from a record, nor a recorded one from a live result", () => {
    const liveConfig = testConfig({ obligations: [obligation({ freshness: "live" })] });
    expect(only(evaluate({ config: liveConfig, records: [evidence()] })).kind).toBe("blocked");
    expect(only(evaluate({ config: testConfig(), liveResults: [GREEN_RESULT] })).kind).toBe("blocked");
  });

  it("blocks on stale evidence rather than calling the obligation inapplicable", () => {
    const stale = evidence({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) });
    const resolution = only(evaluate({ config: testConfig(), records: [stale] }));
    expect(resolution.kind).toBe("blocked");
    expect(resolution.kind).not.toBe("not_applicable");
  });

  it("calls an inactive obligation inapplicable rather than satisfied", () => {
    const config = testConfig({ obligations: [obligation({ activation: "relevant_change" })] });
    const resolution = only(evaluate({ config, projection: INERT_PROJECTION }));
    expect(resolution.kind).toBe("not_applicable");
    expect(resolution.kind).not.toBe("satisfied_evidence");
    expect(resolution.kind).not.toBe("satisfied_live_fact");
  });

  it("does not let an inactive obligation consume evidence", () => {
    const config = testConfig({ obligations: [obligation({ activation: "relevant_change" })] });
    const resolution = only(evaluate({ config, projection: INERT_PROJECTION, records: [evidence()] }));
    expect(resolution.kind).toBe("not_applicable");
  });
});

// ── Freshness ──────────────────────────────────────────────────────────────

describe("freshness is deliverable identity, not the raw tree", () => {
  it("accepts a record whose raw tree moved under an unchanged deliverable", () => {
    const moved = evidence({ binding: boundTo({ treeSha: "9".repeat(40) }) });
    expect(isRecordFreshForCandidate(testConfig(), moved.candidateBinding, CANDIDATE)).toBe(true);
    expect(only(evaluate({ config: testConfig(), records: [moved] })).kind).toBe("satisfied_evidence");
  });

  /**
   * Two codes, not one, and both are load-bearing: the record that was found is
   * stale, *and* the approved provider consequently has nothing fresh. An
   * operator who is only told the second would go looking for a record that is
   * sitting right there.
   */
  it("rejects a record whose deliverable moved under an unchanged raw tree", () => {
    const moved = evidence({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) });
    expect(isRecordFreshForCandidate(testConfig(), moved.candidateBinding, CANDIDATE)).toBe(false);
    expect(codesOf(evaluate({ config: testConfig(), records: [moved] }))).toEqual([
      "stale_evidence",
      "review_evidence_missing",
    ]);
  });

  it.each([
    { member: "baseRef", binding: boundTo({ baseRef: "origin/release" }) },
    { member: "baseTipSha", binding: boundTo({ baseTipSha: "0".repeat(40) }) },
    { member: "mergeBaseSha", binding: boundTo({ mergeBaseSha: "0".repeat(40) }) },
    { member: "workspaceId", binding: boundTo({ workspaceId: "z".repeat(64) }) },
    { member: "identityToken", binding: boundTo({ identityToken: "other-tree/v1" }) },
    { member: "deliverableDigest (empty)", binding: boundTo({ deliverableDigest: "" }) },
  ])("stales a record whose $member differs", ({ binding }) => {
    expect(isRecordFreshForCandidate(testConfig(), binding, CANDIDATE)).toBe(false);
    expect(codesOf(evaluate({ config: testConfig(), records: [evidence({ binding })] }))).toEqual([
      "stale_evidence",
      "review_evidence_missing",
    ]);
  });

  it("fails closed when the candidate names an identity token the config does not accept", () => {
    const foreign: CandidateBinding = { ...CANDIDATE, deliverable: { ...CANDIDATE.deliverable, identity: "unknown-tree/v9" } };
    const record = evidence({ binding: boundTo({ identityToken: "unknown-tree/v9" }, foreign) });
    expect(isRecordFreshForCandidate(testConfig(), record.candidateBinding, foreign)).toBe(false);
    expect(codesOf(evaluate({ config: testConfig(), candidate: foreign, records: [record] }))).toEqual([
      "stale_evidence",
      "review_evidence_missing",
    ]);
  });

  /**
   * FALSIFICATION. A freshness tuple that forgets the workspace admits evidence
   * produced in a different checkout of the same commits — the case the store
   * is deliberately workspace-private to prevent.
   */
  it("FALSIFICATION: dropping the workspace from the tuple admits a foreign workspace's evidence", () => {
    const foreignWorkspace = boundTo({ workspaceId: "z".repeat(64) });
    const withoutWorkspace = (recorded: RecordCandidateBinding, candidate: CandidateBinding): boolean =>
      recorded.identityToken === candidate.deliverable.identity &&
      recorded.deliverableDigest === candidate.deliverable.digest &&
      recorded.baseRef === candidate.base.ref &&
      recorded.baseTipSha === candidate.base.tipSha &&
      recorded.mergeBaseSha === candidate.base.mergeBaseSha;
    expect(withoutWorkspace(foreignWorkspace, CANDIDATE)).toBe(true);
    expect(isRecordFreshForCandidate(testConfig(), foreignWorkspace, CANDIDATE)).toBe(false);
  });

  it("ignores records belonging to another gate or another obligation", () => {
    const decision = evaluate({
      config: testConfig(),
      records: [evidence({ gateId: "other.gate" }), evidence({ obligationId: "other.obligation" })],
    });
    expect(codesOf(decision)).toEqual(["review_evidence_missing"]);
  });

  it("rejects evidence from a provider the obligation does not approve", () => {
    const decision = evaluate({ config: testConfig(), records: [evidence({ providerId: "second.provider" })] });
    expect(codesOf(decision)).toContain("unknown_provider");
    expect(only(decision).kind).toBe("blocked");
  });
});

// ── Ambiguity ──────────────────────────────────────────────────────────────

describe("two records in one provider run slot", () => {
  /**
   * The gate-time leniency creates this case and nothing else does: two records
   * whose deliverable identity agrees but whose raw trees differ are two
   * content-addressed ids in one semantic slot, and the gate cannot choose
   * between them.
   */
  const slotConflict = [
    evidence({ recordId: "record-1" }),
    evidence({ recordId: "record-2", binding: boundTo({ treeSha: "9".repeat(40) }) }),
  ];

  it("is ambiguous rather than resolved by picking one", () => {
    const decision = evaluate({ config: testConfig(), records: slotConflict });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["ambiguous_records"]);
  });

  it("is not waivable, even for an interactive human holding a waiver", () => {
    const decision = evaluate({ config: testConfig(), context: HUMAN, records: [...slotConflict, waiver()] });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["ambiguous_records"]);
  });

  it("is not delegable", () => {
    const config = testConfig({ obligations: [obligation({ ciDelegationPolicyIds: ["pr-tests"] })] });
    const decision = evaluate({ config, context: CI, records: slotConflict });
    expect(only(decision).kind).toBe("blocked");
  });

  it("does not fire for two records in different slots", () => {
    const decision = evaluate({
      config: testConfig(),
      records: [evidence({ recordId: "record-1" }), evidence({ recordId: "record-2", runId: "run-2" })],
    });
    expect(only(decision).kind).toBe("satisfied_evidence");
  });
});

// ── The provider quantifier ────────────────────────────────────────────────

describe("an obligation naming several providers", () => {
  const bothProviders = testConfig({ obligations: [obligation({ providers: ["review.provider", "second.provider"] })] });

  it("requires every configured provider to be satisfied by evidence", () => {
    const decision = evaluate({ config: bothProviders, records: [evidence()] });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["review_evidence_missing"]);
    expect(decision.blockers[0]?.summary).toContain("second.provider");
  });

  it("is satisfied when every configured provider has fresh evidence", () => {
    const decision = evaluate({
      config: bothProviders,
      records: [evidence(), evidence({ recordId: "record-2", providerId: "second.provider", runId: "run-2" })],
    });
    expect(only(decision).kind).toBe("satisfied_evidence");
  });

  it("requires every configured provider to return a green live result", () => {
    const config = testConfig({
      obligations: [obligation({ freshness: "live", providers: ["review.provider", "second.provider"] })],
    });
    expect(only(evaluate({ config, liveResults: [GREEN_RESULT] })).kind).toBe("blocked");
    expect(codesOf(evaluate({ config, liveResults: [GREEN_RESULT] }))).toEqual(["live_provider_missing"]);
    expect(
      only(
        evaluate({
          config,
          liveResults: [GREEN_RESULT, { providerId: "second.provider", runId: "live-2", status: "green", findings: [] }],
        }),
      ).kind,
    ).toBe("satisfied_live_fact");
  });

  it("reads an explicit \"all\" policy as exactly the default quantifier", () => {
    const config = testConfig({
      obligations: [obligation({ providers: ["review.provider", "second.provider"], providerPolicy: "all" })],
    });
    const decision = evaluate({ config, records: [evidence()] });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["review_evidence_missing"]);
  });

  it("satisfies an existential obligation on evidence from any one approved provider", () => {
    const config = testConfig({
      obligations: [obligation({ providers: ["review.provider", "second.provider"], providerPolicy: "existential" })],
    });
    const decision = evaluate({ config, records: [evidence()] });
    const resolution = only(decision);
    expect(resolution.kind).toBe("satisfied_evidence");
    if (resolution.kind !== "satisfied_evidence") return;
    expect(resolution.providerId).toBe("review.provider");
  });

  it("still blocks an existential obligation when no approved provider is covered", () => {
    const config = testConfig({
      obligations: [obligation({ providers: ["review.provider", "second.provider"], providerPolicy: "existential" })],
    });
    const decision = evaluate({ config, records: [] });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["review_evidence_missing", "review_evidence_missing"]);
  });

  it("satisfies an existential live obligation on one green result, keeping the other provider's absence as a diagnostic", () => {
    const config = testConfig({
      obligations: [obligation({ freshness: "live", providers: ["review.provider", "second.provider"], providerPolicy: "existential" })],
    });
    const decision = evaluate({ config, liveResults: [GREEN_RESULT] });
    const resolution = only(decision);
    expect(resolution.kind).toBe("satisfied_live_fact");
    expect(decision.admitted).toBe(true);
    // The uncovered provider is still on the record: admitted, not erased.
    expect(decision.diagnostics.map((entry) => entry.code)).toContain("live_provider_missing");
  });

  it("still blocks an existential live obligation when every result is a failure", () => {
    const config = testConfig({
      obligations: [obligation({ freshness: "live", providers: ["review.provider", "second.provider"], providerPolicy: "existential" })],
    });
    const decision = evaluate({
      config,
      liveResults: [{ providerId: "review.provider", runId: "live-1", status: "failed", findings: [] }],
    });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["live_provider_failed", "live_provider_missing"]);
  });

  // ── The zero-provider corner ─────────────────────────────────────────────
  //
  // An obligation naming no providers loads (the config surface has no
  // minimum-length invariant) and has an empty residue under either policy —
  // vacuously "all covered", trivially short of "one covered". Admission is
  // refused by the guards downstream of the residue instead: the live path's
  // `providers.length > 0` conjunct and the recorded path's requirement that a
  // satisfied obligation name an actual record. These rows pin that fail-closed
  // outcome for all four combinations, so a refactor of either guard cannot
  // quietly turn the empty residue into an admission.

  for (const providerPolicy of ["all", "existential"] as const) {
    it(`blocks a recorded obligation naming no providers under "${providerPolicy}"`, () => {
      const config = testConfig({ obligations: [obligation({ providers: [], providerPolicy })] });
      const bare = evaluate({ config, records: [] });
      expect(only(bare).kind).toBe("blocked");
      expect(bare.admitted).toBe(false);
      expect(codesOf(bare)).toContain("review_evidence_missing");
      // A fresh green record on hand changes nothing: with no approved
      // provider it is an unknown-provider record, never an admission.
      const withRecord = evaluate({ config, records: [evidence()] });
      expect(only(withRecord).kind).toBe("blocked");
      expect(withRecord.admitted).toBe(false);
      expect(codesOf(withRecord)).toContain("unknown_provider");
    });

    it(`blocks a live obligation naming no providers under "${providerPolicy}"`, () => {
      const config = testConfig({ obligations: [obligation({ freshness: "live", providers: [], providerPolicy })] });
      const decision = evaluate({ config, liveResults: [GREEN_RESULT] });
      expect(only(decision).kind).toBe("blocked");
      expect(decision.admitted).toBe(false);
      expect(codesOf(decision)).toContain("live_provider_missing");
    });
  }
});

// ── Live results ───────────────────────────────────────────────────────────

describe("live provider results", () => {
  const liveConfig = testConfig({ obligations: [obligation({ freshness: "live" })] });

  it("blocks when a configured provider returned nothing", () => {
    expect(codesOf(evaluate({ config: liveConfig }))).toEqual(["live_provider_missing"]);
  });

  it("blocks when a configured provider returned twice", () => {
    const decision = evaluate({ config: liveConfig, liveResults: [GREEN_RESULT, { ...GREEN_RESULT, runId: "live-2" }] });
    expect(codesOf(decision)).toEqual(["ambiguous_live_provider"]);
  });

  it("blocks with the provider's own findings when it reports them", () => {
    const decision = evaluate({
      config: liveConfig,
      liveResults: [
        {
          providerId: "review.provider",
          runId: "live-1",
          status: "failed",
          findings: [{ code: "review-incomplete", summary: "Two files were never opened." }],
        },
      ],
    });
    expect(codesOf(decision)).toEqual(["review-incomplete"]);
    expect(decision.blockers[0]?.source).toEqual({ kind: "provider", id: "review.provider" });
  });

  it("blocks with a structural code when a provider fails without a finding", () => {
    const decision = evaluate({
      config: liveConfig,
      liveResults: [{ providerId: "review.provider", runId: "live-1", status: "failed", findings: [] }],
    });
    expect(codesOf(decision)).toEqual(["live_provider_failed"]);
  });

  it("treats a green status carrying findings as a failure", () => {
    const decision = evaluate({
      config: liveConfig,
      liveResults: [
        {
          providerId: "review.provider",
          runId: "live-1",
          status: "green",
          findings: [{ code: "review-incomplete", summary: "Green, with an unresolved finding." }],
        },
      ],
    });
    expect(only(decision).kind).toBe("blocked");
  });

  it("ignores results from providers the obligation does not name", () => {
    const decision = evaluate({
      config: liveConfig,
      liveResults: [GREEN_RESULT, { providerId: "second.provider", runId: "live-2", status: "failed", findings: [] }],
    });
    expect(only(decision).kind).toBe("satisfied_live_fact");
  });
});

// ── Provider-authored text is data, not vocabulary ─────────────────────────

/**
 * A live result is the one input to this module that a provider authored, and
 * both of its text fields land somewhere structural: the code becomes a blocker
 * code, which has a grammar, and it is also what the config's waivable /
 * non-waivable partition is applied to. Neither can be taken on trust.
 *
 * A code the registered provider did not declare is refused for the same reason
 * an ill-formed one is: the partition is computed over the codes the config
 * declares, so a code outside that set is a finding no obligation ever
 * classified, and it would reach the waiver check as neither waivable nor
 * non-waivable. Refusing it keeps the emittable universe closed.
 */
describe("a provider's own finding codes", () => {
  const liveConfig = testConfig({ obligations: [obligation({ freshness: "live" })] });

  function reporting(reported: LiveProviderFinding): GateDecision {
    return evaluate({
      config: liveConfig,
      liveResults: [{ providerId: "review.provider", runId: "live-1", status: "failed", findings: [reported] }],
    });
  }

  it.each([
    { name: "capitals and a space", reported: { code: "Review Failed", summary: "Two files were never opened." } },
    { name: "an empty code", reported: { code: "", summary: "Two files were never opened." } },
    { name: "a doubled separator", reported: { code: "review..bad", summary: "Two files were never opened." } },
    { name: "a trailing separator", reported: { code: "review-incomplete-", summary: "Two files were never opened." } },
    { name: "an empty summary", reported: { code: "review-incomplete", summary: "" } },
    { name: "a whitespace-only summary", reported: { code: "review-incomplete", summary: "   " } },
    { name: "a well-formed code the provider never declared", reported: { code: "not-declared", summary: "Something else." } },
  ])("reports $name structurally instead of throwing", ({ reported }) => {
    let decision: GateDecision | undefined;
    expect(() => {
      decision = reporting(reported);
    }).not.toThrow();
    const settled = decision as GateDecision;
    expect(only(settled).kind).toBe("blocked");
    expect(codesOf(settled)).toEqual(["live_provider_failed"]);
  });

  it("keeps the refused text as operator-facing detail rather than discarding it", () => {
    const decision = reporting({ code: "not-declared", summary: "The provider had its own opinion." });
    const rendered = renderBlockers(decision.blockers);
    expect(rendered).toContain("not-declared");
    expect(rendered).toContain("The provider had its own opinion.");
  });

  it("never lets an undeclared code out as a blocker code", () => {
    const decision = reporting({ code: "not-declared", summary: "Something else." });
    expect(codesOf(decision)).not.toContain("not-declared");
    const universe = new Set(emittableFindingCodes(liveConfig, "review.green"));
    for (const code of codesOf(decision)) expect([...universe]).toContain(code);
  });

  /**
   * The escape this closes: `not-declared` is in neither list, so a waiver
   * check that saw it would have to decide about a code the config never
   * classified. Refused at the door, the pending finding is
   * `live_provider_failed`, which the fixture classifies waivable — so the
   * human path stays open for a *classified* failure and closed for an
   * unclassifiable one.
   */
  it("keeps a refused code inside the config's partition", () => {
    const obligationPolicy = liveConfig.obligations[0] as (typeof liveConfig.obligations)[number];
    expect(obligationPolicy.waivableCodes).not.toContain("not-declared");
    expect(obligationPolicy.nonWaivableCodes).not.toContain("not-declared");
    const decision = evaluate({
      config: liveConfig,
      context: HUMAN,
      liveResults: [{ providerId: "review.provider", runId: "live-1", status: "failed", findings: [{ code: "not-declared", summary: "Something else." }] }],
      records: [waiver({ config: liveConfig, findingCodes: ["live_provider_failed"], scope: "invocation" })],
      invocationWaiverRecordIds: ["waiver-1"],
    });
    expect(only(decision).kind).toBe("waived");
  });

  it("still accepts a code the registered provider declares", () => {
    const decision = reporting({ code: "review-incomplete", summary: "Two files were never opened." });
    expect(codesOf(decision)).toEqual(["review-incomplete"]);
    expect(decision.blockers[0]?.source).toEqual({ kind: "provider", id: "review.provider" });
  });

  it("refuses a code another provider declares but this one does not", () => {
    const decision = reporting({ code: "second-incomplete", summary: "Borrowed from the other provider." });
    expect(codesOf(decision)).toEqual(["live_provider_failed"]);
  });
});

// ── Waivers ────────────────────────────────────────────────────────────────

describe("waiver scoping", () => {
  it("rejects a waiver after policy changes even when its candidate is unchanged", () => {
    const config = testConfig({ activationThreshold: 1 });
    expect(only(evaluate({ config, context: HUMAN, records: [waiver()] })).kind).toBe("blocked");
    expect(only(evaluate({ config, context: HUMAN, records: [waiver({ config })] })).kind).toBe("waived");
  });

  it("rejects an exception for a different finding on the same candidate", () => {
    expect(only(evaluate({ config: testConfig(), context: HUMAN,
      records: [waiver({ findingCodes: ["live_provider_missing"] })],
    })).kind).toBe("blocked");
  });

  it("cannot waive stale evidence even when policy lists its code as waivable", () => {
    const config = testConfig();
    expect(config.obligations[0]!.waivableCodes).toContain("stale_evidence");
    const decision = evaluate({ config, context: HUMAN,
      records: [evidence({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) }),
        waiver({ findingCodes: ["stale_evidence"] })],
    });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toContain("stale_evidence");
  });

  it("honors a durable waiver on a candidate-bound obligation", () => {
    const decision = evaluate({ config: testConfig(), context: HUMAN, records: [waiver({ scope: "durable" })] });
    expect(only(decision).kind).toBe("waived");
  });

  it("does not honor a durable waiver on a live obligation", () => {
    const config = testConfig({ obligations: [obligation({ freshness: "live" })] });
    const decision = evaluate({ config, context: HUMAN, records: [waiver({ config, scope: "durable" })] });
    expect(only(decision).kind).toBe("blocked");
  });

  it("rejects raw-tree-only movement of an otherwise current human approval", () => {
    const config = testConfig();
    expect(evaluate({ config, context: HUMAN, records: [waiver({ config })] }).admitted).toBe(true);
    const changed = waiver({ config, binding: { ...boundTo(), treeSha: "different-raw-tree" } });
    expect(evaluate({ config, context: HUMAN, records: [changed] }).admitted).toBe(false);
  });

  it("honors an invocation waiver this invocation granted", () => {
    const decision = evaluate({
      config: testConfig({ obligations: [obligation({ freshness: "live" })] }),
      context: HUMAN,
      records: [waiver({ config: testConfig({ obligations: [obligation({ freshness: "live" })] }), scope: "invocation" })],
      invocationWaiverRecordIds: ["waiver-1"],
    });
    expect(only(decision).kind).toBe("waived");
  });

  it("leaves a prior invocation's waiver inert on a new invocation", () => {
    const records = [waiver({ scope: "invocation" })];
    for (const config of [testConfig(), testConfig({ obligations: [obligation({ freshness: "live" })] })]) {
      const decision = evaluate({ config, context: HUMAN, records, invocationWaiverRecordIds: [] });
      expect(only(decision).kind).toBe("blocked");
    }
  });

  it("ignores a waiver bound to a different candidate", () => {
    const decision = evaluate({
      config: testConfig(),
      context: HUMAN,
      records: [waiver({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) })],
    });
    expect(only(decision).kind).toBe("blocked");
  });

  it("ignores a waiver for another gate or another obligation", () => {
    const decision = evaluate({
      config: testConfig(),
      context: HUMAN,
      records: [waiver({ gateId: "other.gate" }), waiver({ recordId: "waiver-2", obligationId: "other.obligation" })],
    });
    expect(only(decision).kind).toBe("blocked");
  });

  it("refuses to waive a non-waivable finding even for an interactive human", () => {
    const config = testConfig({
      obligations: [obligation({ nonWaivable: [...DEFAULT_NON_WAIVABLE, "review_evidence_missing"] })],
    });
    const decision = evaluate({ config, context: HUMAN, records: [waiver()] });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["review_evidence_missing"]);
  });

  it("is all-or-nothing: one non-waivable finding suppresses the waiver for the whole obligation", () => {
    const config = testConfig({
      obligations: [
        obligation({
          providers: ["review.provider", "second.provider"],
          nonWaivable: [...DEFAULT_NON_WAIVABLE, "stale_evidence"],
        }),
      ],
    });
    const decision = evaluate({
      config,
      context: HUMAN,
      // One provider is merely missing (waivable); the other's record is stale
      // (classified non-waivable by this obligation).
      records: [evidence({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) }), waiver()],
    });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toContain("stale_evidence");
  });

  it("never waives for a non-human context", () => {
    for (const context of [AGENT, CI, UNKNOWN]) {
      const decision = evaluate({ config: testConfig(), context, records: [waiver()] });
      expect(only(decision).kind, `context ${context.kind}`).toBe("blocked");
    }
  });

  /**
   * The cross-product. CI delegation is switched off in this config so the only
   * dimension moving is the waiver: an obligation kind, the config flag that
   * governs waiving it, and who is asking.
   */
  const CROSS_PRODUCT_CONTEXTS: readonly ExecutionContext[] = [AGENT, HUMAN, CI, UNKNOWN];

  it.each(
    (["exact_candidate", "live"] as const).flatMap((freshness) =>
      [true, false].flatMap((humanWaiverAllowed) =>
        CROSS_PRODUCT_CONTEXTS.map((context) => ({
          freshness,
          humanWaiverAllowed,
          context,
          expected: humanWaiverAllowed && context.kind === "human" ? "waived" : "blocked",
        })),
      ),
    ),
  )("$freshness × humanWaiverAllowed=$humanWaiverAllowed × $context.kind → $expected", ({ freshness, humanWaiverAllowed, context, expected }) => {
    const config = testConfig({
      obligations: [obligation({ freshness, humanWaiverAllowed, ciDelegationPolicyIds: [] })],
    });
    const decision = evaluate({
      config,
      context,
      records: [waiver({ config, scope: freshness === "live" ? "invocation" : "durable" })],
      invocationWaiverRecordIds: ["waiver-1"],
    });
    expect(only(decision).kind).toBe(expected);
  });
});

// ── Delegation ─────────────────────────────────────────────────────────────

describe("CI delegation", () => {
  const delegating = testConfig({ obligations: [obligation({ ciDelegationPolicyIds: ["pr-tests"] })] });

  it("delegates only when the obligation names the matched policy", () => {
    expect(only(evaluate({ config: delegating, context: CI })).kind).toBe("delegated");
  });

  it("is a near miss when the obligation names a different policy", () => {
    const other = testConfig({ obligations: [obligation({ ciDelegationPolicyIds: ["nightly"] })] });
    expect(only(evaluate({ config: other, context: CI })).kind).toBe("blocked");
  });

  it("is a near miss when the matched policy is not declared by the config", () => {
    const foreign: ExecutionContext = { kind: "ci", policyId: "not-declared", requiredEnv: [] };
    expect(only(evaluate({ config: delegating, context: foreign })).kind).toBe("blocked");
  });

  it("does not delegate for an unauthorized automation", () => {
    const unauthorized: ExecutionContext = { kind: "unknown", reason: "unauthorized_automation" };
    expect(only(evaluate({ config: delegating, context: unauthorized })).kind).toBe("blocked");
  });

  it("does not delegate a live obligation: CI is where the live result comes from", () => {
    const live = testConfig({ obligations: [obligation({ freshness: "live", ciDelegationPolicyIds: ["pr-tests"] })] });
    expect(only(evaluate({ config: live, context: CI })).kind).toBe("blocked");
    expect(only(evaluate({ config: live, context: CI, liveResults: [GREEN_RESULT] })).kind).toBe("satisfied_live_fact");
  });

  it("prefers fresh evidence to delegation", () => {
    expect(only(evaluate({ config: delegating, context: CI, records: [evidence()] })).kind).toBe("satisfied_evidence");
  });
});

// ── Allowed resolution kinds ───────────────────────────────────────────────

describe("enforceAllowedResolution", () => {
  const disallowing = obligation({
    ciDelegationPolicyIds: ["pr-tests"],
    allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
  });

  it("blocks a resolution the obligation does not permit", () => {
    const delegated = {
      kind: "delegated",
      gateId: "test.gate",
      obligationId: "review.green",
      ciPolicyId: "pr-tests",
    } as const;
    const enforced = enforceAllowedResolution(disallowing, delegated);
    expect(enforced.kind).toBe("blocked");
    expect(enforced.kind === "blocked" ? enforced.blockers.map((blocker) => blocker.code) : []).toEqual([
      "resolution_not_allowed",
    ]);
  });

  it("passes a permitted resolution through unchanged", () => {
    const evidenceResolution = {
      kind: "satisfied_evidence",
      gateId: "test.gate",
      obligationId: "review.green",
      providerId: "review.provider",
      recordId: "record-1",
      runId: "run-1",
      finalPassId: "pass-1",
      candidateBinding: boundTo(),
    } as const;
    expect(enforceAllowedResolution(disallowing, evidenceResolution)).toBe(evidenceResolution);
  });

  it("never re-blocks an already blocked resolution", () => {
    const blocked = only(evaluate({ config: testConfig({ obligations: [disallowing] }) }));
    expect(blocked.kind).toBe("blocked");
    expect(blocked.kind === "blocked" ? blocked.blockers.map((blocker) => blocker.code) : []).toEqual([
      "review_evidence_missing",
    ]);
  });

  it("applies end to end", () => {
    const decision = evaluate({ config: testConfig({ obligations: [disallowing] }), context: CI });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["resolution_not_allowed"]);
  });

  /**
   * FALSIFICATION. Without the enforcement the same input delegates, which is
   * the obligation's policy being ignored rather than applied.
   */
  it("FALSIFICATION: a pass-through enforcement admits the disallowed delegation", () => {
    const passThrough = (_obligation: ObligationPolicy, resolution: ObligationResolution): ObligationResolution => resolution;
    const delegated = {
      kind: "delegated",
      gateId: "test.gate",
      obligationId: "review.green",
      ciPolicyId: "pr-tests",
    } as const;
    expect(passThrough(disallowing, delegated).kind).toBe("delegated");
    expect(enforceAllowedResolution(disallowing, delegated).kind).toBe("blocked");
  });
});

// ── Quarantine, across the store seam ──────────────────────────────────────

describe("a quarantined file in the store", () => {
  const quarantined: QuarantinedRecord = {
    path: ".git/delivery-harness/records/test.gate--review.green--record-9.json",
    reason: "identity_mismatch",
    detail: "the stored content does not digest to the id it is filed under",
  };

  const attributed: UnreadableRecordInput = {
    gateId: "test.gate",
    obligationId: "review.green",
    appliesToCandidate: true,
    quarantined,
  };

  it("blocks the obligation and names the file and the reason", () => {
    const decision = evaluate({ config: testConfig(), unreadable: [attributed] });
    expect(only(decision).kind).toBe("blocked");
    expect(codesOf(decision)).toEqual(["malformed_record"]);
    const rendered = renderBlockers(decision.blockers);
    expect(rendered).toContain("record-9");
    expect(rendered).toContain("identity_mismatch");
  });

  it("blocks ahead of both delegation and the waiver", () => {
    const config = testConfig({ obligations: [obligation({ ciDelegationPolicyIds: ["pr-tests"] })] });
    expect(only(evaluate({ config, context: CI, unreadable: [attributed] })).kind).toBe("blocked");
    expect(only(evaluate({ config, context: HUMAN, records: [waiver()], unreadable: [attributed] })).kind).toBe("blocked");
  });

  it("is inert when it could not be attributed to this candidate", () => {
    const unattributed: UnreadableRecordInput = { ...attributed, appliesToCandidate: false };
    const decision = evaluate({ config: testConfig(), unreadable: [unattributed] });
    expect(codesOf(decision)).toEqual(["review_evidence_missing"]);
    expect(only(evaluate({ config: testConfig(), records: [evidence()], unreadable: [unattributed] })).kind).toBe(
      "satisfied_evidence",
    );
  });

  it("is inert for another gate or another obligation", () => {
    const decision = evaluate({
      config: testConfig(),
      records: [evidence()],
      unreadable: [
        { ...attributed, gateId: "other.gate" },
        { ...attributed, obligationId: "other.obligation" },
      ],
    });
    expect(only(decision).kind).toBe("satisfied_evidence");
  });

  it("is a diagnostic rather than a block when fresh evidence still satisfies the obligation", () => {
    const decision = evaluate({ config: testConfig(), records: [evidence()], unreadable: [attributed] });
    expect(only(decision).kind).toBe("satisfied_evidence");
    expect(decision.diagnostics.map((finding) => finding.code)).toEqual(["malformed_record"]);
  });
});

// ── The base-movement policy is not read here ──────────────────────────────

describe("deliveryRecordVerification.baseMovement", () => {
  const stale = testConfig({ deliveryRecordVerification: { baseMovement: "stale" } });
  const allow = testConfig({ deliveryRecordVerification: { baseMovement: "allow" } });

  /** A candidate whose base tip moved after the evidence was recorded. */
  const drifted = evidence({ binding: boundTo({ baseTipSha: "0".repeat(40) }) });

  it("differs between the two fixtures, so the comparison below is not vacuous", () => {
    expect(stale.deliveryRecordVerification.baseMovement).toBe("stale");
    expect(allow.deliveryRecordVerification.baseMovement).toBe("allow");
  });

  it("changes nothing the evaluator returns", () => {
    const underStale = evaluate({ config: stale, records: [drifted] });
    const underAllow = evaluate({ config: allow, records: [drifted] });
    expect(underStale.admitted).toBe(false);
    expect(underStale.resolutions).toEqual(underAllow.resolutions);
    expect(underStale.blockers).toEqual(underAllow.blockers);
    expect(underStale.diagnostics).toEqual(underAllow.diagnostics);
  });

  /**
   * FALSIFICATION. An evaluator that consulted the policy would admit under
   * `"allow"`, making the local gate more permissive than the Action — which is
   * exactly the asymmetry the member is kept out of this module to prevent.
   */
  it("FALSIFICATION: an evaluator that branched on the policy would admit the drifted candidate", () => {
    const branching = (config: HarnessConfig): boolean =>
      config.deliveryRecordVerification.baseMovement === "allow"
        ? true
        : evaluate({ config, records: [drifted] }).admitted;
    expect(branching(allow)).toBe(true);
    expect(evaluate({ config: allow, records: [drifted] }).admitted).toBe(false);
  });
});

// ── The blocker contract ───────────────────────────────────────────────────

describe("blocked resolutions speak only through typed blockers", () => {
  it("carries no free-text explanation member", () => {
    const blocked = only(evaluate({ config: testConfig() }));
    expect(Object.keys(blocked).sort()).toEqual(["blockers", "gateId", "kind", "obligationId"]);
  });

  it("emits only codes the obligation declares it can emit", () => {
    const config = testConfig();
    const universe = new Set(emittableFindingCodes(config, "review.green"));
    const decisions = [
      evaluate({ config }),
      evaluate({ config, records: [evidence({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) })] }),
      evaluate({ config, records: [evidence({ providerId: "second.provider" })] }),
      evaluate({
        config,
        records: [evidence(), evidence({ recordId: "record-2", binding: boundTo({ treeSha: "9".repeat(40) }) })],
      }),
      evaluate({
        config: testConfig({ obligations: [obligation({ freshness: "live" })] }),
        liveResults: [
          {
            providerId: "review.provider",
            runId: "live-1",
            status: "failed",
            findings: [{ code: "review-incomplete", summary: "Two files were never opened." }],
          },
        ],
      }),
    ];
    for (const decision of decisions) {
      for (const code of codesOf(decision)) expect([...universe]).toContain(code);
    }
  });

  it("attributes structural findings to the obligation and provider findings to the provider", () => {
    const structural = evaluate({ config: testConfig() });
    expect(structural.blockers[0]?.source).toEqual({ kind: "obligation", id: "review.green" });
  });

  it("draws remediations from the config catalog, per code when one is keyed", () => {
    const config = testConfig({
      obligations: [
        obligation({
          remediationByCode: {
            review_evidence_missing: [
              { id: "submit-the-evidence", kind: "command", command: ["harness", "submit-evidence"], summary: "Submit the review evidence." },
            ],
          },
        }),
      ],
    });
    const decision = evaluate({ config });
    expect(decision.blockers[0]?.remediations.map((remediation) => remediation.id)).toEqual(["submit-the-evidence"]);

    const stale = evaluate({ config, records: [evidence({ binding: boundTo({ deliverableDigest: "e".repeat(64) }) })] });
    expect(stale.blockers[0]?.remediations.map((remediation) => remediation.id)).toEqual(["complete-the-review"]);
  });

  it("renders every blocker it can produce without throwing", () => {
    const decision = evaluate({ config: testConfig() });
    expect(renderBlockers(decision.blockers)).toContain("review_evidence_missing");
  });
});

// ── The gate as a whole ────────────────────────────────────────────────────

describe("the gate decision", () => {
  const twoObligations = testConfig({
    obligations: [obligation({ id: "review.green" }), obligation({ id: "docs.current", providers: ["second.provider"] })],
  });

  it("resolves every declared obligation, in config order", () => {
    const decision = evaluate({ config: twoObligations, records: [evidence()] });
    expect(decision.resolutions.map((resolution) => resolution.obligationId)).toEqual(["review.green", "docs.current"]);
    expect(decision.resolutions.map((resolution) => resolution.kind)).toEqual(["satisfied_evidence", "blocked"]);
  });

  it("admits only when no obligation is blocked", () => {
    const blockedDecision = evaluate({ config: twoObligations, records: [evidence()] });
    expect(blockedDecision.admitted).toBe(false);
    expect(blockedDecision.blockers).toHaveLength(1);

    const admitted = evaluate({
      config: twoObligations,
      records: [evidence(), evidence({ recordId: "record-2", obligationId: "docs.current", providerId: "second.provider" })],
    });
    expect(admitted.admitted).toBe(true);
    expect(admitted.blockers).toEqual([]);
  });

  it("echoes the gate id and the candidate it judged", () => {
    const decision = evaluate({ config: testConfig(), records: [evidence()] });
    expect(decision.gateId).toBe("test.gate");
    expect(decision.candidate).toEqual(CANDIDATE);
  });

  it("keeps non-blocking findings as diagnostics rather than dropping them", () => {
    const decision = evaluate({
      config: testConfig(),
      records: [evidence(), evidence({ recordId: "record-2", binding: boundTo({ baseTipSha: "0".repeat(40) }) })],
    });
    expect(only(decision).kind).toBe("satisfied_evidence");
    expect(decision.diagnostics.map((finding) => finding.code)).toEqual(["stale_evidence"]);
    expect(decision.blockers).toEqual([]);
  });
});


describe("installed data applicability records", () => {
  const resourceBinding = { version: "installed-data-binding/1" as const, candidateDigest: "a".repeat(64), definitionDigest: "b".repeat(64), declarationDigest: "c".repeat(64), sourceApplicabilityDigest: "d".repeat(64), captureDigest: "e".repeat(64), originDigest: "f".repeat(64) };
  const check = { command: ["test"] as [string], timeoutMs: 1000, scope: { version: "scoped-check/1" as const, files: ["src/app.ts"], memberships: [], tests: [], cwd: ".", profile: "local", environment: [] } };
  function fixture(spec = "installed-data.applicable/1") {
    const original = testConfig();
    const config = { ...original, providers: [{ id: "review.provider", findingCodes: ["review-incomplete"], check }], obligations: [{ ...obligation(), acceptedPayloadSpecs: [spec] }] };
    const base = evidence();
    if (base.resolution.kind !== "evidence") throw Error("fixture");
    return { config, record: { ...base, resolution: { ...base.resolution, resourceBinding } } };
  }
  it("requires current resource authority independently of ordinary check bindings", () => {
    const { config, record } = fixture();
    expect(evaluate({ config, records: [record], resourceBindings: { "review.provider": resourceBinding } }).admitted).toBe(true);
    expect(evaluate({ config, records: [record] }).admitted).toBe(false);
    for (const key of Object.keys(resourceBinding).filter(key => key !== "version")) {
      expect(evaluate({ config, records: [record], resourceBindings: { "review.provider": { ...resourceBinding, [key]: "0".repeat(64) } } }).admitted, key).toBe(false);
    }
  });
  it("never transports resource evidence across candidate movement or substitutes it for check success", () => {
    const { config, record } = fixture();
    const moved = { ...record, candidateBinding: { ...record.candidateBinding, deliverableDigest: "0".repeat(64) } };
    expect(evaluate({ config, records: [moved], resourceBindings: { "review.provider": resourceBinding } }).admitted).toBe(false);
    expect(evaluate({ config: fixture("checks.passed/1").config, records: [record], resourceBindings: { "review.provider": resourceBinding } }).admitted).toBe(false);
    const ordinary = { ...record, resolution: { ...record.resolution, resourceBinding: undefined, checkBinding: { definitionDigest: "a".repeat(64), validationDigest: "b".repeat(64), policyDigest: "c".repeat(64), wiringFingerprint: "d".repeat(64), outputsDigest: "e".repeat(64) } } };
    expect(evaluate({ config, records: [ordinary], checkBindings: { "review.provider": ordinary.resolution.checkBinding }, resourceBindings: { "review.provider": resourceBinding } }).admitted).toBe(false);
  });
});
