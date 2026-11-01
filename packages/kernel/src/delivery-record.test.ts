/**
 * The delivery-record produce path and the pure verification core.
 *
 * Everything here is effect-free: records and decisions are constructed by hand,
 * so the suite is a decision table over the drift classes, the base-movement
 * policy, multi-record selection, and the produce/parse round-trip. The
 * git-bound end-to-end proof (a real record written and verified in a temp repo,
 * plus self-neutrality) lives in the CLI suite.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical, manifestDigest as digestManifest, sha256Hex } from "./digest.ts";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "./config.ts";
import { evaluateGate, RESOLUTION_OUTCOMES, type GateDecision, type ObligationResolution } from "./evaluator.ts";
import type { CandidateBinding } from "./candidate.types.ts";
import type { EvidenceRecord, RecordCandidateBinding } from "./records.types.ts";
import {
  DELIVERY_RECORD_VERSION,
  bindingOf,
  buildDeliveryRecord as buildRecord,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  parseDeliveryRecord,
  selectDeliveryRecordForIdentity,
  DELIVERY_OWNED_TREE_PREFIXES,
  CLAUDE_SKILL_EXPOSURE_PREFIX,
  parseCandidateTreeListing,
  needsCommittedSymlinkTarget,
  RECEIPTED_SKILLS_ROOT,
  verifyDeliveryRecord as verifyRecord,
  type DeliveryRecord,
  type RecordedHostedCheckExemption,
} from "./delivery-record.ts";
import { computeRecordId } from "./record-identity.ts";
import { compileRepositoryPolicy, PORTABLE_STAGE_GRANT, type CompiledPolicy } from "./policy/compile.ts";
import { compositionPersonaSetFixture, policyDocumentFixture, repositoryAdapterSetFixture } from "./policy/fixtures.ts";
import { RUN_JOURNAL_REQUIRED_ENTRIES, RUN_JOURNAL_VIOLATIONS } from "./checkpoint/run-journal-completeness.ts";

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DIGEST = "a".repeat(64);
const TOKEN = "deliverable-tree/v1";
const V1_NEUTRAL = [
  { prefix: "docs/reports/" },
  { prefix: "docs/solutions/" },
  { prefix: "telemetry/delivery-runs/" },
] as const;

const STRUCTURAL_WAIVABLE = ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"];
const STRUCTURAL_NONWAIVABLE = [
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
];

function obligation(id: string): HarnessConfigInput["obligations"][number] {
  return {
    id,
    activation: { kind: "relevant_change" },
    freshness: "exact_candidate",
    providers: ["p.reviewer"],
    acceptedPayloadSpecs: ["review.green/1"],
    allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
    humanWaiverAllowed: true,
    minimumAttestationLevel: "self",
    ciDelegationPolicyIds: [],
    remediation: { default: [{ id: "fix-it", kind: "manual_action", summary: "Fix it." }] },
    waivableCodes: [...STRUCTURAL_WAIVABLE],
    nonWaivableCodes: [...STRUCTURAL_NONWAIVABLE],
  };
}

function makeConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    baseRef: "origin/main",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: [TOKEN],
    computingIdentityVersion: TOKEN,
    reviewNeutral: [...V1_NEUTRAL],
    recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    providers: [{ id: "p.reviewer", findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [obligation("review.green")],
    deliveryRecordPath: "telemetry/delivery-runs/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
    ...overrides,
  });
}

const CANDIDATE: CandidateBinding = {
  treeSha: "1".repeat(40),
  deliverable: { digest: DIGEST, identity: TOKEN },
  base: { ref: "origin/main", tipSha: "b".repeat(40), mergeBaseSha: "2".repeat(40) },
  workspaceId: "w-source",
};

const RECORD_BINDING: RecordCandidateBinding = {
  treeSha: CANDIDATE.treeSha,
  deliverableDigest: DIGEST,
  identityToken: TOKEN,
  baseRef: "origin/main",
  baseTipSha: "b".repeat(40),
  mergeBaseSha: "2".repeat(40),
  workspaceId: "w-source",
};

function evidenceResolution(obligationId: string, recordId: string): ObligationResolution {
  return {
    gateId: "test.gate",
    obligationId,
    kind: "satisfied_evidence",
    providerId: "p.reviewer",
    recordId,
    runId: "run-1",
    finalPassId: "pass-2",
    candidateBinding: RECORD_BINDING,
  };
}

function evidenceRecord(obligationId: string, _recordId: string, _manifestDigest: string, config = makeConfig(), providerId = "p.reviewer"): EvidenceRecord {
  const provider = { id: providerId, runId: "run-1", finalPassId: "pass-2", version: "1" };
  const candidate = { vcs: "git", ...CANDIDATE };
  const bytes = JSON.stringify({ schemaVersion: 1, reviewerId: "correctness", result: "approved", provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId }, workspaceId: candidate.workspaceId, candidate });
  const manifest = { spec: "delivery-evidence/1", provider, candidate, repository: null, recordedAt: "2026-09-06T00:00:00Z",
    runHistory: [{ preparedTreeSha: candidate.treeSha, evaluatedInPassId: provider.finalPassId }], attestation: { level: "self", signatures: [] },
    artifacts: [{ path: "reviewers/correctness.json", sha256: sha256Hex(bytes), role: "reviewer-approval" }],
    claims: [{ obligation: obligationId, payloadSpec: "review.green/1", payload: { verdict: "green", finalized: true, editedAfterFinalPass: false,
      reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] }, findings: [],
      telemetry: { iterationCount: 1, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] } } }] };
  const input = { workspaceId: "w-source", gateId: "test.gate", obligationId, candidateBinding: RECORD_BINDING,
    resolution: { kind: "evidence" as const, providerId: provider.id, runId: provider.runId, finalPassId: provider.finalPassId, manifestDigest: digestManifest(manifest),
      portable: { version: "portable-evidence/1" as const, manifest, artifacts: { "reviewers/correctness.json": Buffer.from(bytes).toString("base64") }, context: contextFor(config) } } };
  return { ...input, schemaVersion: 1, recordId: computeRecordId(input.workspaceId, input) };
}
function contextFor(config: HarnessConfig) {
  return { configurationDigest: digestCanonical(config), preparationFingerprint: "f".repeat(64), policyDigest: null, release: null, workflowGraphSha256: null, reviewerCharters: [] };
}
/** Drift tests supply current observations explicitly; integration tests exercise their capture. */
function verifyDeliveryRecord(...args: Parameters<typeof verifyRecord>) {
  const [config, record, identity, base, options = {}] = args;
  return verifyRecord(config, record, identity, base, { evidenceContext: contextFor(config),
    projection: { relevantLineCount: 1, relevantPaths: ["src.ts"], excludedPaths: [], binaryPaths: [], sensitivePathIds: [], hasRelevantBinaryChange: false, hasRelevantZeroLineChange: false, changedEntryCount: 1 },
    executionContext: { kind: "agent", signal: "CLAUDE_CODE" }, ...options });
}
function buildDeliveryRecord(input: Parameters<typeof buildRecord>[0]) {
  const evidenceRecords = input.evidenceRecords;
  const resolutions = input.decision.resolutions.map(resolution => {
    const evidence = evidenceRecords.find(record => record.obligationId === resolution.obligationId);
    return resolution.kind === "satisfied_evidence" && evidence !== undefined ? { ...resolution, recordId: evidence.recordId } : resolution;
  });
  return buildRecord({ ...input, context: contextFor(input.config), decision: { ...input.decision, resolutions } });
}

function admittedDecision(resolutions: readonly ObligationResolution[]): GateDecision {
  return { gateId: "test.gate", candidate: CANDIDATE, admitted: true, resolutions, diagnostics: [], blockers: [] };
}

const RECOMPUTED = { deliverableDigest: DIGEST, identityToken: TOKEN };
const FRESH_BASE = { ref: "origin/main", tipSha: "b".repeat(40), mergeBaseSha: "2".repeat(40) };

function buildFreshRecord(config = makeConfig()): DeliveryRecord {
  const built = buildDeliveryRecord({
    config,
    decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
    evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64), config)],
  });
  if (!built.ok) throw new Error("expected build to succeed");
  return built.record;
}

function compiledHostedPolicy(baseRef = "origin/main", until = "2026-09-12T00:00:00Z"): CompiledPolicy {
  const result = compileRepositoryPolicy({
    document: policyDocumentFixture({
      repositoryId: "test-repo",
      hostedChecks: { required: true, exemptions: [{
        scope: { repositoryId: "test-repo", baseRef },
        reason: "Hosted runners are unavailable while billing is repaired.",
        grantedBy: "repository-owner@example.com",
        until,
      }] },
    }),
    adapters: repositoryAdapterSetFixture(),
    personas: compositionPersonaSetFixture(),
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.compiled;
}

const hostedExemptionMutations = [
  {
    field: "reason",
    mutate: (exemption: RecordedHostedCheckExemption) => ({ ...exemption, reason: "A different owner reason." }),
  },
  {
    field: "grantedBy",
    mutate: (exemption: RecordedHostedCheckExemption) => ({ ...exemption, grantedBy: "another-owner@example.com" }),
  },
  {
    field: "scope.repositoryId",
    mutate: (exemption: RecordedHostedCheckExemption) => ({
      ...exemption,
      scope: { ...exemption.scope, repositoryId: "another-repo" },
    }),
  },
  {
    field: "scope.baseRef",
    mutate: (exemption: RecordedHostedCheckExemption) => ({
      ...exemption,
      scope: { ...exemption.scope, baseRef: "origin/release" },
    }),
  },
  {
    field: "until",
    mutate: (exemption: RecordedHostedCheckExemption) => ({ ...exemption, until: "2026-09-11T00:00:00Z" }),
  },
  {
    field: "policyDigest",
    mutate: (exemption: RecordedHostedCheckExemption) => ({ ...exemption, policyDigest: "f".repeat(64) }),
  },
] satisfies readonly {
  readonly field: string;
  readonly mutate: (exemption: RecordedHostedCheckExemption) => RecordedHostedCheckExemption;
}[];

// ── bindingOf + path ─────────────────────────────────────────────────────────

describe("bindingOf", () => {
  it("flattens the evaluator candidate onto the record binding", () => {
    expect(bindingOf(CANDIDATE)).toEqual(RECORD_BINDING);
  });
});

describe("deliveryRecordPathFor", () => {
  it("splices the digest before the extension and stays under the configured prefix", () => {
    const config = makeConfig();
    const derived = deliveryRecordPathFor(config, DIGEST);
    expect(derived).toBe(`telemetry/delivery-runs/record--${DIGEST}.json`);
    // Neutral to both predicates, exactly like the configured path.
    expect(derived.startsWith("telemetry/delivery-runs/")).toBe(true);
    expect(derived.endsWith(".json")).toBe(true);
  });

  it("keys distinct deliverables to distinct files (merge-conflict-free)", () => {
    const config = makeConfig();
    expect(deliveryRecordPathFor(config, "a".repeat(64))).not.toBe(deliveryRecordPathFor(config, "b".repeat(64)));
  });
});

// ── build ────────────────────────────────────────────────────────────────────

describe("buildDeliveryRecord", () => {
  it("retains every provider selected by the existing all-provider evaluator", () => {
    const config = makeConfig({ providers: [{ id: "p.reviewer", findingCodes: [] }, { id: "p.security", findingCodes: [] }],
      obligations: [{ ...obligation("review.green"), providers: ["p.reviewer", "p.security"] }] });
    const evidenceRecords = [evidenceRecord("review.green", "", "", config), evidenceRecord("review.green", "", "", config, "p.security")];
    const projection = { relevantLineCount: 1, relevantPaths: ["src.ts"], excludedPaths: [], binaryPaths: [], sensitivePathIds: [], hasRelevantBinaryChange: false, hasRelevantZeroLineChange: false, changedEntryCount: 1 };
    const decision = evaluateGate({ config, candidate: CANDIDATE, projection, context: { kind: "agent", signal: "fixture" }, records: evidenceRecords });
    expect(decision.admitted).toBe(true);
    const built = buildDeliveryRecord({ config, decision, evidenceRecords });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.claims[0]?.supportingEvidence).toHaveLength(1);
    expect(built.record.manifestDigest).toBeNull();
    expect(verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE).ok).toBe(true);
    const { integrityDigest: _, ...changed } = { ...built.record, claims: [{ ...built.record.claims[0]!, supportingEvidence: [] }], manifestDigest: built.record.claims[0]!.manifestDigest! };
    const result = verifyDeliveryRecord(config, { ...changed, integrityDigest: digestCanonical(changed) }, RECOMPUTED, FRESH_BASE);
    expect(result.ok).toBe(false);
    expect(result.blockers.map(blocker => blocker.code)).toContain("review_evidence_missing");
  });

  it("promotes an admitted decision, stamping evidence claims with their manifest digest", () => {
    const built = buildDeliveryRecord({
      config: makeConfig(),
      decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
      evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64))],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.version).toBe(DELIVERY_RECORD_VERSION);
    expect(built.record.gateId).toBe("test.gate");
    expect(built.record.attestation.level).toBe("self");
    expect(built.record.claims).toHaveLength(1);
    expect(built.record.claims[0]).toMatchObject({
      obligationId: "review.green",
      outcome: "satisfied_evidence",
      recordId: evidenceRecord("review.green", "rec-1", "").recordId,
      manifestDigest: built.record.claims[0]!.evidence!.resolution.kind === "evidence" ? built.record.claims[0]!.evidence!.resolution.manifestDigest : "",
    });
    expect(built.record.manifestDigest).toBe(built.record.claims[0]!.manifestDigest);
    expect(built.record.candidateBinding).toEqual(RECORD_BINDING);
  });

  it("refuses to build from a decision that did not admit", () => {
    const built = buildDeliveryRecord({
      config: makeConfig(),
      decision: { ...admittedDecision([]), admitted: false },
      evidenceRecords: [],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.blockers[0]?.source.kind).toBe("delivery-record");
  });

  it("refuses a decision carrying a blocked obligation", () => {
    const blocked: ObligationResolution = {
      gateId: "test.gate",
      obligationId: "review.green",
      kind: "blocked",
      blockers: [
        {
          code: "stale_evidence",
          source: { kind: "obligation", id: "review.green" },
          summary: "stale",
          remediations: [{ id: "fix", kind: "manual_action", summary: "fix" }],
        },
      ],
    };
    const built = buildDeliveryRecord({
      config: makeConfig(),
      decision: { ...admittedDecision([blocked]), admitted: false },
      evidenceRecords: [],
    });
    expect(built.ok).toBe(false);
  });
});

// ── bytes ────────────────────────────────────────────────────────────────────

describe("deliveryRecordBytes", () => {
  it("is deterministic and newline-terminated", () => {
    const record = buildFreshRecord();
    const first = deliveryRecordBytes(record);
    const second = deliveryRecordBytes(record);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("round-trips through parseDeliveryRecord", () => {
    const record = buildFreshRecord();
    const parsed = parseDeliveryRecord(deliveryRecordBytes(record));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual(record);
  });
});

// ── parse ────────────────────────────────────────────────────────────────────

describe("parseDeliveryRecord", () => {
  it.each(["delivery-record/1", DELIVERY_RECORD_VERSION])("rejects mismatched identity tokens in %s at parse", (version) => {
    const record = { ...buildFreshRecord(), version, identityToken: "bogus/v9" };
    const parsed = parseDeliveryRecord(JSON.stringify(record));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.blockers[0]?.code).toBe("delivery_record_malformed");
  });

  it.each(["satisfied_evidence", "not_applicable"])("rejects duplicate claims even when the second outcome is %s", (outcome) => {
    const record = buildFreshRecord();
    const parsed = parseDeliveryRecord(JSON.stringify({ ...record, claims: [record.claims[0], { ...record.claims[0], outcome }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.blockers[0]?.code).toBe("delivery_record_malformed");
  });

  it("rejects non-JSON as a finding, never a skip", () => {
    const parsed = parseDeliveryRecord("{ not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.blockers[0]?.source.kind).toBe("delivery-record");
  });

  it("rejects an unsupported version token", () => {
    const record = { ...buildFreshRecord(), version: "delivery-record/9" };
    const parsed = parseDeliveryRecord(`${JSON.stringify(record)}\n`);
    expect(parsed.ok).toBe(false);
  });

  it("rejects a structurally broken record", () => {
    const parsed = parseDeliveryRecord(JSON.stringify({ version: DELIVERY_RECORD_VERSION }));
    expect(parsed.ok).toBe(false);
  });

  // A committed record is operator-editable text. An outcome is not free-form
  // prose — it is the vocabulary the verifier reasons about — so a value outside
  // the resolution universe must be a malformed record rather than something the
  // verifier waves through because it merely "is a non-empty string".
  it("rejects an invented claim outcome", () => {
    const record = buildFreshRecord();
    const tampered = {
      ...record,
      claims: [{ ...record.claims[0], outcome: "rubber_stamped" }],
    };
    const parsed = parseDeliveryRecord(`${JSON.stringify(tampered)}\n`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.blockers[0]?.code).toBe("delivery_record_malformed");
  });

  /**
   * THE SPAN IS OPERATOR-EDITABLE TEXT TOO. `runSpan` is optional, so the
   * absent case must parse; every other shape a hand-edited record can carry
   * there must not, or `verify`'s later comparison reads members it never
   * checked. One vector per rejection branch, and the accept side pinned
   * beside them so a guard that refused everything would fail here.
   */
  it("accepts a well-formed run span and rejects every other shape of one", () => {
    const record = buildFreshRecord();
    const withSpan = (runSpan: unknown) => parseDeliveryRecord(`${JSON.stringify({ ...record, runSpan })}\n`);

    expect(parseDeliveryRecord(`${JSON.stringify(record)}\n`).ok, "an absent span parses").toBe(true);
    expect(withSpan({ startedAt: "2026-09-15T09:00:00Z", endedAt: "2026-09-15T15:00:00Z" }).ok).toBe(true);
    // Equal instants are a span: a record written in the same second the run
    // started is not malformed.
    expect(withSpan({ startedAt: "2026-09-15T09:00:00Z", endedAt: "2026-09-15T09:00:00Z" }).ok).toBe(true);

    for (const rejected of [
      // Out of order.
      { startedAt: "2026-09-15T15:00:00Z", endedAt: "2026-09-15T09:00:00Z" },
      // An extra member, which a comparison would never look at.
      { startedAt: "2026-09-15T09:00:00Z", endedAt: "2026-09-15T15:00:00Z", note: "trust me" },
      // Half a span.
      { startedAt: "2026-09-15T09:00:00Z" },
      { endedAt: "2026-09-15T15:00:00Z" },
      {},
      // Instants that are not the fixed-width UTC shape the journal writes.
      { startedAt: "2026-09-15T09:00:00.000Z", endedAt: "2026-09-15T15:00:00Z" },
      { startedAt: "2026-09-15T09:00:00+01:00", endedAt: "2026-09-15T15:00:00Z" },
      { startedAt: "yesterday", endedAt: "2026-09-15T15:00:00Z" },
      { startedAt: 1, endedAt: 2 },
      // Not an object at all.
      "2026-09-15T09:00:00Z",
      null,
      [],
    ]) {
      const parsed = withSpan(rejected);
      expect(parsed.ok, `expected ${JSON.stringify(rejected)} to be refused`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.blockers[0]?.code).toBe("delivery_record_malformed");
    }
  });

  it("accepts every outcome the evaluator can actually produce", () => {
    const record = buildFreshRecord();
    for (const outcome of RESOLUTION_OUTCOMES.filter((kind) => kind !== "blocked")) {
      const rewritten = { ...record, claims: [{ ...record.claims[0], outcome, ...(outcome === "waived" ? {
        scope: "durable", waiver: { kind: "waiver", scope: "durable", author: "Release owner", reason: "Accepted missing review",
          findingCodes: ["review_evidence_missing"], policyDigest: digestCanonical(makeConfig()), candidateBinding: RECORD_BINDING },
      } : {}) }] };
      const parsed = parseDeliveryRecord(`${JSON.stringify(rewritten)}\n`);
      expect(parsed.ok, `expected ${outcome} to parse`).toBe(true);
    }
  });
});

describe("portable human exceptions", () => {
  const approval = { kind: "waiver" as const, scope: "durable" as const, author: "Release owner", reason: "Accepted missing review",
    findingCodes: ["review_evidence_missing"], policyDigest: digestCanonical(makeConfig()) };
  function record(): DeliveryRecord {
    const built = buildDeliveryRecord({ config: makeConfig(), evidenceRecords: [], decision: admittedDecision([{
      kind: "waived", gateId: "test.gate", obligationId: "review.green", waiverRecordId: "waiver-1",
      scope: "durable", candidateBinding: RECORD_BINDING, waiver: approval,
    }]) });
    if (!built.ok) throw new Error("expected admitted waiver");
    return built.record;
  }
  it("retains attribution, finding scope, policy, and approved candidate through serialization", () => {
    const parsed = parseDeliveryRecord(deliveryRecordBytes(record()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims[0]?.waiver).toEqual({ ...approval, candidateBinding: RECORD_BINDING });
    expect(verifyDeliveryRecord(makeConfig(), parsed.record, RECOMPUTED, FRESH_BASE, { waiverCandidateMatches: true }).ok).toBe(true);
  });
  it("rejects a waiver without a matching current target observation", () => {
    for (const options of [{}, { waiverCandidateMatches: false }]) {
      const result = verifyDeliveryRecord(makeConfig(), record(), RECOMPUTED, FRESH_BASE, options);
      expect(result.ok).toBe(false);
      expect(result.blockers.map(blocker => blocker.code)).toContain("record_waiver_invalid");
    }
  });
  it("rejects a legacy unattributed waiver claim", () => {
    const value = record();
    expect(parseDeliveryRecord(JSON.stringify({ ...value, claims: [{ obligationId: "review.green", outcome: "waived", scope: "durable" }] })).ok).toBe(false);
  });
  it("rejects changing both scope fields to durable for a live obligation", () => {
    const liveObligation = { ...obligation("review.green"), freshness: "live" as const,
      waivableCodes: [...STRUCTURAL_WAIVABLE, "live_provider_missing"],
      nonWaivableCodes: STRUCTURAL_NONWAIVABLE.filter((code) => code !== "live_provider_missing") };
    const config = makeConfig({ obligations: [liveObligation] });
    const value = record();
    const waiver = { ...approval, findingCodes: ["live_provider_missing"], scope: "invocation" as const, policyDigest: digestCanonical(config), candidateBinding: RECORD_BINDING };
    const claim = { ...value.claims[0]!, scope: "invocation", waiver };
    expect(verifyDeliveryRecord(config, { ...value, claims: [claim] }, RECOMPUTED, FRESH_BASE, { waiverCandidateMatches: true }).ok).toBe(false); // Invocation-only approval cannot travel to another verification.
    expect(verifyDeliveryRecord(config, { ...value, claims: [{ ...claim, scope: "durable", waiver: { ...waiver, scope: "durable" } }] }, RECOMPUTED, FRESH_BASE, { waiverCandidateMatches: true }).ok).toBe(false);
  });
  it.each(["policy", "candidate", "integrity"])("rejects an exception with mismatched %s in the verifier", (mutation) => {
    const value = record();
    const waiver = { ...approval, candidateBinding: RECORD_BINDING,
      ...(mutation === "policy" ? { policyDigest: "f".repeat(64) } : {}),
      ...(mutation === "candidate" ? { candidateBinding: { ...RECORD_BINDING, treeSha: "other-tree" } } : {}),
      ...(mutation === "integrity" ? { findingCodes: ["stale_evidence"] } : {}),
    };
    const result = verifyDeliveryRecord(makeConfig(), { ...value, claims: [{ ...value.claims[0]!, waiver }] }, RECOMPUTED, FRESH_BASE, { waiverCandidateMatches: true });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain("record_waiver_invalid");
  });
});

// ── verify (the drift table) ─────────────────────────────────────────────────

describe("verifyDeliveryRecord", () => {
  it("passes a fresh record", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(true);
    expect(check.blockers).toHaveLength(0);
    expect(check.attestationLabel).toContain("process discipline");
  });

  it("records and verifies an active hosted-check exemption without changing local evidence claims", () => {
    const config = makeConfig();
    const compiledPolicy = compiledHostedPolicy();
    const built = buildDeliveryRecord({
      config,
      decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
      evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64), config)],
      compiledPolicy,
      observedAt: "2026-09-10T00:00:00Z",
    });
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    expect(built.record.claims[0]?.outcome).toBe("satisfied_evidence");
    expect(built.record.hostedChecks?.exemption).toMatchObject({
      scope: { repositoryId: "test-repo", baseRef: "origin/main" },
      grantedBy: "repository-owner@example.com",
      until: "2026-09-12T00:00:00Z",
      policyDigest: compiledPolicy.compiledDigest,
    });
    const check = verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE, {
      compiledPolicy,
      observedAt: "2026-09-10T00:00:01Z",
    });
    expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
    expect(check.hostedChecks).toEqual({ status: "exempted", exemption: built.record.hostedChecks?.exemption });
  });

  it("does not activate an exemption for another base ref", () => {
    const config = makeConfig();
    const compiledPolicy = compiledHostedPolicy("origin/release");
    const built = buildDeliveryRecord({
      config,
      decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
      evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64), config)],
      compiledPolicy,
      observedAt: "2026-09-10T00:00:00Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.hostedChecks).toEqual({ required: true });
    expect(verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE, {
      compiledPolicy,
      observedAt: "2026-09-10T00:00:01Z",
    }).hostedChecks.status).toBe("required");
  });

  it.each(hostedExemptionMutations)("refuses a resealed hosted-check exemption with mismatched $field", ({ mutate }) => {
    const config = makeConfig();
    const compiledPolicy = compiledHostedPolicy();
    const built = buildDeliveryRecord({
      config,
      decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
      evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64), config)],
      compiledPolicy,
      observedAt: "2026-09-10T00:00:00Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok || built.record.hostedChecks?.exemption === undefined) return;

    const mismatchedBody = {
      ...built.record,
      hostedChecks: {
        required: true as const,
        exemption: mutate(built.record.hostedChecks.exemption),
      },
    };
    delete (mismatchedBody as { integrityDigest?: string }).integrityDigest;
    const resealed = { ...mismatchedBody, integrityDigest: digestCanonical(mismatchedBody) };
    const check = verifyDeliveryRecord(config, resealed, RECOMPUTED, FRESH_BASE, {
      compiledPolicy,
      observedAt: "2026-09-10T00:00:01Z",
    });
    expect(check.blockers.map((blocker) => blocker.code)).toEqual(["hosted_check_exemption_unrecognized"]);
    expect(check.hostedChecks).toEqual({ status: "required" });
  });

  it("refuses an expired hosted-check exemption", () => {
    const config = makeConfig();
    const compiledPolicy = compiledHostedPolicy();
    const built = buildDeliveryRecord({
      config,
      decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
      evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64), config)],
      compiledPolicy,
      observedAt: "2026-09-10T00:00:00Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const expiredCheck = verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE, {
      compiledPolicy,
      observedAt: "2026-09-12T00:00:00Z",
    });
    expect(expiredCheck.blockers.map((blocker) => blocker.code)).toContain("hosted_check_exemption_expired");
    expect(expiredCheck.hostedChecks.status).toBe("required");
  });

  it("keeps legacy records and consumers without compiled policy compatible", () => {
    const record = buildFreshRecord();
    expect("hostedChecks" in record).toBe(false);
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(true);
    expect(check.hostedChecks).toEqual({ status: "required" });
  });

  it("fails on a changed deliverable identity, naming the drift class", () => {
    const check = verifyDeliveryRecord(
      makeConfig(),
      buildFreshRecord(),
      { deliverableDigest: "c".repeat(64), identityToken: TOKEN },
      FRESH_BASE,
    );
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("deliverable_identity_changed");
  });

  it("independently rejects a candidate tree carrying a projection or discovery-configuration path", () => {
    for (const planted of [
      `${DELIVERY_OWNED_TREE_PREFIXES[0]}/workflows/delivery-v1.json`,
      `${DELIVERY_OWNED_TREE_PREFIXES[1]}/settings.json`,
    ]) {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: ["src/index.ts", planted],
      });
      expect(check.ok, planted).toBe(false);
      expect(check.blockers.map((b) => b.code)).toContain("record_protected_authority_path");
    }
  });

  it("rejects a delivery-owned path aliased by case or committed as a bare symlink", () => {
    // Two shapes the in-run deny side already folds for: a case alias that
    // resolves to the protected path on a case-insensitive checkout, and the
    // prefix committed as a single entry (a symlink) with nothing under it.
    for (const planted of [".Claude/settings.json", ".MANAGED-PROJECTION/x.json", ".claude", ".managed-projection"]) {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [planted],
      });
      expect(check.ok, planted).toBe(false);
      expect(check.blockers.map((b) => b.code), planted).toContain("record_protected_authority_path");
    }
  });

  it("passes a candidate tree that merely NAMES a prefix without being inside it", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
      candidateTreePaths: ["src/managed-projection-notes.md", "docs/.claudette/readme.md", ".claudette", "a.claude/b"],
    });
    expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
  });

  it("keeps its closed path set identical to the portable grant's delivery-owned protections", () => {
    // Two lists, one meaning: the grant protects them inside the run, the
    // external verifier rejects them in the committed tree. Drift between the
    // two would open exactly the gap this check exists to close.
    //
    // The membership is unchanged by the Claude skill-exposure exception below:
    // that exception admits ONE tree-verifiable shape inside `.claude/skills/`
    // and does not remove `.claude` from either list. The in-run grant still
    // protects the whole prefix, because inside a run the `agent-skills`
    // generation install writes the exposure and the candidate never should.
    expect([...DELIVERY_OWNED_TREE_PREFIXES].sort()).toEqual(
      PORTABLE_STAGE_GRANT.protectedPaths.filter((path) => path !== ".git").slice().sort(),
    );
    // The exception's two anchors, pinned literally so a rename cannot widen it.
    expect(CLAUDE_SKILL_EXPOSURE_PREFIX).toBe(".claude/skills/");
    expect(RECEIPTED_SKILLS_ROOT).toBe(".agent-skills/current/skills/");
    expect(CLAUDE_SKILL_EXPOSURE_PREFIX.startsWith(`${DELIVERY_OWNED_TREE_PREFIXES[1]}/`)).toBe(true);
  });

  describe("the tracked Claude skill exposure", () => {
    // One narrow exception to the frozen `.claude` prefix: a committed entry
    // under `.claude/skills/` is admissible ONLY when it is a symlink (git mode
    // 120000) whose target, resolved relative to the entry's own directory,
    // lands inside `.agent-skills/current/skills/`. That is the exact shape the
    // `agent-skills` generation install writes, and it is decidable from the
    // committed tree alone — mode and blob, no filesystem read.

    it("admits a symlink resolving into the receipted generation's skills root", () => {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [
          "src/index.ts",
          { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/execute-work" },
          // A nested exposure resolves against its own directory, not the root.
          { path: ".claude/skills/vendor/plan-work", mode: "120000", symlinkTarget: "../../../.agent-skills/current/skills/plan-work" },
          // A `.` segment normalizes away without moving the resolution, so
          // this is the same admissible shape written differently.
          { path: ".claude/skills/review-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/./review-work" },
        ],
      });
      expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
    });

    it("rejects every other shape under .claude with the same blocker", () => {
      const rejected: readonly { readonly why: string; readonly entry: unknown }[] = [
        {
          why: "a regular file under .claude/skills/",
          entry: { path: ".claude/skills/execute-work/SKILL.md", mode: "100644" },
        },
        {
          why: "an executable regular file under .claude/skills/",
          entry: { path: ".claude/skills/run.sh", mode: "100755" },
        },
        {
          why: "a symlink resolving outside the receipted skills root",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/workflows/execute-work" },
        },
        {
          why: "a symlink resolving into the generation but above its skills root",
          entry: { path: ".claude/skills/current", mode: "120000", symlinkTarget: "../../.agent-skills/current" },
        },
        {
          why: "a symlink escaping the repository with ..",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../../.agent-skills/current/skills/execute-work" },
        },
        {
          why: "a symlink whose target traverses out of the skills root and back down a sibling",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/../../../secrets/x" },
        },
        {
          why: "a symlink to an absolute path",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "/etc/agent-skills/current/skills/execute-work" },
        },
        {
          why: "a symlink to the skills root itself, naming nothing inside it",
          entry: { path: ".claude/skills/all", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/" },
        },
        {
          why: "a symlink with no target read from the tree",
          entry: { path: ".claude/skills/execute-work", mode: "120000" },
        },
        {
          why: "an entry under .claude outside skills/",
          entry: { path: ".claude/settings.json", mode: "100644" },
        },
        {
          why: "a symlink under .claude outside skills/, however it resolves",
          entry: { path: ".claude/hooks/pre", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/pre" },
        },
        {
          why: "the `.claude/skills` directory prefix committed as a single symlink",
          entry: { path: ".claude/skills", mode: "120000", symlinkTarget: "../.agent-skills/current/skills" },
        },
        {
          why: "a case alias of the exposure prefix, which is not the shape the install writes",
          entry: { path: ".Claude/Skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/execute-work" },
        },
      ];
      for (const { why, entry } of rejected) {
        const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
          candidateTreePaths: ["src/index.ts", entry as never],
        });
        expect(check.ok, why).toBe(false);
        expect(check.blockers.map((blocker) => blocker.code), why).toContain("record_protected_authority_path");
      }
    });

    it("still rejects a bare path string under .claude/skills, which carries no mode to judge", () => {
      // The path form is what existing callers pass. It cannot witness a mode
      // or a target, so it can never reach the exception — fail-closed.
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [".claude/skills/execute-work"],
      });
      expect(check.ok).toBe(false);
      expect(check.blockers.map((blocker) => blocker.code)).toContain("record_protected_authority_path");
    });

    it("reads mode, object and path out of a real ls-tree listing, and names the blobs it needs", () => {
      const listing = [
        "100644 blob 1111111111111111111111111111111111111111\tsrc/index.ts",
        "120000 blob 2222222222222222222222222222222222222222\t.claude/skills/execute-work",
        "100644 blob 3333333333333333333333333333333333333333\t.claude/settings.json",
        // A path with an embedded space, and one with an embedded tab: NUL
        // separation means neither is quoted, and the split is on the FIRST
        // tab, so both paths are preserved verbatim.
        "120000 blob 4444444444444444444444444444444444444444\t.claude/skills/two words",
        "120000 blob 6666666666666666666666666666666666666666\t.claude/skills/two\tnames",
        "120000 blob 5555555555555555555555555555555555555555\tdocs/link",
      ].join("\u0000");
      const entries = parseCandidateTreeListing(listing);
      expect(entries.map((entry) => entry.path)).toEqual([
        "src/index.ts",
        ".claude/skills/execute-work",
        ".claude/settings.json",
        ".claude/skills/two words",
        ".claude/skills/two\tnames",
        "docs/link",
      ]);
      expect(entries[1]).toEqual({
        path: ".claude/skills/execute-work",
        mode: "120000",
        objectSha: "2222222222222222222222222222222222222222",
      });
      // Only the delivery-owned symlinks need a blob read: not the regular file
      // under `.claude`, whose verdict its mode already settles, and not the
      // symlink outside every delivery-owned prefix.
      expect(entries.filter(needsCommittedSymlinkTarget).map((entry) => entry.path)).toEqual([
        ".claude/skills/execute-work",
        ".claude/skills/two words",
        ".claude/skills/two\tnames",
      ]);
    });

    it("leaves entries outside the delivery-owned prefixes alone whatever their mode", () => {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [
          { path: "node_modules-link", mode: "120000", symlinkTarget: "/anywhere/at/all" },
          { path: "docs/.claudette/readme.md", mode: "100644" },
        ],
      });
      expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
    });
  });

  it("fails on an identity token the config does not accept", () => {
    const record = { ...buildFreshRecord(), candidateBinding: { ...RECORD_BINDING, identityToken: "other/v1" }, identityToken: "other/v1" };
    const check = verifyDeliveryRecord(makeConfig(), record, { deliverableDigest: DIGEST, identityToken: "other/v1" }, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("stales on base-tip movement under the default policy", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, tipSha: "z".repeat(40) });
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("base_tip_moved");
    expect(check.baseMovementRelaxed).toBe(false);
  });

  it("explains own-merge reconciliation before suggesting a stale record be refreshed", () => {
    const currentTip = "z".repeat(40);
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, tipSha: currentTip });
    const blocker = check.blockers.find(entry => entry.code === "base_tip_moved")!;
    expect(check.ok).toBe(false);
    expect(blocker.details).toContain(FRESH_BASE.tipSha);
    expect(blocker.details).toContain(currentTip);
    expect(blocker.remediations[0]!.summary).toContain("own confirmed merge");
    expect(blocker.remediations[0]!.summary).toContain("no new delivery loop");
    expect(blocker.remediations[0]!.summary).toContain("same run");
  });

  it("stales on merge-base movement", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, mergeBaseSha: "z".repeat(40) });
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("merge_base_moved");
  });

  it("stales on a base ref change", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, ref: "origin/release" });
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("base_ref_changed");
  });

  it("relaxes base movement under the allow policy and names the relaxation", () => {
    const config = makeConfig({ deliveryRecordVerification: { baseMovement: "allow" } });
    const check = verifyDeliveryRecord(config, buildFreshRecord(config), RECOMPUTED, { ...FRESH_BASE, tipSha: "z".repeat(40) });
    expect(check.ok).toBe(true);
    expect(check.baseMovementRelaxed).toBe(true);
    expect(check.relaxedDriftClasses).toContain("base_tip_moved");
  });

  it("keeps identity mismatch fatal even under the allow policy", () => {
    const config = makeConfig({ deliveryRecordVerification: { baseMovement: "allow" } });
    const check = verifyDeliveryRecord(config, buildFreshRecord(config), { deliverableDigest: "c".repeat(64), identityToken: TOKEN }, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("fails on a gate id mismatch", () => {
    const record = { ...buildFreshRecord(), gateId: "other.gate" };
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("fails on a non-self attestation level", () => {
    const record = { ...buildFreshRecord(), attestation: { level: "provider-signed" as const } };
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("fails when an obligation is uncovered by any claim", () => {
    const twoObligations = makeConfig({ obligations: [obligation("review.green"), obligation("second.check")] });
    const check = verifyDeliveryRecord(twoObligations, buildFreshRecord(), RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("obligation_uncovered");
  });

  it("echoes a supplied run-journal row verbatim and omits the member entirely without one", () => {
    // BOTH DIRECTIONS, because both are load-bearing and each fails silently.
    // Dropping the echo would accept the option and lose the row, leaving the
    // one caller that supplies it unable to report what it resolved; echoing
    // unconditionally would give every check — the Action's and the facade's
    // included — a member none of them asked for.
    const row = {
      runId: "r-echoed",
      alsoMatching: ["r-earlier"],
      status: "incomplete",
      missing: ["pr.opened"],
      violations: ["round-not-bound-to-record"],
      attestation: "self",
    } as const;
    const echoed = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, { runJournal: row });
    expect(echoed.runJournal).toEqual(row);

    const withoutRow = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE);
    expect("runJournal" in withoutRow, "a caller that supplied no row gets no member").toBe(false);
  });

  it("does not expose an invented review projection as a journal coordinate", () => {
    const record = structuredClone(buildFreshRecord());
    const evidence = record.claims[0]!.evidence!;
    if (evidence.resolution.kind !== "evidence" || evidence.resolution.portable === undefined) throw new Error("portable evidence missing");
    const portable = evidence.resolution.portable as Mutable<typeof evidence.resolution.portable>;
    const manifest = portable.manifest as Mutable<Record<string, unknown>> & {
      artifacts: { path: string; role: string; sha256: string }[];
    };
    const path = "review-context-projection.json";
    const bytes = `${JSON.stringify({
      spec: "review-context-projection/1",
      reviewRoundAdded: false,
      reviewedCandidate: { treeSha: "c".repeat(40) },
      preparedCandidate: { treeSha: record.candidateBinding.treeSha },
    })}\n`;
    portable.artifacts[path] = Buffer.from(bytes).toString("base64");
    manifest.artifacts.push({ path, role: "review-context-projection", sha256: sha256Hex(bytes) });
    const digest = digestManifest(manifest);
    (evidence.resolution as Mutable<typeof evidence.resolution>).manifestDigest = digest;
    (record.claims[0] as Mutable<typeof record.claims[0]>).manifestDigest = digest;
    (record as Mutable<DeliveryRecord>).manifestDigest = digest;
    delete (record as { integrityDigest?: string }).integrityDigest;
    (record as Mutable<DeliveryRecord>).integrityDigest = digestCanonical(record);

    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
    expect(check.reviewedCandidateTreeShas).toEqual([record.candidateBinding.treeSha]);
  });

  it("never lets a run-journal row change the verdict it is attached to", () => {
    // The row is observability. A journal an owner-executed script can write
    // must not be able to admit a record the drift table refuses, nor refuse one
    // it admits — so both verdicts stand unchanged whatever the row says.
    const worst = {
      status: "absent",
      missing: [...RUN_JOURNAL_REQUIRED_ENTRIES],
      violations: [...RUN_JOURNAL_VIOLATIONS],
      attestation: "self",
    } as const;
    const passing = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, { runJournal: worst });
    expect(passing.ok).toBe(true);
    expect(passing.blockers).toHaveLength(0);

    const best = { runId: "r-perfect", status: "complete", missing: [], attestation: "self" } as const;
    const drifted = verifyDeliveryRecord(
      makeConfig(),
      buildFreshRecord(),
      { deliverableDigest: "c".repeat(64), identityToken: TOKEN },
      FRESH_BASE,
      { runJournal: best },
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.blockers.map((b) => b.code)).toContain("deliverable_identity_changed");
  });

  it("rejects rewriting the original workspace binding in portable evidence", () => {
    const record = {
      ...buildFreshRecord(),
      workspaceId: "w-ci-checkout",
      candidateBinding: { ...RECORD_BINDING, workspaceId: "w-ci-checkout" },
    };
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
  });
});

// ── selection ────────────────────────────────────────────────────────────────

describe("selectDeliveryRecordForIdentity", () => {
  it("selects the one record whose binding matches the recomputed identity", () => {
    const match = buildFreshRecord();
    const foreign: DeliveryRecord = {
      ...match,
      candidateBinding: { ...RECORD_BINDING, deliverableDigest: "f".repeat(64) },
    };
    const selected = selectDeliveryRecordForIdentity(
      [
        { path: "telemetry/delivery-runs/record--foreign.json", record: foreign },
        { path: "telemetry/delivery-runs/record--match.json", record: match },
      ],
      RECOMPUTED,
    );
    expect(selected?.path).toBe("telemetry/delivery-runs/record--match.json");
  });

  it("returns nothing when only a foreign-candidate record is present", () => {
    const foreign: DeliveryRecord = {
      ...buildFreshRecord(),
      candidateBinding: { ...RECORD_BINDING, deliverableDigest: "f".repeat(64) },
    };
    const selected = selectDeliveryRecordForIdentity([{ path: "x.json", record: foreign }], RECOMPUTED);
    expect(selected).toBeUndefined();
  });
});


describe("installed data portable record propagation", () => {
  it("requires matching current resource authority through record verification and rejects claim substitution", () => {
    const source = { version: "scoped-check/1" as const, files: [], tests: ["font.test.ts"], memberships: [], cwd: ".", profile: "font", environment: [] };
    const installedData = { version: "installed-data-consumer/1" as const, consumerId: "font", source, guards: { "font.test.ts": "a".repeat(64) }, requests: [{ version: "installed-package-data/1" as const, id: "font", issuer: "font.test.ts", package: "font", manifest: "package.json" as const, files: ["font.woff2"], directories: [] }] };
    const original = makeConfig();
    const config = { ...original, providers: [{ id: "p.reviewer", findingCodes: [], check: { command: ["node"] as [string], timeoutMs: 1000, scope: source, installedData } }], obligations: original.obligations.map(row => ({ ...row, acceptedPayloadSpecs: ["checks.passed/1", "installed-data.applicable/1"] })) };
    const resourceBinding = { version: "installed-data-binding/1" as const, candidateDigest: digestCanonical(RECORD_BINDING), definitionDigest: "b".repeat(64), declarationDigest: "c".repeat(64), sourceApplicabilityDigest: "d".repeat(64), captureDigest: "e".repeat(64), originDigest: "f".repeat(64) };
    const old = evidenceRecord("review.green", "unused", "unused", config);
    if (old.resolution.kind !== "evidence" || !old.resolution.portable) throw Error("fixture");
    const provider = { id: "p.reviewer", version: "1", runId: "run-1", finalPassId: "pass-2" };
    const payload = { verdict: "applicable", binding: resourceBinding };
    const bytes = JSON.stringify({ providerId: provider.id, runId: provider.runId, finalPassId: provider.finalPassId, ...payload });
    const manifest = { ...(old.resolution.portable.manifest as Record<string, unknown>), artifacts: [{ path: "resource-result.json", role: "resource-result", sha256: sha256Hex(bytes) }], claims: [{ obligation: "review.green", payloadSpec: "installed-data.applicable/1", payload }] };
    const evidence = { ...old, resolution: { ...old.resolution, resourceBinding, manifestDigest: digestManifest(manifest), portable: { ...old.resolution.portable, manifest, artifacts: { "resource-result.json": Buffer.from(bytes).toString("base64") } } } };
    const built = buildDeliveryRecord({ config, decision: admittedDecision([evidenceResolution("review.green", evidence.recordId)]), evidenceRecords: [evidence] });
    expect(built.ok).toBe(true);
    if (!built.ok) throw Error(JSON.stringify(built));
    const options = { resourceBindings: { "p.reviewer": resourceBinding } };
    expect(verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE, options).ok).toBe(true);
    expect(verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE).ok).toBe(false);
    expect(verifyDeliveryRecord(config, built.record, RECOMPUTED, FRESH_BASE, { resourceBindings: { "p.reviewer": { ...resourceBinding, captureDigest: "0".repeat(64) } } }).ok).toBe(false);
    const changedEvidence = { ...evidence, resolution: { ...evidence.resolution, resourceBinding: { ...resourceBinding, captureDigest: "0".repeat(64) } } };
    const changed = buildDeliveryRecord({ config, decision: admittedDecision([evidenceResolution("review.green", changedEvidence.recordId)]), evidenceRecords: [changedEvidence] });
    if (!changed.ok) throw Error(JSON.stringify(changed));
    expect(verifyDeliveryRecord(config, changed.record, RECOMPUTED, FRESH_BASE, options).ok).toBe(false);
  });
});
