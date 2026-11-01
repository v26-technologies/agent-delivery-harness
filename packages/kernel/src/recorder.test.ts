/**
 * The submission flow.
 *
 * The conformance kit is this unit's acceptance test and it runs elsewhere — 89
 * vectors through this module, under two configurations. What is here is what
 * the kit cannot express, and each group says why it cannot:
 *
 *   ATOMICITY ACROSS CLAIMS (GEN-3). Every kit vector carries one claim, so no
 *   vector can show that a manifest with one good claim and one bad one writes
 *   nothing. The store is the observable.
 *
 *   THE DRIFT TAXONOMY (SUB-1). The kit has four candidate-mismatch vectors and
 *   they all produce one code. The five drift classes, the head-moved-only
 *   case, and the three config-binding disagreements are distinct situations
 *   behind that single code, and an operator's next action differs for each.
 *
 *   THE FILESYSTEM'S EDGES. A symlink is not expressible in a JSON vector, so
 *   the two cases that decide what ENV-10's realpath clause means — resolving
 *   inside the run root, resolving outside it — have no vector and are pinned
 *   here.
 *
 *   THE RECEIPT GATE. The kit publishes a receipt for every vector because a
 *   submission without one never reaches a manifest rule. That the *absence* of
 *   a receipt is a blocker rather than a rejection, and that nothing bypasses
 *   it, is this module's own contract.
 */
import { mkdir, mkdtemp, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createArtifactsPort, isSafeRelativePath } from "./artifacts.ts";
import { GATE_STRUCTURAL_FINDING_CODES, type Blocker, type NonEmptyTuple } from "./blockers.ts";
import type { CandidateCapture, CapturedCandidate } from "./candidate.types.ts";
import { DELIVERABLE_TREE_V1_NARRATION_SET, defineHarnessConfig, type HarnessConfig } from "./config.ts";
import { digestCanonical, manifestDigest, sha256Hex } from "./digest.ts";
import { publishPreparationReceipt } from "./preparation.ts";
import { compareSubmissionCandidate, submitManifest, type SubmissionOptions, type SubmissionOutcome } from "./recorder.ts";
import { validateManifest } from "./validator/envelope.ts";
import { verifyPortableEvidence } from "./portable-evidence.ts";
import * as checkCapture from "./checks.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const hex40 = (seed: string): string => sha256Hex(seed).slice(0, 40);
const hex64 = (seed: string): string => sha256Hex(seed);

const TREE = hex40("tree");
const HEAD = hex40("head");
const TIP = hex40("tip");
const MERGE_BASE = hex40("merge-base");
const PREVIOUS_TREE = hex40("previous-tree");
const IDENTITY = "deliverable-tree/v1";
const DELIVERABLE = hex64("deliverable");
const WORKSPACE_ID = "w-recorder-test";
const PROVIDER_ID = "claude-code.ce-code-review";
const RUN_ID = "r-recorder-01";
const FINAL_PASS = "pass-2";

interface CandidateShape {
  readonly vcs: string;
  readonly treeSha: string;
  readonly headSha?: string;
  readonly deliverable: { readonly digest: string; readonly identity: string };
  readonly base: { readonly ref: string; readonly tipSha: string; readonly mergeBaseSha: string };
  readonly workspaceId: string;
}

const CANDIDATE: CandidateShape = {
  vcs: "git",
  treeSha: TREE,
  headSha: HEAD,
  deliverable: { digest: DELIVERABLE, identity: IDENTITY },
  base: { ref: "origin/main", tipSha: TIP, mergeBaseSha: MERGE_BASE },
  workspaceId: WORKSPACE_ID,
};

const CAPTURED: CapturedCandidate = {
  vcs: "git",
  treeSha: TREE,
  headSha: HEAD,
  deliverable: { digest: DELIVERABLE, identity: IDENTITY },
  base: { ref: "origin/main", tipSha: TIP, mergeBaseSha: MERGE_BASE },
  workspaceId: WORKSPACE_ID,
  mode: "clean",
  statusEntries: [],
  untrackedFiles: [],
};

/** The reviewer-approval artifact RG-4 reads, for one reviewer. */
function approvalFor(reviewerId: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewerId,
      result: "approved",
      provider: { id: PROVIDER_ID, runId: RUN_ID, finalPassId: FINAL_PASS },
      workspaceId: WORKSPACE_ID,
      candidate: CANDIDATE,
    },
    null,
    2,
  )}\n`;
}

/**
 * A green payload over one or more reviewers.
 *
 * The reviewer set is a parameter because the artifact pool is shared by every
 * claim (§5.6) while RG-4 requires a one-to-one correspondence between the pool
 * and *each* claim's selected reviewers. A multi-claim manifest therefore has
 * every claim naming every reviewer in the pool — which is what a manifest from
 * one review run over two obligations actually looks like.
 */
function greenPayload(reviewers: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: { selected: [...reviewers], completed: [...reviewers], failed: [], timedOut: [] },
    findings: [],
    telemetry: { iterationCount: 2, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
    ...overrides,
  };
}

/** The two reviewers a multi-claim manifest's shared artifact pool covers. */
const BOTH: readonly string[] = ["correctness", "security"];

/** The artifact pool entry for one reviewer's approval stamp. */
function approvalEntry(reviewerId: string): Record<string, unknown> {
  return { path: `reviewers/${reviewerId}.json`, sha256: sha256Hex(approvalFor(reviewerId)), role: "reviewer-approval" };
}

interface ManifestOverrides {
  readonly candidate?: unknown;
  readonly artifacts?: readonly unknown[];
  readonly claims?: readonly unknown[];
  readonly provider?: unknown;
  readonly recordedAt?: string;
}

function manifestFor(overrides: ManifestOverrides = {}): Record<string, unknown> {
  return {
    spec: "delivery-evidence/1",
    provider: overrides.provider ?? { id: PROVIDER_ID, version: "1.0.0", runId: RUN_ID, finalPassId: FINAL_PASS },
    candidate: overrides.candidate ?? CANDIDATE,
    repository: null,
    runHistory: [
      { preparedTreeSha: PREVIOUS_TREE, evaluatedInPassId: "pass-1" },
      { preparedTreeSha: TREE, evaluatedInPassId: FINAL_PASS },
    ],
    artifacts: overrides.artifacts ?? [
      { path: "reviewers/correctness.json", sha256: sha256Hex(approvalFor("correctness")), role: "reviewer-approval" },
    ],
    attestation: { level: "self", signatures: [] },
    recordedAt: overrides.recordedAt ?? "2026-08-25T00:00:00Z",
    claims: overrides.claims ?? [{ obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload(["correctness"]) }],
  };
}

/** A config with two obligations, so atomicity across claims is expressible. */
function testConfig(): HarnessConfig {
  const obligation = (id: string) => ({
    id,
    acceptedPayloadSpecs: ["review.green/1"],
    providers: [PROVIDER_ID],
    minimumAttestationLevel: "self" as const,
    activation: { kind: "relevant_change" as const },
    freshness: "exact_candidate" as const,
    allowedResolutionKinds: ["satisfied_evidence" as const, "not_applicable" as const],
    humanWaiverAllowed: false,
    ciDelegationPolicyIds: [],
    remediation: { default: [{ id: "submit-evidence", kind: "manual_action" as const, summary: `Submit evidence for ${id}.` }] },
    waivableCodes: [],
    nonWaivableCodes: [...GATE_STRUCTURAL_FINDING_CODES],
  });

  return defineHarnessConfig({
    gateId: "recorder.test-gate",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: [IDENTITY],
    computingIdentityVersion: IDENTITY,
    providers: [{ id: PROVIDER_ID, findingCodes: [] }],
    obligations: [obligation("review.green"), obligation("security.reviewed")],
    reviewNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET],
    recordNeutral: [{ prefix: "docs/reports/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    agentEnvSignals: [],
    ciPolicies: [],
    ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    deliveryRecordPath: "docs/reports/delivery-record.json",
  });
}

const CONFIG = testConfig();

// ── The scenario harness ───────────────────────────────────────────────────

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "recorder-test-"));
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

interface Scenario {
  readonly rootDir: string;
  readonly storageRoot: string;
  readonly outsideDir: string;
  readonly runRoot: string;
  readonly runRootBase: string;
  readonly artifacts: ReturnType<typeof createArtifactsPort>;
  writeArtifact(relative: string, contents: string): Promise<void>;
  writeManifest(manifest: unknown, options?: { readonly outside?: boolean; readonly name?: string }): Promise<string>;
  prepare(candidate?: CapturedCandidate): Promise<void>;
  submit(manifestPath: string, options?: Partial<SubmissionOptions> & { readonly config?: HarnessConfig }): Promise<SubmissionOutcome>;
  recordCount(): Promise<number>;
  recordFiles(): Promise<readonly string[]>;
}

let scenarioCount = 0;

async function scenario(options: { readonly runId?: string; readonly providerId?: string } = {}): Promise<Scenario> {
  scenarioCount += 1;
  const base = path.join(workspaceRoot, `s${String(scenarioCount).padStart(3, "0")}`);
  const rootDir = path.join(base, "workspace");
  const storageRoot = path.join(base, "store");
  const runRootBase = path.join(base, "runs");
  const outsideDir = path.join(base, "outside");
  for (const directory of [rootDir, storageRoot, runRootBase, outsideDir]) {
    await mkdir(directory, { recursive: true });
  }
  for (const wiring of CONFIG.preparationWiringPaths) {
    await writeFile(path.resolve(rootDir, wiring), "// wiring fixture\n", "utf8");
  }

  const recordFiles = async (): Promise<readonly string[]> => {
    try {
      // Publisher temporaries are dot-prefixed and are not records.
      return (await readdir(path.join(storageRoot, "records"))).filter((entry) => !entry.startsWith("."));
    } catch {
      return [];
    }
  };

  const artifacts = createArtifactsPort({ runRootBase });
  const allocation = await artifacts.allocateRunRoot({ providerId: options.providerId ?? PROVIDER_ID, runId: options.runId ?? RUN_ID });
  if (!allocation.ok) throw new Error(`fixture run root refused: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  return {
    rootDir,
    storageRoot,
    outsideDir,
    runRoot,
    runRootBase,
    artifacts,
    async writeArtifact(relative, contents) {
      const target = path.join(runRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    },
    async writeManifest(manifest, writeOptions = {}) {
      const target = path.join(writeOptions.outside === true ? outsideDir : runRoot, writeOptions.name ?? "manifest.json");
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return target;
    },
    async prepare(candidate = CAPTURED) {
      await publishPreparationReceipt(rootDir, { config: CONFIG, candidate }, { storageRoot });
    },
    async submit(manifestPath, submitOptions = {}) {
      const { config, ...rest } = submitOptions;
      return submitManifest(
        { rootDir, manifestPath, config: config ?? CONFIG },
        { captureCandidate: async () => ({ ok: true, candidate: CAPTURED }), artifacts, storageRoot, ...rest },
      );
    },
    recordCount: async () => (await recordFiles()).length,
    recordFiles,
  };
}

/** The standard happy-path scenario: prepared, one artifact, manifest in the run root. */
async function preparedScenario(): Promise<Scenario> {
  const test = await scenario();
  await test.prepare();
  await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
  return test;
}

function codesOf(outcome: SubmissionOutcome): readonly string[] {
  return outcome.status === "rejected" ? outcome.rejections.map((rejection) => rejection.code) : [];
}

function blockerCodesOf(outcome: SubmissionOutcome): readonly string[] {
  return outcome.status === "accepted" ? [] : outcome.blockers.map((blocker: Blocker) => blocker.code);
}

// ── Acceptance ─────────────────────────────────────────────────────────────

describe("an accepted submission", () => {
  it("writes one record per claim, each stamped with the manifest digest", async () => {
    const test = await preparedScenario();
    await test.writeArtifact("reviewers/security.json", approvalFor("security"));
    const manifest = manifestFor({
      artifacts: [approvalEntry("correctness"), approvalEntry("security")],
      claims: [
        { obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
        { obligation: "security.reviewed", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
      ],
    });

    const outcome = await test.submit(await test.writeManifest(manifest));
    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") return;

    expect(outcome.manifestDigest).toBe(manifestDigest(manifest));
    expect(outcome.records.map((record) => record.obligationId).sort()).toEqual(["review.green", "security.reviewed"]);
    for (const record of outcome.records) {
      expect(record.status).toBe("published");
      expect(record.record.resolution).toMatchObject({
        kind: "evidence",
        providerId: PROVIDER_ID,
        runId: RUN_ID,
        finalPassId: FINAL_PASS,
        manifestDigest: outcome.manifestDigest,
      });
      // The binding is the manifest's candidate, which SUB-1 has just proved is
      // the candidate that exists. The raw tree rides along as the audit anchor.
      expect(record.record.candidateBinding).toEqual({
        treeSha: TREE,
        deliverableDigest: DELIVERABLE,
        identityToken: IDENTITY,
        baseRef: "origin/main",
        baseTipSha: TIP,
        mergeBaseSha: MERGE_BASE,
        workspaceId: WORKSPACE_ID,
      });
    }
    expect(await test.recordCount()).toBe(2);
  });

  it("is idempotent: resubmitting the same manifest finds its own records", async () => {
    const test = await preparedScenario();
    const manifestPath = await test.writeManifest(manifestFor());

    const first = await test.submit(manifestPath);
    const second = await test.submit(manifestPath);
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    if (first.status !== "accepted" || second.status !== "accepted") return;

    expect(second.records.map((record) => record.recordId)).toEqual(first.records.map((record) => record.recordId));
    expect(second.records.map((record) => record.status)).toEqual(["idempotent"]);
    expect(await test.recordCount()).toBe(1);
  });

  it("accepts a manifest nested anywhere inside the run root", async () => {
    // SUB-3 says "inside the run root", not "at one exact filename". The
    // production recorder this generalizes required
    // `<runRoot>/final-manifest.json`; the spec's rule is containment, and
    // narrowing it here would reject a conforming submission.
    const test = await preparedScenario();
    const nested = path.join(test.runRoot, "final", "manifest.json");
    await mkdir(path.dirname(nested), { recursive: true });
    await writeFile(nested, `${JSON.stringify(manifestFor(), null, 2)}\n`, "utf8");
    expect((await test.submit(nested)).status).toBe("accepted");
  });
});

describe("provider attempt binding", () => {
  it("validates and publishes the single manifest snapshot it reads", async () => {
    const test = await preparedScenario();
    const manifestPath = await test.writeManifest(manifestFor());
    let reads = 0;
    const artifacts = {
      ...test.artifacts,
      async readTextFile(target: string) {
        reads += 1;
        if (reads > 1) throw new Error("manifest was read more than once");
        return test.artifacts.readTextFile(target);
      },
    };

    const outcome = await test.submit(manifestPath, {
      artifacts,
      expectedProviderAttempt: { providerId: PROVIDER_ID, runId: RUN_ID, runRootPath: test.runRoot },
    });

    expect(outcome.status).toBe("accepted");
    expect(reads).toBe(1);
  });

  it.each([
    ["provider", { id: "other.provider", version: "1.0.0", runId: RUN_ID, finalPassId: FINAL_PASS }],
    ["run", { id: PROVIDER_ID, version: "1.0.0", runId: "other-run", finalPassId: FINAL_PASS }],
  ])("rejects a cross-%s replacement made as the recorder takes its snapshot", async (_label, replacementProvider) => {
    const test = await preparedScenario();
    const manifestPath = await test.writeManifest(manifestFor());
    let replaced = false;
    const artifacts = {
      ...test.artifacts,
      async readTextFile(target: string) {
        if (target === manifestPath && !replaced) {
          replaced = true;
          await writeFile(target, `${JSON.stringify(manifestFor({ provider: replacementProvider }), null, 2)}\n`, "utf8");
        }
        return test.artifacts.readTextFile(target);
      },
    };

    const outcome = await test.submit(manifestPath, {
      artifacts,
      expectedProviderAttempt: { providerId: PROVIDER_ID, runId: RUN_ID, runRootPath: test.runRoot },
    });

    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toContain("provider_attempt_mismatch");
    expect(await test.recordFiles()).toEqual([]);
  });

  it("rejects a cross-root symlink replacement made as the recorder takes its snapshot", async () => {
    const test = await preparedScenario();
    const manifestPath = await test.writeManifest(manifestFor());
    const foreign = await test.artifacts.allocateRunRoot({ providerId: PROVIDER_ID, runId: "other-run" });
    if (!foreign.ok) throw new Error(`foreign fixture run root refused: ${foreign.reason}`);
    const foreignManifest = path.join(foreign.runRoot.path, "manifest.json");
    await writeFile(foreignManifest, `${JSON.stringify(manifestFor(), null, 2)}\n`, "utf8");
    let replaced = false;
    const artifacts = {
      ...test.artifacts,
      async readTextFile(target: string) {
        if (target === manifestPath && !replaced) {
          replaced = true;
          await unlink(target);
          await symlink(foreignManifest, target);
        }
        return test.artifacts.readTextFile(target);
      },
    };

    const outcome = await test.submit(manifestPath, {
      artifacts,
      expectedProviderAttempt: { providerId: PROVIDER_ID, runId: RUN_ID, runRootPath: test.runRoot },
    });

    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toContain("provider_manifest_outside_attempt_root");
    expect(await test.recordFiles()).toEqual([]);
  });
});

// ── GEN-3 ──────────────────────────────────────────────────────────────────

describe("atomicity across claims (GEN-3)", () => {
  it("writes nothing at all when one claim of two is bad", async () => {
    const test = await preparedScenario();
    await test.writeArtifact("reviewers/security.json", approvalFor("security"));
    const manifest = manifestFor({
      artifacts: [approvalEntry("correctness"), approvalEntry("security")],
      claims: [
        // Valid, and it must still leave no trace.
        { obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
        // Two violations in one claim: not green, and not finalized.
        {
          obligation: "security.reviewed",
          payloadSpec: "review.green/1",
          payload: greenPayload(BOTH, { verdict: "red", finalized: false }),
        },
      ],
    });

    const outcome = await test.submit(await test.writeManifest(manifest));
    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toEqual(expect.arrayContaining(["verdict_not_green", "not_finalized"]));
    expect(await test.recordFiles()).toEqual([]);
  });

  it("writes nothing when a second claim would collide with a stored record", async () => {
    // The conflict is discovered on the *second* claim. Publishing the first
    // and then rejecting would leave a rejected submission holding a record.
    const test = await preparedScenario();
    await test.writeArtifact("reviewers/security.json", approvalFor("security"));
    const artifacts = [approvalEntry("correctness"), approvalEntry("security")];

    // A first submission that claims only the second obligation.
    const first = manifestFor({
      artifacts,
      claims: [{ obligation: "security.reviewed", payloadSpec: "review.green/1", payload: greenPayload(BOTH) }],
    });
    expect((await test.submit(await test.writeManifest(first))).status).toBe("accepted");
    expect(await test.recordCount()).toBe(1);

    // Now both obligations, with the second one's content changed. Same record
    // identity — the tuple excludes the payload — and different content.
    const second = manifestFor({
      artifacts,
      recordedAt: "2026-08-26T00:00:00Z",
      claims: [
        { obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
        { obligation: "security.reviewed", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
      ],
    });
    const outcome = await test.submit(await test.writeManifest(second));
    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toContain("record_conflict");
    // One record: the first submission's. The good claim wrote nothing.
    expect(await test.recordCount()).toBe(1);
  });
});

describe("atomicity under concurrency (GEN-3)", () => {
  /**
   * The window the preflight cannot close.
   *
   * Looking for conflicts across every claim before publishing any of them
   * makes the common case atomic, but two submissions for the same provider run
   * can interleave: both preflight clean, one publishes, and the other reaches
   * the same slot with different content and is rejected — with its earlier
   * claims already linked into place. The store's own publication closes
   * *detection*, not atomicity, so the rejection has to undo what it wrote.
   *
   * The invariant is stated over the store rather than over either submission:
   * whatever is on disk must be exactly what the accepted submissions reported.
   * A rejected submission contributing even one record is the GEN-3 breach.
   */
  it("leaves the store holding exactly the accepted submissions' records, over 40 rounds", async () => {
    for (let round = 0; round < 40; round += 1) {
      const test = await preparedScenario();
      await test.writeArtifact("reviewers/security.json", approvalFor("security"));
      const artifacts = [approvalEntry("correctness"), approvalEntry("security")];

      const single = manifestFor({
        artifacts,
        recordedAt: "2026-08-25T00:00:00Z",
        claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload(BOTH) }],
      });
      // The colliding claim is *second*, so this submission has already
      // published one record by the time it discovers the conflict.
      const pair = manifestFor({
        artifacts,
        recordedAt: "2026-08-26T00:00:00Z",
        claims: [
          { obligation: "security.reviewed", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
          { obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload(BOTH) },
        ],
      });

      const singlePath = await test.writeManifest(single, { name: "single.json" });
      const pairPath = await test.writeManifest(pair, { name: "pair.json" });
      const outcomes = await Promise.all([test.submit(singlePath), test.submit(pairPath)]);

      const expected = outcomes
        .flatMap((outcome) => (outcome.status === "accepted" ? [...outcome.records] : []))
        .map((record) => path.basename(record.path))
        .sort();
      expect([...(await test.recordFiles())].sort(), `round ${round}`).toEqual(expected);
    }
  }, 120_000);
});

// ── SUB-4 ──────────────────────────────────────────────────────────────────

describe("record conflict (SUB-4)", () => {
  it("rejects a resubmission with the same identity and different content", async () => {
    const test = await preparedScenario();
    expect((await test.submit(await test.writeManifest(manifestFor()))).status).toBe("accepted");

    // Only `recordedAt` differs. It is informational and no decision reads it —
    // but it is part of the manifest's content, so the digest changes, and the
    // digest is what the record carries. Identity is unchanged because the
    // SUB-4 tuple is provider, run, pass and candidate.
    const outcome = await test.submit(await test.writeManifest(manifestFor({ recordedAt: "2026-08-26T00:00:00Z" })));
    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toEqual(["record_conflict"]);
    expect(await test.recordCount()).toBe(1);
  });

  it("rejects when an unparseable file occupies the record's slot", async () => {
    const test = await preparedScenario();
    const accepted = await test.submit(await test.writeManifest(manifestFor()));
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    // A store the harness cannot read is not a store it may overwrite.
    await writeFile(accepted.records[0].path, "{ not json", "utf8");
    const outcome = await test.submit(await test.writeManifest(manifestFor()));
    expect(codesOf(outcome)).toEqual(["record_conflict"]);
  });
});

// ── SUB-1 ──────────────────────────────────────────────────────────────────

describe("the candidate comparison (SUB-1)", () => {
  const moved = (overrides: Partial<CapturedCandidate>): CapturedCandidate => ({ ...CAPTURED, ...overrides });

  it.each([
    ["deliverable_identity_changed", moved({ deliverable: { digest: hex64("other-deliverable"), identity: IDENTITY } }), "deliverable.digest"],
    ["raw_tree_changed", moved({ treeSha: hex40("other-tree") }), "treeSha"],
    ["base_tip_moved", moved({ base: { ...CAPTURED.base, tipSha: hex40("other-tip") } }), "base.tipSha"],
    ["merge_base_moved", moved({ base: { ...CAPTURED.base, mergeBaseSha: hex40("other-merge") } }), "base.mergeBaseSha"],
    ["workspace_changed", moved({ workspaceId: "w-elsewhere" }), "workspaceId"],
  ])("names the %s drift class and rejects", async (driftClass, captured, field) => {
    const comparison = compareSubmissionCandidate(CANDIDATE, captured);
    expect(comparison.matches).toBe(false);
    expect(comparison.mismatchedFields).toEqual([field]);
    expect(comparison.driftClasses).toEqual([driftClass]);

    const test = await scenario();
    await test.prepare(captured);
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()), {
      captureCandidate: async () => ({ ok: true, candidate: captured }),
    });
    expect(codesOf(outcome)).toContain("candidate_mismatch");
    expect(await test.recordFiles()).toEqual([]);
  });

  it("carries the differing fields and the drift class into the blocker", async () => {
    // The code alone is true of a rebase, a moved base ref and a config pointed
    // at another branch alike, and the operator's next action differs for each.
    const captured = { ...CAPTURED, base: { ...CAPTURED.base, tipSha: hex40("advanced-tip") } };
    const test = await scenario();
    await test.prepare(captured);
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()), {
      captureCandidate: async () => ({ ok: true, candidate: captured }),
    });
    if (outcome.status !== "rejected") throw new Error("expected a rejection");
    const blocker = outcome.blockers.find((candidate) => candidate.code === "candidate_mismatch");
    expect(blocker?.details).toContain("base.tipSha");
    expect(blocker?.details).toContain("base_tip_moved");
  });

  it("rejects a head that moved under an identical tree", async () => {
    // Pinned. §5.3 calls `headSha` informational because *gate-time* freshness
    // is identity-based and a rebase preserving the tree preserves the
    // evidence. SUB-1 is the other end: recording is strict, so this requires
    // re-preparation rather than being waved through.
    const captured = { ...CAPTURED, headSha: hex40("moved-head") };
    const comparison = compareSubmissionCandidate(CANDIDATE, captured);
    expect(comparison.mismatchedFields).toEqual(["headSha"]);
    // No drift class: nothing the taxonomy describes has moved.
    expect(comparison.driftClasses).toEqual([]);

    const test = await scenario();
    await test.prepare(captured);
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()), {
      captureCandidate: async () => ({ ok: true, candidate: captured }),
    });
    expect(codesOf(outcome)).toContain("candidate_mismatch");
  });

  it("compares the other eight fields when the manifest declares no head", () => {
    const { headSha: _dropped, ...withoutHead } = CANDIDATE;
    expect(compareSubmissionCandidate(withoutHead, { ...CAPTURED, headSha: hex40("anything") }).matches).toBe(true);
  });

  it.each([
    ["base.ref", { ...CAPTURED, base: { ...CAPTURED.base, ref: "upstream/trunk" } }],
    ["deliverable.identity", { ...CAPTURED, deliverable: { ...CAPTURED.deliverable, identity: "delivery-harness-tree/v1" } }],
    ["vcs", { ...CAPTURED, vcs: "hg" as CapturedCandidate["vcs"] }],
  ])("rejects the config-binding disagreement on %s", async (field, captured) => {
    const comparison = compareSubmissionCandidate(CANDIDATE, captured);
    expect(comparison.mismatchedFields).toEqual([field]);
    // Deliberately no drift class: a differing base ref, identity token or vcs
    // is a configuration disagreement, and telling an operator to re-prepare
    // would be the wrong instruction.
    expect(comparison.driftClasses).toEqual([]);

    const test = await scenario();
    await test.prepare(captured);
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()), {
      captureCandidate: async () => ({ ok: true, candidate: captured }),
    });
    expect(codesOf(outcome)).toContain("candidate_mismatch");
  });

  it("stays strict on the raw tree where an identity comparison would pass", async () => {
    // The falsification for SUB-1's strictness. Relaxing raw-tree equality to
    // identity equality is the plausible mistake — it is what the *gate* does —
    // and this scenario is built so that the relaxed rule would accept: the
    // deliverable digest and every other field are equal, and only the raw tree
    // differs.
    const captured = { ...CAPTURED, treeSha: hex40("narration-added") };
    expect(captured.deliverable.digest).toBe(CANDIDATE.deliverable.digest);
    const comparison = compareSubmissionCandidate(CANDIDATE, captured);
    expect(comparison.driftClasses).toEqual(["raw_tree_changed"]);

    const test = await scenario();
    await test.prepare(captured);
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()), {
      captureCandidate: async () => ({ ok: true, candidate: captured }),
    });
    expect(codesOf(outcome)).toContain("candidate_mismatch");
  });
});

// ── SUB-2 and the capture port ─────────────────────────────────────────────

describe("the candidate capture", () => {
  const unprepared: CandidateCapture = {
    ok: false,
    code: "candidate_unprepared",
    blockers: [
      {
        code: "candidate_unprepared",
        source: { kind: "candidate", id: "test" },
        summary: "The workspace is not prepared.",
        remediations: [{ id: "prepare-again", kind: "manual_action", summary: "Prepare the candidate." }],
      },
    ] as unknown as NonEmptyTuple<Blocker>,
  };

  it("rejects an unprepared workspace, and reports the candidate as unverified with it", async () => {
    const test = await preparedScenario();
    const outcome = await test.submit(await test.writeManifest(manifestFor()), { captureCandidate: async () => unprepared });
    expect(outcome.status).toBe("rejected");
    // SUB-2 for the state, and SUB-1 because an unobserved candidate supplies
    // no side to be equal to. Failing closed on the second is what keeps an
    // unprepared workspace from also being an unchecked one.
    expect(codesOf(outcome)).toEqual(expect.arrayContaining(["candidate_unprepared", "candidate_mismatch"]));
    expect(await test.recordFiles()).toEqual([]);
  });

  it("blocks rather than rejects when the repository itself cannot be read", async () => {
    const test = await preparedScenario();
    const outcome = await test.submit(await test.writeManifest(manifestFor()), {
      captureCandidate: async () => ({
        ...unprepared,
        code: "candidate_base_missing",
      }),
    });
    // There is no manifest rule for "the base ref is not there". Reporting one
    // would name a comparison nobody performed.
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["candidate_unprepared"]);
  });
});

// ── The receipt gate ───────────────────────────────────────────────────────

describe("the preparation receipt gate", () => {
  it("blocks a submission with no receipt, and writes nothing", async () => {
    const test = await scenario();
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()));
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["preparation_missing"]);
    expect(await test.recordFiles()).toEqual([]);
  });

  it("blocks when the wiring changed after the receipt was published", async () => {
    const test = await preparedScenario();
    await writeFile(path.resolve(test.rootDir, CONFIG.preparationWiringPaths[0] as string), "// edited\n", "utf8");
    const outcome = await test.submit(await test.writeManifest(manifestFor()));
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["preparation_wiring_mismatch"]);
  });

  it("blocks a receipt published for a candidate that has since moved", async () => {
    const test = await scenario();
    await test.prepare({ ...CAPTURED, treeSha: hex40("stale-tree") });
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()));
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["preparation_stale"]);
    // A blocker, never a rejection: the manifest was not judged at all, and
    // reporting a spec code would claim it was.
    expect(codesOf(outcome)).toEqual([]);
  });

  it("surfaces the receipt's own blockers rather than a reason string", async () => {
    const test = await scenario();
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));
    const outcome = await test.submit(await test.writeManifest(manifestFor()));
    if (outcome.status !== "blocked") throw new Error("expected a blocked outcome");
    for (const blocker of outcome.blockers) {
      expect(blocker.source.kind).toBe("preparation");
      expect(blocker.remediations.length).toBeGreaterThan(0);
    }
  });
});

// ── ENV-10, ENV-11 ─────────────────────────────────────────────────────────

describe("artifact verification", () => {
  it("rejects a declared digest that does not match the bytes", async () => {
    const test = await preparedScenario();
    const manifest = manifestFor({
      artifacts: [{ path: "reviewers/correctness.json", sha256: hex64("wrong"), role: "reviewer-approval" }],
    });
    expect(codesOf(await test.submit(await test.writeManifest(manifest)))).toContain("artifact_digest_mismatch");
  });

  it("rejects an artifact whose file is not in the run root", async () => {
    const test = await preparedScenario();
    const manifest = manifestFor({
      artifacts: [
        { path: "reviewers/correctness.json", sha256: sha256Hex(approvalFor("correctness")), role: "reviewer-approval" },
        { path: "reviewers/missing.json", sha256: hex64("missing"), role: "reviewer-approval" },
      ],
    });
    // ENV-11, not ENV-10: with no bytes there is no equality, and the run root
    // is not what was violated.
    const outcome = await test.submit(await test.writeManifest(manifest));
    expect(codesOf(outcome)).toContain("artifact_digest_mismatch");
    expect(codesOf(outcome)).not.toContain("artifact_outside_run_root");
  });

  it("rejects an artifact path that names a directory", async () => {
    const test = await preparedScenario();
    const manifest = manifestFor({
      artifacts: [{ path: "reviewers", sha256: hex64("directory"), role: "reviewer-approval" }],
    });
    expect(codesOf(await test.submit(await test.writeManifest(manifest)))).toContain("artifact_digest_mismatch");
  });

  it("accepts a symlink that resolves inside the run root", async () => {
    const test = await preparedScenario();
    await symlink(path.join(test.runRoot, "reviewers", "correctness.json"), path.join(test.runRoot, "linked.json"));
    const manifest = manifestFor({
      artifacts: [{ path: "linked.json", sha256: sha256Hex(approvalFor("correctness")), role: "reviewer-approval" }],
    });
    expect((await test.submit(await test.writeManifest(manifest))).status).toBe("accepted");
  });

  it("rejects a symlink that resolves outside the run root", async () => {
    const test = await preparedScenario();
    const outside = path.join(test.outsideDir, "correctness.json");
    await writeFile(outside, approvalFor("correctness"), "utf8");
    await symlink(outside, path.join(test.runRoot, "escaped.json"));
    const manifest = manifestFor({
      artifacts: [{ path: "escaped.json", sha256: sha256Hex(approvalFor("correctness")), role: "reviewer-approval" }],
    });
    // The one case that reaches ENV-10's realpath clause: a shape-legal path
    // whose resolution leaves the run. No JSON vector can express it.
    expect(codesOf(await test.submit(await test.writeManifest(manifest)))).toContain("artifact_outside_run_root");
  });
});

// ── A run root the provider tampered with ──────────────────────────────────

describe("a run root that is not where the harness put it", () => {
  it.each(["containment", "artifact-read"] as const)("rejects a run-root swap at the %s boundary after derivation (V13)", async (boundary) => {
    const test = await preparedScenario();
    const manifestPath = await test.writeManifest(manifestFor());
    const planted = path.join(test.outsideDir, "planted-run");
    let swapped = false;
    const swap = async () => {
      expect(swapped).toBe(false);
      await rename(test.runRoot, planted);
      await symlink(planted, test.runRoot);
      swapped = true;
    };

    // Inject through the filesystem port, after derive() has accepted the
    // original root. At artifact-read, SUB-3 has also already passed: its
    // earlier containment check must not mask a missing observation guard.
    const outcome = await test.submit(manifestPath, {
      artifacts: {
        ...test.artifacts,
        async isInsideRunRoot(root, target) {
          if (boundary === "containment") await swap();
          return test.artifacts.isInsideRunRoot(root, target);
        },
        async observeArtifact(root, declaredPath) {
          if (boundary === "artifact-read" && !swapped) await swap();
          return test.artifacts.observeArtifact(root, declaredPath);
        },
      },
    });

    expect(swapped).toBe(true);
    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toContain("artifact_outside_run_root");
    if (boundary === "containment") expect(codesOf(outcome)).toContain("manifest_outside_run_root");
    else expect(codesOf(outcome)).not.toContain("manifest_outside_run_root");
    expect(await test.recordFiles()).toEqual([]);
  });

  it("blocks a submission whose run root has been replaced with a symlink", async () => {
    // The provider owns the run root between allocation and submission, so it
    // can remove the directory and link the name somewhere else. Every
    // containment check downstream then measures the planted target: the
    // manifest and its artifacts sit outside the pool entirely and SUB-3 and
    // ENV-10 both report success. This is the failure that fails *open*, so it
    // is a blocker — there is no manifest rule for "the harness's own
    // directory is not its own".
    const test = await scenario();
    await test.prepare();

    const planted = path.join(test.outsideDir, "planted-run");
    await mkdir(path.join(planted, "reviewers"), { recursive: true });
    await writeFile(path.join(planted, "reviewers", "correctness.json"), approvalFor("correctness"), "utf8");
    await rm(test.runRoot, { recursive: true, force: true });
    await symlink(planted, path.join(test.runRootBase, PROVIDER_ID, RUN_ID));

    const manifestPath = path.join(planted, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifestFor(), null, 2)}\n`, "utf8");

    const outcome = await test.submit(manifestPath);
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["run_root_outside_base"]);
    expect(await test.recordFiles()).toEqual([]);
  });

  it("still accepts a legitimate run root, and one reached through an aliased base", async () => {
    // The other half of the fix: the base is resolved before the comparison, so
    // a symlinked temp directory — every macOS `/var` path — is an alias rather
    // than an escape.
    const test = await preparedScenario();
    expect((await test.submit(await test.writeManifest(manifestFor()))).status).toBe("accepted");
  });

  it("blocks rather than throwing when the provider id cannot be a path component", async () => {
    // ENV-1 bounds the grammar and not the length, so nothing else in the
    // system rejects a 300-character provider id: skipping the run-root rules
    // for it would accept a manifest whose artifacts were never verified.
    const test = await preparedScenario();
    const longId = "a".repeat(300);
    const manifest = manifestFor({ provider: { id: longId, runId: RUN_ID, finalPassId: FINAL_PASS } });
    const outcome = await test.submit(await test.writeManifest(manifest));
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["provider_id_too_long"]);
    expect(await test.recordFiles()).toEqual([]);
  });
});

// ── SUB-3 ──────────────────────────────────────────────────────────────────

describe("the manifest's location (SUB-3)", () => {
  it("rejects a manifest submitted from outside the run root", async () => {
    const test = await preparedScenario();
    const outcome = await test.submit(await test.writeManifest(manifestFor(), { outside: true }));
    expect(codesOf(outcome)).toContain("manifest_outside_run_root");
    expect(await test.recordFiles()).toEqual([]);
  });

  it("performs no run-root check when the run id is not a usable path component", async () => {
    const test = await preparedScenario();
    const manifest = manifestFor({ provider: { id: PROVIDER_ID, runId: "../elsewhere", finalPassId: FINAL_PASS } });
    const outcome = await test.submit(await test.writeManifest(manifest));
    expect(codesOf(outcome)).toContain("invalid_run_id");
    // No run root was allocated, so containment was never established — and a
    // code claiming it was checked would be a fabrication.
    expect(codesOf(outcome)).not.toContain("manifest_outside_run_root");
    // And nothing was created for it.
    expect(await readdir(path.dirname(test.runRoot))).toEqual([RUN_ID]);
  });
});

// ── SUB-5 ──────────────────────────────────────────────────────────────────

describe("aggregation at the recorder (SUB-5)", () => {
  it("reports the containment, digest and candidate violations in one response", async () => {
    const captured = { ...CAPTURED, treeSha: hex40("drifted") };
    const test = await scenario();
    await test.prepare(captured);
    await test.writeArtifact("reviewers/correctness.json", approvalFor("correctness"));

    const manifest = manifestFor({
      artifacts: [{ path: "reviewers/correctness.json", sha256: hex64("wrong"), role: "reviewer-approval" }],
    });
    const outcome = await test.submit(await test.writeManifest(manifest, { outside: true }), {
      captureCandidate: async () => ({ ok: true, candidate: captured }),
    });

    // Three rules, three codes, one response. First-failure reporting would
    // have named exactly one of them and sent the operator round the loop
    // twice more.
    expect(codesOf(outcome)).toEqual(
      expect.arrayContaining(["manifest_outside_run_root", "artifact_digest_mismatch", "candidate_mismatch"]),
    );
    expect(await test.recordFiles()).toEqual([]);
  });

  it("renders every rejection as a blocker carrying a remediation", async () => {
    const test = await preparedScenario();
    const outcome = await test.submit(await test.writeManifest(manifestFor(), { outside: true }));
    if (outcome.status !== "rejected") throw new Error("expected a rejection");
    expect(outcome.blockers).toHaveLength(outcome.rejections.length);
    for (const blocker of outcome.blockers) {
      expect(blocker.source).toEqual({ kind: "gate", id: "delivery-harness.submission" });
      expect(blocker.remediations.length).toBeGreaterThan(0);
    }
  });
});

// ── The manifest itself ────────────────────────────────────────────────────

describe("the submitted file", () => {
  it("blocks on a manifest that is not parseable JSON", async () => {
    const test = await preparedScenario();
    const target = path.join(test.runRoot, "manifest.json");
    await writeFile(target, "{ not json", "utf8");
    const outcome = await test.submit(target);
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["manifest_unparseable"]);
  });

  it("blocks on a manifest file that is not there", async () => {
    const test = await preparedScenario();
    const outcome = await test.submit(path.join(test.runRoot, "absent.json"));
    expect(outcome.status).toBe("blocked");
    expect(blockerCodesOf(outcome)).toEqual(["artifact_file_unreadable"]);
  });

  it("rejects an artifact path carrying a NUL byte rather than throwing", async () => {
    // `realpath` rejects a NUL-bearing path with `ERR_INVALID_ARG_VALUE`, and
    // an argument-validation `TypeError` escaping a submission would reach a
    // command surface as an internal error rather than as the bad input it is.
    const test = await preparedScenario();
    const manifest = manifestFor({
      artifacts: [{ path: "reviewers/\u0000correctness.json", sha256: hex64("nul"), role: "reviewer-approval" }],
    });
    const outcome = await test.submit(await test.writeManifest(manifest));
    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toContain("artifact_path_invalid");
  });

  it("keeps the port's path predicate and the validator's in exact step", async () => {
    // The port refuses a path before joining it; the validator rejects one
    // under ENV-10. They are deliberately two copies — the port must be safe
    // for a caller who never ran the validator — but a path one accepted and
    // the other refused would be an artifact nobody digests and no rule
    // rejects. This asserts the agreement rather than trusting the comment.
    const paths = [
      "reviewers/a.json",
      "a.json",
      "deep/nested/file.json",
      "./a.json",
      "",
      "/absolute.json",
      "\\unc.json",
      "C:/drive.json",
      "../escape.json",
      "a/../b.json",
      "a//b.json",
      "a/",
      "a\u0000b.json",
    ];

    for (const declared of paths) {
      const validation = validateManifest(manifestFor({ artifacts: [{ path: declared, sha256: hex64(declared), role: "reviewer-approval" }] }), {
        config: CONFIG,
        currentCandidate: CANDIDATE,
        prepared: true,
        artifactContents: new Map(),
      });
      const validatorRefused =
        !validation.ok && validation.rejections.some((rejection) => rejection.code === "artifact_path_invalid");
      expect(isSafeRelativePath(declared), `disagreement on ${JSON.stringify(declared)}`).toBe(!validatorRefused);
    }
  });

  it("rejects a manifest that is not a JSON object", async () => {
    const test = await preparedScenario();
    const target = path.join(test.runRoot, "manifest.json");
    await writeFile(target, "[]", "utf8");
    expect(codesOf(await test.submit(target))).toContain("malformed_field");
  });
});


describe("installed data evidence propagation", () => {
  it("retains resource authority separately and requires the current native map", async () => {
    const test = await scenario();
    const source = { version: "scoped-check/1" as const, files: [], tests: ["font.test.ts"], memberships: [], cwd: ".", profile: "font", environment: [] };
    const installedData = { version: "installed-data-consumer/1" as const, consumerId: "font", source, guards: { "font.test.ts": hex64("reader") }, requests: [{ version: "installed-package-data/1" as const, id: "font", issuer: "font.test.ts", package: "font", manifest: "package.json" as const, files: ["font.woff2"], directories: [] }] };
    const config = { ...CONFIG, providers: [{ id: PROVIDER_ID, findingCodes: [], check: { command: ["node"] as [string], timeoutMs: 1000, scope: source, installedData } }], obligations: CONFIG.obligations.map(row => ({ ...row, acceptedPayloadSpecs: ["checks.passed/1", "installed-data.applicable/1"] })) };
    // This propagation fixture supplies no passing check attempt. The ordinary
    // Git-backed check capture has its own sensors; neither validator is mocked.
    const capture = vi.spyOn(checkCapture, "captureCheckBindings").mockResolvedValue({});
    try {
    await publishPreparationReceipt(test.rootDir, { config, candidate: CAPTURED }, { storageRoot: test.storageRoot });
    const candidate = { treeSha: TREE, deliverableDigest: DELIVERABLE, identityToken: IDENTITY, baseRef: "origin/main", baseTipSha: TIP, mergeBaseSha: MERGE_BASE, workspaceId: WORKSPACE_ID };
    const binding = { version: "installed-data-binding/1" as const, candidateDigest: digestCanonical(candidate), definitionDigest: "b".repeat(64), declarationDigest: "c".repeat(64), sourceApplicabilityDigest: "d".repeat(64), captureDigest: "e".repeat(64), originDigest: "f".repeat(64) };
    const payload = { verdict: "applicable", binding };
    const result = JSON.stringify({ providerId: PROVIDER_ID, runId: RUN_ID, finalPassId: FINAL_PASS, ...payload });
    await test.writeArtifact("resource-result.json", result);
    const manifest = manifestFor({ artifacts: [{ path: "resource-result.json", role: "resource-result", sha256: sha256Hex(result) }], claims: [{ obligation: "review.green", payloadSpec: "installed-data.applicable/1", payload }] });
    const manifestPath = await test.writeManifest(manifest);
    const absent = await test.submit(manifestPath, { config });
    expect(absent.status).toBe("rejected");
    expect(await test.recordCount()).toBe(0);
    const outcome = await test.submit(manifestPath, { config, resourceBindings: { [PROVIDER_ID]: binding } });
    expect(outcome.status, JSON.stringify(outcome)).toBe("accepted");
    if (outcome.status !== "accepted") throw Error(JSON.stringify(outcome));
    const resolution = outcome.records[0]!.record.resolution;
    expect(resolution.kind).toBe("evidence");
    if (resolution.kind !== "evidence") throw Error("expected evidence");
    expect(resolution.resourceBinding).toEqual(binding);
    expect(resolution.checkBinding).toBeUndefined();
    expect(resolution.portable?.manifest).toEqual(manifest);
    const portable = resolution.portable!;
    expect(verifyPortableEvidence(config, portable, candidate, portable.context, undefined, { [PROVIDER_ID]: binding })).toEqual([]);
    expect(verifyPortableEvidence(config, portable, candidate, portable.context)).not.toEqual([]);
    for (const key of Object.keys(binding).filter(key => key !== "version")) {
      expect(verifyPortableEvidence(config, portable, candidate, portable.context, undefined, { [PROVIDER_ID]: { ...binding, [key]: "0".repeat(64) } }), key).not.toEqual([]);
    }
    expect(verifyPortableEvidence(config, portable, candidate, { ...portable.context, preparationFingerprint: "0".repeat(64) }, undefined, { [PROVIDER_ID]: binding })).not.toEqual([]);
    } finally { capture.mockRestore(); }
  });
});
