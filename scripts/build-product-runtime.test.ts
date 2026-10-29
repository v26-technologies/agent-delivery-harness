import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getHooks } from "vitest/suite";
import { buildProductRuntime } from "./build-product-runtime.ts";

/**
 * WHY THESE ROWS CARRY EXPLICIT BUDGETS.
 *
 * Every row here drives the bundled runtime as an adopter does: as subprocesses
 * that boot node and load `cli.mjs` from bytes. The scoped row alone makes 45
 * such executions across three disposable repositories, and on untouched
 * `origin/main` it failed by exhausting its own 180 000 ms bound rather than by
 * any assertion (V26-2084). The bound was set when the qualification drove
 * fewer probes and was not restated when V26-2067 added more.
 *
 * What the row spends is process start, not work, and process start here is not
 * a stable quantity. Five consecutive `cli.mjs --help` executions on this host,
 * inside one minute, cost 125, 1516, 8560, 151 and 120 ms: macOS serializes
 * exec on a loaded machine, so the same command is two orders of magnitude
 * apart depending on what else is running. Forty-five executions against that
 * distribution is what these budgets have to survive.
 *
 * That also means no number here is sized from a duration. A run of the whole
 * qualification alongside a delivery wave came to 206.9 s, but
 * `docs/solutions/a-test-timeout-that-is-the-checkout-not-the-diff-2026-09-14.md`
 * is explicit that a duration measured under concurrent load is not a
 * measurement, and it is not used as one. Every budget below is a CEILING set
 * well clear of any cost observed either way, and no row asserts how long it
 * took.
 *
 * A ceiling alone is not enough, and the first version of this file learned it
 * the expensive way. A row that crosses vitest's own ceiling is aborted from
 * outside: its `catch` never runs, and it refuses with a bare `Test timed out
 * in Nms` that says nothing about whether the product stopped or the host did.
 * That is precisely the symptom this ticket was filed for, so a ceiling that
 * merely moves it to another row moves the ticket with it. Every row that
 * drives subprocesses therefore carries TWO numbers, both taken from
 * `ROW_BUDGET` under the row's own name: an inner `bound` it enforces itself
 * through `runRowWithStallAttribution`, and an outer `ceiling` well above it
 * that vitest never reaches in practice. A
 * refusal here names the host or the candidate; it is not left as a bare
 * timeout for the next reader to guess at.
 */

/**
 * The two numbers for every bounded row, in one place, keyed by the row's own
 * name.
 *
 * They were eight loose constants, and a pair of constants ordered correctly
 * says nothing about the pair a row actually runs under: a row is free to pass
 * its own ceiling as its inner bound, and vitest then aborts it from outside
 * with the bare `Test timed out in Nms` this ticket was filed for. Neither the
 * constants nor any assertion over them can see that. So a row does not get to
 * name its own numbers — it names itself, and `itBoundedRow` takes both from
 * this record through `registerBudget`, which registers exactly what it hands
 * out — so the numbers the guard row orders are the numbers the row ran under,
 * not a second reading of the same table.
 *
 * - the build: one esbuild pass over four entry points plus two rollup
 *   declaration passes, measured 1 425 ms cold and 1 061 ms warm.
 * - the consumer row: three bundled executions plus a `tsc --noEmit` over the
 *   shipped declarations.
 * - the admission row: three bundled executions plus the eight git invocations
 *   of a disposable consumer.
 * - the scoped row: forty-five executions, each observed at 8.5 s, plus three
 *   repositories' git plumbing, with room left for the suite at four workers.
 *   Fifteen minutes is far above anything this row has cost and still short
 *   enough to fail a genuine hang inside one delivery.
 *
 * Each bound is far above the cost observed either way, so it is reached only
 * by something that stopped; each ceiling is far above its bound, so vitest
 * never reaches it first.
 */
const ROW_BUDGET = {
  "the shared runtime build": { bound: 120_000, ceiling: 240_000 },
  "runs bundled CLI and a typed consumer config without installed packages": { bound: 180_000, ceiling: 360_000 },
  "runs composite admission from bundled runtime bytes in a disposable consumer": { bound: 240_000, ceiling: 480_000 },
  "qualifies scoped execution through the actual bundled runtime": { bound: 900_000, ceiling: 1_020_000 },
  // A row with no work, declared through the same door as the four above, so
  // the door itself is exercised by something cheap. Its numbers are distinct
  // from every other pair here on purpose: the ceiling it is given is read back
  // from vitest inside the row, so a helper that hands `it` the bound instead
  // of the ceiling fails HERE, in seconds, rather than only in the rows that
  // cost minutes and only once the host is already stalling them.
  "declares a row on the two numbers it registered": { bound: 150_000, ceiling: 300_000 },
} as const satisfies Readonly<Record<string, { readonly bound: number; readonly ceiling: number }>>;

type BudgetedRow = keyof typeof ROW_BUDGET;

/**
 * The executions `runScopedRuntimeQualification` made when this budget was
 * measured. The row asserts the actual count against it, so a probe added to
 * the qualification trips a named assertion here instead of a bare timeout —
 * which is exactly how the 180 s bound went stale.
 */
const BUDGETED_BUNDLED_COMMANDS = 45;

/**
 * The one row here whose whole subject is a single bare start, so it cannot
 * bound that start without bounding what it measures. It carries a ceiling and
 * no inner bound, which is why it is not in `ROW_BUDGET`. The slowest start
 * observed on this host during the storm that produced this file was 445 s.
 */
const BARE_START_ROW_TIMEOUT_MS = 900_000;

/** A bare `node -e 0` on a quiet host here is 40-150 ms. */
const NOMINAL_EXEC_MS = 250;

/** One exec this far above nominal did not queue behind work; the host stalled it. */
const DEGRADED_EXEC_FACTOR = 10;

/** How often the sampler times a bare start while the qualification runs. */
const EXEC_SAMPLE_INTERVAL_MS = 10_000;

/**
 * Attribute a row's failure to the host or to the candidate.
 *
 * The qualification refuses with the command it expected — `gate expected exit
 * 0`, or `runtime command timed out: gate` — and both read as a product defect
 * whatever actually went wrong. On a host whose exec path has stalled, the same
 * messages mean a check crossed its own `timeoutMs` waiting to *start*.
 *
 * The discriminator is the SLOWEST start sampled WHILE THE ROW RAN, not a
 * sample taken afterwards. The first version of this function sampled on the
 * way out of the catch and reported `candidate` for a failure that a 70-second
 * exec stall had caused, because by then the host had recovered and the median
 * was 67 ms. A stall is transient and it is the outlier that records it, so the
 * sampler runs alongside the row and the verdict reads its maximum.
 *
 * An unattributable failure stays with the candidate. A product that genuinely
 * hangs on a healthy host reports `candidate`, which is correct: this names the
 * environment only when the environment was measurably stalled, and never
 * launders a real defect.
 */
export function attributeRowFailure(observation: {
  readonly row: string;
  readonly failure: string;
  readonly execSampleMs: readonly number[];
}): { readonly attribution: "environment" | "candidate"; readonly message: string } {
  const slowest = observation.execSampleMs.length === 0 ? undefined : Math.max(...observation.execSampleMs);
  if (slowest !== undefined && slowest > NOMINAL_EXEC_MS * DEGRADED_EXEC_FACTOR) {
    return {
      attribution: "environment",
      message: `environment: while "${observation.row}" ran, a bare start on this host took ${slowest} ms against a nominal ${NOMINAL_EXEC_MS} ms; the row reported: ${observation.failure}`,
    };
  }
  const observed = slowest === undefined ? "unsampled" : `${slowest} ms`;
  return {
    attribution: "candidate",
    message: `candidate: the slowest start sampled while "${observation.row}" ran was ${observed} against a nominal ${NOMINAL_EXEC_MS} ms, so the host did not stall it; the row reported: ${observation.failure}`,
  };
}

/**
 * One bare node start, awaited.
 *
 * This is what the sampler times when it is given no other probe, and it must
 * actually start a process: a probe that returns without one makes every sample
 * approximately zero, and a sampler whose samples are all approximately zero
 * attributes every stall to the candidate — the defect this file exists to fix,
 * reintroduced one level down.
 *
 * It is awaited rather than synchronous for a reason the first version of this
 * file got wrong. `execFileSync` blocks the worker's event loop for the whole
 * duration of the start, and `scripts/qualify-product.ts` guards every bundled
 * command with a 30 000 ms `setTimeout` on that same loop. A synchronous sample
 * that the host stalls for longer than that guard fires the guard on unblock —
 * ahead of the child's already-queued `close` — so the instrument written to
 * explain a timeout became sufficient to cause one. An awaited start times the
 * same quantity and competes for nothing.
 */
export const bareNodeStart = async (): Promise<void> => {
  try {
    await promisify(execFile)(process.execPath, ["-e", "0"]);
  } catch {
    /* a host that refuses to start a process is itself the observation */
  }
};

export interface ExecSampler {
  /** The probe this sampler times. Exposed so a row can pin which one it is. */
  readonly probe: () => Promise<void>;
  /**
   * Stop sampling and return every sample, INCLUDING the one still in flight.
   * Idempotent.
   */
  readonly stop: () => number[];
}

/**
 * Times starts until stopped.
 *
 * A start is the cost every bundled execution pays before it runs a line, so
 * this measures the same scarce resource the row spends. It is not free of that
 * resource either: one start per interval over a long-bounded row can add up to
 * more starts than the row itself makes, which is honest — the host is why each
 * one is slow — but it is the reason the interval is coarse rather than fine.
 *
 * A completed sample is not the only observation available, and on the host
 * this file was written for it is the rarer one. When a row refuses because the
 * machine stalled, the sampler's own start is usually stalled too and has not
 * returned — so a sampler that reported only completed samples reported NONE at
 * exactly the moment it mattered, and `attributeRowFailure` read that as
 * `unsampled` and blamed the candidate. That is the v1 defect wearing a
 * different hat. A start that has been outstanding for `n` ms is evidence the
 * host took at least `n` ms to start a process, so `stop` returns the in-flight
 * elapsed alongside the completed samples.
 */
export function startExecSampler(intervalMs: number, probe: () => Promise<void> = bareNodeStart): ExecSampler {
  const samples: number[] = [];
  let outstandingSince: number | undefined;
  let sampling = true;
  void (async () => {
    while (sampling) {
      outstandingSince = Date.now();
      await probe();
      samples.push(Date.now() - outstandingSince);
      outstandingSince = undefined;
      if (!sampling) break;
      await new Promise((resolve) => { setTimeout(resolve, intervalMs).unref(); });
    }
  })();
  return {
    probe,
    stop: () => {
      sampling = false;
      return outstandingSince === undefined ? [...samples] : [...samples, Date.now() - outstandingSince];
    },
  };
}

/**
 * One row's name and its two numbers, travelling together.
 *
 * `runRowWithStallAttribution` takes the whole thing rather than a loose
 * `boundMs`, which makes this the only place in the file that reads a bound at
 * all: the object the guard row orders is, by identity, the object the wrapper
 * ran under. A use site that reached for the ceiling where the bound belongs
 * would have to reach inside the wrapper, where the short-bound row below
 * observes it directly.
 */
export interface RowBudget {
  readonly row: string;
  readonly boundMs: number;
  readonly ceilingMs: number;
}

/**
 * Run one row's work under its own bound, with its refusal attributed.
 *
 * Two things the row cannot do for itself. The bound is enforced HERE rather
 * than by vitest's row ceiling, because a row vitest aborts never reaches its
 * own `catch` and refuses as a bare `Test timed out in Nms`. And the sampler is
 * a parameter rather than a local, because the value it returns is what decides
 * the attribution: injecting one is how a row can prove that this wrapper reads
 * it at all.
 */
export async function runRowWithStallAttribution<T>(options: {
  readonly budget: RowBudget;
  readonly sampler: ExecSampler;
  readonly work: () => Promise<T>;
}): Promise<T> {
  const { row, boundMs } = options.budget;
  let bound: ReturnType<typeof setTimeout> | undefined;
  try {
    const working = options.work();
    // The bound may win the race; a later rejection from the losing side is
    // then nobody's, and an unhandled rejection would fail a sibling row.
    working.catch(() => {});
    return await Promise.race([
      working,
      new Promise<never>((_, reject) => {
        bound = setTimeout(() => { reject(new Error(`exceeded its ${boundMs} ms bound`)); }, boundMs);
      }),
    ]);
  } catch (error) {
    // A bare `gate expected exit 0` is what sent this row to three separate
    // deliveries as a suspected product defect. Say which it is.
    throw new Error(attributeRowFailure({
      row,
      failure: error instanceof Error ? error.message : String(error),
      execSampleMs: options.sampler.stop(),
    }).message, { cause: error });
  } finally {
    if (bound !== undefined) clearTimeout(bound);
    options.sampler.stop();
  }
}

/**
 * The two numbers each bounded row was actually declared with, in declaration
 * order.
 *
 * The names are not the interesting part, and a registry that carried only
 * names was the round-4 defect: it proved a row HAD a budget and nothing at all
 * about the numbers that reached `boundMs:` and vitest's timeout argument, so
 * passing a ceiling as a bound satisfied it. What is registered here is what
 * was passed — the same two values, not a second reading of the record — so the
 * guard row orders the numbers a row RUNS under, and the set of names still
 * catches a row declared with a bare `it` or a stale record entry.
 */
const declaredBoundedRows: RowBudget[] = [];

/**
 * Read one row's budget, and register exactly what was read.
 *
 * This is the only place in the file that turns a row name into two numbers.
 * Every consumer takes them from the object it returns, which is the object the
 * guard row asserts over, so no expression producing a bound goes unobserved.
 */
function registerBudget(row: BudgetedRow): RowBudget {
  const declared: RowBudget = { row, boundMs: ROW_BUDGET[row].bound, ceilingMs: ROW_BUDGET[row].ceiling };
  declaredBoundedRows.push(declared);
  return declared;
}

/**
 * Refuse a row that is not running on what it declared.
 *
 * Two things were asserted by construction and neither by evidence:
 *
 * - The budget the row runs under is the one in the registry, BY REFERENCE. A
 *   `registerBudget` that registered an honest pair and handed back a different
 *   one would satisfy the guard row while every row ran on the wrong number.
 * - The ceiling vitest is ACTUALLY enforcing is the registered ceiling. The
 *   guard row orders two fields of one object; it cannot see the third argument
 *   `it` was given, and a ceiling lowered to the row's own bound puts vitest's
 *   abort at the same instant as the inner bound — vitest wins the race, the
 *   catch never runs, and the bare `Test timed out in Nms` is back with every
 *   assertion green. `task.timeout` is what vitest will enforce, so that is
 *   what is read.
 *
 * The hook is not exempt from the second check. `beforeAll` consumes no
 * fixtures, so there is no `task` to read — but the suite's registered hooks
 * carry the timeout vitest will enforce on them, and `getHooks` from
 * `vitest/suite` reaches them. An earlier version of this comment claimed
 * "vitest exposes no hook timeout" and treated the hook as an accepted residue;
 * that was false at vitest 4.1.11, and a ceiling lowered onto the hook's own
 * bound survived every assertion here while restoring the bare `Test timed out
 * in 120000ms` for the file's ONLY producer — the worst place in the file to
 * lose the attribution. The hook now reads its ceiling back like every row.
 *
 * `undefined` is still accepted, because the read-back can return nothing; what
 * makes that safe is that the hook's own work asserts the number it recorded,
 * so a read-back that yields nothing fails rather than silently skips.
 *
 * What was checked is recorded, because a check nothing records is a check that
 * can be deleted from the one path that calls it while the row proving the
 * check works keeps passing on its own.
 */
const checkedDeclarations: string[] = [];

function assertRunsOnItsDeclaration(declared: RowBudget, enforcedCeilingMs: number | undefined): void {
  expect(declaredBoundedRows, `${declared.row}: runs on the budget it registered`).toContain(declared);
  if (enforcedCeilingMs !== undefined) {
    expect(enforcedCeilingMs, `${declared.row}: vitest ceiling is the registered ceiling`).toBe(declared.ceilingMs);
  }
  checkedDeclarations.push(`${declared.row}:${enforcedCeilingMs ?? "hook"}`);
}

/**
 * The bounded, sampled, attributed work every budgeted row runs.
 *
 * The declaration check lives HERE, on the one path every budgeted row and the
 * hook take, rather than being called separately by each of them: two call
 * sites are two places to delete it from, and deleting it from either was
 * invisible.
 */
function boundedBody(declared: RowBudget, work: () => Promise<void>): (enforcedCeilingMs: number | undefined) => Promise<void> {
  return async (enforcedCeilingMs) => {
    assertRunsOnItsDeclaration(declared, enforcedCeilingMs);
    await runRowWithStallAttribution({ budget: declared, sampler: startExecSampler(EXEC_SAMPLE_INTERVAL_MS), work });
  };
}

/**
 * Declare one bounded row, or the one bounded hook.
 *
 * The row's name is the only thing a caller supplies: the inner bound, the
 * outer vitest ceiling and the sampler all come from `ROW_BUDGET` under that
 * one key, and the name is also the title vitest reports and the string the
 * attribution prints. A row cannot be given a bound above its own ceiling
 * because it cannot be given a bound at all — and the hook goes through the
 * same door as the rows, because it is the file's only producer and a bare
 * `Test timed out` there fails every row at once.
 */
function itBoundedRow(row: BudgetedRow, work: () => Promise<void>): void {
  const declared = registerBudget(row);
  const body = boundedBody(declared, work);
  // `task.timeout` is the ceiling vitest will enforce; `declared.ceilingMs` is
  // the one it was asked to. Reading the first and comparing it to the second is
  // the whole of the check, and it is why these two lines sit together. A body
  // rewritten to hand the check `declared.ceilingMs` instead would pass — no
  // assertion inside the process can tell a number read from the runner from an
  // equal number that was not. That residue is where this stops: every version
  // of the guarantee has one, and moving it one call deeper only renames it.
  it(row, async ({ task }) => { await body(task.timeout); }, declared.ceilingMs);
}

function beforeAllBoundedRow(row: BudgetedRow, work: () => Promise<void>): void {
  const declared = registerBudget(row);
  const body = boundedBody(declared, work);
  // The hook's counterpart to `it`'s `task.timeout`. The suite's registered
  // `beforeAll` hooks carry the ceiling vitest will enforce on them; this hook
  // is the last one registered, and `VITEST_CLEANUP_TIMEOUT` is where the
  // runner keeps that number. Reading it here is what makes a ceiling lowered
  // onto the hook's own bound fail instead of quietly restoring the bare
  // `Test timed out` for the file's only producer. The hook keeps the same
  // irreducible residue the rows do, for the same reason: a body rewritten to
  // hand the check `declared.ceilingMs` instead of the read-back would pass,
  // and no assertion inside the process can tell a number read from the runner
  // from an equal number that was not.
  beforeAll(async ({}, suite) => {
    const registered = getHooks(suite as never).beforeAll as unknown as ReadonlyArray<Record<symbol, unknown>>;
    await body(registered.at(-1)?.[Symbol.for("VITEST_CLEANUP_TIMEOUT")] as number | undefined);
  }, declared.ceilingMs);
}

/**
 * One build for the file.
 *
 * Every row used to rebuild the runtime, which is the same bytes three times
 * over. The build is still exercised for real — this is its only producer — and
 * each row takes a copy, because the scoped row corrupts the bytes it runs to
 * prove the checksum refusal.
 */
let shared: string;
let sharedRuntime: string;

beforeAllBoundedRow("the shared runtime build", async () => {
  // Same evidence for the hook, on the number vitest is actually enforcing on
  // it. Spelt out rather than derived, so a read-back that returns nothing —
  // or the registered ceiling — has to restate this line to pass.
  expect(checkedDeclarations).toContain("the shared runtime build:240000");
  shared = await mkdtemp(path.join(os.tmpdir(), "product-runtime-shared-"));
  const manifest = path.join(shared, "workflow.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: "a".repeat(64) }));
  sharedRuntime = path.join(shared, "runtime");
  await buildProductRuntime(process.cwd(), manifest, sharedRuntime);
});

afterAll(async () => { await rm(shared, { recursive: true, force: true }); });

/** The runtime is position-independent: `runtime.json` pins bytes, and the loader resolves relatively. */
const installRuntime = async (destination: string): Promise<string> => {
  await cp(sharedRuntime, destination, { recursive: true });
  return destination;
};

const consumerRow = async (): Promise<void> => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-"));
  try {
    const runtime = await installRuntime(path.join(temporary, "runtime"));
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: temporary });
    await writeFile(path.join(temporary, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(temporary, "harness.config.ts"), (await readFile("harness.config.ts", "utf8")).replace("delivery-harness.pr-admission", "artifact-consumer"));
    const args = ["--experimental-strip-types", "--import", path.join(runtime, "bootstrap.mjs"), path.join(runtime, "cli.mjs")];
    const help = await run(process.execPath, [...args, "--help"], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(help.stdout).toContain("submit-evidence");
    const check = await run(process.execPath, [...args, "check"], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(check.stdout).toContain("artifact-consumer");
    expect(check.stdout).toContain("delivery/records/record--<deliverableDigest>.json");
    expect(check.stdout).toContain("base movement stale: verification refuses");
    await writeFile(path.join(temporary, "consumer.ts"), `
      import { parseDeliveryRecord, captureGitCandidate, digestDeliverableEntries } from "./runtime/kernel.mjs";
      import { runCli, buildRunExport, parseRunExport, type DeliveryRunExport, type RunExportParseResult, type CliRuntime } from "./runtime/cli-api.mjs";
      import { readScopedCheckDiagnostics, type ScopedAttemptDiagnostic } from "./runtime/cli-api.mjs";
      export const inspect = (text: string) => parseDeliveryRecord(text);
      export const check = (runtime: CliRuntime) => runCli(["check"], runtime);
      export const parse = (value: DeliveryRunExport): RunExportParseResult => parseRunExport(JSON.stringify(value));
      void buildRunExport;
      void captureGitCandidate; void digestDeliverableEntries;
      export const diagnostics = () => readScopedCheckDiagnostics({ rootDir: ".", config: { gateId: "fixture", storageNamespace: "fixture/", providers: [] }, attemptIds: [] });
      export const unavailable: ScopedAttemptDiagnostic = { availability: "unavailable", reason: "legacy" };
      // @ts-expect-error Explicit attempt selection is required by the bundled API.
      readScopedCheckDiagnostics({ rootDir: ".", config: { gateId: "fixture", storageNamespace: "fixture/", providers: [] } });
      // @ts-expect-error Arbitrary exception messages are outside the diagnostic union.
      export const unsafe: ScopedAttemptDiagnostic = { availability: "available", phase: "command", failure: { message: "secret" }, command: { unavailable: "not-started" } };
      // @ts-expect-error The shipped parser must retain its actual typed input.
      parseDeliveryRecord(42);
    `);
    await run(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--types", "node", "--typeRoots", path.resolve("node_modules/@types"), "consumer.ts"], { cwd: temporary });
    const parsed = await run(process.execPath, ["--input-type=module", "-e", 'import { buildRunExport, parseRunExport } from "./runtime/cli-api.mjs"; const value = buildRunExport({ runId: "run-1234567890abcdef", events: [] }); if (!parseRunExport(JSON.stringify(value)).ok || parseRunExport("{}").ok) process.exit(1);'], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(parsed.stderr).toBe("");
  } finally { await rm(temporary, { recursive: true, force: true }); }
};

itBoundedRow("runs bundled CLI and a typed consumer config without installed packages", consumerRow);

const admissionRow = async (): Promise<void> => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-admit-"));
  try {
    const runtime = await installRuntime(path.join(temporary, "installed-runtime"));

    const consumer = path.join(temporary, "consumer");
    await mkdir(consumer);
    const run = promisify(execFile);
    await run("git", ["init", "-q", "-b", "main"], { cwd: consumer });
    await run("git", ["config", "user.name", "Artifact sensor"], { cwd: consumer });
    await run("git", ["config", "user.email", "artifact-sensor@example.invalid"], { cwd: consumer });
    await writeFile(path.join(consumer, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(consumer, "harness.config.ts"), `
      import { defineHarnessConfig } from "@agent-delivery-harness/kernel";
      export default defineHarnessConfig({
        gateId: "artifact.admit",
        baseRef: "origin/main",
        storageNamespace: "delivery-harness/",
        acceptedEnvelopeSpecs: ["delivery-evidence/1"],
        identityVersions: ["deliverable-tree/v1"],
        computingIdentityVersion: "deliverable-tree/v1",
        reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
        recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
        pathClassification: { generated: [], test: [{ kind: "glob", value: "**/*.test.ts" }], lockfile: [] },
        sensitivePaths: [],
        activationThreshold: 1,
        providers: [{ id: "fixture.review", findingCodes: [] }],
        agentEnvSignals: [],
        ciPolicies: [],
        ciPolicyEnvKey: "DH_CI_POLICY",
        preparationWiringPaths: ["harness.config.ts"],
        obligations: [{
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "exact_candidate",
          providers: ["fixture.review"],
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
          humanWaiverAllowed: true,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "review", kind: "manual_action", summary: "Obtain review." }] },
          waivableCodes: ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"],
          nonWaivableCodes: ["ambiguous_records", "malformed_record", "unknown_provider", "live_provider_missing", "ambiguous_live_provider", "live_provider_failed", "resolution_not_allowed"],
        }],
        deliveryRecordPath: "telemetry/delivery-runs/record.json",
        deliveryRecordVerification: { baseMovement: "stale" },
      });
    `);
    await mkdir(path.join(consumer, ".agent-skills"), { recursive: true });
    await mkdir(path.join(consumer, ".agents"), { recursive: true });
    await cp(await realpath(".agent-skills/current"), path.join(consumer, ".agent-skills/current"), { recursive: true });
    await cp(".agent-skills/active.json", path.join(consumer, ".agent-skills/active.json"));
    await cp(".agents/policy", path.join(consumer, ".agents/policy"), { recursive: true });
    await run("git", ["add", "."], { cwd: consumer });
    await run("git", ["commit", "-qm", "consumer base"], { cwd: consumer });
    await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: consumer });
    await writeFile(path.join(consumer, "change.txt"), "candidate\n");
    await run("git", ["add", "change.txt"], { cwd: consumer });
    await run("git", ["commit", "-qm", "candidate"], { cwd: consumer });

    // This is an executable qualification fixture for the emitter path. It is
    // not a claim that an independent reviewer inspected this disposable repo.
    const args = ["--experimental-strip-types", "--import", path.join(runtime, "bootstrap.mjs"), path.join(runtime, "cli.mjs")];
    const environment = { ...process.env, NODE_PATH: "" };
    const prepared = await run(process.execPath, [...args, "prepare"], { cwd: consumer, env: environment });
    expect(prepared.stdout).toContain("prepared artifact.admit");
    const context = await run(process.execPath, [...args, "review-context", "--json"], { cwd: consumer, env: environment });
    const reviewed = JSON.parse(context.stdout) as { digest: string; binding: { charters: Array<{ reviewerId: string }> } };
    const outcomePath = path.join(temporary, "outcome.json");
    const outcome = {
      spec: "review-outcome/1",
      contextDigest: reviewed.digest,
      verdict: "green",
      reviewers: reviewed.binding.charters.map((charter) => ({ id: charter.reviewerId, result: "approved" })),
      findings: [],
    };
    await writeFile(outcomePath, `${JSON.stringify(outcome)}\n`);
    const admitted = await run(process.execPath, [...args, "admit", "--outcome", outcomePath], { cwd: consumer, env: environment });
    expect(admitted.stdout).toContain("gate: admitted");
    expect(admitted.stdout).toContain("recorded telemetry/delivery-runs/record--");
    const records = (await readdir(path.join(consumer, "telemetry/delivery-runs"))).filter((name) => name.startsWith("record--"));
    expect(records).toHaveLength(1);
  } finally { await rm(temporary, { recursive: true, force: true }); }
};

itBoundedRow("runs composite admission from bundled runtime bytes in a disposable consumer", admissionRow);

it("names the environment when a start stalled while the row ran", () => {
  const row = "qualifies scoped execution through the actual bundled runtime";
  const failure = "gate expected exit 0";

  // One stalled start among healthy ones is the whole signal: the row that
  // produced this note failed after a single 70-second stall, on a host whose
  // median was 67 ms by the time anything asked.
  const stalled = attributeRowFailure({ row, failure, execSampleMs: [40, 55, 60, 120, 9000] });
  expect(stalled.attribution).toBe("environment");
  expect(stalled.message).toContain("9000 ms");
  expect(stalled.message).toContain(failure);
  expect(stalled.message).toContain(row);

  // The deny side: a host that never stalled leaves the failure with the
  // candidate, however slow the row itself was.
  const healthy = attributeRowFailure({ row, failure: "runtime command timed out: gate", execSampleMs: [40, 55, 60, 120, 2500] });
  expect(healthy.attribution).toBe("candidate");
  expect(healthy.message).toContain("2500 ms");
  expect(healthy.message).toContain("runtime command timed out: gate");

  // An absent sample cannot attribute a failure away from the candidate.
  const unsampled = attributeRowFailure({ row, failure, execSampleMs: [] });
  expect(unsampled.attribution).toBe("candidate");
  expect(unsampled.message).toContain("unsampled");
  expect(unsampled.message).toContain(failure);
});

it("samples repeatedly, and reports the duration it measured rather than one it chose", async () => {
  // The attribution above is only as good as the numbers reaching it. A sampler
  // that returns nothing, that samples once and stops, or that reports a figure
  // it did not measure produces a confident verdict from no observation at all
  // — and the first two of those are the v1 defect exactly.
  // The interval is deliberately several times the probe. Under an interval
  // SMALLER than the band's own tolerance, a sampler that timed the whole cycle
  // — start plus the sleep after it — would report a number inside the band and
  // pass, and at the production interval every sample would then read ten
  // seconds and attribute EVERY failure to the environment: the v1 defect
  // inverted, a real product defect blamed on the host forever.
  const PROBE_MS = 60;
  const INTERVAL_MS = PROBE_MS * 5;
  const sampler = startExecSampler(INTERVAL_MS, async () => { await new Promise((resolve) => { setTimeout(resolve, PROBE_MS); }); });
  await new Promise((resolve) => { setTimeout(resolve, (PROBE_MS + INTERVAL_MS) * 4); });
  const samples = sampler.stop();

  expect(samples.length).toBeGreaterThanOrEqual(2);
  // The band is asserted over the samples that COMPLETED, not over all of them.
  // `stop` may append a start that has not come back yet, and that one is
  // partial by construction — uniform over the probe's duration — so a
  // per-element lower bound over the whole list is a bet on where the stop
  // landed inside a cycle. A row that refuses for host timing, in the file whose
  // whole subject is refusals that blame the wrong side, is the defect twice.
  expect(samples.filter((sample) => sample >= PROBE_MS - 5 && sample < PROBE_MS * 3).length).toBeGreaterThanOrEqual(2);
  // And nothing it reports is a figure it chose rather than measured.
  expect(Math.max(...samples)).toBeLessThan(PROBE_MS * 20);

  // Stopping is what ends it, and it stays stopped — observed across a real
  // interval, because two `stop` calls in one tick cannot see a sampler that
  // never stopped.
  await new Promise((resolve) => { setTimeout(resolve, (PROBE_MS + INTERVAL_MS) * 2); });
  expect(sampler.stop().length).toBe(samples.length);
});

it("counts a start that has not come back yet, which is when a stall is worth naming", async () => {
  // The host stalls the sampler's own start at the same moment it stalls the
  // row's, so the completed-sample list is empty exactly when the verdict
  // matters. `unsampled` reads as `candidate`, which is the v1 defect: a real
  // stall reported as a product failure. An outstanding start IS the reading.
  const sampler = startExecSampler(5, () => new Promise<void>(() => {}));
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  const samples = sampler.stop();

  expect(samples.length).toBe(1);
  expect(samples[0]).toBeGreaterThanOrEqual(70);
  // And it is that number the attribution reads, where an empty list would have
  // said `unsampled` and sent the failure to the candidate.
  const failure = "gate expected exit 0";
  expect(attributeRowFailure({ row: "any row", failure, execSampleMs: samples }).message).toContain(`${samples[0]} ms`);
  expect(attributeRowFailure({ row: "any row", failure, execSampleMs: [] }).message).toContain("unsampled");
  // A start outstanding past the degraded threshold names the host, which is
  // the case the completed-sample list could never reach.
  expect(attributeRowFailure({ row: "any row", failure, execSampleMs: [NOMINAL_EXEC_MS * DEGRADED_EXEC_FACTOR + 1] }).attribution).toBe("environment");
  // The in-flight start is reported ONCE. A `stop` that pushed it into the
  // completed list would hand the next caller two readings of one start.
  expect(sampler.stop().length).toBe(1);
});

it("times an actual process start when it is given no probe", async () => {
  const started = Date.now();
  await bareNodeStart();
  // A node start is tens of milliseconds at best on this host and has been
  // measured at 445 s at worst. A probe that starts nothing returns in under a
  // millisecond, and every sample it feeds the attribution would read healthy.
  expect(Date.now() - started).toBeGreaterThanOrEqual(10);

  const sampler = startExecSampler(EXEC_SAMPLE_INTERVAL_MS);
  expect(sampler.probe).toBe(bareNodeStart);
  sampler.stop();
}, BARE_START_ROW_TIMEOUT_MS);

it("refuses through the attribution on its own bound, and carries the cause", async () => {
  const row = "runs bundled CLI and a typed consumer config without installed packages";
  const stalled: ExecSampler = { probe: bareNodeStart, stop: () => [40, 9000] };
  const quiet: ExecSampler = { probe: bareNodeStart, stop: () => [40, 60] };
  const cause = new Error("gate expected exit 0");

  // The wrapper reads the sampler it was given: the same failure attributes to
  // the host or to the candidate on those samples alone.
  const patient: RowBudget = { row, boundMs: 60_000, ceilingMs: 120_000 };
  const attributed = await runRowWithStallAttribution({ budget: patient, sampler: stalled, work: async () => { throw cause; } })
    .then(() => undefined, (error: unknown) => error as Error);
  expect(attributed?.message).toContain("environment:");
  expect(attributed?.message).toContain("9000 ms");
  expect(attributed?.message).toContain("gate expected exit 0");
  // The original refusal is not replaced, only named.
  expect(attributed?.cause).toBe(cause);

  await expect(runRowWithStallAttribution({ budget: patient, sampler: quiet, work: async () => { throw cause; } }))
    .rejects.toThrow("candidate:");

  // Its own bound is what refuses, not vitest's ceiling: a row aborted from
  // outside never reaches this catch, and `Test timed out in Nms` is the exact
  // message V26-2084 was filed for.
  // The bound it enforces is the `boundMs` of the budget it was handed, not the
  // `ceilingMs` sitting beside it: work that never settles refuses in 20 ms, and
  // a wrapper reaching for the wrong field of the same object would sit here for
  // two minutes and be killed by vitest without an attribution.
  await expect(runRowWithStallAttribution({ budget: { row, boundMs: 20, ceilingMs: 120_000 }, sampler: stalled, work: () => new Promise<never>(() => {}) }))
    .rejects.toThrow("exceeded its 20 ms bound");

  // And a row that finishes returns its value rather than being wrapped.
  await expect(runRowWithStallAttribution({ budget: patient, sampler: quiet, work: async () => "qualified" }))
    .resolves.toBe("qualified");
});

const scopedRow = async (): Promise<void> => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-scoped-"));
  try {
    const runtime = await installRuntime(path.join(temporary, "runtime"));
    const { runScopedRuntimeQualification, SCOPED_RUNTIME_PROBES } = await import("./qualify-product.ts");
    const result = await runScopedRuntimeQualification(runtime);
    expect(result.probes).toEqual(SCOPED_RUNTIME_PROBES);
    expect(result.runtimeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.repositories).toBe(3);
    // The budget above is 45 executions wide, and the qualification spends
    // exactly that today. Equality rather than a ceiling, so a probe that adds
    // an execution and a probe that quietly drops one both have to restate the
    // number rather than spend someone else's tail gate.
    expect(result.commands.length).toBe(BUDGETED_BUNDLED_COMMANDS);
    await writeFile(path.join(runtime, "cli.mjs"), "throw Error(\"must not execute corrupt runtime\");\n");
    await expect(runScopedRuntimeQualification(runtime)).rejects.toThrow("runtime checksum mismatch: cli.mjs");
  } finally { await rm(temporary, { recursive: true, force: true }); }
};

itBoundedRow("declares a row on the two numbers it registered", async () => {
  // The work of this row is to be the evidence that the check above it ran, on
  // the ceiling the runner is actually enforcing. Without this, the check could
  // be lifted off the path every budgeted row takes and the row below would go
  // on passing, because it calls the check directly.
  expect(checkedDeclarations).toContain("declares a row on the two numbers it registered:300000");
});

it("refuses a budgeted row that is not running on what it declared", () => {
  const declared = declaredBoundedRows[0]!;
  // A ceiling lowered to the row's own bound is the edit that puts vitest's
  // abort on top of the inner bound and brings the bare timeout back.
  expect(() => { assertRunsOnItsDeclaration(declared, declared.boundMs); }).toThrow("vitest ceiling is the registered ceiling");
  expect(() => { assertRunsOnItsDeclaration(declared, declared.ceilingMs); }).not.toThrow();
  // A read-back that yields nothing skips the ceiling half rather than
  // asserting a wrong number; what keeps that honest is the hook's own work,
  // which names the figure it recorded.
  expect(() => { assertRunsOnItsDeclaration(declared, undefined); }).not.toThrow();
  // An unregistered budget is what a `registerBudget` handing back a copy of
  // what it pushed would produce: the registry holds an honest pair while the
  // row runs on another one. The fixture is therefore a COPY of a registered
  // budget carrying its real ceiling — field-for-field equal, a different
  // object — because that is the only shape that separates `toContain` from
  // `toContainEqual`. An unequal fixture would pass under either, and the
  // by-reference claim is the whole of this check.
  const unregistered: RowBudget = { ...declared };
  expect(() => { assertRunsOnItsDeclaration(unregistered, declared.ceilingMs); }).toThrow("runs on the budget it registered");
});

it("keeps every inner bound under its own ceiling, and every bounded row on the budget", () => {
  // Two numbers ordered by prose until now — "an outer `_TIMEOUT_MS` ceiling
  // well above it" — and an inner bound raised above its own ceiling silently
  // restores the bare `Test timed out in Nms` this ticket was filed for: vitest
  // aborts the row from outside and its catch never runs. Every row still
  // passes on a healthy host, so nothing else here would notice.
  // Ordering the record's own numbers would not be enough: it says nothing
  // about the numbers a row RUNS under, and that gap is what let a ceiling be
  // passed as a bound while every pair in the record stayed ordered. So the
  // assertion is over what was registered at the declaration — the same two
  // values that reached `runRowWithStallAttribution` and vitest.
  expect(declaredBoundedRows.length).toBeGreaterThan(0);
  for (const declared of declaredBoundedRows) {
    expect(declared.boundMs, `${declared.row}: bound under ceiling`).toBeLessThan(declared.ceilingMs);
  }

  // And the rows that carry a budget are exactly the rows the record names — a
  // row declared with a bare `it` drops out of the left side, an entry kept
  // here after its row went away is left on the right, and a row registered
  // twice lengthens the left.
  expect(declaredBoundedRows.map((declared) => declared.row).sort()).toEqual(Object.keys(ROW_BUDGET).sort());

  // And the sampler has to get several starts in before the tightest of those
  // bounds, or the verdict rests on one reading — at a large enough interval it
  // takes one sample and sleeps past every row, which is the v1 defect restored
  // by a single constant.
  expect(EXEC_SAMPLE_INTERVAL_MS * 10).toBeLessThan(Math.min(...declaredBoundedRows.map((declared) => declared.boundMs)));
});

itBoundedRow("qualifies scoped execution through the actual bundled runtime", scopedRow);
