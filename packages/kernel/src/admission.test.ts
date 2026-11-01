/**
 * The admission adapter: the effectful seam between the store, the classified
 * context, the caller-supplied live results, and the pure evaluator.
 *
 * WHAT THESE TESTS PIN, AND WHY EACH IS A REAL INTEGRATION. The adapter is the
 * one place where a real record store, a real preparation receipt, an injected
 * prompt port and the *real* evaluator meet. So every scenario runs against a
 * real temporary git repository (the store and the receipt are resolved through
 * `git rev-parse`, and nothing short of git can decide worktree privacy), the
 * real `discoverRecords` / `publishRecord` / `evaluatePreparationReceipt`, and
 * the real `evaluateGate`. The candidate capture and the activation projection
 * are the two injected ports — capture is stubbed with declared candidate
 * values exactly as the conformance runner stubs the recorder, because a real
 * git capture would test `candidate.ts`, not this seam.
 *
 * THE TWO-PASS WAIVER FLOW IS PROVEN IN EVERY DIRECTION:
 *   - accept  → `waived`, with an attributed waiver record on disk;
 *   - decline → blocked, with ZERO waiver records on disk (the write happens
 *               only after an accepted prompt and a clean re-capture);
 *   - the prompt is issued EXACTLY once, and its obligation-id argument is
 *     asserted to enumerate every covered obligation;
 *   - the second pass re-evaluates without ever prompting again;
 *   - one non-waivable blocker suppresses the prompt entirely;
 *   - an agent context never prompts.
 *
 * And the record-mapping seam:
 *   - a well-formed record bound to a different candidate is excluded
 *     (`appliesToCandidate` false) and the obligation resolves as absent —
 *     never as stale evidence;
 *   - a malformed record becomes a diagnostic, never dropped;
 *   - candidate drift between the prompt and the re-evaluation blocks;
 *   - capture and store pointed at different workspaces is refused.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATE_STRUCTURAL_FINDING_CODES } from "./blockers.ts";
import { CANDIDATE_VCS, type CandidateCapture, type CapturedCandidate, type ReviewActivationProjection } from "./candidate.types.ts";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput, type ObligationPolicy } from "./config.ts";
import type { ExecutionContext } from "./context.ts";
import type { LiveProviderResult } from "./evaluator.ts";
import { publishPreparationReceipt } from "./preparation.ts";
import { discoverRecords, publishRecord, resolveRecordStorage } from "./records.ts";
import type { RecordCandidateBinding } from "./records.types.ts";
import { runAdmission, type AdmissionOptions, type AdmissionResult } from "./admission.ts";
import * as checkCapture from "./checks.ts";
import { digestCanonical } from "./digest.ts";

const run = promisify(execFile);

// ── Temporary git repositories ───────────────────────────────────────────────

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await run("git", [...args], { cwd });
}

/** A real repository with one commit and the declared wiring file on disk. */
async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dh-admission-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "root");
  writeFileSync(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
  return dir;
}

function storeWorkspaceId(rootDir: string): Promise<string> {
  return resolveRecordStorage(rootDir).then((storage) => storage.workspaceId);
}

// ── Config ───────────────────────────────────────────────────────────────────

const STRUCTURAL = [...GATE_STRUCTURAL_FINDING_CODES];

/** Everything structural except the codes a test wants to leave waivable. */
function nonWaivableExcept(...waivable: readonly string[]): readonly string[] {
  const allowed = new Set(waivable);
  return STRUCTURAL.filter((code) => !allowed.has(code));
}

const REMEDIATION = {
  default: [{ id: "do-the-thing", kind: "manual_action", summary: "Complete the obligation for this candidate." }],
} as const;

interface ObligationSpec {
  readonly id: string;
  readonly freshness: "live" | "exact_candidate";
  readonly providers: readonly string[];
  readonly humanWaiverAllowed: boolean;
  readonly waivableCodes: readonly string[];
}

function obligation(spec: ObligationSpec): ObligationPolicy {
  const satisfied = spec.freshness === "live" ? "satisfied_live_fact" : "satisfied_evidence";
  return {
    id: spec.id,
    activation: { kind: "always" },
    freshness: spec.freshness,
    providers: spec.providers,
    acceptedPayloadSpecs: ["review.green/1"],
    allowedResolutionKinds: spec.humanWaiverAllowed ? [satisfied, "waived", "not_applicable"] : [satisfied, "not_applicable"],
    humanWaiverAllowed: spec.humanWaiverAllowed,
    minimumAttestationLevel: "self",
    ciDelegationPolicyIds: [],
    remediation: REMEDIATION,
    waivableCodes: spec.waivableCodes,
    nonWaivableCodes: nonWaivableExcept(...spec.waivableCodes),
  };
}

function testConfig(obligations: readonly ObligationPolicy[], overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  const providerIds = [...new Set(obligations.flatMap((o) => o.providers))];
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
    sensitivePaths: [],
    activationThreshold: 50,
    providers: providerIds.map((id) => ({ id, findingCodes: [] })),
    agentEnvSignals: ["TEST_AGENT"],
    ciPolicies: [],
    ciPolicyEnvKey: "TEST_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations,
    deliveryRecordPath: "delivery/records/latest.json",
    ...overrides,
  });
}

// ── Candidate ────────────────────────────────────────────────────────────────

function capturedCandidate(workspaceId: string, overrides: Partial<CapturedCandidate> = {}): CapturedCandidate {
  return {
    vcs: CANDIDATE_VCS,
    headSha: "b".repeat(40),
    treeSha: "a".repeat(40),
    mode: "clean",
    deliverable: { digest: "c".repeat(64), identity: "test-tree/v1" },
    base: { ref: "origin/main", tipSha: "d".repeat(40), mergeBaseSha: "e".repeat(40) },
    workspaceId,
    statusEntries: [],
    untrackedFiles: [],
    ...overrides,
  };
}

function recordBinding(candidate: CapturedCandidate): RecordCandidateBinding {
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

const ACTIVE_PROJECTION: ReviewActivationProjection = {
  relevantLineCount: 100,
  relevantPaths: [],
  excludedPaths: [],
  binaryPaths: [],
  sensitivePathIds: [],
  hasRelevantBinaryChange: false,
  hasRelevantZeroLineChange: false,
  changedEntryCount: 1,
};

const HUMAN: ExecutionContext = { kind: "human", interactive: true };
const AGENT: ExecutionContext = { kind: "agent", signal: "TEST_AGENT" };

/** A prompt port that records every call, so "exactly once" is a count. */
function fakePrompt(answer: boolean) {
  const calls: { readonly obligationIds: readonly string[] }[] = [];
  const port = async (_decision: unknown, obligationIds: readonly string[]) => {
    calls.push({ obligationIds });
    return answer ? { author: "Test Operator", reason: "Explicit test exception" } : false as const;
  };
  return { port, calls };
}

function fixedCapture(candidate: CapturedCandidate): () => Promise<CandidateCapture> {
  return () => Promise.resolve({ ok: true, candidate });
}

function baseOptions(candidate: CapturedCandidate, overrides: Partial<AdmissionOptions> = {}): AdmissionOptions {
  return {
    captureCandidate: fixedCapture(candidate),
    projectActivation: () => Promise.resolve(ACTIVE_PROJECTION),
    ...overrides,
  };
}

/** Publish the receipt the admission adapter requires, for this exact candidate. */
async function prepare(rootDir: string, config: HarnessConfig, candidate: CapturedCandidate): Promise<void> {
  await publishPreparationReceipt(rootDir, { config, candidate });
}

function blockerCodes(result: AdmissionResult): readonly string[] {
  return result.blockers.map((blocker) => blocker.code);
}

async function waiverRecordCount(rootDir: string, gateId: string, obligationId: string): Promise<number> {
  const discovery = await discoverRecords(rootDir, { gateId, obligationId });
  return discovery.records.filter((record) => record.resolution.kind === "waiver").length;
}

// ── Happy paths ──────────────────────────────────────────────────────────────

describe("admission: satisfied obligations", () => {
  it("admits a candidate whose store holds fresh evidence (satisfied_evidence)", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: false, waivableCodes: [] }),
    ]);
    await prepare(repo, config, candidate);
    await publishRecord(repo, {
      gateId: "test.gate",
      obligationId: "review.green",
      candidateBinding: recordBinding(candidate),
      resolution: { kind: "evidence", providerId: "rev", runId: "run-1", finalPassId: "pass-1", manifestDigest: "f".repeat(64) },
    });

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate));

    expect(result.admitted).toBe(true);
    expect(result.decision?.resolutions.map((r) => r.kind)).toEqual(["satisfied_evidence"]);
    expect(result.waiver).toBe("not_offered");
  });

  it("admits on a caller-supplied green live result (satisfied_live_fact), distinct from evidence", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "live.check", freshness: "live", providers: ["live"], humanWaiverAllowed: false, waivableCodes: [] }),
    ]);
    await prepare(repo, config, candidate);
    const liveResults: readonly LiveProviderResult[] = [{ providerId: "live", runId: "run-1", status: "green", findings: [] }];

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN, liveResults }, baseOptions(candidate));

    expect(result.admitted).toBe(true);
    expect(result.decision?.resolutions.map((r) => r.kind)).toEqual(["satisfied_live_fact"]);
  });
});

// ── The receipt gate ─────────────────────────────────────────────────────────

describe("admission: the receipt gate", () => {
  it("blocks before evaluation when no receipt exists, and never prompts", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    // Deliberately no prepare(): the receipt is missing.
    const prompt = fakePrompt(true);

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, { promptForWaiver: prompt.port }));

    expect(result.admitted).toBe(false);
    expect(blockerCodes(result)).toContain("preparation_missing");
    expect(result.decision).toBeUndefined();
    expect(prompt.calls.length).toBe(0);
  });
});

// ── The two-pass waiver flow ─────────────────────────────────────────────────

describe("admission: the two-pass waiver flow", () => {
  it("accept → waived, with a candidate-bound waiver record on disk, prompting exactly once", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    await prepare(repo, config, candidate);
    const prompt = fakePrompt(true);

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, { promptForWaiver: prompt.port }));

    expect(result.admitted).toBe(true);
    expect(result.waiver).toBe("accepted");
    expect(result.decision?.resolutions.map((r) => r.kind)).toEqual(["waived"]);
    expect(result.waivedObligationIds).toEqual(["review.green"]);
    // Exactly once, naming every covered obligation.
    expect(prompt.calls.length).toBe(1);
    expect(prompt.calls[0]?.obligationIds).toEqual(["review.green"]);
    // The candidate-bound waiver is on disk, and its id is the one the result reports.
    expect(await waiverRecordCount(repo, "test.gate", "review.green")).toBe(1);
    expect(result.waiverRecordIds.length).toBe(1);
    const records = await discoverRecords(repo, { gateId: "test.gate", obligationId: "review.green" });
    expect(records.records[0]?.resolution).toMatchObject({
      scope: "durable",
      author: "Test Operator",
      reason: "Explicit test exception",
      findingCodes: ["review_evidence_missing"],
    });
  });

  it("refuses an affirmative waiver without human attribution", async () => {
    const repo = await tempRepo();
    const candidate = capturedCandidate(await storeWorkspaceId(repo));
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    await prepare(repo, config, candidate);
    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, {
      promptForWaiver: (async () => true) as unknown as AdmissionOptions["promptForWaiver"],
    }));
    expect(result.admitted).toBe(false);
    expect(blockerCodes(result)).toContain("waiver_attribution_invalid");
    expect(await waiverRecordCount(repo, "test.gate", "review.green")).toBe(0);
  });

  it("keeps live approval invocation-scoped and refuses later reuse", async () => {
    const repo = await tempRepo();
    const candidate = capturedCandidate(await storeWorkspaceId(repo));
    const config = testConfig([obligation({ id: "check.live", freshness: "live", providers: ["check"], humanWaiverAllowed: true, waivableCodes: ["live_provider_missing"] })]);
    await prepare(repo, config, candidate);
    const first = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, { promptForWaiver: fakePrompt(true).port }));
    expect(first.admitted).toBe(true);
    const stored = await discoverRecords(repo, { gateId: config.gateId, obligationId: "check.live" });
    expect(stored.records[0]?.resolution).toMatchObject({ kind: "waiver", scope: "invocation" });
    const later = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate));
    expect(later.admitted).toBe(false);
    const renewed = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, {
      promptForWaiver: async () => ({ author: "Another Operator", reason: "Fresh approval of this live check" }),
    }));
    expect(renewed.admitted).toBe(true);
    expect(await waiverRecordCount(repo, config.gateId, "check.live")).toBe(2);
  });

  it("rejects changed evidence scope while the human prompt is open", async () => {
    const repo = await tempRepo();
    const candidate = capturedCandidate(await storeWorkspaceId(repo));
    const config = testConfig([obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] })]);
    await prepare(repo, config, candidate);
    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, {
      promptForWaiver: async () => {
        await publishRecord(repo, { gateId: config.gateId, obligationId: "review.green", candidateBinding: recordBinding(candidate),
          resolution: { kind: "evidence", providerId: "unknown", runId: "new", finalPassId: "final", manifestDigest: "f".repeat(64) } });
        return { author: "Test Operator", reason: "Only the displayed missing review was approved" };
      },
    }));
    expect(result.admitted).toBe(false);
    expect(blockerCodes(result)).toContain("unknown_provider");
    expect(await waiverRecordCount(repo, config.gateId, "review.green")).toBe(0);
  });

  it("refuses approval when policy wiring changes during the prompt", async () => {
    const repo = await tempRepo();
    const candidate = capturedCandidate(await storeWorkspaceId(repo));
    const config = testConfig([obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] })]);
    await prepare(repo, config, candidate);
    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, {
      promptForWaiver: async () => {
        writeFileSync(path.join(repo, "harness.config.ts"), "export default { changed: true };\n");
        return { author: "Test Operator", reason: "Policy was changed while answering" };
      },
    }));
    expect(result.admitted).toBe(false);
    expect(result.waiver).toBe("candidate_changed");
    expect(await waiverRecordCount(repo, config.gateId, "review.green")).toBe(0);
  });

  it("decline → blocked, with ZERO waiver records on disk", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    await prepare(repo, config, candidate);
    const prompt = fakePrompt(false);

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, { promptForWaiver: prompt.port }));

    expect(result.admitted).toBe(false);
    expect(result.waiver).toBe("declined");
    expect(blockerCodes(result)).toContain("waiver_declined");
    expect(prompt.calls.length).toBe(1);
    expect(result.waiverRecordIds).toEqual([]);
    expect(await waiverRecordCount(repo, "test.gate", "review.green")).toBe(0);
  });

  it("suppresses the prompt entirely when any blocked obligation carries a non-waivable code", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "waivable.ob", freshness: "exact_candidate", providers: ["a"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
      obligation({ id: "strict.ob", freshness: "exact_candidate", providers: ["b"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    await prepare(repo, config, candidate);
    // strict.ob is blocked by a malformed record — a non-waivable structural code.
    const storage = await resolveRecordStorage(repo);
    mkdirSync(storage.storageDir, { recursive: true });
    writeFileSync(path.join(storage.storageDir, "test.gate--strict.ob--deadbeef.json"), "not json at all", "utf8");
    const prompt = fakePrompt(true);

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate, { promptForWaiver: prompt.port }));

    expect(result.admitted).toBe(false);
    expect(prompt.calls.length).toBe(0);
    expect(blockerCodes(result)).toContain("malformed_record");
    expect(await waiverRecordCount(repo, "test.gate", "waivable.ob")).toBe(0);
  });

  it("never prompts in an agent context, even when every blocker is waivable", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    await prepare(repo, config, candidate);
    const prompt = fakePrompt(true);

    const result = await runAdmission({ rootDir: repo, config, context: AGENT }, baseOptions(candidate, { promptForWaiver: prompt.port }));

    expect(result.admitted).toBe(false);
    expect(result.waiver).toBe("not_offered");
    expect(prompt.calls.length).toBe(0);
    expect(await waiverRecordCount(repo, "test.gate", "review.green")).toBe(0);
  });

  it("blocks when the candidate drifts between the prompt and the re-evaluation", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const moved = capturedCandidate(workspaceId, { treeSha: "9".repeat(40), deliverable: { digest: "1".repeat(64), identity: "test-tree/v1" } });
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: true, waivableCodes: ["review_evidence_missing"] }),
    ]);
    await prepare(repo, config, candidate);
    const prompt = fakePrompt(true);
    // First capture (and the receipt check) see `candidate`; the re-capture after
    // the accepted prompt sees `moved`.
    let calls = 0;
    const captureCandidate = (): Promise<CandidateCapture> => {
      calls += 1;
      return Promise.resolve({ ok: true, candidate: calls === 1 ? candidate : moved });
    };

    const result = await runAdmission(
      { rootDir: repo, config, context: HUMAN },
      baseOptions(candidate, { captureCandidate, promptForWaiver: prompt.port }),
    );

    expect(result.admitted).toBe(false);
    expect(result.waiver).toBe("candidate_changed");
    expect(blockerCodes(result)).toContain("candidate_changed_during_prompt");
    expect(prompt.calls.length).toBe(1);
    expect(await waiverRecordCount(repo, "test.gate", "review.green")).toBe(0);
  });
});

// ── Record mapping: appliesToCandidate ───────────────────────────────────────

describe("admission: record mapping", () => {
  it("excludes a well-formed record bound to a different candidate — it resolves as absent, not stale", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const foreign = capturedCandidate(workspaceId, { treeSha: "7".repeat(40), deliverable: { digest: "2".repeat(64), identity: "test-tree/v1" } });
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: false, waivableCodes: [] }),
    ]);
    await prepare(repo, config, candidate);
    // Evidence for a DIFFERENT candidate, sitting in the same slot.
    await publishRecord(repo, {
      gateId: "test.gate",
      obligationId: "review.green",
      candidateBinding: recordBinding(foreign),
      resolution: { kind: "evidence", providerId: "rev", runId: "run-1", finalPassId: "pass-1", manifestDigest: "f".repeat(64) },
    });

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate));

    expect(result.admitted).toBe(false);
    // Absent, not stale: the foreign record is excluded rather than reported as
    // stale evidence. (Falsification: hardcoding appliesToCandidate=true forwards
    // the foreign record and this becomes `stale_evidence`.)
    expect(blockerCodes(result)).toContain("review_evidence_missing");
    expect(blockerCodes(result)).not.toContain("stale_evidence");
  });

  it("maps a malformed record to a diagnostic rather than dropping it", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: false, waivableCodes: [] }),
    ]);
    await prepare(repo, config, candidate);
    const storage = await resolveRecordStorage(repo);
    mkdirSync(storage.storageDir, { recursive: true });
    writeFileSync(path.join(storage.storageDir, "test.gate--review.green--corrupt.json"), "{ not valid", "utf8");

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate));

    expect(result.admitted).toBe(false);
    expect(blockerCodes(result)).toContain("malformed_record");
  });
});

// ── Workspace coherence ──────────────────────────────────────────────────────

describe("admission: workspace coherence", () => {
  it("refuses when the captured candidate and the store resolve to different workspaces", async () => {
    const repo = await tempRepo();
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: false, waivableCodes: [] }),
    ]);
    // The candidate names a workspace that is not this store's.
    const candidate = capturedCandidate("z".repeat(64));

    const result = await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate));

    expect(result.admitted).toBe(false);
    expect(blockerCodes(result)).toContain("workspace_incoherent");
  });
});

// ── Store hygiene ────────────────────────────────────────────────────────────

describe("admission: store hygiene", () => {
  it("leaves the store empty when nothing writes to it", async () => {
    const repo = await tempRepo();
    const workspaceId = await storeWorkspaceId(repo);
    const candidate = capturedCandidate(workspaceId);
    const config = testConfig([
      obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: false, waivableCodes: [] }),
    ]);
    await prepare(repo, config, candidate);
    const storage = await resolveRecordStorage(repo);

    await runAdmission({ rootDir: repo, config, context: HUMAN }, baseOptions(candidate));

    // Only the receipt leaf exists; no records leaf was created.
    const contents = readdirSync(storage.storageRoot);
    expect(contents).not.toContain("records");
  });
});


describe("installed data admission propagation", () => {
  it("uses only the current invocation resource map and retains ordinary candidate freshness", async () => {
    const repo = await tempRepo(), workspaceId = await storeWorkspaceId(repo), candidate = capturedCandidate(workspaceId);
    const original = testConfig([obligation({ id: "review.green", freshness: "exact_candidate", providers: ["rev"], humanWaiverAllowed: false, waivableCodes: [] })]);
    const source = { version: "scoped-check/1" as const, files: [], tests: ["font.test.ts"], memberships: [], cwd: ".", profile: "font", environment: [] };
    const installedData = { version: "installed-data-consumer/1" as const, consumerId: "font", source, guards: { "font.test.ts": "a".repeat(64) }, requests: [{ version: "installed-package-data/1" as const, id: "font", issuer: "font.test.ts", package: "font", manifest: "package.json" as const, files: ["font.woff2"], directories: [] }] };
    const config = { ...original, providers: [{ id: "rev", findingCodes: [], check: { command: ["node"] as [string], timeoutMs: 1000, scope: source, installedData } }], obligations: original.obligations.map(row => ({ ...row, acceptedPayloadSpecs: ["checks.passed/1", "installed-data.applicable/1"] })) };
    const resourceBinding = { version: "installed-data-binding/1" as const, candidateDigest: digestCanonical(recordBinding(candidate)), definitionDigest: "b".repeat(64), declarationDigest: "c".repeat(64), sourceApplicabilityDigest: "d".repeat(64), captureDigest: "e".repeat(64), originDigest: "f".repeat(64) };
    await prepare(repo, config, candidate);
    await publishRecord(repo, { gateId: config.gateId, obligationId: "review.green", candidateBinding: recordBinding(candidate), resolution: { kind: "evidence", providerId: "rev", runId: "run-1", finalPassId: "pass-1", manifestDigest: "f".repeat(64), resourceBinding } });
    // No ordinary passing check attempt exists in this invocation.
    const capture = vi.spyOn(checkCapture, "captureCheckBindings").mockResolvedValue({});
    try {
      const input = { rootDir: repo, config, context: HUMAN };
      expect((await runAdmission(input, baseOptions(candidate))).admitted).toBe(false);
      expect((await runAdmission(input, baseOptions(candidate, { resourceBindings: { rev: resourceBinding } }))).admitted).toBe(true);
      expect((await runAdmission(input, baseOptions(candidate, { resourceBindings: { rev: { ...resourceBinding, captureDigest: "0".repeat(64) } } }))).admitted).toBe(false);
      const moved = { ...candidate, deliverable: { ...candidate.deliverable, digest: "0".repeat(64) } };
      await prepare(repo, config, moved);
      expect((await runAdmission(input, baseOptions(moved, { resourceBindings: { rev: resourceBinding } }))).admitted).toBe(false);
    } finally { capture.mockRestore(); }
  });
});
