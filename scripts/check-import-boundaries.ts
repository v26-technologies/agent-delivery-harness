/**
 * Static import-boundary, env, runtime, purity, and time sensor.
 *
 * Six independently falsifiable rules, all parsed with the TypeScript compiler
 * API (never regex over source text):
 *
 *   a  — kernel modules import nothing from `cli`/`mcp`/`action` and never
 *        import `harness.config`.
 *   b  — no module reads `process.env` while it is being evaluated (import
 *        time). In-function reads are legal. Aliased top-level reads
 *        (`const p = process; p.env.X`) are resolved and rejected. Dynamic
 *        constructs the resolver cannot decide are reported as findings —
 *        never silently skipped.
 *   c  — no `Bun.*` API anywhere. Bun is a supported runtime via the CI matrix,
 *        never a required one.
 *   d1 — true purity. The d1 protected classes (`validator/`, `evaluator.ts`,
 *        `context.ts`) import none of the fs/process/os specifier family and,
 *        within the kernel, import only the enumerated allowlist (plus, for
 *        files in a kernel subdirectory, siblings of that subdirectory).
 *   d2 — no ad-hoc fs. `recorder.ts`, `admission.ts`, `delivery-record.ts` may
 *        not import the fs/process/os family directly; their filesystem work
 *        goes through the `artifacts.ts` fs port (not yet created).
 *   e  — GEN-5 time ban. No `Date.now()`, `new Date()`, or `recordedAt` member
 *        read in the decision paths the spec forbids consulting a clock from.
 *        Four forms are rejected: `x.recordedAt`, `x["recordedAt"]`, a
 *        destructured `recordedAt`, and the member name handed to a reader as a
 *        call argument (`read(m, "recordedAt")`) — the last because a module
 *        that reads every member through one helper never writes any of the
 *        first three, which would leave the rule unfalsifiable exactly where it
 *        matters most. A locally-scoped binding merely named `recordedAt` is
 *        legal; only reading the member is a finding. The one structural read
 *        the grammar needs is registered in TIMESTAMP_READ_EXEMPTIONS, site by
 *        site, and each registration is checked against the tree.
 *
 * `import type` is always legal — a type has no runtime edge. `*.test.ts` files
 * are outside the d1/d2/e scans (tests read fixtures from disk and stub clocks);
 * rules a, b, and c apply to them.
 *
 * ANTI-VACUITY. Most protected files do not exist yet. Every scan root and every
 * protected class is registered below with an explicit status, and the registry
 * is checked against the filesystem on every run: a `present` entry that has
 * vanished and a `pending` entry that has appeared are both findings. A rename
 * or a newly landed unit therefore cannot silently drop coverage. Scan roots
 * must exist and yield at least one source file.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ── Registry ───────────────────────────────────────────────────────────────

export type SensorRule =
  | "a-kernel-boundary"
  | "b-import-time-env"
  | "c-bun-api"
  | "d1-kernel-purity"
  | "d2-no-adhoc-fs"
  | "e-time-ban"
  | "anti-vacuity";

export interface Finding {
  readonly rule: SensorRule;
  /** Repo-relative POSIX path, or the registry entry id for anti-vacuity findings. */
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export type ProtectedRule = "d1" | "d2" | "e";

export interface ProtectedClass {
  readonly id: string;
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly rules: readonly ProtectedRule[];
  /**
   * `pending` means "this unit has not landed yet". The sensor asserts the
   * status against the filesystem, so the unit that creates the file must
   * promote it to `present` in the same change.
   */
  readonly status: "present" | "pending";
  /**
   * For a d1 class: the kernel-root modules its members may import by name,
   * replacing D1_KERNEL_ALLOWLIST. This is how dependency DIRECTIONS are
   * enforced, not just purity: the contract spine's allowlist names only the
   * canonicalizer and digest modules, so the spine cannot reach the evidence
   * kernel (validator/, evaluator, config, blockers), while the evidence
   * kernel's default allowlist does not name the spine — the two stay
   * independent in both directions and meet only at the package barrel.
   */
  readonly d1Allowlist?: readonly string[];
  /** For a d1 dir class: whether members may import siblings inside the class. */
  readonly d1SiblingAllowance?: boolean;
}

/** The informational timestamp (§5.8) no decision path may read. */
const RECORDED_AT = "recordedAt";

/**
 * Sites permitted to name `recordedAt` as a call argument, one entry per site.
 *
 * A closed grammar has to know the member exists — the envelope requires it, and
 * a manifest without it is malformed — so a validator that never mentions the
 * name at all cannot enforce GEN-1 over it. That is a shape check, not a
 * decision: the value is tested for being a non-empty string and is never
 * compared, ordered, or otherwise consulted.
 *
 * This is deliberately a registry and not a suppression comment. An exemption
 * names a file and the function inside it, both are checked against the tree,
 * and each must cover exactly one read — so an exemption that stops matching is
 * a finding, and a second read cannot hide behind the first.
 */
export interface TimestampReadExemption {
  /** Repo-relative POSIX path. */
  readonly file: string;
  /** Enclosing function name, as written. */
  readonly fn: string;
  readonly reason: string;
}

export const TIMESTAMP_READ_EXEMPTIONS: readonly TimestampReadExemption[] = [
  {
    file: "packages/kernel/src/validator/envelope.ts",
    fn: "checkTimestamp",
    reason:
      "GEN-1/GEN-4 shape check: the member must be present and a non-empty string. The value is never read into a comparison, and GEN-5 bans decisions on it, not knowledge that it exists.",
  },
];

/**
 * Scanned for the always-on rules (a, b, c). Directories are walked; a single
 * file is scanned as itself, which is how the two pieces of repository source
 * that live outside any package `src` are covered — the fixture configs and the
 * consumer-owned config at the repo root. Source the sensor does not scan is
 * source the rules do not reach, and a config file is an unusually likely place
 * for an import-time environment read to be written.
 */
export const SCAN_ROOTS: readonly string[] = [
  "packages/kernel/src",
  "packages/conformance/src",
  "packages/conformance/fixtures",
  "packages/cli/src",
  "packages/mcp/src",
  "packages/action/src",
  "scripts",
  "harness.config.ts",
];

export const KERNEL_SRC = "packages/kernel/src";

/** The kernel's workspace specifier — its barrel, reachable without a relative path. */
export const KERNEL_PACKAGE = "@agent-delivery-harness/kernel";

export const PROTECTED_CLASSES: readonly ProtectedClass[] = [
  { id: "kernel-validator", path: "packages/kernel/src/validator", kind: "dir", rules: ["d1", "e"], status: "present", d1SiblingAllowance: true },
  // The managed-delivery contract spine: pure validators, the frozen
  // vocabulary, and the journal reducers. Its allowlist deliberately names
  // only the canonicalizer and digest modules — the evidence kernel and the
  // spine stay independent in both directions.
  {
    id: "kernel-spine",
    path: "packages/kernel/src/spine",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    d1Allowlist: ["canonical.ts", "digest.ts"],
    d1SiblingAllowance: true,
  },
  // The trusted host-control binding's admission decisions: pure by contract —
  // model-external means no I/O, no clock, and no process launch, and the fs
  // family ban (which includes child_process) is where the last one starts
  // being mechanical. Its allowlist names only the spine contracts it consumes.
  {
    id: "kernel-binding",
    path: "packages/kernel/src/binding",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    d1Allowlist: ["spine/grant.ts", "spine/grammar.ts"],
    d1SiblingAllowance: true,
  },
  // The local composition substrate. The manifest grammar and the trust-store
  // decisions are pure; the installer is the substrate's one filesystem
  // module (registered for the time ban — install, activation, and trust
  // decisions never consult a clock).
  {
    id: "substrate-manifest",
    path: "packages/kernel/src/substrate/manifest.ts",
    kind: "file",
    rules: ["d1", "e"],
    status: "present",
    d1Allowlist: ["canonical.ts", "digest.ts", "spine/composition.ts", "spine/grammar.ts"],
  },
  {
    id: "substrate-trust-store",
    path: "packages/kernel/src/substrate/trust-store.ts",
    kind: "file",
    rules: ["d1", "e"],
    status: "present",
    d1Allowlist: ["spine/composition.ts"],
  },
  {
    id: "substrate-installer",
    path: "packages/kernel/src/substrate/installer.ts",
    kind: "file",
    rules: ["e"],
    status: "present",
  },
  // The maintenance lane: update/rollback/trust-state decisions and the
  // assertion-freshness check consume a caller-observed instant, never a
  // clock. (The assertion SOURCE mints evaluation expiries with a real
  // clock — that is the provider observing when the operator authenticated,
  // not an admissibility decision, and it stays outside this class.)
  {
    id: "substrate-lifecycle",
    path: "packages/kernel/src/substrate/lifecycle.ts",
    kind: "file",
    rules: ["e"],
    status: "present",
  },
  {
    id: "substrate-maintenance-journal",
    path: "packages/kernel/src/substrate/maintenance-journal.ts",
    kind: "file",
    rules: ["e"],
    status: "present",
  },
  // The walking skeleton's V-slice modules — the final module boundaries the
  // later policy/checkpoint/workflow/host/evidence/finish-line/facade units
  // harden. Pure modules carry d1 allowlists naming exactly the spine and
  // digest edges they consume; the impure modules (checkpoint store, host
  // binding, facade) are registered for the time ban. `host/hook-main.ts` is
  // deliberately NOT time-banned: it is a process boundary (like the CLI
  // main) that stamps the ambient clock into the observation marker, while
  // every decision it takes is the pure admission module's.
  {
    id: "kernel-workflow",
    path: "packages/kernel/src/workflow",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    d1Allowlist: ["digest.ts", "spine/composition.ts"],
    d1SiblingAllowance: true,
  },
  {
    id: "kernel-policy",
    path: "packages/kernel/src/policy",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    // The policy compiler consumes the frozen spine shapes it emits
    // (snapshot, grants, capability result specs, finish-line vocabulary)
    // and the pure config loader whose output is its admission projection.
    d1Allowlist: [
      "digest.ts",
      "config.ts",
      "spine/grammar.ts",
      "spine/policy.ts",
      "spine/contract.ts",
      "spine/grant.ts",
      "spine/capability.ts",
      // The frozen external-action vocabulary the grant model names.
      "spine/finish-line.ts",
    ],
    d1SiblingAllowance: true,
  },
  {
    id: "kernel-evidence",
    path: "packages/kernel/src/evidence",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    // The waiver lane consumes the sensitive-approval assertion contract the
    // composition-lifecycle unit froze; it never re-authors an approval
    // primitive of its own.
    d1Allowlist: ["spine/grammar.ts", "spine/assertion.ts", "spine/vocabulary.ts"],
    d1SiblingAllowance: true,
  },
  {
    id: "kernel-coordination",
    path: "packages/kernel/src/coordination",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    // The coordination unit consumes two frozen spine contracts and authors
    // no primitive of its own: the member grammar its wire family is written
    // in, and the journal payload table that owns the mirror record's claim
    // vocabulary — imported rather than restated so the wire can never
    // express a claim the journal cannot record.
    //
    // It imports no peer unit. Everything it needs to know about local
    // authority, local evidence and the local fact epoch is passed in as
    // values and predicates, never imported, so a remote message can reach no
    // decision module by riding an import edge. d1 also keeps it away from
    // the fs/process/os family: a transport belongs to the adapter that binds
    // the port, never to the unit that decides what a message is worth.
    //
    // The third entry is the durable path's SECRET CORPUS, and it is here for
    // the same reason the claim vocabulary is: so the wire cannot admit what
    // the journal will refuse. `messageId` and `nonce` are authored by the
    // peer and reach the durable mirror payload, a spine id can be shaped like
    // a credential, and a structural member carrying one is rejected at the
    // append — by which point the reconciliation already owes an advancing
    // blocker. The corpus is a frozen list of patterns with no I/O and no
    // authority of its own; importing it restates nothing and lets this unit
    // refuse the message before anything is owed.
    d1Allowlist: ["spine/grammar.ts", "spine/journal.ts", "checkpoint/redaction.ts"],
    d1SiblingAllowance: true,
  },
  {
    id: "kernel-finish-line",
    path: "packages/kernel/src/finish-line",
    kind: "dir",
    rules: ["d1", "e"],
    status: "present",
    // The finish-line reducer consumes the frozen result grammar and the
    // spine's own "a contract cannot request beyond policy" rule; it authors
    // no authority model of its own. The external-actions unit consumes three
    // further FROZEN SPINE CONTRACTS for the same reason the waiver lane does:
    // the sensitive-approval assertion it must not re-author, the member
    // grammar its own post-action result is written in, and the action
    // outcome/verification vocabularies the journal already froze. It still
    // imports no peer unit — the policy module's authorization recheck is
    // passed to it as a function, never imported.
    d1Allowlist: [
      "digest.ts",
      "spine/finish-line.ts",
      "spine/contract.ts",
      "spine/grammar.ts",
      "spine/assertion.ts",
      "spine/journal.ts",
    ],
    d1SiblingAllowance: true,
  },
  { id: "kernel-checkpoint", path: "packages/kernel/src/checkpoint", kind: "dir", rules: ["e"], status: "present" },
  { id: "host-claude-code", path: "packages/kernel/src/host/claude-code.ts", kind: "file", rules: ["e"], status: "present" },
  {
    id: "host-consumption-gate-record",
    path: "packages/kernel/src/host/consumption-gate-record.ts",
    kind: "file",
    rules: ["e"],
    status: "present",
  },
  { id: "host-exec-port", path: "packages/kernel/src/host/exec-port.ts", kind: "file", rules: ["e"], status: "present" },
  // Entry identity resolves filesystem spellings, so it is neither d1-pure nor
  // a d2 artifact-port consumer. It remains a decision path with no clock.
  { id: "host-entry", path: "packages/kernel/src/host/entry.ts", kind: "file", rules: ["e"], status: "present" },
  { id: "kernel-facade", path: "packages/kernel/src/facade", kind: "dir", rules: ["e"], status: "present" },
  { id: "kernel-evaluator", path: "packages/kernel/src/evaluator.ts", kind: "file", rules: ["d1", "e"], status: "present" },
  { id: "kernel-context", path: "packages/kernel/src/context.ts", kind: "file", rules: ["d1"], status: "present" },
  { id: "kernel-recorder", path: "packages/kernel/src/recorder.ts", kind: "file", rules: ["d2", "e"], status: "present" },
  { id: "kernel-admission", path: "packages/kernel/src/admission.ts", kind: "file", rules: ["d2", "e"], status: "present" },
  { id: "kernel-delivery-record", path: "packages/kernel/src/delivery-record.ts", kind: "file", rules: ["d2", "e"], status: "present" },
  { id: "action-main", path: "packages/action/src/main.ts", kind: "file", rules: ["e"], status: "present" },
  // On the d1 kernel-import allowlist below, which means d1-pure modules may
  // import it: an fs edge acquired here would be an fs edge acquired by every
  // pure module. Registered as a d1 class so the allowlist cannot become the
  // hole in the rule it exists to enforce.
  { id: "kernel-blockers", path: "packages/kernel/src/blockers.ts", kind: "file", rules: ["d1"], status: "present" },
  // Also on the d1 allowlist, for the same reason and with the same
  // consequence: config is what every pure module reads its policy from, so an
  // fs edge here would be an fs edge in the validator, the evaluator, and the
  // context classifier at once.
  { id: "kernel-config", path: "packages/kernel/src/config.ts", kind: "file", rules: ["d1"], status: "present",
    d1Allowlist: ["canonical.ts", "digest.ts", "blockers.ts", "config.ts", "context.ts", "installed-data-resources.ts"] },
  // Config delegates the finite resource grammar here; protect that edge rather
  // than allow resource acquisition or ambient reads into policy validation.
  { id: "kernel-installed-data", path: "packages/kernel/src/installed-data-resources.ts", kind: "file", rules: ["d1"], status: "present", d1Allowlist: ["digest.ts", "portable-limits.ts"] },
  { id: "kernel-portable-limits", path: "packages/kernel/src/portable-limits.ts", kind: "file", rules: ["d1"], status: "present", d1Allowlist: [] },
];

/**
 * The fs/process/os specifier family banned by d1 and d2. `node:module` and
 * `module` are members because `createRequire` is an fs escape hatch;
 * `node:process` and `process` are members because a d1-pure module receives the
 * environment as a context snapshot and never imports the ambient process.
 */
export const FS_SPECIFIER_FAMILY: readonly string[] = [
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
  "node:child_process",
  "child_process",
  "node:os",
  "os",
  "node:module",
  "module",
  "node:process",
  "process",
];

/**
 * Kernel modules a d1-pure module may import by name. Everything else inside
 * the kernel is reachable only through a `*.types.ts` seam, so a pure module
 * cannot acquire fs transitively.
 */
export const D1_KERNEL_ALLOWLIST: readonly string[] = [
  "canonical.ts",
  "digest.ts",
  "blockers.ts",
  "config.ts",
  "context.ts",
];

/** Packages the kernel must never import from (rule a). */
const FORBIDDEN_KERNEL_PACKAGES: readonly string[] = ["cli", "mcp", "action"];

// ── Public API ─────────────────────────────────────────────────────────────

export interface SensorInput {
  /** Absolute path to the tree to scan. Fixtures pass a temp dir. */
  readonly root: string;
  readonly scanRoots?: readonly string[];
  readonly protectedClasses?: readonly ProtectedClass[];
  readonly kernelSrc?: string;
  readonly timestampReadExemptions?: readonly TimestampReadExemption[];
}

export interface SensorResult {
  readonly findings: readonly Finding[];
  readonly filesScanned: number;
  readonly scanRootFileCounts: Readonly<Record<string, number>>;
}

export function runImportBoundarySensor(input: SensorInput): SensorResult {
  const root = input.root;
  const scanRoots = input.scanRoots ?? SCAN_ROOTS;
  const protectedClasses = input.protectedClasses ?? PROTECTED_CLASSES;
  const kernelSrc = input.kernelSrc ?? KERNEL_SRC;
  const exemptions = input.timestampReadExemptions ?? TIMESTAMP_READ_EXEMPTIONS;
  /** Exempted reads actually seen, keyed `file#fn`, so each registration can be checked against the tree. */
  const exemptedReads = new Map<string, number>();
  const timeBannedFiles = new Set<string>();

  const findings: Finding[] = [];
  const scanRootFileCounts: Record<string, number> = {};

  // Anti-vacuity: every scan root exists and is non-empty.
  const files: string[] = [];
  for (const scanRoot of scanRoots) {
    const abs = path.join(root, scanRoot);
    if (!existsSync(abs)) {
      scanRootFileCounts[scanRoot] = 0;
      findings.push({
        rule: "anti-vacuity",
        file: scanRoot,
        line: 0,
        message: `scan root does not exist; the sensor would vacuously pass over it`,
      });
      continue;
    }
    const found = statSync(abs).isDirectory()
      ? collectSourceFiles(abs).map((f) => toPosix(path.relative(root, f)))
      : [toPosix(scanRoot)];
    scanRootFileCounts[scanRoot] = found.length;
    if (found.length === 0) {
      findings.push({
        rule: "anti-vacuity",
        file: scanRoot,
        line: 0,
        message: `scan root contains no TypeScript source files; the sensor would vacuously pass over it`,
      });
    }
    files.push(...found);
  }

  // Anti-vacuity: the protected-class registry matches the filesystem.
  for (const entry of protectedClasses) {
    const exists = existsSync(path.join(root, entry.path));
    if (entry.status === "present" && !exists) {
      findings.push({
        rule: "anti-vacuity",
        file: entry.path,
        line: 0,
        message: `protected class "${entry.id}" is registered as present but does not exist; a rename must update PROTECTED_CLASSES, never drop it`,
      });
    }
    if (entry.status === "pending" && exists) {
      findings.push({
        rule: "anti-vacuity",
        file: entry.path,
        line: 0,
        message: `protected class "${entry.id}" now exists but is still registered as pending; set status to "present" so rules ${entry.rules.join("/")} are enforced against it`,
      });
    }
    if (entry.status === "present" && exists && entry.kind === "dir") {
      // `*.test.ts` files are outside the d1/d2/e scans, so a directory holding
      // only tests carries no enforced file at all.
      const scanned = collectSourceFiles(path.join(root, entry.path)).filter((f) => !f.endsWith(".test.ts"));
      if (scanned.length === 0) {
        findings.push({
          rule: "anti-vacuity",
          file: entry.path,
          line: 0,
          message: `protected class "${entry.id}" contains no non-test TypeScript source files; rules ${entry.rules.join("/")} would vacuously pass over it`,
        });
      }
    }
  }

  const activeClasses = protectedClasses.filter((c) => c.status === "present");

  for (const relFile of files.sort()) {
    const absFile = path.join(root, relFile);
    const text = readFileSync(absFile, "utf8");
    const source = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
    const isTest = relFile.endsWith(".test.ts");

    const imports = collectImports(source);
    const emit = (rule: SensorRule, node: ts.Node, message: string): void => {
      findings.push({ rule, file: relFile, line: lineOf(source, node), message });
    };

    // Rule a — kernel boundary. Applies to every kernel file, tests included.
    if (isUnder(relFile, kernelSrc)) {
      checkKernelBoundary(relFile, kernelSrc, imports, emit);
    }

    // Rule b — no import-time process.env read.
    checkImportTimeEnv(source, emit);

    // Rule c — no Bun.* API.
    checkBunApi(source, emit);

    if (isTest) continue;

    const rules = rulesFor(relFile, activeClasses);

    if (rules.has("d1")) {
      const d1Class = d1ClassFor(relFile, activeClasses);
      checkD1(
        relFile,
        kernelSrc,
        imports,
        root,
        d1Class?.d1SiblingAllowance ?? false,
        d1Class?.d1Allowlist ?? D1_KERNEL_ALLOWLIST,
        emit,
      );
    }
    if (rules.has("d2")) {
      checkFsFamily(imports, "d2-no-adhoc-fs", "filesystem work must go through the artifacts.ts port, not a direct import", emit);
    }
    if (rules.has("e")) {
      timeBannedFiles.add(relFile);
      checkTimeBan(source, relFile, exemptions, emit, (key) => exemptedReads.set(key, (exemptedReads.get(key) ?? 0) + 1));
    }
  }

  // Anti-vacuity: every timestamp-read exemption still names a site, and covers
  // exactly one read there. Both halves matter — a registration that matches
  // nothing is a hole kept open for no reason, and one that matches twice would
  // let a second read in on the strength of the first.
  for (const exemption of exemptions) {
    const key = `${exemption.file}#${exemption.fn}`;
    if (!timeBannedFiles.has(exemption.file)) {
      findings.push({
        rule: "anti-vacuity",
        file: exemption.file,
        line: 0,
        message: `timestamp-read exemption "${key}" names a file no rule-e class covers, so it exempts nothing`,
      });
      continue;
    }
    const seen = exemptedReads.get(key) ?? 0;
    if (seen === 0) {
      findings.push({
        rule: "anti-vacuity",
        file: exemption.file,
        line: 0,
        message: `timestamp-read exemption "${key}" matched no read, so it exempts nothing; drop the registration or restore the site`,
      });
    } else if (seen > 1) {
      findings.push({
        rule: "anti-vacuity",
        file: exemption.file,
        line: 0,
        message: `timestamp-read exemption "${key}" matched ${seen} reads; an exemption covers exactly one site so a second read cannot hide behind the first`,
      });
    }
  }

  return {
    findings,
    filesScanned: files.length,
    scanRootFileCounts,
  };
}

// ── Rule a ─────────────────────────────────────────────────────────────────

function checkKernelBoundary(
  relFile: string,
  kernelSrc: string,
  imports: readonly ImportEdge[],
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
): void {
  for (const edge of imports) {
    const spec = edge.specifier;

    for (const pkg of FORBIDDEN_KERNEL_PACKAGES) {
      if (spec === `@agent-delivery-harness/${pkg}` || spec.startsWith(`@agent-delivery-harness/${pkg}/`)) {
        emit("a-kernel-boundary", edge.node, `kernel imports "${spec}"; the kernel must not depend on the ${pkg} package`);
      }
    }

    if (spec.startsWith(".")) {
      const resolvedRel = toPosix(path.normalize(path.join(path.dirname(relFile), spec)));
      for (const pkg of FORBIDDEN_KERNEL_PACKAGES) {
        if (isUnder(resolvedRel, `packages/${pkg}/`) || resolvedRel.startsWith(`packages/${pkg}/`)) {
          emit("a-kernel-boundary", edge.node, `kernel imports "${spec}" which resolves into packages/${pkg}; the kernel must not depend on the ${pkg} package`);
        }
      }
    }

    if (isHarnessConfigSpecifier(spec)) {
      emit(
        "a-kernel-boundary",
        edge.node,
        `kernel imports "${spec}"; config is an explicit parameter (defineHarnessConfig), never an ambient module the kernel reaches for`,
      );
    }
  }
}

function isHarnessConfigSpecifier(spec: string): boolean {
  const base = spec.split("/").pop() ?? spec;
  return /^harness\.config(\.[cm]?[jt]s)?$/.test(base);
}

// ── Rule b ─────────────────────────────────────────────────────────────────

type ProcessBinding = "process" | "env";

function checkImportTimeEnv(source: ts.SourceFile, emit: (rule: SensorRule, node: ts.Node, message: string) => void): void {
  const aliases = new Map<string, ProcessBinding>();

  // `import process from "node:process"` / `import { env } from "node:process"`.
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    if (spec !== "node:process" && spec !== "process") continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name) aliases.set(clause.name.text, "process");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, "process");
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "env") {
          aliases.set(element.name.text, "env");
          emit("b-import-time-env", element, `imports \`env\` from "${spec}", which binds \`process.env\` while this module is evaluated; read the environment inside a function instead`);
        }
        if (imported === "default") aliases.set(element.name.text, "process");
      }
    }
  }

  const resolve = (node: ts.Expression): ProcessBinding | "unresolvable" | undefined => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) {
      if (expr.text === "process") return "process";
      return aliases.get(expr.text);
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const base = resolve(expr.expression);
      if (base === "unresolvable") return "unresolvable";
      if (base === "process" && expr.name.text === "env") return "env";
      if (isGlobalThis(expr.expression) && expr.name.text === "process") return "process";
      return undefined;
    }
    if (ts.isElementAccessExpression(expr)) {
      const arg = unwrap(expr.argumentExpression);
      const literal = ts.isStringLiteralLike(arg) ? arg.text : undefined;
      const base = resolve(expr.expression);
      const baseIsGlobal = isGlobalThis(expr.expression);
      if (literal === undefined) {
        // A computed key on `process`, on an alias of it, or on `globalThis`
        // cannot be decided statically. Report, never skip.
        if (base !== undefined || baseIsGlobal) return "unresolvable";
        return undefined;
      }
      if (base === "unresolvable") return "unresolvable";
      if (base === "process" && literal === "env") return "env";
      if (baseIsGlobal && literal === "process") return "process";
      return undefined;
    }
    return undefined;
  };

  // Top-level aliases, resolved to a fixed point over statement order.
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (init === undefined) continue;
      const resolved = resolve(init);
      if (ts.isIdentifier(decl.name)) {
        if (resolved === "process" || resolved === "env") {
          aliases.set(decl.name.text, resolved);
          continue;
        }
      }
      if (ts.isObjectBindingPattern(decl.name) && resolve(init) === "process") {
        for (const element of decl.name.elements) {
          if (element.dotDotDotToken !== undefined) {
            // `const { ...proc } = process` — the rest binding still carries
            // `env`, so it is an alias of `process`, not a skip.
            if (ts.isIdentifier(element.name)) {
              aliases.set(element.name.text, "process");
            } else {
              emit(
                "b-import-time-env",
                element,
                `rest element of a \`process\` destructuring that this sensor cannot resolve; unresolvable constructs are findings, not skips`,
              );
            }
            continue;
          }
          const propertyName = element.propertyName;
          const sourceName = propertyName && ts.isIdentifier(propertyName) ? propertyName.text : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (sourceName === "env") {
            // A nested pattern (`const { env: { CI } } = process`) binds no
            // alias but has already read `process.env` at import time.
            if (ts.isIdentifier(element.name)) aliases.set(element.name.text, "env");
            emit("b-import-time-env", element, `destructures \`env\` off \`process\` at import time; move the read inside a function`);
          }
        }
        continue;
      }
    }
  }

  const reported = new Set<number>();
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const entersFunction = inFunction || isFunctionLike(node);

    if (!entersFunction && isMemberAccess(node) && !reported.has(node.getStart(source))) {
      const resolved = resolve(node);
      if (resolved === "env") {
        reported.add(node.getStart(source));
        emit("b-import-time-env", node, `\`process.env\` is read while this module is evaluated; config is an explicit parameter — move the read inside a function`);
      } else if (resolved === "unresolvable") {
        reported.add(node.getStart(source));
        emit(
          "b-import-time-env",
          node,
          `dynamic access to \`process\`/\`process.env\` at import time that this sensor cannot resolve; unresolvable constructs are findings, not skips`,
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, entersFunction));
  };
  ts.forEachChild(source, (child) => visit(child, false));
}

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/**
 * Only member accesses are resolved in the walk. A bare identifier is never a
 * fresh `process.env` read — the read happened where the binding was created,
 * and that site is checked separately — and resolving bare identifiers would
 * misfire on every unrelated `.env` property name in the tree.
 */
function isMemberAccess(node: ts.Node): node is MemberAccess {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/**
 * Import-time is "not lexically inside a function body". Class property
 * initializers are deliberately treated as import-time: fail closed rather than
 * reason about instantiation order.
 */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

// ── Rule c ─────────────────────────────────────────────────────────────────

function checkBunApi(source: ts.SourceFile, emit: (rule: SensorRule, node: ts.Node, message: string) => void): void {
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isBunBase(node.expression)) {
      emit("c-bun-api", node, `\`Bun.${node.name.getText(source)}\` is a Bun-only API; Bun is a supported runtime, never a required one — use the node: equivalent`);
    }
    if (ts.isElementAccessExpression(node) && isBunBase(node.expression)) {
      emit("c-bun-api", node, `Bun-only API accessed via computed member; Bun is a supported runtime, never a required one — use the node: equivalent`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function isBunBase(node: ts.Expression): boolean {
  const expr = unwrap(node);
  if (ts.isIdentifier(expr)) return expr.text === "Bun";
  if (ts.isPropertyAccessExpression(expr)) return isGlobalThis(expr.expression) && expr.name.text === "Bun";
  return false;
}

// ── Rules d1 / d2 ──────────────────────────────────────────────────────────

function checkFsFamily(
  imports: readonly ImportEdge[],
  rule: SensorRule,
  why: string,
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
): void {
  for (const edge of imports) {
    if (edge.typeOnly) continue;
    if (FS_SPECIFIER_FAMILY.includes(edge.specifier)) {
      emit(rule, edge.node, `imports "${edge.specifier}"; ${why}`);
    }
  }
}

function checkD1(
  relFile: string,
  kernelSrc: string,
  imports: readonly ImportEdge[],
  root: string,
  hasSiblingAllowance: boolean,
  allowlist: readonly string[],
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
): void {
  checkFsFamily(imports, "d1-kernel-purity", "this module is pure by contract and performs no I/O", emit);

  const importerDir = path.posix.dirname(relFile);

  for (const edge of imports) {
    if (edge.typeOnly) continue;

    // The workspace barrel re-exports the whole kernel, so it is a kernel-internal
    // import that no allowlist entry names — reaching it would acquire fs
    // transitively.
    if (edge.specifier === KERNEL_PACKAGE || edge.specifier.startsWith(`${KERNEL_PACKAGE}/`)) {
      emit(
        "d1-kernel-purity",
        edge.node,
        `imports "${edge.specifier}"; the kernel barrel is not on the d1 allowlist — a d1-pure module may reach only *.types.ts or ${allowlist.join(", ")} by relative path`,
      );
      continue;
    }

    if (!edge.specifier.startsWith(".")) continue;

    const resolved = resolveRelativeImport(root, relFile, edge.specifier);
    if (resolved === undefined) {
      emit(
        "d1-kernel-purity",
        edge.node,
        `relative import "${edge.specifier}" does not resolve to a source file; an unresolvable edge cannot be proven pure`,
      );
      continue;
    }
    if (!isUnder(resolved, kernelSrc)) continue;

    const kernelRel = toPosix(path.posix.relative(kernelSrc, resolved));
    const base = path.posix.basename(resolved);
    const allowed =
      base.endsWith(".types.ts") ||
      allowlist.includes(kernelRel) ||
      (hasSiblingAllowance && path.posix.dirname(resolved) === importerDir);

    if (!allowed) {
      const allowance = hasSiblingAllowance
        ? `, or a sibling inside ${importerDir}`
        : ` (no sibling allowance for this class)`;
      emit(
        "d1-kernel-purity",
        edge.node,
        `imports kernel module "${kernelRel}"; this d1 class may import only *.types.ts or ${allowlist.join(", ")}${allowance}`,
      );
    }
  }
}

// ── Rule e ─────────────────────────────────────────────────────────────────

function checkTimeBan(
  source: ts.SourceFile,
  relFile: string,
  exemptions: readonly TimestampReadExemption[],
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
  recordExemptedRead: (key: string) => void,
): void {
  const exemptFunctions = new Set(exemptions.filter((entry) => entry.file === relFile).map((entry) => entry.fn));

  const visit = (node: ts.Node, enclosing: string): void => {
    const here = functionNameOf(node) ?? enclosing;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && node.name.text === "now") {
      emit("e-time-ban", node, `\`Date.now()\` in a decision path; GEN-5 forbids any admissibility or freshness decision from consulting a clock`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      emit("e-time-ban", node, `\`new Date()\` in a decision path; GEN-5 forbids any admissibility or freshness decision from consulting a clock`);
    }
    // `recordedAt` is informational (§5.8). Only member reads are banned — a
    // locally-scoped binding of that name carries no manifest timestamp.
    if (ts.isPropertyAccessExpression(node) && node.name.text === RECORDED_AT) {
      emit("e-time-ban", node, `reads \`.${RECORDED_AT}\` in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it`);
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = unwrap(node.argumentExpression);
      if (ts.isStringLiteralLike(arg) && arg.text === RECORDED_AT) {
        emit("e-time-ban", node, `reads \`["${RECORDED_AT}"]\` in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it`);
      }
    }
    if (ts.isBindingElement(node)) {
      const member = node.propertyName ?? node.name;
      if (ts.isIdentifier(member) && member.text === RECORDED_AT) {
        emit("e-time-ban", node, `destructures \`${RECORDED_AT}\` in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it`);
      }
    }
    // A member name handed to a reader. The three forms above are what a module
    // that reads members directly writes; this is what a module that reads them
    // through a helper writes, and validator/ is entirely the second kind.
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        const unwrapped = unwrap(argument);
        if (!ts.isStringLiteralLike(unwrapped) || unwrapped.text !== RECORDED_AT) continue;
        if (exemptFunctions.has(here)) {
          recordExemptedRead(`${relFile}#${here}`);
          continue;
        }
        emit(
          "e-time-ban",
          node,
          `hands \`"${RECORDED_AT}"\` to a member reader in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it. A grammar-only read must be registered in TIMESTAMP_READ_EXEMPTIONS`,
        );
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, here);
    });
  };
  ts.forEachChild(source, (child) => {
    visit(child, "<module>");
  });
}

/** The name a finding should attribute a read to: the nearest enclosing function, as written. */
function functionNameOf(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : "<anonymous>";
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    return "<anonymous>";
  }
  return undefined;
}

// ── Import extraction ──────────────────────────────────────────────────────

interface ImportEdge {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly node: ts.Node;
}

function collectImports(source: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImport(node), node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const ref = node.moduleReference.expression;
      if (ts.isStringLiteral(ref)) edges.push({ specifier: ref.text, typeOnly: false, node });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && first !== undefined && ts.isStringLiteralLike(first)) {
        edges.push({ specifier: first.text, typeOnly: false, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return edges;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false; // bare side-effect import: a runtime edge
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rulesFor(relFile: string, activeClasses: readonly ProtectedClass[]): Set<ProtectedRule> {
  const rules = new Set<ProtectedRule>();
  for (const entry of activeClasses) {
    const matches = entry.kind === "file" ? relFile === entry.path : isUnder(relFile, entry.path);
    if (matches) for (const rule of entry.rules) rules.add(rule);
  }
  return rules;
}

/**
 * The most specific d1 class covering this file: a matching dir class first,
 * then a matching file class. The class carries the allowlist and sibling
 * allowance the check runs under; a file class without either falls back to
 * the kernel-root defaults.
 */
function d1ClassFor(relFile: string, activeClasses: readonly ProtectedClass[]): ProtectedClass | undefined {
  const matches = activeClasses.filter((entry) => {
    if (!entry.rules.includes("d1")) return false;
    return entry.kind === "file" ? relFile === entry.path : isUnder(relFile, entry.path);
  });
  return matches.find((entry) => entry.kind === "dir") ?? matches[0];
}

function resolveRelativeImport(root: string, relFile: string, specifier: string): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(relFile), specifier));
  const candidates = [
    joined.replace(/\.js$/, ".ts"),
    joined.replace(/\.mjs$/, ".mts"),
    `${joined}.ts`,
    joined,
    path.posix.join(joined, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (!candidate.endsWith(".ts") && !candidate.endsWith(".mts")) continue;
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return undefined;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...collectSourceFiles(abs));
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(ts|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

function isUnder(relPath: string, dir: string): boolean {
  const normalized = dir.endsWith("/") ? dir : `${dir}/`;
  return relPath.startsWith(normalized);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isGlobalThis(node: ts.Expression): boolean {
  const expr = unwrap(node);
  return ts.isIdentifier(expr) && expr.text === "globalThis";
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.rule}  ${f.file}:${f.line}\n      ${f.message}`).join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const root = repoRootFromHere();
  const result = runImportBoundarySensor({ root });
  const roots = Object.entries(result.scanRootFileCounts)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");

  if (result.findings.length === 0) {
    process.stdout.write(`check-import-boundaries: clean (${result.filesScanned} files; ${roots})\n`);
    return;
  }
  process.stderr.write(`check-import-boundaries: ${result.findings.length} finding(s) (${result.filesScanned} files; ${roots})\n`);
  process.stderr.write(`${formatFindings(result.findings)}\n`);
  process.exitCode = 1;
}

/** The spelling the filesystem can vouch for: the realpath where it can answer, the spelling itself where it cannot. */
function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

// argv and `import.meta.url` may spell this file differently: argv carries the
// caller's spelling while Node builds the module URL from the realpath (or,
// under `--preserve-symlinks-main`, from the caller's spelling). A sensor that
// under-matches here no-ops and exits 0 — a green sensor run that scanned
// nothing — so each side is canonicalized independently and compared as paths.
const invokedDirectly =
  process.argv[1] !== undefined &&
  canonicalEntryPath(path.resolve(process.argv[1])) === canonicalEntryPath(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
