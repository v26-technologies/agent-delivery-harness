/**
 * Falsification suite for the import-boundary sensor.
 *
 * Every rule, and every protected file class, is planted with a violation in a
 * fixture tree and asserted red — then asserted green on the clean tree. A
 * sensor that cannot fail is not a sensor. Fixtures live in a temp directory,
 * deliberately outside every real scan root, and are injected through the
 * sensor's `root` / `protectedClasses` parameters.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import {
  PROTECTED_CLASSES,
  SCAN_ROOTS,
  TIMESTAMP_READ_EXEMPTIONS,
  repoRootFromHere,
  runImportBoundarySensor,
  type Finding,
  type ProtectedClass,
  type SensorRule,
  type TimestampReadExemption,
} from "./check-import-boundaries.ts";

// ── Fixture tree ───────────────────────────────────────────────────────────

/**
 * A tree that satisfies every rule, containing one file of each protected class
 * so that a planted violation has somewhere legal to sit next to.
 */
const CLEAN_TREE: Readonly<Record<string, string>> = {
  // Kernel modules a pure module is allowed to reach.
  "packages/kernel/src/index.ts": `export const PACKAGE_NAME = "kernel";\n`,
  "packages/kernel/src/canonical.ts": `export const canonicalize = (v: unknown): string => JSON.stringify(v);\n`,
  "packages/kernel/src/digest.ts": `export const sha256 = (s: string): string => s;\n`,
  "packages/kernel/src/blockers.ts": `export const blocker = (code: string): string => code;\n`,
  "packages/kernel/src/config.ts": `export const defineHarnessConfig = <T,>(c: T): T => c;\n`,
  "packages/kernel/src/candidate.types.ts": `export interface CandidateShape { digest: string }\n`,
  "packages/kernel/src/records.types.ts": `export interface RecordShape { id: string }\n`,
  "packages/kernel/src/artifacts.types.ts": `export interface ArtifactsPort { read(p: string): Promise<string> }\n`,
  // The finite installed-DATA grammar and its applicability evidence, each pure.
  "packages/kernel/src/portable-limits.ts": `export const MAX_PORTABLE_ARTIFACT_BYTES = 1;\n`,
  "packages/kernel/src/installed-data-resources.ts": `import { sha256 } from "./digest.ts";\nimport { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-limits.ts";\nexport const normalizeInstalledDataResourceRequests = (v: string): string => sha256(v) + MAX_PORTABLE_ARTIFACT_BYTES;\n`,
  "packages/kernel/src/installed-data-evidence.ts": `import { normalizeInstalledDataResourceRequests } from "./installed-data-resources.ts";\nexport const binding = (v: string): string => normalizeInstalledDataResourceRequests(v);\n`,

  // Kernel modules that legitimately touch the filesystem.
  "packages/kernel/src/identity.ts": `import { execFileSync } from "node:child_process";\nexport const lsTree = (): string => String(execFileSync("git", ["ls-tree"]));\n`,
  "packages/kernel/src/records.ts": `import { writeFileSync } from "node:fs";\nexport const publish = (p: string, b: string): void => writeFileSync(p, b);\n`,
  "packages/kernel/src/artifacts.ts": `import { readFileSync } from "node:fs";\nexport const read = (p: string): string => readFileSync(p, "utf8");\n`,

  // d1 — true purity.
  "packages/kernel/src/context.ts": `import { blocker } from "./blockers.ts";\nexport const classify = (env: Record<string, string>): string => blocker(env["CI"] ?? "unknown");\n`,
  "packages/kernel/src/evaluator.ts": `import type { CandidateShape } from "./candidate.types.ts";\nimport { sha256 } from "./digest.ts";\nimport { classify } from "./context.ts";\nexport const evaluate = (c: CandidateShape, e: Record<string, string>): string => sha256(c.digest) + classify(e);\n`,
  "packages/kernel/src/validator/codes.ts": `export const CODES = ["unknown_member"] as const;\n`,
  "packages/kernel/src/validator/envelope.ts":
    `import type { RecordShape } from "../records.types.ts";\n` +
    `import { canonicalize } from "../canonical.ts";\n` +
    `import { CODES } from "./codes.ts";\n` +
    `const read = (o: Record<string, unknown>, k: string): unknown => o[k];\n` +
    `export const validate = (r: RecordShape): string => canonicalize(r) + CODES[0];\n` +
    // The registered site: the closed grammar has to know the member exists.
    `export function checkTimestamp(m: Record<string, unknown>): boolean {\n  return typeof read(m, "recordedAt") === "string";\n}\n`,

  // The contract spine: pure, and independent of the evidence kernel. Its
  // fixture mirrors the real shape — a sibling import plus the canonicalizer.
  "packages/kernel/src/spine/grammar.ts": `export const SPINE_INSTANT = /^\\d{4}/;\n`,
  "packages/kernel/src/spine/composition.ts": `export const PRODUCT_TRUST_LABEL = "local-digest / operator-pinned";\n`,
  "packages/kernel/src/spine/vocabulary.ts": `export const JOURNALS = ["intake", "delivery", "maintenance"] as const;\n`,
  "packages/kernel/src/spine/journal.ts":
    `import { canonicalize } from "../canonical.ts";\n` +
    `import { JOURNALS } from "./vocabulary.ts";\n` +
    `export const describeEntry = (v: unknown): string => canonicalize(v) + JOURNALS[0];\n`,

  // The trusted host-control binding: pure, reaching the spine only through
  // its named allowlist entries.
  "packages/kernel/src/binding/host-admission.ts":
    `import { SPINE_INSTANT } from "../spine/grammar.ts";\n` +
    `export const observedAtIsWellFormed = (v: string): boolean => SPINE_INSTANT.test(v);\n`,

  // The local composition substrate: two pure modules reaching the kernel
  // only through their named allowlists (the fixtures mirror the real import
  // shapes), and the installer — the substrate's one filesystem module,
  // registered for the time ban only.
  "packages/kernel/src/substrate/manifest.ts":
    `import { canonicalize } from "../canonical.ts";\n` +
    `import { sha256 } from "../digest.ts";\n` +
    `import { PRODUCT_TRUST_LABEL } from "../spine/composition.ts";\n` +
    `import { SPINE_INSTANT } from "../spine/grammar.ts";\n` +
    `export const manifestDigestOf = (v: unknown): string => sha256(canonicalize(v)) + PRODUCT_TRUST_LABEL + String(SPINE_INSTANT);\n`,
  "packages/kernel/src/substrate/trust-store.ts":
    `import { PRODUCT_TRUST_LABEL } from "../spine/composition.ts";\n` +
    `export const checkNoDowngrade = (sequence: number, mark: number): string => (sequence >= mark ? PRODUCT_TRUST_LABEL : "downgrade");\n`,
  "packages/kernel/src/substrate/installer.ts":
    `import { readFileSync } from "node:fs";\n` +
    `import { manifestDigestOf } from "./manifest.ts";\n` +
    `export const digestOfFile = (p: string): string => manifestDigestOf(readFileSync(p, "utf8"));\n`,
  "packages/kernel/src/substrate/lifecycle.ts":
    `import { digestOfFile } from "./installer.ts";\n` +
    `export const updateComposition = (p: string, now: string): string => digestOfFile(p) + now;\n`,
  "packages/kernel/src/substrate/maintenance-journal.ts":
    `import { readFileSync } from "node:fs";\n` +
    `export const readMaintenanceJournal = (p: string): string => readFileSync(p, "utf8");\n`,

  // The walking skeleton's V-slice modules, mirroring their real import
  // shapes: the pure modules reach the kernel only through their named
  // allowlists (plus siblings), and the impure ones are time-banned only.
  "packages/kernel/src/spine/finish-line.ts": `export const FINISH_LINE_RESULT_SPEC = "finish-line-result/1";\n`,
  "packages/kernel/src/workflow/archive.ts": `export const listArchiveEntries = (bytes: Uint8Array): number => bytes.length;\n`,
  "packages/kernel/src/workflow/graph.ts":
    `import { sha256 } from "../digest.ts";\n` +
    `import { PRODUCT_TRUST_LABEL } from "../spine/composition.ts";\n` +
    `import { listArchiveEntries } from "./archive.ts";\n` +
    `export const describeGraph = (bytes: Uint8Array): string => sha256(String(listArchiveEntries(bytes))) + PRODUCT_TRUST_LABEL;\n`,
  "packages/kernel/src/policy/disposable.ts":
    `import { sha256 } from "../digest.ts";\nexport const policyDigestOf = (v: string): string => sha256(v);\n`,
  "packages/kernel/src/evidence/review.ts":
    `import { SPINE_INSTANT } from "../spine/grammar.ts";\nexport const contextObservedAtOk = (v: string): boolean => SPINE_INSTANT.test(v);\n`,
  "packages/kernel/src/finish-line/merge-ready.ts":
    `import { sha256 } from "../digest.ts";\n` +
    `import { FINISH_LINE_RESULT_SPEC } from "../spine/finish-line.ts";\n` +
    `export const resultDigestOf = (v: string): string => sha256(v + FINISH_LINE_RESULT_SPEC);\n`,
  // The coordination unit: one module on each side of its registered edge, so
  // the clean fixture actually makes `kernel-coordination` `present` and the
  // rows below have something legal to plant next to. Round 3 found the class
  // registered with no fixture entry at all, which silently downgraded it to
  // `pending` — the clean-fixture row went red, and with it the suite's only
  // proof that the sensor reports NO findings on a legal tree.
  // All three allowlisted edges are exercised here, the redaction corpus
  // included: an allowlist entry no clean-tree file uses is an entry whose
  // removal nothing notices.
  "packages/kernel/src/coordination/message.ts":
    `import { SPINE_INSTANT } from "../spine/grammar.ts";\n` +
    `import { JOURNAL_ENTRY_SPEC } from "../spine/journal.ts";\n` +
    `import { SECRET_PATTERNS } from "../checkpoint/redaction.ts";\n` +
    `export const messageOk = (v: string): boolean =>\n` +
    `  SPINE_INSTANT.test(v) && JOURNAL_ENTRY_SPEC.length > 0 && SECRET_PATTERNS.length > 0;\n`,
  "packages/kernel/src/coordination/reconcile.ts":
    `import { messageOk } from "./message.ts";\n` +
    `export const reconcile = (v: string): boolean => messageOk(v);\n`,
  "packages/kernel/src/checkpoint/redaction.ts":
    `export const SECRET_PATTERNS = Object.freeze([{ id: "github-token", source: "ghp_" }] as const);\n`,
  "packages/kernel/src/checkpoint/journal-store.ts":
    `import { appendFile } from "node:fs/promises";\nexport const append = (p: string, line: string): Promise<void> => appendFile(p, line);\n`,
  "packages/kernel/src/host/claude-code.ts":
    `import { readFile } from "node:fs/promises";\nexport const projectionBytes = (p: string): Promise<Uint8Array> => readFile(p);\n`,
  "packages/kernel/src/host/consumption-gate-record.ts":
    `import { writeFile } from "node:fs/promises";\nexport const emit = (p: string, v: string): Promise<void> => writeFile(p, v);\n`,
  "packages/kernel/src/host/exec-port.ts":
    `import { execFile } from "node:child_process";\nexport const run = (cmd: string): void => void execFile(cmd, []);\n`,
  "packages/kernel/src/host/entry.ts":
    `import { realpathSync } from "node:fs";\nexport const entry = (p: string): string => realpathSync(p);\n`,
  "packages/kernel/src/facade/managed-delivery.ts":
    `import { readFile } from "node:fs/promises";\nexport const readJournal = (p: string): Promise<string> => readFile(p, "utf8");\n`,

  // d2 — fs only through the artifacts port.
  "packages/kernel/src/recorder.ts": `import type { ArtifactsPort } from "./artifacts.types.ts";\nexport const submit = (port: ArtifactsPort, p: string): Promise<string> => port.read(p);\n`,
  "packages/kernel/src/admission.ts": `import type { RecordShape } from "./records.types.ts";\nimport { evaluate } from "./evaluator.ts";\nexport const admit = (r: RecordShape): string => r.id + evaluate({ digest: r.id }, {});\n`,
  "packages/kernel/src/delivery-record.ts": `import type { ArtifactsPort } from "./artifacts.types.ts";\nexport const produce = (port: ArtifactsPort): ArtifactsPort => port;\n`,

  // e — the action entry point.
  "packages/action/src/index.ts": `export const PACKAGE_NAME = "action";\n`,
  "packages/action/src/main.ts": `export const run = (recordedAt: string): string => recordedAt;\n`,

  // Rule b's legal shape: an in-function environment read.
  "packages/cli/src/index.ts": `export const logLevel = (): string | undefined => process.env["DELIVERY_HARNESS_LOG"];\n`,
  "packages/mcp/src/index.ts": `export const PACKAGE_NAME = "mcp";\n`,
  "packages/conformance/src/index.ts": `export const PACKAGE_NAME = "conformance";\n`,
  "scripts/placeholder.ts": `export const PLACEHOLDER = true;\n`,

  // Source that lives outside every package's `src`: the fixture configs, and
  // the consumer-owned config at the repo root.
  "packages/conformance/fixtures/example-config.ts": `export const exampleConfig = { gateId: "example.gate" };\n`,
  "harness.config.ts": `export default { gateId: "example.gate" };\n`,
};

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dh-sensor-"));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** Registry derived from the fixture: whatever exists is enforced. */
function registryFor(root: string): ProtectedClass[] {
  return PROTECTED_CLASSES.map((entry) => ({
    ...entry,
    status: existsSync(path.join(root, entry.path)) ? ("present" as const) : ("pending" as const),
  }));
}

/**
 * Exemptions derived from the fixture, on the same principle as `registryFor`:
 * a fixture that does not contain the registered site is not making a claim
 * about it. The registry's own load-bearingness is asserted against the real
 * tree, and by the three tests that pass an explicit registry.
 */
function exemptionsFor(root: string): TimestampReadExemption[] {
  return TIMESTAMP_READ_EXEMPTIONS.filter((entry) => {
    const abs = path.join(root, entry.file);
    return existsSync(abs) && readFileSync(abs, "utf8").includes('"recordedAt"');
  });
}

function scan(overrides: Readonly<Record<string, string>> = {}): readonly Finding[] {
  const root = writeTree({ ...CLEAN_TREE, ...overrides });
  return runImportBoundarySensor({ root, protectedClasses: registryFor(root), timestampReadExemptions: exemptionsFor(root) }).findings;
}

function rules(findings: readonly Finding[]): SensorRule[] {
  return findings.map((f) => f.rule);
}

/** Every falsification asserts red here and green on the untouched fixture. */
function expectFalsified(rule: SensorRule, overrides: Readonly<Record<string, string>>, file: string): readonly Finding[] {
  const findings = scan(overrides);
  expect(rules(findings), `expected ${rule}, got ${JSON.stringify(findings, null, 2)}`).toContain(rule);
  expect(findings.some((f) => f.rule === rule && f.file === file)).toBe(true);
  expect(findings.every((f) => f.line > 0)).toBe(true);
  return findings;
}

// ── The tree this repo actually has ────────────────────────────────────────

describe("the real tree", () => {
  const root = repoRootFromHere();

  it("is clean", () => {
    const result = runImportBoundarySensor({ root });
    expect(result.findings, `\n${JSON.stringify(result.findings, null, 2)}`).toEqual([]);
  });

  it("has no vacuous scan root", () => {
    const result = runImportBoundarySensor({ root });
    expect(Object.keys(result.scanRootFileCounts).sort()).toEqual([...SCAN_ROOTS].sort());
    for (const [scanRoot, count] of Object.entries(result.scanRootFileCounts)) {
      expect(count, `scan root ${scanRoot} is empty`).toBeGreaterThan(0);
    }
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it("registers every protected class at the status the filesystem actually shows", () => {
    // A later unit that creates one of these files must promote it to
    // "present" in the same change, or this assertion (and the sensor) go red.
    for (const entry of PROTECTED_CLASSES) {
      const exists = existsSync(path.join(root, entry.path));
      expect(exists, `${entry.id} (${entry.path}) status=${entry.status} exists=${exists}`).toBe(entry.status === "present");
    }
  });

  it("registers a protected class for every rule the plan names", () => {
    const byRule = { d1: 0, d2: 0, e: 0 };
    for (const entry of PROTECTED_CLASSES) for (const rule of entry.rules) byRule[rule] += 1;
    expect(byRule.d1).toBeGreaterThan(0);
    expect(byRule.d2).toBeGreaterThan(0);
    expect(byRule.e).toBeGreaterThan(0);
    expect(PROTECTED_CLASSES.map((c) => c.id)).toEqual([...new Set(PROTECTED_CLASSES.map((c) => c.id))]);
  });
});

// ── The clean fixture ──────────────────────────────────────────────────────

describe("the clean fixture", () => {
  it("is green with every protected class present and enforced", () => {
    const root = writeTree(CLEAN_TREE);
    const registry = registryFor(root);
    expect(registry.every((entry) => entry.status === "present")).toBe(true);
    const result = runImportBoundarySensor({ root, protectedClasses: registry });
    expect(result.findings, `\n${JSON.stringify(result.findings, null, 2)}`).toEqual([]);
  });

  it("enforces the coordination class's d1 allowlist — a peer-unit import is a violation", () => {
    // The allowlist is a policy claim ("it imports no peer unit ... so a remote
    // message can reach no decision module by riding an import edge"), and a
    // policy claim with no falsification row is a comment. Round 3 planted two
    // widenings of this entry and neither turned a row red; these are the rows
    // that now go red.
    const findings = expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/coordination/reconcile.ts":
          `import { messageOk } from "./message.ts";\n` +
          `import { policyDigestOf } from "../policy/disposable.ts";\n` +
          `export const reconcile = (v: string): boolean => messageOk(policyDigestOf(v));\n`,
      },
      "packages/kernel/src/coordination/reconcile.ts",
    );
    expect(findings.some((finding) => finding.message.includes("policy/disposable.ts"))).toBe(true);
  });

  it("enforces d1 purity in the coordination class — the fs family is a violation there too", () => {
    expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/coordination/reconcile.ts":
          `import { readFileSync } from "node:fs";\n` +
          `export const reconcile = (p: string): number => readFileSync(p).length;\n`,
      },
      "packages/kernel/src/coordination/reconcile.ts",
    );
  });

  it("enforces the GEN-5 time ban in the coordination class", () => {
    expectFalsified(
      "e-time-ban",
      {
        "packages/kernel/src/coordination/reconcile.ts":
          `export const reconcile = (entry: { recordedAt: string }): string => entry.recordedAt;\n`,
      },
      "packages/kernel/src/coordination/reconcile.ts",
    );
  });

  it("keeps a legal in-function process.env read green", () => {
    expect(rules(scan())).not.toContain("b-import-time-env");
    expect(CLEAN_TREE["packages/cli/src/index.ts"]).toContain("process.env");
  });

  it("keeps `import type` from the fs family green in a d1-pure module", () => {
    const findings = scan({
      "packages/kernel/src/evaluator.ts": `import type { Stats } from "node:fs";\nexport const size = (s: Stats): number => s.size;\n`,
    });
    expect(findings).toEqual([]);
  });

  it("keeps a validator sibling import green", () => {
    expect(rules(scan())).not.toContain("d1-kernel-purity");
    expect(CLEAN_TREE["packages/kernel/src/validator/envelope.ts"]).toContain("./codes.ts");
  });
});

// ── Rule a — kernel boundary ───────────────────────────────────────────────

describe("rule a — kernel boundary", () => {
  it("rejects a kernel import of the cli package", () => {
    const findings = expectFalsified(
      "a-kernel-boundary",
      { "packages/kernel/src/records.ts": `import { render } from "@agent-delivery-harness/cli";\nexport const publish = (): string => render();\n` },
      "packages/kernel/src/records.ts",
    );
    expect(findings[0]?.message).toContain("cli");
  });

  it("rejects a relative kernel import that reaches into packages/action", () => {
    expectFalsified(
      "a-kernel-boundary",
      { "packages/kernel/src/records.ts": `import { run } from "../../action/src/main.ts";\nexport const publish = (): string => run("");\n` },
      "packages/kernel/src/records.ts",
    );
  });

  it("rejects a kernel import of harness.config", () => {
    const findings = expectFalsified(
      "a-kernel-boundary",
      { "packages/kernel/src/config.ts": `import { config } from "../../../harness.config.ts";\nexport const defineHarnessConfig = (): unknown => config;\n` },
      "packages/kernel/src/config.ts",
    );
    expect(findings[0]?.message).toContain("explicit parameter");
  });

  it("still catches the boundary inside a kernel test file", () => {
    expectFalsified(
      "a-kernel-boundary",
      { "packages/kernel/src/records.test.ts": `import { render } from "@agent-delivery-harness/mcp";\nexport const t = render;\n` },
      "packages/kernel/src/records.test.ts",
    );
  });
});

// ── Rule b — import-time env ───────────────────────────────────────────────

describe("rule b — import-time process.env", () => {
  it("rejects a direct top-level read", () => {
    expectFalsified(
      "b-import-time-env",
      { "packages/cli/src/index.ts": `export const LEVEL = process.env["DELIVERY_HARNESS_LOG"];\n` },
      "packages/cli/src/index.ts",
    );
  });

  it("rejects an aliased top-level read", () => {
    const findings = expectFalsified(
      "b-import-time-env",
      { "packages/cli/src/index.ts": `const p = process;\nexport const LEVEL = p.env["DELIVERY_HARNESS_LOG"];\n` },
      "packages/cli/src/index.ts",
    );
    expect(findings[0]?.line).toBe(2);
  });

  it("rejects a top-level alias of process.env itself", () => {
    expectFalsified("b-import-time-env", { "packages/mcp/src/index.ts": `const e = process.env;\nexport const LEVEL = (): unknown => e;\n` }, "packages/mcp/src/index.ts");
  });

  it("rejects destructuring env off process at import time", () => {
    expectFalsified("b-import-time-env", { "packages/mcp/src/index.ts": `const { env } = process;\nexport const LEVEL = (): unknown => env;\n` }, "packages/mcp/src/index.ts");
  });

  it("rejects importing env from node:process", () => {
    expectFalsified("b-import-time-env", { "packages/mcp/src/index.ts": `import { env } from "node:process";\nexport const LEVEL = (): unknown => env;\n` }, "packages/mcp/src/index.ts");
  });

  it("rejects a globalThis-routed read", () => {
    expectFalsified("b-import-time-env", { "packages/mcp/src/index.ts": `export const LEVEL = globalThis.process.env["X"];\n` }, "packages/mcp/src/index.ts");
  });

  it("reports an unresolvable dynamic construct as a finding rather than skipping it", () => {
    const findings = expectFalsified(
      "b-import-time-env",
      {
        "packages/cli/src/index.ts": `const p = process;\nconst key = "en" + "v";\nexport const LEVEL = (p as unknown as Record<string, Record<string, string>>)[key];\n`,
      },
      "packages/cli/src/index.ts",
    );
    expect(findings.some((f) => f.message.includes("cannot resolve"))).toBe(true);
  });

  it("does not misread a non-env process member", () => {
    const findings = scan({ "packages/cli/src/index.ts": `export const ARGS = process.argv.slice(2);\n` });
    expect(rules(findings)).not.toContain("b-import-time-env");
  });

  it("rejects a nested destructuring of env off process at import time", () => {
    expectFalsified(
      "b-import-time-env",
      { "packages/mcp/src/index.ts": `const { env: { CI } } = process;\nexport const LEVEL = (): unknown => CI;\n` },
      "packages/mcp/src/index.ts",
    );
  });

  it("rejects a read through a rest binding of process at import time", () => {
    expectFalsified(
      "b-import-time-env",
      { "packages/mcp/src/index.ts": `const { ...proc } = process;\nexport const LEVEL = proc.env["X"];\n` },
      "packages/mcp/src/index.ts",
    );
  });

  it("keeps the same nested destructuring green inside a function body", () => {
    const findings = scan({
      "packages/mcp/src/index.ts": `export const level = (): unknown => {\n  const { env: { CI } } = process;\n  return CI;\n};\n`,
    });
    expect(rules(findings)).not.toContain("b-import-time-env");
  });

  it("keeps the same rest binding green inside a function body", () => {
    const findings = scan({
      "packages/mcp/src/index.ts": `export const level = (): unknown => {\n  const { ...proc } = process;\n  return proc.env["X"];\n};\n`,
    });
    expect(rules(findings)).not.toContain("b-import-time-env");
  });
});

// ── Rule c — Bun API ───────────────────────────────────────────────────────

describe("rule c — Bun API", () => {
  it("rejects Bun.spawn", () => {
    const findings = expectFalsified(
      "c-bun-api",
      { "packages/cli/src/index.ts": `export const run = (): unknown => Bun.spawn(["git", "status"]);\n` },
      "packages/cli/src/index.ts",
    );
    expect(findings[0]?.message).toContain("Bun.spawn");
  });

  it("rejects a computed Bun member access", () => {
    expectFalsified("c-bun-api", { "packages/cli/src/index.ts": `const k = "file";\nexport const f = (): unknown => (Bun as never)[k];\n` }, "packages/cli/src/index.ts");
  });

  it("rejects Bun reached through globalThis", () => {
    expectFalsified("c-bun-api", { "packages/mcp/src/index.ts": `export const w = (): unknown => globalThis.Bun.write("x", "y");\n` }, "packages/mcp/src/index.ts");
  });

  it("rejects Bun in a fixture config", () => {
    // The fixture configs are real source that no package `src` contains. Left
    // unscanned they would be the one place in the repo a banned runtime API
    // could sit unnoticed.
    expectFalsified(
      "c-bun-api",
      { "packages/conformance/fixtures/example-config.ts": `export const gateId = (): unknown => Bun.file("harness.config.ts");\n` },
      "packages/conformance/fixtures/example-config.ts",
    );
  });

  it("rejects Bun in the consumer config at the repo root", () => {
    expectFalsified(
      "c-bun-api",
      { "harness.config.ts": `export default { gateId: String(Bun.env["GATE"]) };\n` },
      "harness.config.ts",
    );
  });

  it("rejects Bun usage inside a test file too", () => {
    expectFalsified("c-bun-api", { "packages/mcp/src/server.test.ts": `export const t = (): unknown => Bun.file("x");\n` }, "packages/mcp/src/server.test.ts");
  });
});

// ── Rule d1 — true purity ──────────────────────────────────────────────────

describe("rule d1 — true purity", () => {
  it("rejects node:fs/promises in evaluator.ts", () => {
    expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/evaluator.ts": `import { readFile } from "node:fs/promises";\nexport const evaluate = (p: string): Promise<Buffer> => readFile(p);\n` },
      "packages/kernel/src/evaluator.ts",
    );
  });

  it("rejects the fs family in context.ts", () => {
    expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/context.ts": `import { hostname } from "node:os";\nexport const classify = (): string => hostname();\n` },
      "packages/kernel/src/context.ts",
    );
  });

  it("rejects the fs family inside validator/", () => {
    expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/validator/envelope.ts": `import { createRequire } from "node:module";\nexport const validate = (): unknown => createRequire(import.meta.url);\n` },
      "packages/kernel/src/validator/envelope.ts",
    );
  });

  it("rejects a validator import of identity.ts — an fs-bearing kernel module outside the allowlist", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/validator/envelope.ts": `import { lsTree } from "../identity.ts";\nexport const validate = (): string => lsTree();\n` },
      "packages/kernel/src/validator/envelope.ts",
    );
    expect(findings[0]?.message).toContain("identity.ts");
  });

  it("gives evaluator.ts no sibling allowance at the kernel root", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/evaluator.ts": `import { publish } from "./records.ts";\nexport const evaluate = (): void => publish("a", "b");\n` },
      "packages/kernel/src/evaluator.ts",
    );
    expect(findings[0]?.message).toContain("no sibling allowance");
  });

  it("allows config's installed resource grammar while retaining its transitive purity boundary", () => {
    const config = `import { normalizeInstalledDataResourceRequests } from "./installed-data-resources.ts";\nexport const defineHarnessConfig = (): unknown => normalizeInstalledDataResourceRequests([]);\n`;
    const resource = `import { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-limits.ts";\nexport const normalizeInstalledDataResourceRequests = (v: unknown): unknown => [v, MAX_PORTABLE_ARTIFACT_BYTES];\n`;
    const files = {"packages/kernel/src/config.ts": config,"packages/kernel/src/installed-data-resources.ts":resource,"packages/kernel/src/portable-limits.ts": "export const MAX_PORTABLE_ARTIFACT_BYTES = 1;\n"};
    expect(rules(scan(files))).not.toContain("d1-kernel-purity");
    for (const file of ["installed-data-resources.ts","portable-limits.ts"]) {
      const findings=scan({...files,[`packages/kernel/src/${file}`]:`import { readFileSync } from "node:fs";\nexport const hidden = (): unknown => readFileSync("host");\n`});
      expect(findings.some(f=>f.rule==="d1-kernel-purity" && f.file.endsWith(file))).toBe(true);
    }
  });

  it("gives context.ts no sibling allowance at the kernel root", () => {
    expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/context.ts": `import { read } from "./artifacts.ts";\nexport const classify = (): string => read("x");\n` },
      "packages/kernel/src/context.ts",
    );
  });

  it("keeps a spine sibling import and the canonicalizer green", () => {
    expect(rules(scan())).not.toContain("d1-kernel-purity");
    expect(CLEAN_TREE["packages/kernel/src/spine/journal.ts"]).toContain("./vocabulary.ts");
    expect(CLEAN_TREE["packages/kernel/src/spine/journal.ts"]).toContain("../canonical.ts");
  });

  it("rejects a spine import of the evidence validator — the spine cannot reach the evidence kernel", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/spine/journal.ts": `import { CODES } from "../validator/codes.ts";\nexport const describeEntry = (): string => CODES[0];\n`,
      },
      "packages/kernel/src/spine/journal.ts",
    );
    expect(findings[0]?.message).toContain("validator/codes.ts");
  });

  it("rejects a spine import of the kernel config — the evidence kernel's policy surface is not the spine's", () => {
    expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/spine/journal.ts": `import { defineHarnessConfig } from "../config.ts";\nexport const describeEntry = (): unknown => defineHarnessConfig({});\n`,
      },
      "packages/kernel/src/spine/journal.ts",
    );
  });

  it("rejects an evidence-validator import of the spine — the evidence kernel cannot reach the spine either", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/validator/envelope.ts": `import { JOURNALS } from "../spine/vocabulary.ts";\nexport const validate = (): string => JOURNALS[0];\n`,
      },
      "packages/kernel/src/validator/envelope.ts",
    );
    expect(findings[0]?.message).toContain("spine/vocabulary.ts");
  });

  it("rejects the fs family inside the spine", () => {
    expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/spine/journal.ts": `import { readFileSync } from "node:fs";\nexport const describeEntry = (p: string): string => readFileSync(p, "utf8");\n`,
      },
      "packages/kernel/src/spine/journal.ts",
    );
  });

  it("rejects the process-spawning module inside the binding — the binding can never launch an agent child", () => {
    expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/binding/host-admission.ts": `import { spawn } from "node:child_process";\nexport const launch = (): unknown => spawn("claude", ["--print"]);\n`,
      },
      "packages/kernel/src/binding/host-admission.ts",
    );
  });

  it("rejects a binding import off its subdirectory-shaped allowlist — spine/grant.ts is in, the evidence validator is not", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/binding/host-admission.ts": `import { CODES } from "../validator/codes.ts";\nexport const admissible = (): string => CODES[0];\n`,
      },
      "packages/kernel/src/binding/host-admission.ts",
    );
    expect(findings[0]?.message).toContain("validator/codes.ts");
  });

  it("rejects the fs family in the substrate's trust-store module", () => {
    expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/substrate/trust-store.ts": `import { readFileSync } from "node:fs";\nexport const checkNoDowngrade = (p: string): string => readFileSync(p, "utf8");\n`,
      },
      "packages/kernel/src/substrate/trust-store.ts",
    );
  });

  it("rejects a substrate-manifest import off its file-class allowlist — the evidence evaluator is not on it", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      {
        "packages/kernel/src/substrate/manifest.ts": `import { evaluate } from "../evaluator.ts";\nexport const manifestDigestOf = (): unknown => evaluate({ digest: "d" }, {});\n`,
      },
      "packages/kernel/src/substrate/manifest.ts",
    );
    expect(findings[0]?.message).toContain("evaluator.ts");
  });

  it("rejects a relative import that resolves to nothing", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/evaluator.ts": `import { nope } from "./does-not-exist.ts";\nexport const evaluate = (): unknown => nope;\n` },
      "packages/kernel/src/evaluator.ts",
    );
    expect(findings[0]?.message).toContain("does not resolve");
  });

  it("rejects the kernel barrel specifier, which no allowlist entry names", () => {
    const findings = expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/evaluator.ts": `import { sha256 } from "@agent-delivery-harness/kernel";\nexport const evaluate = (s: string): string => sha256(s);\n` },
      "packages/kernel/src/evaluator.ts",
    );
    expect(findings[0]?.message).toContain("kernel barrel");
  });

  it("rejects a subpath of the kernel barrel too", () => {
    expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/context.ts": `import { lsTree } from "@agent-delivery-harness/kernel/identity";\nexport const classify = (): string => lsTree();\n` },
      "packages/kernel/src/context.ts",
    );
  });

  it("rejects an ambient process import in a d1-pure module", () => {
    expectFalsified(
      "d1-kernel-purity",
      { "packages/kernel/src/context.ts": `import { argv } from "node:process";\nexport const classify = (): string => argv[0] ?? "";\n` },
      "packages/kernel/src/context.ts",
    );
  });

  it("gives a non-validator kernel subdirectory no sibling allowance", () => {
    const root = writeTree({
      ...CLEAN_TREE,
      "packages/kernel/src/gate/helpers.ts": `export const helper = (s: string): string => s;\n`,
      "packages/kernel/src/gate/decide.ts": `import { helper } from "./helpers.ts";\nexport const decide = (s: string): string => helper(s);\n`,
    });
    const registry: ProtectedClass[] = [
      ...registryFor(root),
      { id: "kernel-gate", path: "packages/kernel/src/gate", kind: "dir", rules: ["d1"], status: "present" },
    ];
    const findings = runImportBoundarySensor({ root, protectedClasses: registry }).findings;
    expect(findings.some((f) => f.rule === "d1-kernel-purity" && f.file === "packages/kernel/src/gate/decide.ts")).toBe(true);
    expect(findings.find((f) => f.file === "packages/kernel/src/gate/decide.ts")?.message).toContain("no sibling allowance");
  });

  it("leaves a validator test file outside the d1 scan", () => {
    const findings = scan({
      "packages/kernel/src/validator/envelope.test.ts": `import { readFileSync } from "node:fs";\nexport const fixture = (p: string): string => readFileSync(p, "utf8");\n`,
    });
    expect(rules(findings)).not.toContain("d1-kernel-purity");
  });

  it("enforces nothing while the class is pending", () => {
    const withoutEvaluator = { ...CLEAN_TREE };
    delete (withoutEvaluator as Record<string, string>)["packages/kernel/src/evaluator.ts"];
    delete (withoutEvaluator as Record<string, string>)["packages/kernel/src/admission.ts"];
    const root = writeTree(withoutEvaluator);
    const result = runImportBoundarySensor({ root, protectedClasses: registryFor(root) });
    expect(result.findings).toEqual([]);
  });
});

// ── Rule d2 — no ad-hoc fs ─────────────────────────────────────────────────

describe("rule d2 — no ad-hoc fs", () => {
  it("rejects a bare `fs` import in delivery-record.ts", () => {
    const findings = expectFalsified(
      "d2-no-adhoc-fs",
      { "packages/kernel/src/delivery-record.ts": `import { writeFileSync } from "fs";\nexport const produce = (p: string): void => writeFileSync(p, "");\n` },
      "packages/kernel/src/delivery-record.ts",
    );
    expect(findings[0]?.message).toContain("artifacts.ts port");
  });

  it("rejects child_process in recorder.ts", () => {
    expectFalsified(
      "d2-no-adhoc-fs",
      { "packages/kernel/src/recorder.ts": `import { execFileSync } from "node:child_process";\nexport const submit = (): unknown => execFileSync("git", []);\n` },
      "packages/kernel/src/recorder.ts",
    );
  });

  it("rejects node:fs in admission.ts", () => {
    expectFalsified(
      "d2-no-adhoc-fs",
      { "packages/kernel/src/admission.ts": `import { readdirSync } from "node:fs";\nexport const admit = (p: string): string[] => readdirSync(p);\n` },
      "packages/kernel/src/admission.ts",
    );
  });

  it("still allows d2 modules to import fs-bearing kernel modules", () => {
    const findings = scan({
      "packages/kernel/src/recorder.ts": `import { publish } from "./records.ts";\nexport const submit = (): void => publish("a", "b");\n`,
    });
    expect(findings).toEqual([]);
  });
});

// ── Rule e — GEN-5 time ban ────────────────────────────────────────────────

describe("rule e — GEN-5 time ban", () => {
  it("rejects Date.now() in a validator module", () => {
    const findings = expectFalsified(
      "e-time-ban",
      { "packages/kernel/src/validator/envelope.ts": `export const validate = (): number => Date.now();\n` },
      "packages/kernel/src/validator/envelope.ts",
    );
    expect(findings[0]?.message).toContain("GEN-5");
  });

  it("rejects new Date() in the action entry point", () => {
    expectFalsified("e-time-ban", { "packages/action/src/main.ts": `export const run = (): Date => new Date();\n` }, "packages/action/src/main.ts");
  });

  it("rejects Date.now() in the action entry point", () => {
    expectFalsified("e-time-ban", { "packages/action/src/main.ts": `export const run = (): number => Date.now();\n` }, "packages/action/src/main.ts");
  });

  it("rejects Date.now() in the substrate installer — install decisions never consult a clock", () => {
    expectFalsified(
      "e-time-ban",
      { "packages/kernel/src/substrate/installer.ts": `export const install = (): number => Date.now();\n` },
      "packages/kernel/src/substrate/installer.ts",
    );
  });

  it("rejects a clock read in the fs-bearing host entry guard without classifying it as d1 or d2", () => {
    const findings = expectFalsified(
      "e-time-ban",
      {
        "packages/kernel/src/host/entry.ts":
          `import { realpathSync } from "node:fs";\n` +
          `export const entry = (p: string): string => realpathSync(p) + Date.now();\n`,
      },
      "packages/kernel/src/host/entry.ts",
    );
    expect(rules(findings)).not.toContain("d1-kernel-purity");
    expect(rules(findings)).not.toContain("d2-no-adhoc-fs");
  });

  it("rejects a `.recordedAt` member read in a decision path", () => {
    const findings = expectFalsified(
      "e-time-ban",
      { "packages/kernel/src/admission.ts": `export const admit = (m: { recordedAt: string }): string => m.recordedAt;\n` },
      "packages/kernel/src/admission.ts",
    );
    expect(findings[0]?.message).toContain("recordedAt");
  });

  it('rejects a `["recordedAt"]` element read in a decision path', () => {
    expectFalsified(
      "e-time-ban",
      { "packages/kernel/src/evaluator.ts": `export const evaluate = (m: Record<string, string>): string => m["recordedAt"];\n` },
      "packages/kernel/src/evaluator.ts",
    );
  });

  it("rejects a destructured `recordedAt` read in a decision path", () => {
    expectFalsified(
      "e-time-ban",
      { "packages/kernel/src/admission.ts": `export const admit = (m: { recordedAt: string }): string => { const { recordedAt } = m; return recordedAt; };\n` },
      "packages/kernel/src/admission.ts",
    );
  });

  it("rejects a renamed destructured `recordedAt` read in a decision path", () => {
    expectFalsified(
      "e-time-ban",
      { "packages/kernel/src/admission.ts": `export const admit = (m: { recordedAt: string }): string => { const { recordedAt: at } = m; return at; };\n` },
      "packages/kernel/src/admission.ts",
    );
  });

  it("rejects a `\"recordedAt\"` literal handed to a member reader in a decision path", () => {
    // The evasion an indirect reader opens: every member read in validator/
    // goes through a helper, so none of the three syntactic forms above appears
    // there at all. Without this form the recordedAt half of the rule would be
    // unfalsifiable over that whole class.
    const findings = expectFalsified(
      "e-time-ban",
      {
        "packages/kernel/src/validator/envelope.ts":
          `const read = (o: Record<string, unknown>, k: string): unknown => o[k];\n` +
          `export const validate = (m: Record<string, unknown>): unknown => read(m, "recordedAt");\n` +
          `export function checkTimestamp(m: Record<string, unknown>): boolean {\n  return typeof read(m, "recordedAt") === "string";\n}\n`,
      },
      "packages/kernel/src/validator/envelope.ts",
    );
    expect(findings.some((f) => f.rule === "e-time-ban" && f.message.includes("TIMESTAMP_READ_EXEMPTIONS"))).toBe(true);
  });

  it("leaves the registered structural read alone, and goes red the moment its registration is dropped", () => {
    // Registration is load-bearing in both directions: the site is green only
    // because it is registered, and the registry is checked against the site.
    expect(rules(scan())).not.toContain("e-time-ban");

    const root = writeTree(CLEAN_TREE);
    const unregistered = runImportBoundarySensor({ root, protectedClasses: registryFor(root), timestampReadExemptions: [] }).findings;
    expect(rules(unregistered)).toContain("e-time-ban");
  });

  it("reports a registration that exempts nothing, and one that would cover two reads", () => {
    const withoutSite = writeTree({
      ...CLEAN_TREE,
      "packages/kernel/src/validator/envelope.ts": `export const validate = (m: Record<string, unknown>): unknown => m["id"];\n`,
    });
    const orphaned = runImportBoundarySensor({
      root: withoutSite,
      protectedClasses: registryFor(withoutSite),
      timestampReadExemptions: TIMESTAMP_READ_EXEMPTIONS,
    }).findings;
    expect(orphaned.some((f) => f.rule === "anti-vacuity" && f.message.includes("exempts nothing"))).toBe(true);

    const twice = writeTree({
      ...CLEAN_TREE,
      "packages/kernel/src/validator/envelope.ts":
        `const read = (o: Record<string, unknown>, k: string): unknown => o[k];\n` +
        `export function checkTimestamp(m: Record<string, unknown>): boolean {\n` +
        `  return typeof read(m, "recordedAt") === "string" && read(m, "recordedAt") !== "";\n}\n`,
    });
    const twoReads = runImportBoundarySensor({
      root: twice,
      protectedClasses: registryFor(twice),
      timestampReadExemptions: TIMESTAMP_READ_EXEMPTIONS,
    }).findings;
    expect(twoReads.some((f) => f.rule === "anti-vacuity" && f.message.includes("exactly one"))).toBe(true);
  });

  it("leaves a bare `recordedAt` parameter in a decision path alone", () => {
    expect(rules(scan())).not.toContain("e-time-ban");
    expect(CLEAN_TREE["packages/action/src/main.ts"]).toContain("recordedAt");
  });

  it("rejects a clock read in each remaining protected decision path", () => {
    for (const file of ["packages/kernel/src/recorder.ts", "packages/kernel/src/evaluator.ts", "packages/kernel/src/admission.ts", "packages/kernel/src/delivery-record.ts"]) {
      expectFalsified("e-time-ban", { [file]: `export const stamp = (): number => Date.now();\n` }, file);
    }
  });

  it("leaves a clock read outside a protected decision path alone", () => {
    const findings = scan({ "packages/kernel/src/records.ts": `export const stamp = (): number => Date.now();\n` });
    expect(rules(findings)).not.toContain("e-time-ban");
  });
});

// ── Anti-vacuity ───────────────────────────────────────────────────────────

describe("anti-vacuity", () => {
  it("reports a scan root that does not exist", () => {
    const root = writeTree(CLEAN_TREE);
    const result = runImportBoundarySensor({ root, scanRoots: [...SCAN_ROOTS, "packages/ghost/src"], protectedClasses: registryFor(root) });
    expect(result.findings.some((f) => f.rule === "anti-vacuity" && f.file === "packages/ghost/src" && f.message.includes("does not exist"))).toBe(true);
  });

  it("reports a scan root with no source files", () => {
    const root = writeTree({ ...CLEAN_TREE, "packages/empty/src/notes.md": "no source here\n" });
    const result = runImportBoundarySensor({ root, scanRoots: [...SCAN_ROOTS, "packages/empty/src"], protectedClasses: registryFor(root) });
    expect(result.findings.some((f) => f.rule === "anti-vacuity" && f.file === "packages/empty/src" && f.message.includes("no TypeScript source files"))).toBe(true);
  });

  it("reports a present dir class that holds only test files", () => {
    const testsOnly = Object.fromEntries(Object.entries(CLEAN_TREE).filter(([rel]) => !rel.startsWith("packages/kernel/src/validator/")));
    const root = writeTree({
      ...testsOnly,
      "packages/kernel/src/validator/envelope.test.ts": `export const t = true;\n`,
    });
    const result = runImportBoundarySensor({ root, protectedClasses: registryFor(root) });
    expect(
      result.findings.some(
        (f) => f.rule === "anti-vacuity" && f.file === "packages/kernel/src/validator" && f.message.includes("no non-test TypeScript source files"),
      ),
    ).toBe(true);
  });

  it("reports a protected class registered present that has vanished", () => {
    const withoutValidator = Object.fromEntries(Object.entries(CLEAN_TREE).filter(([rel]) => !rel.startsWith("packages/kernel/src/validator/")));
    const root = writeTree(withoutValidator);
    const registry = registryFor(root).map((entry) => (entry.id === "kernel-validator" ? { ...entry, status: "present" as const } : entry));
    const result = runImportBoundarySensor({ root, protectedClasses: registry });
    expect(result.findings.some((f) => f.rule === "anti-vacuity" && f.message.includes("registered as present but does not exist"))).toBe(true);
  });

  it("reports a protected class that landed while still registered pending", () => {
    const root = writeTree(CLEAN_TREE);
    const registry = registryFor(root).map((entry) => (entry.id === "kernel-evaluator" ? { ...entry, status: "pending" as const } : entry));
    const result = runImportBoundarySensor({ root, protectedClasses: registry });
    const finding = result.findings.find((f) => f.rule === "anti-vacuity");
    expect(finding?.message).toContain("still registered as pending");
    expect(finding?.file).toBe("packages/kernel/src/evaluator.ts");
  });
});

/**
 * The sensor's entry guard, exercised the way `npm run sensor` exercises it: a
 * spawned process launched by absolute path — here through a symlink, the shape
 * a symlinked checkout (or macOS `/tmp`) produces. The guard's exit-code floor
 * sits inside the guard itself, so an under-match is invisible in-process: the
 * script just exits 0 having scanned nothing, and every sensor leg goes green
 * over an unscanned tree. This spawn is the tripwire.
 */
describe("the entry guard", () => {
  it("scans and reports when launched through a symlinked path", async () => {
    const { spawn } = await import("node:child_process");
    const { symlink, mkdtemp } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-sensor-entry-"));
    const repoRoot = repoRootFromHere();
    const linkedRepo = path.join(dir, "linked-repo");
    await symlink(repoRoot, linkedRepo, "dir");
    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join(linkedRepo, "scripts/check-import-boundaries.ts")],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      onTestFinished(() => {
        child.kill("SIGKILL");
      });
      child.on("error", () => {});
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8");
      expect(exitCode, diagnostics).toBe(0);
      // Empty output with exit 0 is the exact under-match signature: the guard
      // declined the entry and the sensor scanned nothing.
      expect(output, `entry guard skipped the scan; stderr: ${diagnostics}`).toContain("check-import-boundaries:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});


describe("installed data applicability purity",()=>{
 it("allows only the pure applicability evidence edge from validators",()=>{
  expect(scan({"packages/kernel/src/installed-data-evidence.ts":"export const binding = 1;\n","packages/kernel/src/validator/envelope.ts":"import { binding } from '../installed-data-evidence.ts'; export const validate = () => binding;\n"})).toEqual([]);
 });
 it("refuses ambient filesystem in the applicability evidence helper",()=>{
  expectFalsified("d1-kernel-purity",{"packages/kernel/src/installed-data-evidence.ts":"import { readFileSync } from 'node:fs'; export const binding = readFileSync('data');\n"},"packages/kernel/src/installed-data-evidence.ts");
 });
 it("refuses executable source capture imports from applicability evidence or validators",()=>{
  for(const file of ["packages/kernel/src/installed-data-evidence.ts","packages/kernel/src/validator/envelope.ts"]){
   const module=file.includes('/validator/')?'../installed-data-source.ts':'./installed-data-source.ts';
   expectFalsified("d1-kernel-purity",{[file]:`import { captureInstalledDataBinding } from '${module}'; export const binding = captureInstalledDataBinding;\n`},file);
  }
 });
});
