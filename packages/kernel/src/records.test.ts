/**
 * The evidence record store, written before `records.ts` existed.
 *
 * Three properties carry this unit, and each is asserted where it can actually
 * fail rather than where it is convenient:
 *
 *   1. IDENTITY is a closed tuple. The evidence variant is pinned member by
 *      member — every one of the seven members moves `recordId`, and a change
 *      confined to the payload does not. The waiver variant is pinned the same
 *      way from the other side: it carries no provider triple, so two waivers
 *      with identical attribution for one candidate are idempotent.
 *   2. PUBLICATION is atomic under REAL concurrency. Two processes inside one
 *      interpreter prove nothing about `link()`; these tests spawn actual node
 *      child processes through `node:child_process`, released against a shared
 *      wall-clock barrier, and assert on what is left on disk afterwards. The
 *      crash window between `fsync` and `link()` is exercised by killing a
 *      child inside it.
 *   3. STORAGE is worktree-private. Proven with real `git worktree add` in real
 *      temporary repositories: a record published from one worktree is not
 *      discoverable from another, and the two workspaces do not share an id.
 *
 * Falsification rows sit beside the properties they guard: corrupting a record
 * after publication must be flagged, and the three quarantine classes must stay
 * distinguishable — a store that reported one class for everything would let a
 * tampered record hide behind a truncated write.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { BlockedError } from "./blockers.ts";
import { canonicalize } from "./canonical.ts";
import { sha256Hex } from "./digest.ts";
import {
  RECORDS_LEAF,
  RECORD_SCHEMA_VERSION,
  computeRecordId,
  discoverRecords,
  publishRecord,
  recordFileName,
  resolveRecordStorage,
} from "./records.ts";
import type { EvidenceResolution, PublishRecordInput, RecordCandidateBinding } from "./records.types.ts";

const run = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RECORDS_MODULE = path.join(REPO_ROOT, "packages/kernel/src/records.ts");
const BLOCKERS_MODULE = path.join(REPO_ROOT, "packages/kernel/src/blockers.ts");

// ── Fixtures ───────────────────────────────────────────────────────────────

const BINDING: RecordCandidateBinding = {
  treeSha: "a".repeat(40),
  deliverableDigest: "b".repeat(64),
  identityToken: "deliverable-tree/v1",
  baseRef: "origin/main",
  baseTipSha: "c".repeat(40),
  mergeBaseSha: "d".repeat(40),
  workspaceId: "e".repeat(64),
};

const RESOLUTION: EvidenceResolution = {
  kind: "evidence",
  providerId: "claude-code.ce-code-review",
  runId: "run-0001",
  finalPassId: "pass-3",
  manifestDigest: "f".repeat(64),
};

const EVIDENCE: PublishRecordInput = {
  gateId: "delivery",
  obligationId: "review.green",
  candidateBinding: BINDING,
  resolution: RESOLUTION,
};

/** The same evidence record with only its payload moved — identity is unchanged. */
const REPAID: PublishRecordInput = {
  ...EVIDENCE,
  resolution: { ...RESOLUTION, manifestDigest: "0".repeat(64) },
};

const WAIVER = {
  gateId: "delivery",
  obligationId: "review.green",
  candidateBinding: BINDING,
  resolution: { kind: "waiver", scope: "invocation", author: "Test Operator", reason: "Explicit exception", findingCodes: ["review_evidence_missing"], policyDigest: "a".repeat(64) },
} satisfies PublishRecordInput;

const WORKSPACE = "9".repeat(64);

// ── Temp repositories ──────────────────────────────────────────────────────

/**
 * Deliberately NOT realpathed. macOS hands out `/var` temporary directories
 * that are really `/private/var`, so every test here addresses its store
 * through a symlinked spelling — which is exactly the case a store that
 * digested the path as written would get wrong.
 */
function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `dh-${label}-`));
}

/** The physical spelling of a path whose leaf may not exist yet. */
function real(target: string): string {
  return path.join(realpathSync(path.dirname(target)), path.basename(target));
}

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

/** A real repository with one commit — enough for `git worktree add`. */
async function tempRepo(label = "repo"): Promise<string> {
  const dir = tempDir(label);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "commit", "--quiet", "--allow-empty", "-m", "root");
  return dir;
}

/** A storage root that needs no repository — the direct-injection seam. */
function tempStorageRoot(label = "store"): string {
  return path.join(tempDir(label), "delivery-harness");
}

// ── Subprocess harness ─────────────────────────────────────────────────────

interface ChildOutcome {
  readonly status?: string;
  readonly recordId?: string;
  readonly path?: string;
  readonly blocked?: string;
  readonly exitCode: number;
}

/**
 * The racer. Written to a temp file rather than kept as a fixture in the
 * package so that it cannot drift into being imported by production code, and
 * so that the module under test is reached the way an external caller reaches
 * it — by path, in a fresh interpreter.
 */
const CHILD_SOURCE = `
const { publishRecord } = await import(process.env["DH_RECORDS_MODULE"]);
const { BlockedError } = await import(process.env["DH_BLOCKERS_MODULE"]);

const job = JSON.parse(process.argv[2]);
if (typeof job.startAt === "number") {
  const wait = job.startAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

try {
  const result = await publishRecord(job.rootDir, job.input, {
    storageRoot: job.storageRoot,
    ...(job.crash === true ? { beforeLink: () => process.exit(9) } : {}),
  });
  process.stdout.write(JSON.stringify({ status: result.status, recordId: result.record.recordId, path: result.path }));
} catch (error) {
  if (error instanceof BlockedError) {
    process.stdout.write(JSON.stringify({ blocked: error.blockers[0].code }));
  } else {
    process.stdout.write(JSON.stringify({ blocked: "unexpected:" + String(error && error.message) }));
  }
}
`;

let childScript = "";

beforeAll(() => {
  childScript = path.join(tempDir("child"), "publish-child.mts");
  writeFileSync(childScript, CHILD_SOURCE, "utf8");
});

async function spawnPublisher(job: Record<string, unknown>): Promise<ChildOutcome> {
  try {
    const { stdout } = await run(process.execPath, ["--import", "tsx", childScript, JSON.stringify(job)], {
      cwd: REPO_ROOT,
      env: { ...process.env, DH_RECORDS_MODULE: RECORDS_MODULE, DH_BLOCKERS_MODULE: BLOCKERS_MODULE },
    });
    return { ...(JSON.parse(stdout.trim() || "{}") as Record<string, unknown>), exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    const stdout = (failure.stdout ?? "").trim();
    return { ...(stdout === "" ? {} : (JSON.parse(stdout) as Record<string, unknown>)), exitCode: failure.code ?? -1 };
  }
}

function jsonFilesIn(dir: string): readonly string[] {
  return readdirSync(dir).filter((entry) => entry.endsWith(".json"));
}

function blockerCodeOf(thrown: unknown): string {
  expect(thrown).toBeInstanceOf(BlockedError);
  const blockers = (thrown as BlockedError).blockers;
  expect(blockers.length).toBeGreaterThan(0);
  return blockers[0]!.code;
}

async function captureBlocker(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return blockerCodeOf(error);
  }
  throw new Error("expected the store to block, but the call resolved");
}

// ── Storage resolution ─────────────────────────────────────────────────────

describe("storage resolution", () => {
  it("resolves the records directory under the git directory, never the worktree", async () => {
    const repo = await tempRepo();
    const { storageRoot, storageDir, workspaceId } = await resolveRecordStorage(repo);

    expect(storageRoot).toBe(path.join(realpathSync(repo), ".git", "delivery-harness"));
    expect(storageDir).toBe(path.join(storageRoot, RECORDS_LEAF));
    // Git-private: the store is inside `.git`, which no working tree tracks.
    expect(storageDir.startsWith(path.join(realpathSync(repo), ".git") + path.sep)).toBe(true);
    expect(workspaceId).toBe(sha256Hex(canonicalize(storageRoot)));
    expect(storageRoot).toBe(real(storageRoot));
  });

  it("normalizes a namespace whether or not the config spelled a trailing slash", async () => {
    const repo = await tempRepo();
    const withSlash = await resolveRecordStorage(repo, { storageNamespace: "evidence/" });
    const withoutSlash = await resolveRecordStorage(repo, { storageNamespace: "evidence" });

    expect(withSlash.storageDir).toBe(withoutSlash.storageDir);
    expect(withSlash.workspaceId).toBe(withoutSlash.workspaceId);
    expect(withSlash.storageDir).toBe(path.join(realpathSync(repo), ".git", "evidence", RECORDS_LEAF));
  });

  it("derives the workspace id from the namespace root, so every leaf shares one workspace", async () => {
    const repo = await tempRepo();
    const records = await resolveRecordStorage(repo);
    const receipts = await resolveRecordStorage(repo, { leaf: "receipts" });

    expect(receipts.storageDir).toBe(path.join(records.storageRoot, "receipts"));
    expect(receipts.workspaceId).toBe(records.workspaceId);
  });

  it("blocks with a typed store blocker outside a repository", async () => {
    const notARepo = tempDir("bare");
    const code = await captureBlocker(() => resolveRecordStorage(notARepo));
    expect(code).toBe("record_store_unresolved");
  });

  it("accepts an injected storage root without consulting git at all", async () => {
    const storageRoot = tempStorageRoot();
    const resolved = await resolveRecordStorage(path.join(storageRoot, "..", "nowhere"), { storageRoot });

    expect(resolved.storageRoot).toBe(real(storageRoot));
    expect(resolved.workspaceId).toBe(sha256Hex(canonicalize(real(storageRoot))));
  });
});

// ── Identity ───────────────────────────────────────────────────────────────

describe("record identity — evidence variant", () => {
  const baseline = computeRecordId(WORKSPACE, EVIDENCE);

  it("is a lowercase-hex sha256 over the canonical identity tuple", () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline).toBe(
      sha256Hex(
        canonicalize({
          workspaceId: WORKSPACE,
          gateId: EVIDENCE.gateId,
          obligationId: EVIDENCE.obligationId,
          candidateBinding: BINDING,
          providerId: "claude-code.ce-code-review",
          runId: "run-0001",
          finalPassId: "pass-3",
        }),
      ),
    );
  });

  const tupleMutations: readonly (readonly [string, () => string])[] = [
    ["workspaceId", () => computeRecordId("8".repeat(64), EVIDENCE)],
    ["gateId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, gateId: "other-gate" })],
    ["obligationId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, obligationId: "review.other" })],
    ["providerId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, resolution: { ...RESOLUTION, providerId: "other-provider" } })],
    ["runId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, resolution: { ...RESOLUTION, runId: "run-0002" } })],
    ["finalPassId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, resolution: { ...RESOLUTION, finalPassId: "pass-4" } })],
  ];

  for (const [member, mutate] of tupleMutations) {
    it(`moves when the tuple member "${member}" moves`, () => {
      expect(mutate()).not.toBe(baseline);
    });
  }

  const bindingMembers: readonly (readonly [keyof RecordCandidateBinding, string])[] = [
    ["treeSha", "1".repeat(40)],
    ["deliverableDigest", "2".repeat(64)],
    ["identityToken", "deliverable-tree/v2"],
    ["baseRef", "origin/release"],
    ["baseTipSha", "3".repeat(40)],
    ["mergeBaseSha", "4".repeat(40)],
    ["workspaceId", "5".repeat(64)],
  ];

  for (const [member, replacement] of bindingMembers) {
    it(`moves when the candidate binding member "${member}" moves`, () => {
      const moved = computeRecordId(WORKSPACE, {
        ...EVIDENCE,
        candidateBinding: { ...BINDING, [member]: replacement },
      });
      expect(moved).not.toBe(baseline);
    });
  }

  it("every mutation above produces a distinct id — no two collapse onto each other", () => {
    const ids = new Set<string>([baseline]);
    for (const [, mutate] of tupleMutations) ids.add(mutate());
    for (const [member, replacement] of bindingMembers) {
      ids.add(computeRecordId(WORKSPACE, { ...EVIDENCE, candidateBinding: { ...BINDING, [member]: replacement } }));
    }
    expect(ids.size).toBe(1 + tupleMutations.length + bindingMembers.length);
  });

  it("does not move when only the payload moves — that is what makes republish a conflict", () => {
    expect(computeRecordId(WORKSPACE, REPAID)).toBe(baseline);
  });
});

describe("record identity — waiver variant", () => {
  it("binds full approval so distinct scopes coexist without overwriting", () => {
    const invocation = computeRecordId(WORKSPACE, WAIVER);
    const durable = computeRecordId(WORKSPACE, {
      ...WAIVER,
      resolution: { ...WAIVER.resolution, kind: "waiver", scope: "durable" },
    });

    expect(invocation).not.toBe(durable);
    expect(invocation).toBe(
      sha256Hex(
        canonicalize({
          workspaceId: WORKSPACE,
          gateId: WAIVER.gateId,
          obligationId: WAIVER.obligationId,
          candidateBinding: BINDING,
          kind: "waiver",
          approval: WAIVER.resolution,
        }),
      ),
    );
  });

  it("is distinct from the evidence variant for the same coordinates", () => {
    expect(computeRecordId(WORKSPACE, WAIVER)).not.toBe(computeRecordId(WORKSPACE, EVIDENCE));
  });

  it("moves with the candidate binding, so a waiver never survives a new candidate", () => {
    const moved = computeRecordId(WORKSPACE, {
      ...WAIVER,
      candidateBinding: { ...BINDING, deliverableDigest: "7".repeat(64) },
    });
    expect(moved).not.toBe(computeRecordId(WORKSPACE, WAIVER));
  });
});

// ── Publication ────────────────────────────────────────────────────────────

describe("publication", () => {
  it("writes one content-addressed file with 0700/0600 modes", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });

    expect(published.status).toBe("published");
    expect(published.record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(published.record.recordId).toBe(computeRecordId(published.record.workspaceId, EVIDENCE));
    expect(path.basename(published.path)).toBe(
      recordFileName(EVIDENCE.gateId, EVIDENCE.obligationId, published.record.recordId),
    );

    expect(statSync(path.dirname(published.path)).mode & 0o777).toBe(0o700);
    expect(statSync(published.path).mode & 0o777).toBe(0o600);

    const onDisk = JSON.parse(readFileSync(published.path, "utf8")) as Record<string, unknown>;
    expect(onDisk["recordId"]).toBe(published.record.recordId);
    expect(onDisk["workspaceId"]).toBe(published.record.workspaceId);
  });

  it("leaves no temporary file behind", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    expect(readdirSync(path.dirname(published.path))).toEqual([path.basename(published.path)]);
  });

  it("is idempotent for a byte-identical resubmission", async () => {
    const storageRoot = tempStorageRoot();
    const first = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const second = await publishRecord(storageRoot, EVIDENCE, { storageRoot });

    expect(second.status).toBe("idempotent");
    expect(second.record.recordId).toBe(first.record.recordId);
    expect(second.path).toBe(first.path);
    expect(jsonFilesIn(path.dirname(first.path))).toHaveLength(1);
  });

  it("rejects the same identity carrying different content", async () => {
    const storageRoot = tempStorageRoot();
    await publishRecord(storageRoot, EVIDENCE, { storageRoot });

    const code = await captureBlocker(() => publishRecord(storageRoot, REPAID, { storageRoot }));
    expect(code).toBe("record_conflict");
  });

  it("treats a repeated waiver for one candidate as idempotent", async () => {
    const storageRoot = tempStorageRoot();
    const first = await publishRecord(storageRoot, WAIVER, { storageRoot });
    const second = await publishRecord(storageRoot, WAIVER, { storageRoot });

    expect(first.status).toBe("published");
    expect(second.status).toBe("idempotent");
    expect(jsonFilesIn(path.dirname(first.path))).toHaveLength(1);
  });

  it("retains both approvals when a human grants a different scope", async () => {
    const storageRoot = tempStorageRoot();
    const first = await publishRecord(storageRoot, WAIVER, { storageRoot });
    const original = readFileSync(first.path, "utf8");
    const second = await publishRecord(storageRoot, { ...WAIVER, resolution: { ...WAIVER.resolution, kind: "waiver", scope: "durable" } }, { storageRoot });
    expect(second.status).toBe("published");
    expect(second.record.recordId).not.toBe(first.record.recordId);
    expect(readFileSync(first.path, "utf8")).toBe(original);
    expect(jsonFilesIn(path.dirname(first.path))).toHaveLength(2);
  });

  it("rejects an existing file at the slot that cannot be parsed at all", async () => {
    const storageRoot = tempStorageRoot();
    const { storageDir, workspaceId } = await resolveRecordStorage(storageRoot, { storageRoot });
    const recordId = computeRecordId(workspaceId, EVIDENCE);

    // Publish once to create the directory, then squat the slot with garbage.
    await publishRecord(storageRoot, WAIVER, { storageRoot });
    writeFileSync(path.join(storageDir, recordFileName(EVIDENCE.gateId, EVIDENCE.obligationId, recordId)), "{ not json");

    const code = await captureBlocker(() => publishRecord(storageRoot, EVIDENCE, { storageRoot }));
    expect(code).toBe("record_conflict");
  });

  it("blocks with a typed blocker when the storage directory cannot be created", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits this asserts on
    const parent = tempDir("readonly");
    chmodSync(parent, 0o500);
    try {
      const code = await captureBlocker(() =>
        publishRecord(parent, EVIDENCE, { storageRoot: path.join(parent, "delivery-harness") }),
      );
      expect(code).toBe("record_store_unwritable");
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

// ── Discovery ──────────────────────────────────────────────────────────────

describe("discovery", () => {
  const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId };

  it("returns nothing, and does not throw, before anything has been published", async () => {
    const storageRoot = tempStorageRoot();
    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.records).toEqual([]);
    expect(found.quarantined).toEqual([]);
  });

  it("finds records for the selected obligation and ignores the neighbours", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    await publishRecord(storageRoot, { ...EVIDENCE, obligationId: "review.other" }, { storageRoot });
    writeFileSync(path.join(path.dirname(published.path), "notes.txt"), "not a record");

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.records.map((record) => record.recordId)).toEqual([published.record.recordId]);
    expect(found.quarantined).toEqual([]);
    expect(found.ignored.map((entry) => path.basename(entry.path))).toContain("notes.txt");
  });

  it("distinguishes byte corruption from a tampered identity from a malformed shape", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const dir = path.dirname(published.path);

    // (1) truncated write — the JSON parser is what fails.
    writeFileSync(published.path, readFileSync(published.path, "utf8").slice(0, 40));
    // (2) valid JSON, wrong shape.
    const shapePath = path.join(dir, recordFileName(selector.gateId, selector.obligationId, "1".repeat(64)));
    writeFileSync(shapePath, JSON.stringify({ schemaVersion: RECORD_SCHEMA_VERSION, recordId: "1".repeat(64) }));
    // (3) valid shape, tampered member, original id retained.
    const tampered = { ...published.record, candidateBinding: { ...BINDING, treeSha: "9".repeat(40) } };
    const tamperedPath = path.join(dir, recordFileName(selector.gateId, selector.obligationId, "2".repeat(64)));
    writeFileSync(tamperedPath, JSON.stringify({ ...tampered, recordId: "2".repeat(64) }));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.records).toEqual([]);
    const reasons = new Map(found.quarantined.map((entry) => [path.basename(entry.path), entry.reason]));
    expect(reasons.get(path.basename(published.path))).toBe("corrupt_json");
    expect(reasons.get(path.basename(shapePath))).toBe("malformed_shape");
    expect(reasons.get(path.basename(tamperedPath))).toBe("identity_mismatch");
    expect(new Set(found.quarantined.map((entry) => entry.reason)).size).toBe(3);
  });

  it("quarantines a record whose filename does not carry its own id", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const wrongSlot = path.join(
      path.dirname(published.path),
      recordFileName(selector.gateId, selector.obligationId, "3".repeat(64)),
    );
    writeFileSync(wrongSlot, readFileSync(published.path, "utf8"));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });
    expect(found.quarantined.map((entry) => entry.reason)).toEqual(["identity_mismatch"]);
    expect(found.records).toHaveLength(1);
  });

  it("quarantines a record carrying another workspace's id", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const foreign = { ...published.record, workspaceId: "c".repeat(64) };
    writeFileSync(published.path, JSON.stringify(foreign));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });
    expect(found.records).toEqual([]);
    expect(found.quarantined[0]?.reason).toBe("identity_mismatch");
  });

  it("falsification: a record corrupted after publication is flagged, not silently dropped", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    writeFileSync(published.path, "}}}");

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });
    expect(found.records).toEqual([]);
    expect(found.quarantined).toHaveLength(1);
    expect(found.quarantined[0]?.path).toBe(published.path);
  });

  it.each(["", "token_", "x"])("redacts a credential planted in a stored record after %s", async (prefix) => {
    const storageRoot = tempStorageRoot("redaction");
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const token = `ghp_${"A".repeat(30)}`;
    writeFileSync(published.path, JSON.stringify({ ...published.record, schemaVersion: `${prefix}${token}` }));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.quarantined).toHaveLength(1);
    expect(found.quarantined[0]?.detail).not.toContain(token);
    expect(found.quarantined[0]?.detail).toContain("[REDACTED]");
  });

  it("blocks with a read-path blocker when the store cannot be listed", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits this asserts on
    const storageRoot = tempStorageRoot("unlistable");
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const dir = path.dirname(published.path);
    chmodSync(dir, 0o000);
    try {
      const code = await captureBlocker(() => discoverRecords(storageRoot, { ...selector, storageRoot }));
      expect(code).toBe("record_store_unreadable");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});



// ── Namespace containment ──────────────────────────────────────────────────

describe("namespace containment", () => {
  it("blocks a namespace that traverses back into the working tree", async () => {
    const repo = await tempRepo("traversal");
    const code = await captureBlocker(() => resolveRecordStorage(repo, { storageNamespace: "foo/../../bar" }));
    expect(code).toBe("record_store_unresolved");
  }, 60_000);

  it("blocks a namespace that escapes the repository entirely", async () => {
    const repo = await tempRepo("escape");
    const code = await captureBlocker(() => resolveRecordStorage(repo, { storageNamespace: "a/../../../escape" }));
    expect(code).toBe("record_store_unresolved");
  }, 60_000);

  /**
   * Git roots a handful of names — `objects`, `refs`, `info`, `hooks`, `logs`
   * — in the common directory rather than the per-worktree one, so a namespace
   * under any of them resolves identically from every worktree and every
   * worktree would share one store. The containment check refuses it the moment
   * a second worktree exists, which is the only moment the privacy claim is
   * making a promise.
   */
  const commonNames = ["objects", "refs", "info", "hooks", "logs"] as const;

  for (const name of commonNames) {
    it(`blocks the shared-store namespace "${name}/dh" from a linked worktree`, async () => {
      const repo = await tempRepo(`common-${name}`);
      const linked = path.join(tempDir(`common-wt-${name}`), "wt");
      await git(repo, "worktree", "add", "--quiet", "-b", `common-${name}`, linked);

      const code = await captureBlocker(() => resolveRecordStorage(linked, { storageNamespace: `${name}/dh` }));
      expect(code).toBe("record_store_unresolved");
    }, 60_000);
  }

  it("still resolves the default and a nested namespace from both worktrees", async () => {
    const repo = await tempRepo("nested");
    const linked = path.join(tempDir("nested-wt"), "wt");
    await git(repo, "worktree", "add", "--quiet", "-b", "nested-feature", linked);

    for (const dir of [repo, linked]) {
      const byDefault = await resolveRecordStorage(dir);
      const nested = await resolveRecordStorage(dir, { storageNamespace: "team/delivery-harness/v1" });
      expect(byDefault.storageDir.endsWith(path.join("delivery-harness", RECORDS_LEAF))).toBe(true);
      expect(nested.storageDir.endsWith(path.join("team", "delivery-harness", "v1", RECORDS_LEAF))).toBe(true);
    }
  }, 60_000);
});

// ── Path spelling ──────────────────────────────────────────────────────────

describe("workspace identity is physical, not textual", () => {
  it("gives one store one id however the caller spelled the path", async () => {
    const repo = await tempRepo("spelling");
    const alias = path.join(tempDir("alias"), "repo-link");
    symlinkSync(repo, alias);

    const direct = await resolveRecordStorage(repo);
    const viaSymlink = await resolveRecordStorage(alias);

    expect(viaSymlink.workspaceId).toBe(direct.workspaceId);
    expect(viaSymlink.storageDir).toBe(direct.storageDir);
  }, 60_000);

  it("lets the two spellings see each other's records", async () => {
    const repo = await tempRepo("spelling-records");
    const alias = path.join(tempDir("alias-records"), "repo-link");
    symlinkSync(repo, alias);
    const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId };

    const published = await publishRecord(alias, EVIDENCE, {});
    const found = await discoverRecords(repo, selector);

    expect(found.records.map((record) => record.recordId)).toEqual([published.record.recordId]);
    expect(found.quarantined).toEqual([]);
    // And a republication through the other spelling is idempotent, not a
    // second record filed under a second workspace.
    expect((await publishRecord(repo, EVIDENCE, {})).status).toBe("idempotent");
  }, 60_000);
});

// ── Inputs the identity computation itself rejects ─────────────────────────

describe("malformed publish input", () => {
  const cyclicBinding = (): unknown => {
    const binding: Record<string, unknown> = { ...BINDING };
    binding["treeSha"] = binding;
    return binding;
  };

  const cases: readonly (readonly [string, () => unknown])[] = [
    ["a missing candidate binding", () => ({ ...EVIDENCE, candidateBinding: undefined })],
    ["a missing resolution", () => ({ gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId, candidateBinding: BINDING })],
    ["an unknown resolution kind", () => ({ ...EVIDENCE, resolution: { kind: "hunch" } })],
    ["a cyclic candidate binding", () => ({ ...EVIDENCE, candidateBinding: cyclicBinding() })],
    [
      "a candidate binding whose toJSON throws",
      () => ({
        ...EVIDENCE,
        candidateBinding: {
          ...BINDING,
          toJSON: () => {
            throw new Error("hostile serializer");
          },
        },
      }),
    ],
  ];

  for (const [label, build] of cases) {
    it(`blocks ${label} as invalid input, never as a raw throw`, async () => {
      const storageRoot = tempStorageRoot("invalid");
      const code = await captureBlocker(() =>
        publishRecord(storageRoot, build() as PublishRecordInput, { storageRoot }),
      );
      expect(code).toBe("record_input_invalid");
    });
  }

  it("blocks a slot name the filesystem cannot hold", async () => {
    const storageRoot = tempStorageRoot("long-slot");
    const code = await captureBlocker(() =>
      publishRecord(storageRoot, { ...EVIDENCE, gateId: "g".repeat(5_000) }, { storageRoot }),
    );
    expect(code).toBe("record_store_unwritable");
  });
});

// ── Real subprocess concurrency ────────────────────────────────────────────

describe("concurrency, in real child processes", () => {
  const RACERS = 6;

  it("admits exactly one publisher when identical records race", async () => {
    const storageRoot = tempStorageRoot("race");
    const startAt = Date.now() + 700;
    const outcomes = await Promise.all(
      Array.from({ length: RACERS }, () =>
        spawnPublisher({ rootDir: storageRoot, storageRoot, input: EVIDENCE, startAt }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "published")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "idempotent")).toHaveLength(RACERS - 1);

    const found = await discoverRecords(storageRoot, {
      gateId: EVIDENCE.gateId,
      obligationId: EVIDENCE.obligationId,
      storageRoot,
    });
    expect(found.records).toHaveLength(1);
    expect(found.quarantined).toEqual([]);
    expect(readdirSync(path.join(storageRoot, RECORDS_LEAF))).toHaveLength(1);
  }, 60_000);

  it("admits exactly one publisher, and blocks the rest, when contents disagree", async () => {
    const storageRoot = tempStorageRoot("conflict-race");
    const startAt = Date.now() + 700;
    const outcomes = await Promise.all(
      Array.from({ length: RACERS }, (_unused, index) =>
        spawnPublisher({
          rootDir: storageRoot,
          storageRoot,
          input: index % 2 === 0 ? EVIDENCE : REPAID,
          startAt,
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "published")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.blocked === "record_conflict").length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      expect(outcome.status ?? outcome.blocked).toMatch(/^(published|idempotent|record_conflict)$/);
    }

    const dir = path.join(storageRoot, RECORDS_LEAF);
    expect(jsonFilesIn(dir)).toHaveLength(1);
    const found = await discoverRecords(storageRoot, {
      gateId: EVIDENCE.gateId,
      obligationId: EVIDENCE.obligationId,
      storageRoot,
    });
    expect(found.records).toHaveLength(1);
  }, 60_000);

  it("survives a crash inside the window between fsync and link", async () => {
    const storageRoot = tempStorageRoot("crash");
    const crashed = await spawnPublisher({ rootDir: storageRoot, storageRoot, input: EVIDENCE, crash: true });
    expect(crashed.exitCode).toBe(9);

    const dir = path.join(storageRoot, RECORDS_LEAF);
    const leftovers = readdirSync(dir);
    expect(leftovers).toHaveLength(1); // the orphaned temporary
    expect(jsonFilesIn(dir)).toEqual([]);

    // The orphan is invisible to readers: not a record, and not a quarantine.
    const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId, storageRoot };
    const afterCrash = await discoverRecords(storageRoot, selector);
    expect(afterCrash.records).toEqual([]);
    expect(afterCrash.quarantined).toEqual([]);

    // And it does not block the next publisher.
    const republished = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    expect(republished.status).toBe("published");
    const afterRepublish = await discoverRecords(storageRoot, selector);
    expect(afterRepublish.records).toHaveLength(1);
    expect(afterRepublish.quarantined).toEqual([]);
  }, 60_000);
});

// ── Worktree privacy ───────────────────────────────────────────────────────

describe("linked worktrees", () => {
  it("cannot see each other's records", async () => {
    const repo = await tempRepo("main-worktree");
    const linked = path.join(tempDir("linked"), "wt");
    await git(repo, "worktree", "add", "--quiet", "-b", "feature", linked);

    const main = await resolveRecordStorage(repo);
    const other = await resolveRecordStorage(linked);

    expect(other.storageDir).not.toBe(main.storageDir);
    expect(other.workspaceId).not.toBe(main.workspaceId);

    await publishRecord(repo, EVIDENCE, {});
    const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId };

    expect((await discoverRecords(repo, selector)).records).toHaveLength(1);
    expect((await discoverRecords(linked, selector)).records).toEqual([]);
    expect((await discoverRecords(linked, selector)).quarantined).toEqual([]);
  }, 60_000);

  it("scopes record identity by workspace, so the same input yields different ids", async () => {
    const repo = await tempRepo("scoped");
    const linked = path.join(tempDir("linked-scoped"), "wt");
    await git(repo, "worktree", "add", "--quiet", "-b", "scoped-feature", linked);

    const here = await publishRecord(repo, EVIDENCE, {});
    const there = await publishRecord(linked, EVIDENCE, {});

    expect(there.record.recordId).not.toBe(here.record.recordId);
    expect(there.record.workspaceId).not.toBe(here.record.workspaceId);
  }, 60_000);
});


describe("installed data record grammar", () => {
  const resourceBinding = { version: "installed-data-binding/1", candidateDigest: "a".repeat(64), definitionDigest: "b".repeat(64), declarationDigest: "c".repeat(64), sourceApplicabilityDigest: "d".repeat(64), captureDigest: "e".repeat(64), originDigest: "f".repeat(64) };
  it("roundtrips the closed resource variant and rejects extra, missing and invalid binding members", async () => {
    const root = tempDir("resource-record");
    const input = { ...EVIDENCE, resolution: { ...RESOLUTION, resourceBinding } };
    const saved = await publishRecord(root, input as PublishRecordInput, { storageRoot: root });
    expect(saved.record.resolution).toEqual(input.resolution);
    await expect(publishRecord(root, { ...input, resolution: { ...input.resolution, checkBinding: { definitionDigest: "a".repeat(64), validationDigest: "b".repeat(64), policyDigest: "c".repeat(64), wiringFingerprint: "d".repeat(64), outputsDigest: "e".repeat(64) } } } as PublishRecordInput, { storageRoot: root })).rejects.toThrow();
    for (const binding of [{ ...resourceBinding, extra: true }, { ...resourceBinding, version: "unknown" }, ...Object.keys(resourceBinding).filter(key => key !== "version").flatMap(key => {
      const missing = { ...resourceBinding } as Record<string, unknown>; delete missing[key];
      return [missing, { ...resourceBinding, [key]: "bad" }];
    })]) {
      await expect(publishRecord(tempDir("bad-resource-record"), { ...input, resolution: { ...input.resolution, resourceBinding: binding } } as unknown as PublishRecordInput, { storageRoot: tempDir("bad-resource-store") })).rejects.toThrow();
    }
  });
});
