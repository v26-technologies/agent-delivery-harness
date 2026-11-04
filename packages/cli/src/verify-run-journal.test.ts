/**
 * `verify`'s run-journal completeness row, driven the way an operator drives it.
 *
 * Every scenario here runs the real CLI against a real temporary git
 * repository: the whole delivery loop to a committed record, and a real run
 * journal written through `emit` and the boundary wrap. Nothing stubs git and
 * nothing stubs the store, because the one claim this row makes — that THIS
 * record's candidate was journaled completely — is a claim about two
 * independently written artifacts agreeing on one tree sha.
 *
 * THE ROW IS NEVER EVIDENCE. `verify` passes on an absent or incomplete
 * journal exactly as it did before; only the local `--require-run-journal`
 * opt-in fails on one, and that flag reaches neither CI nor the gate.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MAX_RUN_PROVIDER_ID,
  captureGitCandidate,
  createArtifactsPort,
  defineHarnessConfig,
  digestCanonical,
  manifestDigest as digestManifest,
  resolveRecordStorage,
  sha256Hex,
  withDeliverableIdentity,
  type ArtifactsPort,
  type HarnessConfig,
  type HarnessConfigInput,
  type RunStore,
} from "@agent-delivery-harness/kernel";
import { EXIT_OK, EXIT_POLICY, EXIT_USAGE, runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";
import { ScopedChecks } from "./scoped-checks.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const PROVIDER = { id: "claude-code.ce-code-review", version: "1.0.0", runId: "r-verify-01", finalPassId: "pass-1" };
const OTHER_TREE_SHA = "b".repeat(40);
const MANDATED = ["lens.outcome-correctness", "lens.adversarial-testing"] as const;
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

function makeConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "verify.run-journal.gate",
    baseRef: "origin/main",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["deliverable-tree/v1"],
    computingIdentityVersion: "deliverable-tree/v1",
    reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
    recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    providers: [{ id: PROVIDER.id, findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: [PROVIDER.id],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
        humanWaiverAllowed: true,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: { default: [{ id: "submit-evidence", kind: "manual_action", summary: "Submit review evidence." }] },
        waivableCodes: [...STRUCTURAL_WAIVABLE],
        nonWaivableCodes: [...STRUCTURAL_NONWAIVABLE],
      },
    ],
    deliveryRecordPath: "telemetry/delivery-runs/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
    ...overrides,
  });
}

// ── Repository, CLI, and store fixtures ──────────────────────────────────────

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(withReviewProduct = false): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-verify-run-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
  await git(dir, "add", "harness.config.ts");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");
  await git(dir, "branch", "origin/main");
  if (withReviewProduct) {
    const charter = "# correctness charter\n\nReview the candidate for correctness.\n";
    const charterDigest = createHash("sha256").update(charter).digest("hex");
    await mkdir(path.join(dir, ".agent-skills/current/personas"), { recursive: true });
    await mkdir(path.join(dir, ".agent-skills/current/workflows"), { recursive: true });
    await mkdir(path.join(dir, ".agents/policy"), { recursive: true });
    await writeFile(path.join(dir, ".agent-skills/current/personas/manifest.json"), `${JSON.stringify({
      schemaVersion: "reviewer-persona-manifest/1",
      personas: [{ personaId: "persona.correctness", path: "personas/correctness.md" }],
    })}\n`);
    await writeFile(path.join(dir, ".agent-skills/current/personas/correctness.md"), charter);
    await writeFile(path.join(dir, ".agent-skills/current/workflows/delivery-v1.json"), "{}\n");
    await writeFile(path.join(dir, ".agent-skills/active.json"), `${JSON.stringify({ release: {
      releaseId: "fixture-release", profile: "linear", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64),
    } })}\n`);
    await writeFile(path.join(dir, ".agents/policy/compiled-snapshot.json"), `${JSON.stringify({
      schemaVersion: "delivery-harness-compiled-policy-snapshot/1",
      compiled: { snapshot: { reviewLenses: [{ lensId: "lens.correctness", category: "correctness", personaId: "persona.correctness", personaDigest: charterDigest }] } },
    })}\n`);
    await git(dir, "add", ".agent-skills", ".agents");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "install review product");
  }
  writeFileSync(path.join(dir, "src.txt"), "hello world\n", "utf8");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "work");
  return dir;
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

interface Harness {
  readonly dir: string;
  readonly config: HarnessConfig;
  readonly artifacts: ArtifactsPort;
  /** The candidate tree sha the record will bind, captured before the loop runs. */
  readonly treeSha: string;
  cli(argv: readonly string[], extra?: Partial<CliRuntime>): Promise<Invocation>;
  emit(kind: string, payload: unknown): Promise<Invocation>;
}

async function makeArtifacts(): Promise<ArtifactsPort> {
  const base = await mkdtemp(path.join(os.tmpdir(), "dh-verify-runroot-"));
  cleanups.push(base);
  return createArtifactsPort({ runRootBase: base });
}

async function captureTreeSha(dir: string, config: HarnessConfig): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  return capture.candidate.treeSha;
}

async function makeHarness(overrides: Partial<HarnessConfigInput> = {}, withReviewProduct = false): Promise<Harness> {
  const dir = await initRepo(withReviewProduct);
  const config = makeConfig(overrides);
  const artifacts = await makeArtifacts();
  const treeSha = await captureTreeSha(dir, config);
  const cli = async (argv: readonly string[], extra: Partial<CliRuntime> = {}): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const runtime: CliRuntime = {
      cwd: dir,
      env: {},
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      loadConfig: async () => config,
      artifacts,
      ...extra,
    };
    const code = await runCli(argv, runtime);
    return { code, out: out.join(""), err: err.join("") };
  };
  return {
    dir,
    config,
    artifacts,
    treeSha,
    cli: (argv, extra) => cli(argv, extra),
    emit: (kind, payload) => cli(["emit", kind], { readStdin: async () => JSON.stringify(payload) }),
  };
}

/**
 * The store an invocation from `dir` actually resolves, which under this
 * suite's pinned `DELIVERY_HARNESS_RUN_STORE` is not the one this repository
 * owns. Every assertion here reads back through the same resolver the CLI
 * wrote through, so the two can never disagree about which store was meant.
 */
async function storeOf(
  dir: string,
): Promise<{
  readonly store: RunStore;
  readonly runsDir: string;
  readonly commonDir: string;
  readonly worktreeKey: string;
}> {
  const resolved = await resolveRunSurface(dir);
  if (!resolved.ok) throw new Error(resolved.reason);
  const { store, runsDir, commonDir, worktreeKey } = resolved.surface;
  return { store, runsDir, commonDir, worktreeKey };
}

async function currentRun(dir: string): Promise<string | undefined> {
  const { store, worktreeKey } = await storeOf(dir);
  const current = await store.current(worktreeKey);
  if (!current.ok) throw new Error("the pointer is unreadable");
  return current.runId;
}

/** `emit run.started`, returning the run id the store allocated. */
async function startRun(harness: Harness, extra: readonly string[] = []): Promise<string> {
  const started = await harness.cli([
    "emit",
    "run.started",
    ...extra,
    "--json",
    JSON.stringify({ host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } }),
  ]);
  expect(started.code, started.err).toBe(EXIT_OK);
  const runId = await currentRun(harness.dir);
  if (runId === undefined) throw new Error("run.started left no current run");
  return runId;
}

// ── The delivery loop, to a committed record ─────────────────────────────────

function greenPayload(): unknown {
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] },
    findings: [],
    telemetry: { iterationCount: 1, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
  };
}

async function buildAcceptSubmission(harness: Harness): Promise<string> {
  const { dir, config, artifacts } = harness;
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  const captured = capture.candidate;
  const candidate = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };
  const allocation = await artifacts.allocateRunRoot({ providerId: PROVIDER.id, runId: PROVIDER.runId });
  if (!allocation.ok) throw new Error(`run root: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;
  const approval = `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewerId: "correctness",
      result: "approved",
      provider: { id: PROVIDER.id, runId: PROVIDER.runId, finalPassId: PROVIDER.finalPassId },
      workspaceId: candidate.workspaceId,
      candidate,
    },
    null,
    2,
  )}\n`;
  await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
  await writeFile(path.join(runRoot, "reviewers/correctness.json"), approval, "utf8");
  const manifest = {
    spec: "delivery-evidence/1",
    provider: PROVIDER,
    candidate,
    repository: null,
    runHistory: [{ preparedTreeSha: captured.treeSha, evaluatedInPassId: PROVIDER.finalPassId }],
    artifacts: [{ path: "reviewers/correctness.json", sha256: sha256Hex(approval), role: "reviewer-approval" }],
    attestation: { level: "self", signatures: [] },
    recordedAt: "2026-09-02T00:00:00Z",
    claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload() }],
  };
  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

/** `prepare` through `record`, then commit the record. The tree the record binds is unchanged by any of it. */
async function deliverRecord(harness: Harness, options: { readonly between?: () => Promise<void> } = {}): Promise<void> {
  const prepared = await harness.cli(["prepare"]);
  expect(prepared.code, prepared.err).toBe(EXIT_OK);
  const context = await harness.cli(["review-context"]);
  expect(context.code, context.err).toBe(EXIT_OK);
  if (options.between !== undefined) await options.between();
  const manifestPath = await buildAcceptSubmission(harness);
  const submitted = await harness.cli(["submit-evidence", "--manifest", manifestPath]);
  expect(submitted.code, submitted.err).toBe(EXIT_OK);
  const gated = await harness.cli(["gate"]);
  expect(gated.code, gated.err).toBe(EXIT_OK);
  const recorded = await harness.cli(["record"]);
  expect(recorded.code, recorded.err).toBe(EXIT_OK);
}

async function commitRecord(dir: string): Promise<void> {
  await git(dir, "add", "-A", "telemetry");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "record");
}

/** The tree sha the written record actually bound, read back off the tracked record. */
async function recordedTreeSha(dir: string): Promise<string> {
  const recordDir = path.join(dir, "telemetry/delivery-runs");
  const names = (await readdir(recordDir)).filter((name) => name.startsWith("record--") && name.endsWith(".json"));
  expect(names).toHaveLength(1);
  const parsed = JSON.parse(await readFile(path.join(recordDir, names[0]!), "utf8")) as {
    candidateBinding: { treeSha: string };
  };
  return parsed.candidateBinding.treeSha;
}

// ── Journal shapes ───────────────────────────────────────────────────────────

const prerequisites = (): readonly (readonly [string, unknown])[] => [
  ["ticket.read", { ticket: "V26-1556", tracker: "linear" }],
  ["posture.declared", { posture: "test-first" }],
  ["lens.selected", { mandated: [...MANDATED], selected: [...MANDATED], rationale: "the shipped pair" }],
];

const roundOpened = (treeSha: string): readonly [string, unknown] => [
  "review.round.opened",
  { round: 1, candidateTreeSha: treeSha, lenses: [...MANDATED] },
];

const roundClosed = (treeSha: string): readonly [string, unknown] => [
  "review.round.closed",
  {
    round: 1,
    candidateTreeSha: treeSha,
    outcome: "aligned",
    findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
    cost: { unit: "usd", total: 0, reportedBy: "vitest" },
  },
];

const ended = (): readonly [string, unknown] => [
  "run.ended",
  { result: "complete", cost: { unit: "usd", total: 0, reportedBy: "vitest" } },
];

async function emitAll(harness: Harness, steps: readonly (readonly [string, unknown])[]): Promise<void> {
  for (const [kind, payload] of steps) {
    const result = await harness.emit(kind, payload);
    expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
  }
}

/**
 * A run journaled the way the harness's own delivery journals one: the CLI
 * writes the `gate` and `record` completions from inside the loop, and the
 * executor writes everything around them.
 */
async function journaledDelivery(
  harness: Harness,
  options: { readonly withPrOpened?: boolean; readonly roundTreeSha?: string } = {},
): Promise<string> {
  const runId = await startRun(harness);
  const roundSha = options.roundTreeSha ?? harness.treeSha;
  await emitAll(harness, [...prerequisites(), roundOpened(roundSha), roundClosed(roundSha)]);
  await deliverRecord(harness);
  if (options.withPrOpened !== false) {
    await emitAll(harness, [["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }]]);
  }
  await commitRecord(harness.dir);
  await emitAll(harness, [ended()]);
  return runId;
}

/**
 * Athena's finished state: no product command ran, so the journal carries no
 * CLI completion at all and `gate.reported` stands in its ordered place. The
 * record is delivered first, with no run current, so the boundary wrap writes
 * nothing into it.
 */
async function executorOnlyDelivery(harness: Harness): Promise<string> {
  await deliverRecord(harness);
  await commitRecord(harness.dir);
  const runId = await startRun(harness);
  await emitAll(harness, [
    ...prerequisites(),
    roundOpened(harness.treeSha),
    roundClosed(harness.treeSha),
    ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 5 }],
    ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }],
    ended(),
  ]);
  return runId;
}

/** The row `verify` printed, as the lines under its `run journal:` heading. */
function rowOf(out: string): string {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => line.includes("run journal:"));
  expect(start, `verify printed a run-journal row:\n${out}`).toBeGreaterThanOrEqual(0);
  return lines.slice(start).join("\n");
}

// ── Scenarios ────────────────────────────────────────────────────────────────

describe("the composite admit command", () => {
  it("transcribes a concluded outcome against the exact current context and records the admitted candidate", { timeout: 120000 }, async () => {
    const harness = await makeHarness({}, true);
    const prepared = await harness.cli(["prepare"]);
    expect(prepared.code, prepared.err).toBe(EXIT_OK);
    const reviewed = await harness.cli(["review-context", "--json"]);
    expect(reviewed.code, reviewed.err).toBe(EXIT_OK);
    const reviewContext = JSON.parse(reviewed.out) as { digest: string };
    const outcome = {
      spec: "review-outcome/1",
      contextDigest: reviewContext.digest,
      verdict: "green",
      reviewers: [{ id: "correctness", result: "approved" }],
      findings: [],
    };
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-admit-outcome-"));
    cleanups.push(scratch);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, `${JSON.stringify(outcome, null, 2)}\n`);

    const admitted = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(admitted.code, admitted.err).toBe(EXIT_OK);
    expect(admitted.out).toContain("prepared:");
    expect(admitted.out).toContain("review evidence:");
    expect(admitted.out).toContain("submitted:");
    expect(admitted.out).toContain("gate: admitted");
    expect(admitted.out).toContain("recorded telemetry/delivery-runs/record--");

    const recordDir = path.join(harness.dir, "telemetry/delivery-runs");
    const names = (await readdir(recordDir)).filter((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const record = JSON.parse(await readFile(path.join(recordDir, names[0]!), "utf8"));
    const portable = record.claims[0].evidence.resolution.portable;
    const contextEntry = portable.manifest.artifacts.find((entry: { role: string }) => entry.role === "review-context");
    const outcomeEntry = portable.manifest.artifacts.find((entry: { role: string }) => entry.role === "review-outcome");
    expect(JSON.parse(Buffer.from(portable.artifacts[contextEntry.path], "base64").toString("utf8"))).toEqual(JSON.parse(reviewed.out));
    expect(JSON.parse(Buffer.from(portable.artifacts[outcomeEntry.path], "base64").toString("utf8"))).toEqual(outcome);
  });

  it("still gates and records under a focused base, while the gate and record commands take the focused outcome", { timeout: 120000 }, async () => {
    const harness = await makeHarness({}, true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-admit-focused-"));
    cleanups.push(scratch);
    const remote = path.join(scratch, "remote.git"), seed = path.join(scratch, "seed");
    await mkdir(remote);
    await git(remote, "init", "-q", "--bare", "-b", "main");
    await mkdir(path.join(seed, ".agents"), { recursive: true });
    await git(seed, "init", "-q", "-b", "main");
    await git(seed, "config", "user.name", "Test");
    await git(seed, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(seed, ".agents/delivery-posture.json"), `${JSON.stringify({ schemaVersion: "delivery-posture/1", posture: "focused", reason: "Tuning the gate." })}\n`);
    await git(seed, "add", "-A");
    await git(seed, "-c", "commit.gpgsign=false", "commit", "-qm", "focused");
    await git(seed, "push", "-q", remote, "HEAD:refs/heads/main");
    await git(harness.dir, "remote", "add", "origin", remote);

    const gated = await harness.cli(["gate"]);
    expect(gated.code, gated.err).toBe(EXIT_OK);
    expect(gated.out).toContain("outcome: focused");

    const prepared = await harness.cli(["prepare"]);
    expect(prepared.code, prepared.err).toBe(EXIT_OK);
    const reviewed = await harness.cli(["review-context", "--json"]);
    expect(reviewed.code, reviewed.err).toBe(EXIT_OK);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, `${JSON.stringify({
      spec: "review-outcome/1",
      contextDigest: (JSON.parse(reviewed.out) as { digest: string }).digest,
      verdict: "green",
      reviewers: [{ id: "correctness", result: "approved" }],
      findings: [],
    }, null, 2)}\n`);

    const admitted = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(admitted.code, admitted.err).toBe(EXIT_OK);
    expect(admitted.out).toContain("gate: admitted");
    expect(admitted.out).toContain("recorded telemetry/delivery-runs/record--");
    expect(admitted.out).not.toContain("outcome: focused");
    const names = (await readdir(path.join(harness.dir, "telemetry/delivery-runs"))).filter((name) => name.startsWith("record--"));
    expect(names).toHaveLength(1);
  });

  it("refuses an outcome for any other review context before evidence or a record is published", { timeout: 120000 }, async () => {
    const harness = await makeHarness({}, true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-admit-mismatch-"));
    cleanups.push(scratch);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, `${JSON.stringify({
      spec: "review-outcome/1",
      contextDigest: "f".repeat(64),
      verdict: "green",
      reviewers: [{ id: "correctness", result: "approved" }],
      findings: [],
    })}\n`);

    const refused = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(refused.code).toBe(EXIT_POLICY);
    expect(refused.err).toContain("review_outcome_invalid");
    expect(refused.err).toContain("does not name the original review context digest");
    const storage = await resolveRecordStorage(harness.dir, { storageNamespace: harness.config.storageNamespace });
    expect((await readdir(storage.storageDir).catch(() => [])).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(await readdir(path.join(harness.dir, "telemetry/delivery-runs")).catch(() => [])).toEqual([]);
  });

  it("stops at a failed preparation without interpreting the review outcome", { timeout: 120000 }, async () => {
    const harness = await makeHarness({
      preparationCommands: [{ id: "failing-check", command: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 }],
    }, true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-admit-prepare-failure-"));
    cleanups.push(scratch);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, `${JSON.stringify({
      spec: "review-outcome/1",
      contextDigest: "f".repeat(64),
      verdict: "green",
      reviewers: [{ id: "correctness", result: "approved" }],
      findings: [],
    })}\n`);

    const refused = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(refused.code).toBe(EXIT_POLICY);
    expect(refused.err).toContain("preparation_command_failed");
    expect(refused.err).not.toContain("review_outcome_invalid");
    expect(await readdir(path.join(harness.dir, "telemetry/delivery-runs")).catch(() => [])).toEqual([]);
  });

  it("transcribes a non-green review without turning it into an admitted record", { timeout: 120000 }, async () => {
    const harness = await makeHarness({}, true);
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    const context = await harness.cli(["review-context", "--json"]);
    expect(context.code, context.err).toBe(EXIT_OK);
    const reviewed = JSON.parse(context.out) as { digest: string };
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-admit-rejected-"));
    cleanups.push(scratch);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, `${JSON.stringify({
      spec: "review-outcome/1",
      contextDigest: reviewed.digest,
      verdict: "changes-requested",
      reviewers: [{ id: "correctness", result: "rejected" }],
      findings: [],
    })}\n`);

    const refused = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(refused.code).toBe(EXIT_POLICY);
    expect(refused.err).toContain("verdict_not_green");
    expect(refused.err).toContain("approval_missing");
    expect(await readdir(path.join(harness.dir, "telemetry/delivery-runs")).catch(() => [])).toEqual([]);
  });

  it("rejects malformed outcome input before preparing or writing a record", { timeout: 120000 }, async () => {
    const harness = await makeHarness({}, true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-admit-malformed-"));
    cleanups.push(scratch);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, "{\n");

    const refused = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(refused.code).toBe(EXIT_USAGE);
    expect(refused.err).toContain("readable JSON document");
    const unprepared = await harness.cli(["review-context"]);
    expect(unprepared.code).toBe(EXIT_POLICY);
    expect(unprepared.err).toContain("review_context_requires_receipt");
    expect(await readdir(path.join(harness.dir, "telemetry/delivery-runs")).catch(() => [])).toEqual([]);
  });
});

const SCOPED_CHECK = "fixture.scoped-check";

/** One scoped check provider and its obligation beside the review provider. */
function scopedCheckOverrides(): Partial<HarnessConfigInput> {
  const review = makeConfig().obligations[0]!;
  return {
    providers: [
      { id: PROVIDER.id, findingCodes: [] },
      { id: SCOPED_CHECK, findingCodes: [], check: {
        command: [process.execPath, "-e", "require('fs').writeFileSync('result.json','{}')"], timeoutMs: 5000, outputs: ["result.json"],
        scope: { version: "scoped-check/1", files: ["src.txt"], memberships: [], tests: [], cwd: ".", profile: "fixture", environment: [] },
      } },
    ],
    obligations: [review, { ...review, id: "check.passed", activation: { kind: "always" }, providers: [SCOPED_CHECK],
      acceptedPayloadSpecs: ["checks.passed/1"], humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_evidence"] }],
    scopedExecution: { version: "scoped-execution/1", mechanicalProviders: [],
      profiles: [{ id: "fixture", gitContext: "none", dependencyInputs: [], mutableOutputs: ["result.json"], credentialIdentities: {} }] },
  } as Partial<HarnessConfigInput>;
}

/** Emits green review evidence for the current prepared candidate and returns the manifest path. */
async function emitGreenReview(harness: Harness): Promise<string> {
  const reviewed = await harness.cli(["review-context", "--json"]);
  expect(reviewed.code, reviewed.err).toBe(EXIT_OK);
  const contextDir = await mkdtemp(path.join(os.tmpdir(), "dh-scoped-context-"));
  cleanups.push(contextDir);
  const contextPath = path.join(contextDir, "review-context.json");
  await writeFile(contextPath, reviewed.out);
  const outcome = { spec: "review-outcome/1", contextDigest: (JSON.parse(reviewed.out) as { digest: string }).digest,
    verdict: "green", reviewers: [{ id: "correctness", result: "approved" }], findings: [] };
  const emitted = await harness.cli(["emit-review-evidence", "--context", contextPath], { readStdin: async () => `${JSON.stringify(outcome)}\n` });
  expect(emitted.code, emitted.err).toBe(EXIT_OK);
  return emitted.out.trim();
}

describe("review evidence beside a scoped check", () => {
  it("submits review evidence for the prepared candidate, then gates and records it", { timeout: 120000 }, async () => {
    const harness = await makeHarness(scopedCheckOverrides(), true);
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    const submitted = await harness.cli(["submit-evidence", "--manifest", await emitGreenReview(harness)]);
    expect(submitted.code, submitted.err).toBe(EXIT_OK);
    expect(submitted.out).toContain("review.green: published");
    const gated = await harness.cli(["gate"]);
    expect(gated.code, gated.err).toBe(EXIT_OK);
    expect(gated.out).toContain("review.green=satisfied_evidence");
    expect(gated.out).toContain("check.passed=satisfied_evidence");
    expect((await harness.cli(["record"])).code).toBe(EXIT_OK);
  });

  it("accepts the scoped check's retained manifest resubmitted through submit-evidence", { timeout: 120000 }, async () => {
    const harness = await makeHarness(scopedCheckOverrides(), true);
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    const submitted = await harness.cli(["submit-evidence", "--manifest", await emitGreenReview(harness)]);
    expect(submitted.code, submitted.err).toBe(EXIT_OK);
    const gated = await harness.cli(["gate"]);
    expect(gated.code, gated.err).toBe(EXIT_OK);
    const runId = new RegExp(`passed ${SCOPED_CHECK}: .*; retained (\\S+)`).exec(gated.out)?.[1];
    expect(runId, gated.out).toBeDefined();
    const root = await harness.artifacts.resolveRunRoot({ providerId: SCOPED_CHECK, runId: runId! });
    if (!root.ok) throw new Error(`run root unavailable: ${root.reason}`);
    // Only the check's retained output, read through the scoped session, can confirm its binding.
    const resubmitted = await harness.cli(["submit-evidence", "--manifest", path.join(root.runRoot.path, "manifest.json")]);
    expect(resubmitted.code, resubmitted.err).toBe(EXIT_OK);
    expect(resubmitted.out).toContain("accepted (manifestDigest");
    // The gate already published this exact manifest, so the resubmission is recognized as the same publication.
    expect(resubmitted.out).toContain("check.passed: idempotent");
  });

  it("admits a concluded outcome end to end", { timeout: 120000 }, async () => {
    const harness = await makeHarness(scopedCheckOverrides(), true);
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    const reviewed = await harness.cli(["review-context", "--json"]);
    expect(reviewed.code, reviewed.err).toBe(EXIT_OK);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "dh-scoped-admit-"));
    cleanups.push(scratch);
    const outcomePath = path.join(scratch, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ spec: "review-outcome/1", contextDigest: (JSON.parse(reviewed.out) as { digest: string }).digest,
      verdict: "green", reviewers: [{ id: "correctness", result: "approved" }], findings: [] }));
    const admitted = await harness.cli(["admit", "--outcome", outcomePath]);
    expect(admitted.code, admitted.err).toBe(EXIT_OK);
    expect(admitted.out).toContain("submitted:");
    expect(admitted.out).toContain("gate: admitted");
    expect(admitted.out).toContain("recorded telemetry/delivery-runs/record--");
  });

  it("still refuses a plan built for a candidate whose base has since moved", { timeout: 120000 }, async () => {
    const harness = await makeHarness(scopedCheckOverrides(), true);
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    const storage = await resolveRecordStorage(harness.dir, { storageNamespace: harness.config.storageNamespace });
    const stale = await captureGitCandidate({ rootDir: harness.dir, config: harness.config, workspaceId: storage.workspaceId, computeIdentity: withDeliverableIdentity() });
    if (!stale.ok) throw new Error(`capture failed: ${stale.code}`);
    await git(harness.dir, "branch", "-f", "origin/main", "HEAD");
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    const manifestPath = await emitGreenReview(harness);
    const create = ScopedChecks.create.bind(ScopedChecks);
    const spy = vi.spyOn(ScopedChecks, "create").mockImplementation(context => create(context, stale.candidate));
    try {
      const refused = await harness.cli(["submit-evidence", "--manifest", manifestPath]);
      expect(spy).toHaveBeenCalled();
      expect(refused.code).toBe(EXIT_POLICY);
      expect(refused.err).toContain("scoped_check_plan_required");
    } finally { spy.mockRestore(); }
  });
});

describe("verify's run-journal completeness row", () => {
  it("reports complete for a record whose candidate has a complete journal", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    expect(await recordedTreeSha(harness.dir)).toBe(harness.treeSha);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("complete");
    expect(row).not.toContain("incomplete");
    expect(row).toContain(runId);
    expect(row).toContain("self-attested");
    expect(row).toContain("observability, not evidence");
    // The label that separates this caller from the viewer's: `verify` judged
    // the round constraints against THIS record's candidate.
    expect(row).toContain("bound to the record");
    // And the binding is named on the healthy row too, not only where a
    // projection widened it: an operator who sees the reviewed-tree sentence
    // elsewhere can tell the two apart because both are always printed.
    expect(row).toContain("round binding: the governing closed round binds the record's own candidate tree");
    // Nothing was violated, so no reason and no admission sentence appear.
    expect(row).not.toContain("admission:");

    // The opt-in agrees with the row it reads.
    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code, required.err).toBe(EXIT_OK);
  });

  it.each([false, true])("recognizes reviewed trees through record-neutral transport (projection=%s)", { timeout: 120000 }, async (withProjection) => {
    const harness = await makeHarness({}, true);
    const runId = await startRun(harness);
    await emitAll(harness, prerequisites());

    const prepared = await harness.cli(["prepare"]);
    expect(prepared.code, prepared.err).toBe(EXIT_OK);
    const reviewed = await harness.cli(["review-context", "--json"]);
    expect(reviewed.code, reviewed.err).toBe(EXIT_OK);
    const reviewedDocument = JSON.parse(reviewed.out) as { digest: string; binding: { candidate: { treeSha: string } } };
    const reviewedTreeSha = reviewedDocument.binding.candidate.treeSha;
    await emitAll(harness, [roundOpened(reviewedTreeSha), roundClosed(reviewedTreeSha)]);

    if (withProjection) {
      await mkdir(path.join(harness.dir, "docs/reports"), { recursive: true });
      await writeFile(path.join(harness.dir, "docs/reports/review.md"), "Reviewed delivery report.\n");
      await git(harness.dir, "add", "docs/reports/review.md");
      await git(harness.dir, "commit", "--quiet", "--no-gpg-sign", "-m", "add neutral review report");
      expect(await captureTreeSha(harness.dir, harness.config)).not.toBe(reviewedTreeSha);
      expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    }

    const contextDir = await mkdtemp(path.join(os.tmpdir(), "dh-reviewed-context-"));
    cleanups.push(contextDir);
    const contextPath = path.join(contextDir, "review-context.json");
    await writeFile(contextPath, reviewed.out);
    const outcome = {
      spec: "review-outcome/1",
      contextDigest: reviewedDocument.digest,
      verdict: "green",
      reviewers: [{ id: "correctness", result: "approved" }],
      findings: [],
    };
    const emitted = await harness.cli(["emit-review-evidence", "--context", contextPath], {
      readStdin: async () => `${JSON.stringify(outcome)}\n`,
    });
    expect(emitted.code, emitted.err).toBe(EXIT_OK);
    const manifestPath = emitted.out.trim();
    expect((await harness.cli(["submit-evidence", "--manifest", manifestPath])).code).toBe(EXIT_OK);
    expect((await harness.cli(["gate"])).code).toBe(EXIT_OK);
    await mkdir(path.join(harness.dir, "telemetry/delivery-runs"), { recursive: true });
    await writeFile(path.join(harness.dir, "telemetry/delivery-runs/transport.json"), '{"observation":"retained"}\n');
    await git(harness.dir, "add", "telemetry/delivery-runs/transport.json");
    const transportedTreeSha = await captureTreeSha(harness.dir, harness.config);
    expect((await harness.cli(["prepare"])).code).toBe(EXIT_OK);
    expect((await harness.cli(["record"])).code).toBe(EXIT_OK);
    expect(await recordedTreeSha(harness.dir)).toBe(transportedTreeSha);
    await emitAll(harness, [["pr.opened", { url: "https://example.invalid/pr/neutral", candidateTreeSha: transportedTreeSha }]]);
    await commitRecord(harness.dir);
    await emitAll(harness, [ended()]);

    const verified = await harness.cli(["verify", "--require-run-journal"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain(runId);
    expect(row).toContain(`record candidate: ${transportedTreeSha}`);
    expect(row.split("\n").find(line => line.includes("reviewed candidate:"))).toContain(reviewedTreeSha);
    expect(row).toContain("verified review-neutral projection");
    expect(row).not.toContain("gate-before-closed-round");
    expect(row).not.toContain("round-not-bound-to-record");
    // The acceptance is displayed with where it came from — this record's own
    // verified evidence — and with the explicit statement that the two trees
    // differ, so the row is never read as a claim that they are the same tree.
    expect(row).toContain("round binding: the governing closed round binds a reviewed candidate above");
    expect(row).toContain("accepted from this record's verified review-neutral projection");
    expect(row).toContain("the two trees differ and neither is claimed to equal the other");
    // Nothing was violated, so the row carries no admission disclaimer to read
    // past; the statement appears exactly where a warning does.
    expect(row).not.toContain("admission: none of the above");

    if (!withProjection) return;
    const recordDir = path.join(harness.dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--"));
    if (recordName === undefined) throw new Error("record missing");
    const recordPath = path.join(recordDir, recordName);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const portable = record.claims[0].evidence.resolution.portable;
    const projectionEntry = portable.manifest.artifacts.find((entry: { role: string }) => entry.role === "review-context-projection");
    const projection = JSON.parse(Buffer.from(portable.artifacts[projectionEntry.path], "base64").toString("utf8"));
    projection.reviewedCandidate.treeSha = OTHER_TREE_SHA;
    const corruptBytes = `${JSON.stringify(projection)}\n`;
    portable.artifacts[projectionEntry.path] = Buffer.from(corruptBytes).toString("base64");
    projectionEntry.sha256 = sha256Hex(corruptBytes);
    const changedManifestDigest = digestManifest(portable.manifest);
    record.manifestDigest = changedManifestDigest;
    record.claims[0].manifestDigest = changedManifestDigest;
    record.claims[0].evidence.resolution.manifestDigest = changedManifestDigest;
    delete record.integrityDigest;
    record.integrityDigest = digestCanonical(record);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    await git(harness.dir, "add", recordPath);
    await git(harness.dir, "commit", "--quiet", "--no-gpg-sign", "-m", "corrupt retained projection");

    const refused = await harness.cli(["verify", "--require-run-journal"]);
    expect(refused.code).toBe(EXIT_POLICY);
    expect(refused.err).toContain("portable_review_outcome_invalid");
    expect(refused.out).not.toContain("reviewed candidate:");
  });

  it("finds the journal by the record's tree sha after the run ended and the pointer was cleared", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    expect(await currentRun(harness.dir), "run.ended clears its own worktree pointer").toBeUndefined();

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    expect(rowOf(verified.out)).toContain(runId);
  });

  it("fails under the opt-in on an incomplete journal, naming the missing kinds, and passes without it", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await journaledDelivery(harness, { withPrOpened: false });

    const relaxed = await harness.cli(["verify"]);
    expect(relaxed.code, relaxed.err).toBe(EXIT_OK);
    expect(rowOf(relaxed.out)).toContain("pr.opened");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("pr.opened");
  });

  it("fails under the opt-in on an executor-only journal, naming both CLI completions", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await executorOnlyDelivery(harness);

    const relaxed = await harness.cli(["verify"]);
    expect(relaxed.code, relaxed.err).toBe(EXIT_OK);
    const row = rowOf(relaxed.out);
    expect(row).toContain("complete-executor-only");
    expect(row).toContain(runId);
    expect(row).toContain("command.completed:gate");
    expect(row).toContain("command.completed:record");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("command.completed:gate");
    expect(required.err).toContain("command.completed:record");
  });

  it("reports mandated-pair-mismatch when --mandated-lens differs from the journal's pair", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await journaledDelivery(harness);

    const verified = await harness.cli(["verify", "--mandated-lens", "lens.security", "--mandated-lens", "lens.performance"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("incomplete");
    expect(row).toContain("mandated-pair-mismatch");

    // The journal's own pair, supplied, agrees.
    const agreeing = await harness.cli(["verify", "--mandated-lens", MANDATED[0], "--mandated-lens", MANDATED[1]]);
    expect(agreeing.code, agreeing.err).toBe(EXIT_OK);
    expect(rowOf(agreeing.out)).not.toContain("mandated-pair-mismatch");
  });

  it("reports round-not-bound-to-record when the only paired round binds another tree", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    // Selected on the `pr.opened` that carries the record's tree sha, and still
    // unbound: no CLOSED ROUND names it.
    await deliverRecord(harness);
    await commitRecord(harness.dir);
    const runId = await startRun(harness);
    await emitAll(harness, [
      ...prerequisites(),
      roundOpened(OTHER_TREE_SHA),
      roundClosed(OTHER_TREE_SHA),
      ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }],
      ended(),
    ]);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain(runId);
    expect(row).toContain("incomplete");
    expect(row).toContain("round-not-bound-to-record");

    // The three questions a bare identifier leaves open, answered on the row
    // itself: which trees a round could have bound, why the gate warning is
    // beside it, and whether any of it stops this candidate being admitted.
    expect(row).toContain("round binding: no closed round binds the record's candidate tree or any reviewed candidate it accepts");
    expect(row).toContain("round-not-bound-to-record: the governing round closed at seq");
    expect(row).toContain("admission: none of the above blocks admission");
    expect(row).toContain("Only --require-run-journal blocks, and only this verify invocation.");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("round-not-bound-to-record");
    // The refusal carries the same reason, so nobody has to re-run the command
    // with the flag dropped just to read why it refused.
    expect(required.err).toContain("round-not-bound-to-record: the governing round closed at seq");
    expect(required.err).toContain("none of the above blocks admission");
  });

  /**
   * The shape this ticket was filed from: a round closed against an earlier
   * tree, and a gate reported after it. Two warnings appear, and they are one
   * fact — the gate warning exists only because no round this record accepts
   * closed at all. A row that listed them as peers would send an operator
   * looking for a mis-ordered gate that never happened.
   */
  it("names the gate warning as a consequence of the unaccepted round, not a second defect", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await deliverRecord(harness);
    await commitRecord(harness.dir);
    const runId = await startRun(harness);
    await emitAll(harness, [
      ...prerequisites(),
      roundOpened(OTHER_TREE_SHA),
      roundClosed(OTHER_TREE_SHA),
      ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 5 }],
      ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }],
      ended(),
    ]);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("round-not-bound-to-record");
    expect(row).toContain("gate-reported-before-closed-round: the governing gate.reported at seq");
    expect(row).toContain("a consequence of round-not-bound-to-record, not a separate mistake");
    // The gate itself is not accused of preceding anything: there is no closed
    // round this record accepts for it to have preceded.
    expect(row).not.toContain("precedes the governing closed round");
    expect(row).toContain("admission: none of the above blocks admission");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    // The clause naming the other warning as this one's cause is ADJACENT to
    // the identifier, ahead of the reason. The reason is the part the refusal's
    // per-warning bound truncates, so a clause written after it is the first
    // thing the 600-character cap destroys — and two warnings printed as peers
    // with nothing saying one restates the other are the misreading this row
    // exists to prevent.
    expect(required.err).toContain("gate-reported-before-closed-round (a consequence of round-not-bound-to-record): the governing gate.reported at seq");
    expect(required.err).toContain("none of the above blocks admission");
    // Three sightings of the second warning: the violations list, the clause
    // naming it as the first warning's cause, and the start of its own
    // segment. The third is what the per-warning reason bound of 120 buys over
    // the stdout row's 400 - a larger bound spends the last of the
    // 600-character budget on the first warning's reason, and this warning
    // keeps only its `violations:` entry and the consequence clause without
    // ever beginning a segment of its own.
    //
    // This holds at the run id the store mints (`run-` + 16 hex = 20
    // characters) and has no margin above it: one more character ahead of the
    // explanations - a longer run id, another `missing:` entry, a third
    // warning - takes the third sighting away. So read a red here as
    // "something grew ahead of the explanations", not as "the bound
    // regressed", and check which before changing the bound.
    expect(runId).toHaveLength(20);
    expect(required.err.split("round-not-bou").length - 1).toBeGreaterThanOrEqual(3);
    // The remediation says to emit the run events this delivery did not
    // journal; this list is the only place the refusal names them, so it has
    // to survive the 600-character cap on a detail with two warnings in it.
    expect(required.err).toContain("missing: command.completed:gate");
  });

  it("resolves two journals binding the record's tree to one run, naming the other in alsoMatching", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const displaced = await startRun(harness);
    await emitAll(harness, [...prerequisites(), roundOpened(harness.treeSha), roundClosed(harness.treeSha)]);

    // The second start displaces the first run's pointer; the first journal is
    // left incomplete and still binds the record's candidate.
    const later = await startRun(harness, ["--force"]);
    expect(later).not.toBe(displaced);
    await emitAll(harness, [...prerequisites(), roundOpened(harness.treeSha), roundClosed(harness.treeSha)]);
    await deliverRecord(harness);
    await emitAll(harness, [["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }]]);
    await commitRecord(harness.dir);
    await emitAll(harness, [ended()]);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    // One journal is selected and the other is named beside it; which is which
    // is the store's ranking, asserted where that ranking lives.
    expect(row).toContain(displaced);
    expect(row).toContain(later);
    expect(row).toContain("also matching");
  });

  it("reports absent when the only matching journal refuses the read discipline", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    const { runsDir } = await storeOf(harness.dir);
    // Group-readable: the store's owner-only discipline refuses it, so the scan
    // skips it and there is nothing else to find.
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o644);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("absent");
    expect(row).not.toContain(runId);

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("absent");
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o600);
  });

  it("finds the journal in a repository with a non-default storage namespace", { timeout: 120000 }, async () => {
    const harness = await makeHarness({ storageNamespace: "custom-delivery-namespace/" });
    const runId = await journaledDelivery(harness);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("complete");
    expect(row).toContain(runId);
  });

  it("resolves the store under the invoking worktree even with GIT_DIR and GIT_COMMON_DIR planted", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    const elsewhere = await makeHarness();
    const saved = { dir: process.env["GIT_DIR"], common: process.env["GIT_COMMON_DIR"] };
    process.env["GIT_DIR"] = path.join(elsewhere.dir, ".git");
    process.env["GIT_COMMON_DIR"] = path.join(elsewhere.dir, ".git");
    try {
      const verified = await harness.cli(["verify"]);
      expect(verified.code, verified.err).toBe(EXIT_OK);
      expect(rowOf(verified.out)).toContain(runId);
      // The planted repository's own store was never read into this row.
      expect(await (await storeOf(elsewhere.dir)).store.list()).toEqual([]);
    } finally {
      if (saved.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.common === undefined) delete process.env["GIT_COMMON_DIR"];
      else process.env["GIT_COMMON_DIR"] = saved.common;
    }
  });

  it("names the record's own drift, not the journal, when both are wrong under the opt-in", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    // Incomplete on purpose, and the opt-in is on: if the row were judged
    // before the record, this is the invocation that would say so.
    await journaledDelivery(harness, { withPrOpened: false });
    // The base moves under the `stale` policy, so the record is stale while
    // still being the record this candidate's identity resolves to.
    await git(harness.dir, "branch", "--force", "origin/main", "HEAD");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("base_tip_moved");
    expect(required.err, "the journal must never stand in for the record's own verdict").not.toContain("run_journal_incomplete");
    expect(required.err).not.toContain("pr.opened");
  });

  it.each(["merge", "squash", "unrelated"] as const)(
    "keeps admission stale after %s base movement and explains how to reconcile the finish line",
    { timeout: 120000 },
    async (movement) => {
      const harness = await makeHarness();
      await journaledDelivery(harness);
      const before = await harness.cli(["verify"]);
      expect(before.code, before.err).toBe(EXIT_OK);
      const recordedBase = await git(harness.dir, "rev-parse", "origin/main");
      expect(before.out).toContain(`recorded base: origin/main at ${recordedBase}`);
      expect(before.out).toContain(`observed base: origin/main at ${recordedBase}`);
      const deliveryHead = await git(harness.dir, "rev-parse", "HEAD");
      await git(harness.dir, "checkout", "--quiet", "origin/main");
      if (movement === "merge") {
        await git(harness.dir, "merge", "--no-ff", "--no-gpg-sign", "-m", "merge delivery", deliveryHead);
      } else if (movement === "squash") {
        await git(harness.dir, "merge", "--squash", deliveryHead);
        await git(harness.dir, "commit", "--quiet", "--no-gpg-sign", "-m", "squash delivery");
      } else {
        await writeFile(path.join(harness.dir, "unrelated.txt"), "another delivery\n");
        await git(harness.dir, "add", "unrelated.txt");
        await git(harness.dir, "commit", "--quiet", "--no-gpg-sign", "-m", "unrelated delivery");
      }
      const observedBase = await git(harness.dir, "rev-parse", "HEAD");
      await git(harness.dir, "checkout", "--quiet", "main");
      const after = await harness.cli(["verify", "--require-run-journal"]);
      expect(after.code).toBe(EXIT_POLICY);
      expect(after.err).toContain("base_tip_moved");
      expect(after.err).toContain(recordedBase);
      expect(after.err).toContain(observedBase);
      expect(after.err).toContain("own confirmed merge");
      expect(after.err).toContain("no new delivery loop");
      expect(after.err).toContain("same run");
      expect(after.err).not.toContain("run_journal_incomplete");
    },
  );

  it("distinguishes recorded and observed base tips when policy permits base movement", { timeout: 120000 }, async () => {
    const harness = await makeHarness({ deliveryRecordVerification: { baseMovement: "allow" } });
    await journaledDelivery(harness);
    const recordedBase = await git(harness.dir, "rev-parse", "origin/main");
    await git(harness.dir, "checkout", "--quiet", "origin/main");
    await git(harness.dir, "commit", "--allow-empty", "--quiet", "--no-gpg-sign", "-m", "advance base");
    const observedBase = await git(harness.dir, "rev-parse", "HEAD");
    expect(observedBase).not.toBe(recordedBase);
    await git(harness.dir, "checkout", "--quiet", "main");
    const result = await harness.cli(["verify"]);
    expect(result.code, result.err).toBe(EXIT_OK);
    expect(result.out).toContain(`recorded base: origin/main at ${recordedBase}`);
    expect(result.out).toContain(`observed base: origin/main at ${observedBase}`);
    expect(result.out).toContain("base movement relaxed by policy");
  });
});

// ── The delivery's own span ──────────────────────────────────────────────────

/** The one tracked record this delivery wrote, and its path. */
async function recordFileOf(dir: string): Promise<string> {
  const recordDir = path.join(dir, "telemetry/delivery-runs");
  const names = (await readdir(recordDir)).filter((name) => name.startsWith("record--") && name.endsWith(".json"));
  expect(names).toHaveLength(1);
  return path.join(recordDir, names[0]!);
}

async function recordOf(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(await recordFileOf(dir), "utf8")) as Record<string, unknown>;
}

/**
 * Rewrites a record and RE-SEALS it, so the forgery is the one worth testing.
 *
 * A record edited in place fails on its integrity digest, which proves only
 * that the digest works. The interesting adversary recomputes the seal — every
 * byte of the record then agrees with itself, and the only thing left that can
 * contradict the span is the journal it claims to have been read from.
 */
async function resealRecord(dir: string, edit: (record: Record<string, unknown>) => void): Promise<void> {
  const file = await recordFileOf(dir);
  const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  edit(record);
  delete record["integrityDigest"];
  const sealed = { ...record, integrityDigest: digestCanonical(record) };
  await writeFile(file, `${JSON.stringify(sealed)}\n`, "utf8");
  // The forged record is COMMITTED, exactly as the honest one was: an
  // uncommitted edit would stop `verify` at `candidate_unprepared` long before
  // the span is read, which would prove nothing about the span check. The
  // record lives under a record-neutral prefix, so committing it leaves the
  // candidate this record binds unchanged.
  await commitRecord(dir);
}

/**
 * Rewrites every instant of one journal, keeping every other byte `emit` wrote.
 *
 * A test that needs two runs to be an hour apart cannot wait an hour, and two
 * runs journaled in the same second would make the rank that separates them
 * arbitrary. Only the clock moves.
 */
async function restampRun(dir: string, runId: string, at: string): Promise<void> {
  const { runsDir } = await storeOf(dir);
  const journal = path.join(runsDir, `${runId}.jsonl`);
  const lines = (await readFile(journal, "utf8")).split("\n").filter((line) => line.length > 0);
  const restamped = lines.map((line) => JSON.stringify({ ...(JSON.parse(line) as object), at }));
  await writeFile(journal, `${restamped.join("\n")}\n`, "utf8");
}

describe("the delivery record's run span", () => {
  it("carries the span of the run that delivered it, and verifies against that journal", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    const { store } = await storeOf(harness.dir);
    const read = await store.read(runId);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("the journal is unreadable");

    const span = (await recordOf(harness.dir))["runSpan"] as { startedAt: string; endedAt: string };
    // The start is the journal's own first instant, exactly.
    expect(span.startedAt).toBe(read.events[0]!.at);
    // The end is an instant the journal had REACHED when the record was
    // written, not its last: `pr.opened` and `run.ended` were journaled after.
    expect(span.endedAt <= read.events[read.events.length - 1]!.at).toBe(true);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    expect(verified.out).toContain(`recorded run span: ${span.startedAt} to ${span.endedAt}`);
    expect(verified.out).toContain(`checked against run ${runId}`);
  });

  it("refuses a re-sealed record whose span the journal contradicts", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    await resealRecord(harness.dir, (record) => {
      const span = record["runSpan"] as { startedAt: string; endedAt: string };
      record["runSpan"] = { startedAt: span.startedAt, endedAt: "2099-01-01T00:00:00Z" };
    });

    const verified = await harness.cli(["verify"]);
    expect(verified.code).toBe(EXIT_POLICY);
    expect(verified.err).toContain("record_run_span_mismatch");
    expect(verified.err).toContain("2099-01-01T00:00:00Z");
    expect(verified.err).toContain(runId);
  });

  it("refuses a re-sealed record that claims some other run's start", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await journaledDelivery(harness);
    await resealRecord(harness.dir, (record) => {
      const span = record["runSpan"] as { startedAt: string; endedAt: string };
      record["runSpan"] = { startedAt: "2020-01-01T00:00:00Z", endedAt: span.endedAt };
    });

    const verified = await harness.cli(["verify"]);
    expect(verified.code).toBe(EXIT_POLICY);
    expect(verified.err).toContain("record_run_span_mismatch");
    expect(verified.err).toContain("2020-01-01T00:00:00Z");
  });

  it("refuses a re-sealed record whose span is not a span at all", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await journaledDelivery(harness);
    await resealRecord(harness.dir, (record) => {
      record["runSpan"] = { startedAt: "2026-09-02T00:00:00Z", endedAt: "2026-09-01T00:00:00Z" };
    });

    // Malformed on its own face — no journal is consulted to know that a
    // delivery cannot end before it starts.
    const verified = await harness.cli(["verify"]);
    expect(verified.code).toBe(EXIT_POLICY);
    expect(verified.err).toContain("runSpan must carry exactly a startedAt and an endedAt UTC instant, in order");
  });

  it("reports the span unchecked where no journal binds the candidate", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    const { runsDir } = await storeOf(harness.dir);
    // The journal is gone, as it is in the CI checkout that verifies this
    // record. The record is unchanged and still verifies.
    await rm(path.join(runsDir, `${runId}.jsonl`));
    // And a DIFFERENT run is current in this worktree, which is the shape that
    // separates "unchecked because nothing binds this candidate" from "checked
    // against whichever run happened to be open here". The second run binds
    // nothing of this record's; a verify that fell back to it would refuse an
    // honest record on a journal that never described it.
    await startRun(harness);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    expect(verified.out).toContain("unchecked: no run journal in this repository binds this candidate");
  });

  it("stamps the span from the current run when no round has journaled the candidate yet", { timeout: 120000 }, async () => {
    // `record` runs mid-delivery. A delivery that records before any round
    // event has journaled this tree has no journal BOUND to the candidate yet,
    // and the worktree's own current run is the run it is recording from — the
    // one case the stamping fallback exists for.
    const harness = await makeHarness();
    const runId = await startRun(harness);
    await emitAll(harness, [...prerequisites()]);
    await deliverRecord(harness);
    await commitRecord(harness.dir);

    const span = (await recordOf(harness.dir))["runSpan"] as { startedAt: string; endedAt: string } | undefined;
    expect(span, "a record written mid-run carries the span of the run it recorded from").toBeDefined();
    const { store } = await storeOf(harness.dir);
    const read = await store.read(runId);
    if (!read.ok) throw new Error("the journal is unreadable");
    expect(span?.startedAt).toBe(read.events[0]!.at);
  });

  it("checks the span against the run that started where the record says, not the newest one", { timeout: 120000 }, async () => {
    // TWO runs bind this candidate: the one that recorded it, and a later one
    // opened in the same worktree — a tail, a follow-up session, a re-verify.
    // The later run starts hours after the record's own span. Refusing on it
    // would block a record whose journal agrees with it exactly.
    const harness = await makeHarness();
    const recordingRun = await journaledDelivery(harness);
    const laterRun = await startRun(harness);
    expect(laterRun).not.toBe(recordingRun);
    await emitAll(harness, [roundOpened(harness.treeSha), roundClosed(harness.treeSha)]);
    // Stamped a year on, so the later run provably outranks the recording one
    // (`findByCandidateTreeSha` returns the most recently started first) and
    // its start provably differs from the record's. Without this the two runs
    // can share a second and the row would assert nothing.
    await restampRun(harness.dir, laterRun, "2027-01-01T00:00:00Z");
    const { store } = await storeOf(harness.dir);
    const both = await store.findByCandidateTreeSha(harness.treeSha);
    expect(both?.runId, "the later run outranks the one that recorded").toBe(laterRun);
    expect(both?.alsoMatching, "both runs bind this candidate").toEqual([recordingRun]);

    // The record is honest, so `verify` passes — and names the run that
    // actually agrees with it, not the one that merely sorted first.
    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    expect(verified.out).toContain(`checked against run ${recordingRun}`);

    // And where NO matching run starts where the record says, the refusal is
    // the top-ranked run's, which is the one the rank promises: a fallback that
    // kept overwriting itself would name the other run here.
    await resealRecord(harness.dir, (record) => {
      const span = record["runSpan"] as { startedAt: string; endedAt: string };
      record["runSpan"] = { startedAt: "2020-01-01T00:00:00Z", endedAt: span.endedAt };
    });
    const refused = await harness.cli(["verify"]);
    expect(refused.code).toBe(EXIT_POLICY);
    expect(refused.err).toContain("record_run_span_mismatch");
    expect(refused.err).toContain(laterRun);
    expect(refused.err).not.toContain(recordingRun);
  });

  it("records no span at all when the delivery ran under no journal", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await deliverRecord(harness);
    await commitRecord(harness.dir);

    expect(await recordOf(harness.dir)).not.toHaveProperty("runSpan");
    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    expect(verified.out).not.toContain("run span");
  });
});

// ── The argument surface ─────────────────────────────────────────────────────

describe("verify's argument surface", () => {
  it("refuses the --flag=value form, an unknown flag, and a --mandated-lens with no value", async () => {
    const harness = await makeHarness();
    for (const argv of [
      ["verify", "--require-run-journal=true"],
      ["verify", "--mandated-lens=lens.outcome-correctness"],
      ["verify", "--unknown-flag"],
      ["verify", "--mandated-lens"],
    ]) {
      const result = await harness.cli(argv);
      expect(result.code, `${argv.join(" ")}: ${result.out}${result.err}`).toBe(EXIT_USAGE);
    }
  });

  /**
   * The charset bound is what keeps an id out of the row it would otherwise be
   * echoed into, so it is pinned on each of the three ways a value can leave
   * the family: empty, out of charset, and over length.
   */
  it("refuses a --mandated-lens id outside the bounded charset or length", async () => {
    const harness = await makeHarness();
    const rejected: readonly string[] = [
      "",
      "Lens Outcome Correctness",
      "lens.Outcome/../x",
      "lens.outcome correctness",
      "lens.outcome\ncorrectness",
      "a".repeat(MAX_RUN_PROVIDER_ID + 1),
    ];
    for (const value of rejected) {
      const result = await harness.cli(["verify", "--mandated-lens", value]);
      expect(result.code, `${JSON.stringify(value)}: ${result.out}${result.err}`).toBe(EXIT_USAGE);
    }
    // And the boundary length itself is accepted, so the bound is a bound and
    // not a blanket refusal.
    const accepted = await harness.cli(["verify", "--mandated-lens", "a".repeat(MAX_RUN_PROVIDER_ID)]);
    expect(accepted.code, accepted.err).not.toBe(EXIT_USAGE);
  });

  it("refuses a positional argument", async () => {
    const harness = await makeHarness();
    const result = await harness.cli(["verify", "record.json"]);
    expect(result.code, result.err).toBe(EXIT_USAGE);
  });

  /**
   * A usage error an operator can act on names the token it refused and the
   * flags it would have accepted, by the exact strings the parser matches.
   */
  it("names the offending token and both accepted flags in every usage refusal", async () => {
    const harness = await makeHarness();
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["verify", "--unknown-flag"], "--unknown-flag"],
      [["verify", "--mandated-lens=lens.outcome-correctness"], "--mandated-lens=lens.outcome-correctness"],
      [["verify", "--mandated-lens"], "--mandated-lens"],
      [["verify", "--mandated-lens", "Lens Outcome Correctness"], "Lens Outcome Correctness"],
      [["verify", "record.json"], "record.json"],
    ];
    for (const [argv, token] of cases) {
      const result = await harness.cli(argv);
      const message = `${result.out}${result.err}`;
      expect(result.code, message).toBe(EXIT_USAGE);
      expect(message, `${argv.join(" ")} names its token`).toContain(token);
      expect(message).toContain("--require-run-journal");
      expect(message).toContain("--mandated-lens");
    }
  });
});
