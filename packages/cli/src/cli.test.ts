/**
 * The operator surface, end to end.
 *
 * Two kinds of test live here. The boundary tests drive synthetic commands to
 * pin the exit-code and rendering contract deterministically. The loop tests
 * drive the evidence-loop commands against real temporary git repositories — the
 * only way to prove capture, the store, admission, the record write, and the
 * verify core agree about one repository. Nothing here stubs git.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BlockedError,
  captureGitCandidate,
  classifyExecutionContext,
  createArtifactsPort,
  createBlocker,
  compileRepositoryPolicy,
  defineHarnessConfig,
  deliveryRecordPathFor,
  parseDeliveryRecord,
  resolveRecordStorage,
  resolveReceiptStorage,
  receiptFileName,
  runAdmission,
  sha256Hex,
  runGitCommand,
  withDeliverableIdentity,
  type ArtifactsPort,
  type CapturedCandidate,
  type HarnessConfig,
  type HarnessConfigInput,
  type WaiverPrompt,
} from "@agent-delivery-harness/kernel";
import {
  CliInterruption,
  COMMANDS,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_POLICY,
  EXIT_USAGE,
  recordCommand,
  runCli,
  runCliBoundary,
  wireRepo,
  type CliRuntime,
  type CommandDescriptor,
} from "./index.ts";
import { runProviderBackedAdmission } from "./commands/gate.ts";
import type { ProviderRailMessage, ProviderRailSession } from "./provider-rails.ts";
import { runAction } from "../../action/src/main.ts";

const run = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Config ───────────────────────────────────────────────────────────────────

const PROVIDER = { id: "claude-code.ce-code-review", version: "1.0.0", runId: "r-cli-01", finalPassId: "pass-2" };
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
    gateId: "test.gate",
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

// ── Repo fixtures ────────────────────────────────────────────────────────────

describe("mechanical preparation", () => {
  it("documents the opt-in receipt refresh and rejects unknown preparation arguments", async () => {
    const dir = await initRepo();
    const { runtime, out } = makeRuntime(dir, makeConfig(), await makeArtifacts());
    expect(await runCli(["prepare", "--help"], runtime)).toBe(EXIT_OK);
    expect(out.join("")).toContain("--refresh-record-neutral");
    expect(out.join("")).toContain("Ordinary prepare always runs mechanical checks");
    expect(await runCli(["prepare", "--unknown"], runtime)).toBe(EXIT_USAGE);
    expect(await runCli(["prepare", "--refresh-record-neutral", "extra"], runtime)).toBe(EXIT_USAGE);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
  });

  it("revokes an earlier receipt before replacement commands execute", async () => {
    const dir = await initRepo();
    const { storageDir } = await resolveReceiptStorage(dir);
    const receipt = path.join(storageDir, receiptFileName("test.gate"));
    const config = makeConfig({ preparationCommands: [
      { id: "check-revoked", command: [process.execPath, "-e", "if(require('node:fs').existsSync(process.argv[1])) process.exit(17)", receipt], timeoutMs: 5000 },
    ] });
    const { runtime } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(existsSync(receipt)).toBe(true);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_OK);
  });

  it.each(["older-first", "newer-first"])("rejects superseded overlapping preparation (%s)", async (order) => {
    const dir = await initRepo();
    const script = `const f=require('node:fs'); const p=require('node:path');
      const root=process.argv[1]; let older=true;
      try { f.writeFileSync(p.join(root,'claimed'), '', {flag:'wx'}); } catch { older=false; }
      const label=older?'older':'newer'; f.writeFileSync(p.join(root,label+'-started'), '');
      const timer=setInterval(()=>{if(f.existsSync(p.join(root,label+'-release'))){clearInterval(timer); process.exit(older?0:9)}}, 5);`;
    const config = makeConfig({ preparationCommands: [
      { id: "overlap", command: [process.execPath, "-e", script, path.join(dir, ".git")], timeoutMs: 10000 },
    ] });
    const first = makeRuntime(dir, config, await makeArtifacts());
    const second = makeRuntime(dir, config, await makeArtifacts());
    const older = runCli(["prepare"], first.runtime);
    let newer: Promise<number> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(path.join(dir, ".git/older-started"))).toBe(true), { timeout: 3000 });
      newer = runCli(["prepare"], second.runtime);
      await vi.waitFor(() => expect(existsSync(path.join(dir, ".git/newer-started"))).toBe(true), { timeout: 3000 });
      const firstLabel = order === "older-first" ? "older" : "newer";
      const secondLabel = order === "older-first" ? "newer" : "older";
      await writeFile(path.join(dir, `.git/${firstLabel}-release`), "");
      expect(await (order === "older-first" ? older : newer)).toBe(EXIT_POLICY);
      expect(await runCli(["review-context"], first.runtime)).toBe(EXIT_POLICY);
      await writeFile(path.join(dir, `.git/${secondLabel}-release`), "");
      expect(await (order === "older-first" ? newer : older)).toBe(EXIT_POLICY);
      expect(await runCli(["review-context"], first.runtime)).toBe(EXIT_POLICY);
    } finally {
      await writeFile(path.join(dir, ".git/older-release"), "");
      await writeFile(path.join(dir, ".git/newer-release"), "");
      await Promise.all([older, newer]);
    }
  });
  it("runs configured argv checks in order before issuing a usable receipt", async () => {
    const dir = await initRepo();
    const marker = path.join(dir, ".git", "preparation-order");
    const literal = "$(touch should-not-exist); `echo unsafe`";
    const config = makeConfig({ preparationCommands: [
      { id: "first", command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", marker, literal], timeoutMs: 5000 },
      { id: "second", command: [process.execPath, "-e", "if(require('node:fs').readFileSync(process.argv[1], 'utf8') !== process.argv[2]) process.exit(1)", marker, literal], timeoutMs: 5000 },
    ] });
    const { runtime } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await readFile(marker, "utf8")).toBe(literal);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_OK);
  });

  it("revokes previous success when the same candidate fails a later check", async () => {
    const dir = await initRepo();
    const flag = path.join(dir, ".git", "fail-preparation");
    const config = makeConfig({ preparationCommands: [
      { id: "check", command: [process.execPath, "-e", "if(require('node:fs').existsSync(process.argv[1])) process.exit(9)", flag], timeoutMs: 5000 },
    ] });
    const { runtime, err } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    await writeFile(flag, "fail");
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("preparation_command_failed");
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("preparation_missing");
  });

  it.each([
    ["timeout", [process.execPath, "-e", "setInterval(() => {}, 1000)"], 30],
    ["spawn", ["/nonexistent/preparation-command"], 1000],
    ["output-limit", [process.execPath, "-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], 5000],
  ] as const)("refuses %s and stops before the next check", async (_label, argv, timeoutMs) => {
    const dir = await initRepo();
    const marker = path.join(dir, ".git", "must-not-run");
    const config = makeConfig({ preparationCommands: [
      { id: "failure", command: [...argv] as [string, ...string[]], timeoutMs },
      { id: "later", command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker], timeoutMs: 5000 },
    ] });
    const { runtime, err } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("preparation_command_failed");
    expect(err.join("").length).toBeLessThan(6000);
    expect(existsSync(marker)).toBe(false);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
  });

  it.each(["src.txt", "harness.config.ts"])("refuses a check that mutates %s", async (file) => {
    const dir = await initRepo();
    const config = makeConfig({ preparationCommands: [
      { id: "mutation", command: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'changed')", file], timeoutMs: 5000 },
    ] });
    const { runtime } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_POLICY);
    await git(dir, "checkout", "--", file);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
  });

  it("refuses base movement during a passing check", async () => {
    const dir = await initRepo();
    const config = makeConfig({ preparationCommands: [
      { id: "move-base", command: ["git", "branch", "-f", "origin/main", "HEAD"], timeoutMs: 5000 },
    ] });
    const { runtime, err } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("preparation_candidate_changed");
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
  });

  it("refuses changed wiring even when git ignores the wiring file", async () => {
    const dir = await initRepo();
    const wiring = ".git/preparation-wiring";
    await writeFile(path.join(dir, wiring), "before");
    const config = makeConfig({ preparationWiringPaths: ["harness.config.ts", wiring], preparationCommands: [
      { id: "wiring", command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'after')", wiring], timeoutMs: 5000 },
    ] });
    const { runtime, err } = makeRuntime(dir, config, await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("preparation_candidate_changed");
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
  });

  it("revokes an old receipt before rejecting a dirty candidate", async () => {
    const dir = await initRepo();
    const { runtime } = makeRuntime(dir, makeConfig(), await makeArtifacts());
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    await writeFile(path.join(dir, "src.txt"), "dirty");
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_POLICY);
    await git(dir, "checkout", "--", "src.txt");
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
  });
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(await os.tmpdir(), "dh-cli-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
  await git(dir, "add", "harness.config.ts");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");
  await git(dir, "branch", "origin/main");
  writeFileSync(path.join(dir, "src.txt"), "hello world\n", "utf8");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "work");
  return dir;
}

async function installHostedCheckPolicy(dir: string): Promise<void> {
  const correctness = "# Correctness\n\nReview outcomes.\n";
  const testing = "# Testing\n\nReview adversarial tests.\n";
  const document = {
    spec: "repository-policy-document/1",
    repositoryId: "consumer-repo",
    policyGeneration: 1,
    grantedFinishLines: ["merge-ready"],
    grantedAuthority: [],
    forbiddenAuthority: [],
    reviewLenses: [
      { lensId: "lens.correctness", category: "outcome-correctness", personaId: "persona.correctness" },
      { lensId: "lens.testing", category: "testing-policy", personaId: "persona.testing" },
    ],
    obligations: [{ obligationId: "review.green" }],
    requiredCapabilities: [{ capabilityId: "sensor.acceptance", kind: "sensor", version: "1" }],
    approvals: [],
    trackerAbsenceFallback: "proceed-without-tracker",
    hostedChecks: {
      required: true,
      exemptions: [{
        scope: { repositoryId: "consumer-repo", baseRef: "origin/main" },
        reason: "Hosted runner billing is unavailable.",
        grantedBy: "repository-owner@example.com",
        until: "2999-01-01T00:00:00Z",
      }],
    },
  };
  const adapters = [{ spec: "adapter-capability/1", capabilityId: "sensor.acceptance", kind: "sensor", version: "1", resultSpec: "sensor-result/1" }];
  const compiled = compileRepositoryPolicy({
    document,
    adapters,
    personas: [
      { personaId: "persona.correctness", digest: sha256Hex(correctness), origin: "composition" },
      { personaId: "persona.testing", digest: sha256Hex(testing), origin: "composition" },
    ],
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.rejections));
  const files: Readonly<Record<string, string>> = {
    ".agents/policy/repository-policy.json": `${JSON.stringify(document)}\n`,
    ".agents/policy/adapters.json": `${JSON.stringify(adapters)}\n`,
    ".agents/policy/compiled-snapshot.json": `${JSON.stringify({ schemaVersion: "delivery-harness-compiled-policy-snapshot/1", compiled: compiled.compiled })}\n`,
    ".agent-skills/active.json": `${JSON.stringify({ release: { releaseId: "fixture-release", profile: "linear", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) } })}\n`,
    ".agent-skills/current/personas/manifest.json": `${JSON.stringify({ schemaVersion: "reviewer-persona-manifest/1", personas: [
      { personaId: "persona.correctness", path: "personas/correctness.md" },
      { personaId: "persona.testing", path: "personas/testing.md" },
    ] })}\n`,
    ".agent-skills/current/personas/correctness.md": correctness,
    ".agent-skills/current/personas/testing.md": testing,
    ".agent-skills/current/workflows/delivery-v1.json": "{}\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  await git(dir, "add", ".agents", ".agent-skills");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "owner hosted-check policy");
}

interface Runtime {
  readonly runtime: CliRuntime;
  readonly out: string[];
  readonly err: string[];
}

function makeRuntime(dir: string, config: HarnessConfig, artifacts: ArtifactsPort, overrides: Partial<CliRuntime> = {}): Runtime {
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
    ...overrides,
  };
  return { runtime, out, err };
}

async function makeArtifacts(): Promise<ArtifactsPort> {
  const base = await mkdtemp(path.join(await os.tmpdir(), "dh-runs-"));
  cleanups.push(base);
  return createArtifactsPort({ runRootBase: base });
}

function greenPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] },
    findings: [],
    telemetry: { iterationCount: 2, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
    ...overrides,
  };
}

/**
 * A green review that resolved one in-contract finding and deferred one
 * expansion finding, naming `followUpItem` as the tracker item that carries the
 * deferred work — or naming none, which is the case the harness must refuse.
 *
 * The resolved finding sits at index 0 deliberately, so the deferral is judged
 * at index 1. A rule that only ever evaluated the first finding would pass
 * every other deferral payload in this repository — each of them is a single
 * finding at index 0 — and would still refuse this one only if the deferral
 * were the first thing it saw.
 */
const DEFERRAL_POINTER = "/claims/0/payload/findings/1";

function deferringPayload(followUpItem: string | undefined): unknown {
  return greenPayload({
    findings: [
      { id: "f-1", severity: "P3", scope: "in_contract", actionable: true, blocking: false, disposition: "resolved" },
      {
        id: "f-2",
        severity: "P2",
        scope: "expansion",
        actionable: true,
        blocking: false,
        disposition: "deferred",
        ...(followUpItem === undefined ? {} : { deferredIssueId: followUpItem }),
      },
    ],
    telemetry: {
      iterationCount: 2,
      findingCounts: { P0: 0, P1: 0, P2: 1, P3: 1 },
      deferredExpansionCount: 1,
      deferredIssueIds: followUpItem === undefined ? [] : [followUpItem],
    },
  });
}

/** Captures the candidate the way the CLI does, then builds an accepted manifest bound to it. */
async function buildAcceptSubmission(
  dir: string,
  config: HarnessConfig,
  artifacts: ArtifactsPort,
  provider = PROVIDER,
  payload: unknown = greenPayload(),
): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  const captured: CapturedCandidate = capture.candidate;
  const candidate = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };

  const allocation = await artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
  if (!allocation.ok) throw new Error(`run root: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  const approval = `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewerId: "correctness",
      result: "approved",
      provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
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
    provider,
    candidate,
    repository: null,
    runHistory: [
      { preparedTreeSha: "1".repeat(40), evaluatedInPassId: "pass-1" },
      { preparedTreeSha: captured.treeSha, evaluatedInPassId: provider.finalPassId },
    ],
    artifacts: [{ path: "reviewers/correctness.json", sha256: sha256Hex(approval), role: "reviewer-approval" }],
    attestation: { level: "self", signatures: [] },
    recordedAt: "2026-08-25T00:00:00Z",
    claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload }],
  };
  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function commitRecord(dir: string): Promise<void> {
  await git(dir, "add", "-A", "telemetry");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "record");
}

async function captureDigest(dir: string, config: HarnessConfig): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({ rootDir: dir, config, workspaceId: storage.workspaceId, computeIdentity: withDeliverableIdentity() });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  return capture.candidate.deliverable.digest;
}

// ── Boundary contract (synthetic commands) ───────────────────────────────────

function fakeCommand(name: string, result: CommandDescriptor["run"]): CommandDescriptor {
  return { name, sourceId: `delivery-harness.cli.${name}`, summary: `${name} summary`, usage: `Usage: delivery-harness ${name}`, run: result };
}

function boundaryRuntime(): Runtime {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: CliRuntime = {
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadConfig: async () => makeConfig(),
  };
  return { runtime, out, err };
}

describe("runCliBoundary exit codes", () => {
  it("returns 0 for a passing command", async () => {
    const { runtime } = boundaryRuntime();
    const code = await runCliBoundary(["ok"], [fakeCommand("ok", async () => ({ kind: "ok", summary: "done" }))], runtime);
    expect(code).toBe(EXIT_OK);
  });

  it("returns 1 for a policy block", async () => {
    const { runtime, err } = boundaryRuntime();
    const blocker = createBlocker({
      code: "blocked_thing",
      source: { kind: "command", id: "delivery-harness.cli.block" },
      summary: "blocked",
      remediations: [{ id: "do-x", kind: "manual_action", summary: "Do x." }],
    });
    const code = await runCliBoundary(["block"], [fakeCommand("block", async () => ({ kind: "blocked", blockers: [blocker] }))], runtime);
    expect(code).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("blocked_thing");
  });

  it("returns 2 for an unknown command", async () => {
    const { runtime, err } = boundaryRuntime();
    const code = await runCliBoundary(["nope"], [fakeCommand("ok", async () => ({ kind: "ok" }))], runtime);
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("")).toContain("Unknown command");
  });

  it("returns 2 for a command-reported usage error", async () => {
    const { runtime } = boundaryRuntime();
    const code = await runCliBoundary(["u"], [fakeCommand("u", async () => ({ kind: "usage", message: "need --flag" }))], runtime);
    expect(code).toBe(EXIT_USAGE);
  });

  it("returns 130 when a command is interrupted (SIGINT)", async () => {
    const { runtime } = boundaryRuntime();
    const code = await runCliBoundary(
      ["i"],
      [
        fakeCommand("i", async () => {
          throw new CliInterruption();
        }),
      ],
      runtime,
    );
    expect(code).toBe(EXIT_INTERRUPTED);
  });

  it("maps an unexpected throw to a redacted internal_error, still exit 1", async () => {
    const { runtime, err } = boundaryRuntime();
    const code = await runCliBoundary(
      ["boom"],
      [
        fakeCommand("boom", async () => {
          throw new Error("secret token=ghp_0123456789abcdefghijでたらめ");
        }),
      ],
      runtime,
    );
    expect(code).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("internal_error");
    expect(err.join("")).not.toContain("ghp_0123456789abcdefghij");
  });

  it("neutralizes hostile blocker text at the CLI surface", async () => {
    const { runtime, err } = boundaryRuntime();
    const blocker = createBlocker({
      code: "hostile",
      source: { kind: "command", id: "delivery-harness.cli.hostile" },
      summary: "clean summary",
      details: "line[31mred[0m‮reversed",
      remediations: [{ id: "fix", kind: "manual_action", summary: "Fix it." }],
    });
    await runCliBoundary(["h"], [fakeCommand("h", async () => ({ kind: "blocked", blockers: [blocker] }))], runtime);
    const text = err.join("");
    expect(text).not.toContain("[31m");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("");
  });
});

// ── Repo coherence ───────────────────────────────────────────────────────────

describe("repo wiring coherence", () => {
  it("wires capture and the store from one root so their workspace ids agree", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
    const wiring = await wireRepo(dir, config);
    const capture = await wiring.captureCandidate();
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.candidate.workspaceId).toBe(storage.workspaceId);
    expect(wiring.workspaceId).toBe(storage.workspaceId);
  });
});

// ── The full loop ────────────────────────────────────────────────────────────

describe("the full delivery loop", () => {
  it.each([false, true])("runs prepare → review-context → submit-evidence → gate → record → verify green (mechanical checks: %s)", { timeout: 60000 }, async (mechanical) => {
    const dir = await initRepo();
    const config = makeConfig(mechanical ? { preparationCommands: [
      { id: "mechanical", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5000 },
    ] } : {});
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_OK);

    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    const submitCode = await runCli(["submit-evidence", "--manifest", manifestPath], runtime);
    expect(err.join("")).not.toContain("[");
    expect(submitCode).toBe(EXIT_OK);

    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const written = await readdir(recordDir);
    expect(written.filter((name) => name.startsWith("record--") && name.endsWith(".json"))).toHaveLength(1);

    await commitRecord(dir);
    expect(await runCli(["verify"], runtime), err.join("")).toBe(EXIT_OK);
  });

  it("bounds opt-in same-delivery records after the new record verifies and preserves Git history", { timeout: 120000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err, out } = makeRuntime(dir, config, artifacts);
    const recordedPaths: string[] = [];

    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) {
        await writeFile(path.join(dir, `attempt-${attempt}.txt`), `attempt ${attempt}\n`);
        await git(dir, "add", `attempt-${attempt}.txt`);
        await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", `attempt ${attempt}`);
      }
      expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
      const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
      expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);
      const digest = await captureDigest(dir, config);
      recordedPaths.push(deliveryRecordPathFor(config, digest));
      expect(
        await runCli(["record", "--retention-scope", "delivery-v26-1915", "--keep-superseded", "1"], runtime),
        err.join(""),
      ).toBe(EXIT_OK);
      await commitRecord(dir);
    }

    expect(existsSync(path.join(dir, recordedPaths[0]!))).toBe(false);
    expect(existsSync(path.join(dir, recordedPaths[1]!))).toBe(true);
    expect(existsSync(path.join(dir, recordedPaths[2]!))).toBe(true);
    expect(out.join("")).toContain(`pruned Git-preserved ${recordedPaths[0]}`);
    expect(await runCli(["verify"], runtime)).toBe(EXIT_OK);
    expect((await readdir(path.dirname(path.join(dir, recordedPaths[2]!)))).filter((name) => name.startsWith("record--"))).toHaveLength(2);
    expect(await git(dir, "show", `HEAD^:${recordedPaths[0]}`)).toContain("delivery-record/2");
  });

  it("invokes an opt-in provider at the existing record boundary and promotes only its retained green evidence", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig({ providers: [{ id: PROVIDER.id, findingCodes: [], command: ["fake-review-provider"] }] });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    let opened = 0;
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async (): Promise<ProviderRailSession> => {
        opened += 1;
        let receiveCount = 0;
        let terminal: ProviderRailMessage | null = null;
        return {
          async send(message) {
            if (message.kind !== "request") return;
            const manifestPath = await buildAcceptSubmission(dir, config, artifacts, {
              id: PROVIDER.id,
              version: PROVIDER.version,
              runId: message.requestId,
              finalPassId: "pass-2",
            });
            terminal = {
              kind: "terminal",
              outcome: "success",
              requestId: message.requestId,
              sequence: 1,
              summary: "Review complete",
              version: "delivery-provider-rails/1",
              result: { manifestPath },
            };
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            return terminal;
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["prepare"], railRuntime)).toBe(EXIT_OK);
    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toBe(1);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(recordName).toBeDefined();
    if (recordName === undefined) return;
    const parsed = parseDeliveryRecord(await readFile(path.join(recordDir, recordName), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims).toHaveLength(1);
    expect(parsed.record.claims[0]).toMatchObject({
      obligationId: "review.green",
      outcome: "satisfied_evidence",
      providerId: PROVIDER.id,
    });
  });

  it("maps provider success into the existing live-fact delivery claim", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig({
      providers: [{ id: PROVIDER.id, findingCodes: [], command: ["fake-live-provider"] }],
      obligations: [
        {
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "live",
          providers: [PROVIDER.id],
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_live_fact", "not_applicable"],
          humanWaiverAllowed: false,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run the live provider." }] },
          waivableCodes: [],
          nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
        },
      ],
    });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    let opened = 0;
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async (): Promise<ProviderRailSession> => {
        opened += 1;
        let receiveCount = 0;
        let requestId: string | undefined;
        return {
          async send(message) {
            if (message.kind === "request") requestId = message.requestId;
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            if (requestId === undefined) return null;
            return {
              kind: "terminal",
              outcome: "success",
              requestId,
              sequence: 1,
              summary: "Live review complete",
              version: "delivery-provider-rails/1",
            };
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["prepare"], railRuntime)).toBe(EXIT_OK);
    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toBe(1);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(recordName).toBeDefined();
    if (recordName === undefined) return;
    const parsed = parseDeliveryRecord(await readFile(path.join(recordDir, recordName), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims).toHaveLength(1);
    expect(parsed.record.claims[0]).toMatchObject({
      obligationId: "review.green",
      outcome: "satisfied_live_fact",
      providerId: PROVIDER.id,
    });
  });

  it("re-evaluates an existential live obligation after failure and stops after another provider succeeds", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const providerIds = ["failing.provider", "passing.provider"] as const;
    const config = makeConfig({
      providers: providerIds.map((id) => ({ id, findingCodes: [], command: [`fake-${id}`] })),
      obligations: [
        {
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "live",
          providers: providerIds,
          providerPolicy: "existential",
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_live_fact", "not_applicable"],
          humanWaiverAllowed: false,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run an uncovered provider." }] },
          waivableCodes: [],
          nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
        },
      ],
    });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    const opened: string[] = [];
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async ({ providerId }): Promise<ProviderRailSession> => {
        opened.push(providerId);
        let receiveCount = 0;
        let requestId: string | undefined;
        return {
          async send(message) {
            if (message.kind === "request") requestId = message.requestId;
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            if (requestId === undefined) return null;
            return {
              kind: "terminal",
              outcome: providerId === "failing.provider" ? "failed" : "success",
              requestId,
              sequence: 1,
              summary: `${providerId} complete`,
              version: "delivery-provider-rails/1",
            };
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["prepare"], railRuntime)).toBe(EXIT_OK);
    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toEqual(["failing.provider", "passing.provider"]);
  });

  it("invokes only the uncovered provider for an all-provider exact-evidence obligation", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const providerIds = ["first.provider", "second.provider"] as const;
    const config = makeConfig({
      providers: providerIds.map((id) => ({ id, findingCodes: [], command: [`fake-${id}`] })),
      obligations: [
        {
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "exact_candidate",
          providers: providerIds,
          providerPolicy: "all",
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_evidence", "not_applicable"],
          humanWaiverAllowed: false,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run the uncovered provider." }] },
          waivableCodes: [],
          nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
        },
      ],
    });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const existingManifest = await buildAcceptSubmission(dir, config, artifacts, {
      id: "first.provider",
      version: "1.0.0",
      runId: "first-run",
      finalPassId: "pass-2",
    });
    expect(await runCli(["submit-evidence", "--manifest", existingManifest], runtime)).toBe(EXIT_OK);

    const opened: string[] = [];
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async ({ providerId }): Promise<ProviderRailSession> => {
        opened.push(providerId);
        let receiveCount = 0;
        let terminal: ProviderRailMessage | null = null;
        return {
          async send(message) {
            if (message.kind !== "request") return;
            const manifestPath = await buildAcceptSubmission(dir, config, artifacts, {
              id: providerId,
              version: "1.0.0",
              runId: message.requestId,
              finalPassId: "pass-2",
            });
            terminal = {
              kind: "terminal",
              outcome: "success",
              requestId: message.requestId,
              sequence: 1,
              summary: "Review complete",
              version: "delivery-provider-rails/1",
              result: { manifestPath },
            };
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            return terminal;
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toEqual(["second.provider"]);
  });
});

describe("owner-declared hosted-check exemptions", () => {
  it("records and prints the active exemption in a disposable consumer while still requiring a passing local gate", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    await installHostedCheckPolicy(dir);
    const provider = `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.kind==='negotiate')console.log(JSON.stringify({kind:'negotiation',outcome:'supported',selectedVersion:'delivery-provider-rails/1',supportedVersions:['delivery-provider-rails/1']}));if(m.kind==='request')console.log(JSON.stringify({kind:'terminal',version:m.version,requestId:m.requestId,sequence:1,summary:'Local gate passed',outcome:'success'}));});`;
    const config = makeConfig({
      providers: [{ id: PROVIDER.id, findingCodes: [], command: [process.execPath, "-e", provider] }],
      obligations: [{
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "live",
        providers: [PROVIDER.id],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_live_fact", "not_applicable"],
        humanWaiverAllowed: false,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run the local provider." }] },
        waivableCodes: [],
        nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
      }],
    });
    const artifacts = await makeArtifacts();
    const driven = makeRuntime(dir, config, artifacts);
    const runtime = driven.runtime;

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(recordName).toBeDefined();
    if (recordName === undefined) return;
    const parsed = parseDeliveryRecord(await readFile(path.join(recordDir, recordName), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims[0]?.outcome).toBe("satisfied_live_fact");
    expect(parsed.record.hostedChecks?.exemption?.scope).toEqual({ repositoryId: "consumer-repo", baseRef: "origin/main" });

    await commitRecord(dir);
    driven.out.length = 0;
    expect(await runCli(["verify"], runtime), driven.err.join("")).toBe(EXIT_OK);
    expect(driven.out.join("")).toContain("hosted checks: exempted for consumer-repo at origin/main");
    expect(driven.out.join("")).toContain("granted by repository-owner@example.com");
    expect(driven.out.join("")).toContain("Hosted runner billing is unavailable.");

    const headSha = await git(dir, "rev-parse", "HEAD");
    const baseSha = await git(dir, "rev-parse", "origin/main");
    const eventPath = path.join(dir, ".git", "hosted-check-event.json");
    await writeFile(eventPath, JSON.stringify({ action: "synchronize", pull_request: {
      head: { sha: headSha, ref: "feature" }, base: { sha: baseSha, ref: "main" },
    } }));
    const outputs: Readonly<Record<string, string>>[] = [];
    const actionRuntime = {
      workspace: dir,
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: "f".repeat(40) },
      git: runGitCommand,
      readFile: (absolutePath: string) => readFile(absolutePath, "utf8"),
      loadConfig: async () => config,
      writeSummary: async () => {},
      writeOutputs: async (value: Readonly<Record<string, string>>) => { outputs.push(value); },
      log: () => {},
    };
    const active = await runAction({ ...actionRuntime, observedAt: "2998-12-31T23:59:59Z" });
    expect(active.ok, JSON.stringify(active.blockers)).toBe(true);
    expect(active.summary).toContain("Hosted checks: exempted");
    expect(outputs.at(-1)?.["hosted-checks"]).toBe("exempted");

    const expired = await runAction({ ...actionRuntime, observedAt: "2999-01-01T00:00:00Z" });
    expect(expired.ok).toBe(false);
    expect(expired.blockers.map((blocker) => blocker.code)).toContain("hosted_check_exemption_expired");
    expect(outputs.at(-1)?.["hosted-checks"]).toBe("blocked");
  });
});

// ── Self-neutrality ──────────────────────────────────────────────────────────

describe("delivery record self-neutrality", () => {
  it("writing the record does not change the deliverable identity it attests", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);

    const before = await captureDigest(dir, config);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);
    const after = await captureDigest(dir, config);
    expect(after).toBe(before);
  });

  it("negative control: a non-neutral path does change the deliverable identity", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const before = await captureDigest(dir, config);
    writeFileSync(path.join(dir, "poison.txt"), "not neutral\n", "utf8");
    await git(dir, "add", "poison.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "poison");
    const after = await captureDigest(dir, config);
    expect(after).not.toBe(before);
  });
});

// ── Waiver wiring ────────────────────────────────────────────────────────────

describe("waiver wiring", () => {
  it("keeps manual providers on one admission capture and evaluation pass", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);

    const wiring = await wireRepo(dir, config);
    let captures = 0;
    let projections = 0;
    const result = await runProviderBackedAdmission(
      {
        rootDir: dir,
        config,
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
        args: [],
        wire: async () => ({
          ...wiring,
          captureCandidate: async () => {
            captures += 1;
            return wiring.captureCandidate();
          },
          projectActivation: async (candidate) => {
            projections += 1;
            return wiring.projectActivation(candidate);
          },
        }),
        artifacts,
        write: () => {},
        writeError: () => {},
        classifyContext: () => classifyExecutionContext({ config, env: {}, stdinIsTTY: false, stdoutIsTTY: false }),
      },
      { allowPrompt: true, includeInjectedLiveResults: true },
    );

    expect(result.admitted).toBe(false);
    expect(result.waiver).toBe("not_offered");
    expect(captures).toBe(1);
    expect(projections).toBe(1);
  });

  it("never prompts and blocks when non-interactive, even for an all-waivable block", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => ({ author: "Test Operator", reason: "Explicit test exception" }));
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: false, stdoutIsTTY: false, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    // No evidence submitted: the obligation is active and blocked on a waivable code.
    expect(await runCli(["gate"], runtime)).toBe(EXIT_POLICY);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("waives end to end under a TTY when the operator accepts", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => ({ author: "Test Operator", reason: "Explicit test exception" }));
    const { runtime, err } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await git(dir, "add", "-A", "telemetry");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "record human exception");
    expect(await runCli(["verify"], runtime), err.join("\n")).toBe(EXIT_OK);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("blocks with exit 1 and writes no waiver record when the operator declines", { timeout: 60000 }, async () => {
    // The decline path is also the EOF path: `createWaiverPrompt` resolves false
    // on Ctrl-D, and a declined waiver must be a policy block with nothing
    // written — never the silent success a never-settling prompt produced.
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => false as const);
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_POLICY);
    expect(prompt).toHaveBeenCalledTimes(1);

    const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
    const stored = await readdir(storage.storageDir).catch(() => [] as string[]);
    expect(stored.filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("returns 130 when the operator interrupts the waiver prompt", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = async () => {
      throw new CliInterruption("Waiver prompt interrupted.");
    };
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_INTERRUPTED);
  });
});

// ── Error paths ──────────────────────────────────────────────────────────────

describe("error paths", () => {
  it("review-context without a receipt blocks and names prepare", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("prepare");
  });

  it("review-context on a stale receipt blocks with a class distinct from missing", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    // Move the candidate: a new commit changes the tree the receipt was cut for.
    writeFileSync(path.join(dir, "more.txt"), "more\n", "utf8");
    await git(dir, "add", "more.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "more");
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
    const text = err.join("");
    expect(text).toContain("preparation_");
    expect(text).not.toContain("preparation_missing");
  });

  it("submit-evidence after an edit rejects on a candidate mismatch", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    // Edit the tree after building the manifest: the re-captured candidate diverges.
    writeFileSync(path.join(dir, "src.txt"), "edited\n", "utf8");
    await git(dir, "add", "src.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "edit");
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_POLICY);
  });

  it("submit-evidence without --manifest is a usage error", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["submit-evidence"], runtime)).toBe(EXIT_USAGE);
  });

  it("record after an edit is refused", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);
    // Dirty the tree, then try to record.
    writeFileSync(path.join(dir, "src.txt"), "edited after gate\n", "utf8");
    expect(await runCli(["record"], runtime)).toBe(EXIT_POLICY);
  });

  it("records a review whose deferral names a tracked follow-up item", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts, PROVIDER, deferringPayload("V26-1583"));
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);

    // Read the record back: an admitted deferral records, it does not merely
    // exit zero.
    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(recordName).toBeDefined();
    const parsed = parseDeliveryRecord(await readFile(path.join(recordDir, recordName as string), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims.map((claim) => [claim.obligationId, claim.outcome])).toEqual([["review.green", "satisfied_evidence"]]);
  });

  it("refuses to record a review whose deferral names no follow-up item", { timeout: 60000 }, async () => {
    // The rule is "every deferral carries a tracked follow-up item". It is
    // enforced one command upstream of `record`, by RG-7 over the review
    // claim — which is what makes it reach `record` at all: an untracked
    // deferral never becomes an evidence record, so there is nothing for a
    // record to attest and `record` refuses for want of review evidence.
    // Presence and shape are both refused; a tracker's opinion is never asked.
    for (const followUpItem of [undefined, "TODO", "v26-1583"]) {
      const dir = await initRepo();
      const config = makeConfig();
      const artifacts = await makeArtifacts();
      const { runtime, err } = makeRuntime(dir, config, artifacts);
      expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);

      const manifestPath = await buildAcceptSubmission(dir, config, artifacts, PROVIDER, deferringPayload(followUpItem));
      expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime), String(followUpItem)).toBe(EXIT_POLICY);
      const submitted = err.join("");
      expect(submitted, String(followUpItem)).toContain("illegal_deferral");
      // The refusal names WHICH deferral, at its own index — not the payload it
      // was found in, and not merely the first finding.
      expect(submitted, String(followUpItem)).toContain(DEFERRAL_POINTER);

      // Nothing was published, so no record can carry the untracked deferral.
      const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
      const stored = await readdir(storage.storageDir).catch(() => [] as string[]);
      expect(stored.filter((name) => name.endsWith(".json")), String(followUpItem)).toHaveLength(0);

      const before = err.length;
      expect(await runCli(["record"], runtime), String(followUpItem)).toBe(EXIT_POLICY);
      // Only what `record` itself wrote: the submission's own refusal is behind us.
      expect(err.slice(before).join(""), String(followUpItem)).toContain("review_evidence_missing");
      expect(existsSync(path.join(dir, "telemetry/delivery-runs"))).toBe(false);
    }
  });

  it("check outside a repository blocks with a typed store finding", { timeout: 60000 }, async () => {
    const notARepo = await mkdtemp(path.join(await os.tmpdir(), "dh-norepo-"));
    cleanups.push(notARepo);
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(notARepo, config, artifacts);
    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
    // The rendered blocker names the store, so an operator learns which of the
    // two preflight halves failed rather than only that one did.
    expect(err.join("")).toMatch(/store|storage|repository/i);
    expect(err.join("")).toContain("Remediation:");
  });

  it("check on an unwritable store blocks with a typed finding", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);

    // Plant a regular file where the storage namespace directory must be. Every
    // mkdir beneath it then fails with ENOTDIR — deterministically, and without
    // depending on the uid the suite runs as (a chmod-based fixture is a no-op
    // for root, which is exactly how this scenario rots in CI).
    const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
    await rm(storage.storageRoot, { recursive: true, force: true });
    await mkdir(path.dirname(storage.storageRoot), { recursive: true });
    await writeFile(storage.storageRoot, "not a directory\n", "utf8");

    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
    const text = err.join("");
    // A typed store finding, not an internal error. The distinction is the whole
    // point of the preflight: an unusable store is a condition the operator can
    // act on, and reporting it as an unexpected crash tells them nothing and
    // implicates the harness instead of their checkout.
    expect(text).toContain("artifact_write_failed");
    expect(text).not.toContain("internal_error");
    expect(text).toContain("Remediation:");
  });

  it("an invalid config is a typed policy block", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, makeConfig(), artifacts, {
      loadConfig: async () => {
        throw new BlockedError([
          createBlocker({
            code: "config_broken",
            source: { kind: "config", id: "delivery-harness.config" },
            summary: "config is invalid",
            remediations: [{ id: "fix-config", kind: "manual_action", summary: "Fix the config." }],
          }),
        ]);
      },
    });
    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("config_broken");
  });

  it("check on a real repository reports readiness", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, out } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["check"], runtime)).toBe(EXIT_OK);
    const report = out.join("");
    expect(report).toContain("test.gate");
    expect(report).toContain("delivery record path telemetry/delivery-runs/record--<deliverableDigest>.json");
    expect(report).toContain("base movement stale:");
    expect(report).toContain("verification refuses");
    expect(report).toContain("admit again against the current base");
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("concurrent record writes", () => {
  it("eight record processes report index contention and a retry succeeds after release", { timeout: 120000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifest = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifest], runtime)).toBe(EXIT_OK);
    const cliUrl = new URL("./index.ts", import.meta.url).href;
    const runner = path.join(dir, ".git", "record-witness.mjs");
    await writeFile(runner, `import { runCli } from ${JSON.stringify(cliUrl)};
process.exitCode = await runCli(["record"], {
  cwd: process.cwd(), env: {}, stdinIsTTY: false, stdoutIsTTY: false,
  stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
  loadConfig: async () => (${JSON.stringify(config)})
});`);
    const lock = path.join(dir, ".git", "index.lock");
    await writeFile(lock, "held by the test until every child has answered\n");
    try {
      const loader = pathToFileURL(fileURLToPath(import.meta.resolve("tsx"))).href;
      const results = await Promise.all(Array.from({ length: 8 }, async () => {
        try {
          const result = await run(process.execPath, ["--import", loader, runner], { cwd: dir, timeout: 30000 });
          return { ...result, code: 0 };
        } catch (error) {
          return error as { stdout: string; stderr: string; code: number };
        }
      }));
      for (const result of results) {
        expect(result.code).toBe(EXIT_POLICY);
        expect(result.stderr).toContain("candidate_repository_unreadable");
        expect(result.stderr).toContain("Retry after the other Git operation finishes");
        expect(result.stderr).not.toContain("Repair the index");
      }
    } finally {
      await rm(lock, { force: true });
    }
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
  });

  it("two branches each write a record and both files coexist and parse", { timeout: 120000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);

    // Branch one: the full loop through a written record.
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestMain = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestMain], runtime)).toBe(EXIT_OK);
    const digestMain = await captureDigest(dir, config);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);

    // Branch two: a different deliverable, its own loop, its own record. The
    // first branch's record file is carried along, which is what makes this the
    // collision test rather than two independent writes.
    await git(dir, "checkout", "--quiet", "-b", "feature");
    writeFileSync(path.join(dir, "feature.txt"), "feature work\n", "utf8");
    await git(dir, "add", "feature.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "feature");
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestFeature = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestFeature], runtime)).toBe(EXIT_OK);
    const digestFeature = await captureDigest(dir, config);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);

    expect(digestFeature).not.toBe(digestMain);
    const pathMain = deliveryRecordPathFor(config, digestMain);
    const pathFeature = deliveryRecordPathFor(config, digestFeature);
    expect(pathMain).not.toBe(pathFeature);

    // Both files exist side by side — no overwrite, no merge conflict — and both
    // are readable records bound to their own candidate.
    for (const [relative, digest] of [
      [pathMain, digestMain],
      [pathFeature, digestFeature],
    ] as const) {
      const parsed = parseDeliveryRecord(await readFile(path.join(dir, relative), "utf8"));
      expect(parsed.ok, `expected ${relative} to parse`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.record.candidateBinding.deliverableDigest).toBe(digest);
    }

    // And the feature branch verifies against its own record with both present.
    expect(await runCli(["verify"], runtime)).toBe(EXIT_OK);
  });
});

// ── The record-identity guard, witnessed directly ────────────────────────────

describe("record refuses when the identity moves under it", () => {
  /**
   * Drives the command with a wiring whose capture returns a *different*
   * deliverable digest on the recheck than it did for the gate. The loop-level
   * test cannot reach this guard: dirtying a real tree makes the candidate
   * unprepared, so capture fails first and the guard is never consulted. This
   * is the only witness that the recheck itself refuses.
   */
  it("blocks with record_identity_changed when the recheck capture disagrees", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);

    const wiring = await wireRepo(dir, config);

    // How many captures admission itself consumes, measured rather than guessed:
    // the recheck is the command's *next* capture after that, and hard-coding an
    // index would silently stop targeting it the moment admission's own capture
    // count changed.
    let admissionCaptures = 0;
    await runAdmission(
      { rootDir: dir, config, context: classifyExecutionContext({ config, env: {}, stdinIsTTY: false, stdoutIsTTY: false }) },
      {
        captureCandidate: async () => {
          admissionCaptures += 1;
          return wiring.captureCandidate();
        },
        projectActivation: wiring.projectActivation,
        ...wiring.storageOptions,
      },
    );

    let calls = 0;
    const drifting: typeof wiring.captureCandidate = async () => {
      const capture = await wiring.captureCandidate();
      calls += 1;
      // Admission's captures pass through untouched; the recheck — the first
      // capture after them — reports a moved deliverable.
      if (!capture.ok || calls <= admissionCaptures) return capture;
      return {
        ...capture,
        candidate: {
          ...capture.candidate,
          deliverable: { ...capture.candidate.deliverable, digest: "f".repeat(64) },
        },
      };
    };

    const blockers: string[] = [];
    const result = await recordCommand.run({
      rootDir: dir,
      config,
      env: {},
      stdinIsTTY: false,
      stdoutIsTTY: false,
      args: [],
      wire: async () => ({ ...wiring, captureCandidate: drifting }),
      artifacts,
      write: () => {},
      writeError: () => {},
      classifyContext: () => classifyExecutionContext({ config, env: {}, stdinIsTTY: false, stdoutIsTTY: false }),
    });

    if (result.kind === "blocked") blockers.push(...result.blockers.map((blocker) => blocker.code));
    expect(result.kind).toBe("blocked");
    expect(blockers).toContain("record_identity_changed");

    // Nothing was written for the drifted identity.
    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const written = await readdir(recordDir).catch(() => [] as string[]);
    expect(written.some((name) => name.includes("f".repeat(64)))).toBe(false);
  });
});

// ── The tracked Claude skill exposure, over a real repository ────────────────

describe("verify over a candidate carrying a Claude skill exposure", () => {
  /**
   * Drives the loop to a committed record and returns what `verify` said about
   * it, so the two polarities differ only in what the tree carries under
   * `.claude/skills/`.
   */
  async function loopToVerify(dir: string): Promise<{ readonly code: number; readonly err: string }> {
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);
    return { code: await runCli(["verify"], runtime), err: err.join("") };
  }

  it("verifies a tree whose .claude/skills entries are symlinks into the receipted generation", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    // The shape the `agent-skills` generation install writes: the generation's
    // skill directory tracked under `.agent-skills/current/skills/`, and a
    // relative symlink under `.claude/skills/` exposing it to the host.
    await mkdir(path.join(dir, ".agent-skills/current/skills/execute-work"), { recursive: true });
    await writeFile(path.join(dir, ".agent-skills/current/skills/execute-work/SKILL.md"), "# execute work\n", "utf8");
    await mkdir(path.join(dir, ".claude/skills"), { recursive: true });
    await symlink("../../.agent-skills/current/skills/execute-work", path.join(dir, ".claude/skills/execute-work"));
    await git(dir, "add", "-A", ".agent-skills", ".claude");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "install the agent-skills exposure");
    // The exposure really is committed as a symlink; without that this test
    // would be proving nothing about the mode the exception turns on.
    expect(await git(dir, "ls-tree", "HEAD", ".claude/skills/execute-work")).toMatch(/^120000 blob /);

    const verified = await loopToVerify(dir);
    expect(verified.err).not.toContain("record_protected_authority_path");
    expect(verified.code).toBe(EXIT_OK);
  });

  it("blocks a tree carrying a regular file under .claude/skills", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    await mkdir(path.join(dir, ".claude/skills"), { recursive: true });
    await writeFile(path.join(dir, ".claude/skills/planted.md"), "# planted authority\n", "utf8");
    await git(dir, "add", "-A", ".claude");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "plant a regular file");

    const verified = await loopToVerify(dir);
    expect(verified.code).toBe(EXIT_POLICY);
    expect(verified.err).toContain("record_protected_authority_path");
  });

  it("blocks a .claude/skills symlink resolving outside the receipted generation", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    await mkdir(path.join(dir, ".claude/skills"), { recursive: true });
    await symlink("../../src.txt", path.join(dir, ".claude/skills/execute-work"));
    await git(dir, "add", "-A", ".claude");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "plant an outward symlink");
    expect(await git(dir, "ls-tree", "HEAD", ".claude/skills/execute-work")).toMatch(/^120000 blob /);

    const verified = await loopToVerify(dir);
    expect(verified.code).toBe(EXIT_POLICY);
    expect(verified.err).toContain("record_protected_authority_path");
  });
});

// ── Per-command help and unrecognized flags ──────────────────────────────────

/**
 * WHY THIS IS A BOUNDARY CONCERN, NOT A PER-COMMAND ONE. `--help` is a request
 * to be told what a command does; performing the command instead is the wrong
 * answer to it, and it was the answer `gate`, `record` and `check` gave — they
 * parse no arguments at all, so the boundary loaded config, wired the repo and
 * ran the action while the operator was asking a question. The lone help token
 * is now answered once, after the descriptor is found and before anything is
 * loaded, from the descriptor's own `usage`. So the assertions below are about
 * WHEN the answer arrives as much as what it says: a `loadConfig` that throws
 * proves nothing was loaded, because a help path that loaded it would throw.
 */
describe("per-command help", () => {
  const helpRuntime = (): Runtime => {
    const out: string[] = [];
    const err: string[] = [];
    const runtime: CliRuntime = {
      cwd: process.cwd(),
      env: {},
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      // The tripwire: reaching config loading at all is the defect.
      loadConfig: async () => {
        throw new Error("config was loaded for a help request");
      },
    };
    return { runtime, out, err };
  };

  it.each(COMMANDS.map((command) => command.name))("answers %s --help with its own usage and loads nothing", async (name) => {
    for (const flag of ["--help", "-h"]) {
      const { runtime, out, err } = helpRuntime();
      expect(await runCli([name, flag], runtime), `${name} ${flag}: ${err.join("")}`).toBe(EXIT_OK);
      expect(out.join("")).toContain(`Usage: delivery-harness ${name}`);
      expect(err.join("")).toBe("");
    }
  });

  it("keeps the descriptor's usage and its summary distinct and non-empty", () => {
    for (const command of COMMANDS) {
      expect(command.usage, `${command.name} declares a usage`).toContain(`delivery-harness ${command.name}`);
      expect(command.summary.length, `${command.name} declares a summary`).toBeGreaterThan(0);
    }
  });

  it("still runs the command when the help token is not the whole invocation", async () => {
    const { runtime } = helpRuntime();
    // Two arguments, one of them `--help`: not a help request. It reaches the
    // configured path, where this runtime's loader throws — rendered as an
    // internal error, which is exit 1 and emphatically not the help exit.
    expect(await runCli(["prepare", "--refresh-record-neutral", "--help"], runtime)).not.toBe(EXIT_OK);
    // And in leading position, which `args.length === 1` is what rejects: a
    // predicate that merely looked for the token anywhere would answer this as
    // help and swallow the real invocation.
    expect(await runCli(["prepare", "--help", "--refresh-record-neutral"], runtime)).not.toBe(EXIT_OK);
  });
});

/**
 * THE LISTING SEPARATOR. `emit-review-evidence` is twenty characters against a
 * pad width of sixteen, so the top-level listing printed
 * `emit-review-evidenceBind concluded review outcomes…` — a name and a sentence
 * fused into one token. The column is computed from the longest registered name
 * now, and this reads every line back through one grammar so a name that
 * outgrows the column again cannot pass.
 */
describe("the top-level usage listing", () => {
  const listing = async (): Promise<readonly string[]> => {
    const out: string[] = [];
    const runtime: CliRuntime = {
      cwd: process.cwd(), env: {}, stdinIsTTY: false, stdoutIsTTY: false,
      stdout: (text) => out.push(text), stderr: () => {}, loadConfig: async () => makeConfig(),
    };
    expect(await runCli(["--help"], runtime)).toBe(EXIT_OK);
    const lines = out.join("").split("\n");
    const header = lines.indexOf("Commands:");
    expect(header).toBeGreaterThan(-1);
    return lines.slice(header + 1).filter((line) => line.trim() !== "");
  };

  it("separates every command name from its summary, longest name included", async () => {
    const rows = await listing();
    expect(rows).toHaveLength(COMMANDS.length);
    const summaries = new Map(COMMANDS.map((command) => [command.name, command.summary]));
    for (const row of rows) {
      // Two spaces of indent, the name, at least two spaces, then the summary.
      // Anchored, so a fused row cannot satisfy it by matching a later word.
      const match = /^ {2}(\S+) {2,}(\S.*)$/.exec(row);
      expect(match, `listing row is separated: ${JSON.stringify(row)}`).not.toBeNull();
      const [, name, summary] = match!;
      expect(summaries.get(name!), `${name} is a registered command`).toBe(summary);
    }
    // Anti-vacuity: the row that fused under the old pad width is present.
    const longest = [...COMMANDS].sort((a, b) => b.name.length - a.name.length)[0]!;
    expect(rows.some((row) => row.startsWith(`  ${longest.name} `))).toBe(true);
  });
});

describe("unrecognized flags on the direct commands", () => {
  const DIRECT = ["admit", "prepare", "review-context", "emit-review-evidence", "submit-evidence", "gate", "record", "verify", "check"];

  it.each(DIRECT)("rejects %s --bogus-flag as a usage error", async (name) => {
    const dir = await initRepo();
    const { runtime, err } = makeRuntime(dir, makeConfig(), await makeArtifacts());
    expect(await runCli([name, "--bogus-flag"], runtime), err.join("")).toBe(EXIT_USAGE);
    // A usage error is about the CALL: it renders no blocker at all, so the
    // renderer's `[code] summary` / `Source:` shape must be absent. Merely
    // checking the exit code would pass for a command that blocked its way to
    // exit 2 after wiring the repository.
    expect(err.join("")).not.toMatch(/^\[[a-z_]+\] /m);
    expect(err.join("")).not.toContain("Source: command:");
  }, 30_000);

  it("accepts every direct command's real arguments", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare", "--refresh-record-neutral"], runtime)).toBe(EXIT_OK);
    // `--json` needs an installed workflow release this fixture has not got,
    // so it blocks — the point here is only that the flag is not refused.
    expect(await runCli(["review-context", "--json"], runtime)).not.toBe(EXIT_USAGE);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);
    // The positional form of the same argument, which is not a flag and must
    // not be swept up by the rejection.
    expect(await runCli(["submit-evidence", manifestPath], runtime)).toBe(EXIT_OK);
    // A manifest path that begins with a hyphen is still `--manifest`'s VALUE,
    // never an unknown flag: refusing it would be exactly the "reject a
    // legitimate argument generically" failure CLI-004 forbids. Pinned against
    // an ordinary missing path so the row asserts the two are treated
    // identically, not merely that this one was not refused.
    const hyphenLeading = await runCli(["submit-evidence", "--manifest", "-manifest.json"], runtime);
    const ordinaryMissing = await runCli(["submit-evidence", "--manifest", "missing.json"], runtime);
    expect(hyphenLeading).not.toBe(EXIT_USAGE);
    expect(hyphenLeading).toBe(ordinaryMissing);
    // The input the unknown-flag guard exists for: a mistyped flag ALONGSIDE a
    // real `--manifest`. Without the guard the manifest is published and the
    // mistyped flag is silently dropped, so `submit-evidence --bogus-flag`
    // alone proves nothing — it was already a usage error before this change,
    // by falling through to the missing-manifest arm.
    expect(await runCli(["submit-evidence", "--manifest", manifestPath, "--bogus-flag"], runtime)).toBe(EXIT_USAGE);
    expect(await runCli(["verify", "--require-run-journal"], runtime)).not.toBe(EXIT_USAGE);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
  }, 60_000);

  it("neither records nor admits for a help request or a nonsense flag on record", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, out } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const records = async (): Promise<string[]> =>
      (await readdir(recordDir).catch(() => [] as string[])).filter((name) => name.startsWith("record--"));

    expect(await runCli(["record", "--help"], runtime)).toBe(EXIT_OK);
    expect(out.join("")).toContain("--retention-scope <delivery-key> --keep-superseded <0-100>");
    expect(await records()).toEqual([]);
    expect(await runCli(["record", "--bogus-flag"], runtime)).toBe(EXIT_USAGE);
    expect(await runCli(["record", "--retention-scope", "V26-1915"], runtime)).toBe(EXIT_USAGE);
    expect(await runCli(["record", "--retention-scope", "V26-1915", "--keep-superseded", "101"], runtime)).toBe(EXIT_USAGE);
    expect(await records()).toEqual([]);
    // The admitted control: the same repository, the same runtime, the real
    // invocation — so the two empty listings above mean the arguments were
    // refused, not that this fixture could never have recorded.
    expect(await runCli(["record"], runtime), out.join("")).toBe(EXIT_OK);
    expect(await records()).toHaveLength(1);
  }, 60_000);
});
