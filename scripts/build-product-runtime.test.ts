import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildProductRuntime, computedImports, refuseComputedImports } from "./build-product-runtime.ts";

it("runs bundled CLI and a typed consumer config without installed packages", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-"));
  try {
    const manifest = path.join(temporary, "workflow.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: "a".repeat(64) }));
    const runtime = path.join(temporary, "runtime");
    await buildProductRuntime(process.cwd(), manifest, runtime);
    // Bun's FFI stays a literal, external load that a scanner can bound; Node never evaluates it.
    expect(await readFile(path.join(runtime, "kernel.mjs"), "utf8")).toContain('import("bun:ffi")');
    for (const name of ["kernel", "policy"]) expect(computedImports(await readFile(path.join(runtime, `${name}.mjs`), "utf8"))).toEqual([]);
    for (const name of ["cli", "cli-api"]) expect(computedImports(await readFile(path.join(runtime, `${name}.mjs`), "utf8"))).toEqual(["pathToFileURL(configPath).href"]);
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
}, 15_000);

it("runs composite admission from bundled runtime bytes in a disposable consumer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-admit-"));
  try {
    const manifest = path.join(temporary, "workflow.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: "a".repeat(64) }));
    const runtime = path.join(temporary, "installed-runtime");
    await buildProductRuntime(process.cwd(), manifest, runtime);

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
}, 30_000);

it("qualifies scoped execution through the actual bundled runtime", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-scoped-"));
  try {
    const manifest = path.join(temporary, "workflow.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: "a".repeat(64) }));
    const runtime = path.join(temporary, "runtime");
    await buildProductRuntime(process.cwd(), manifest, runtime);
    const { runScopedRuntimeQualification, SCOPED_RUNTIME_PROBES } = await import("./qualify-product.ts");
    const result = await runScopedRuntimeQualification(runtime);
    expect(result.probes).toEqual(SCOPED_RUNTIME_PROBES);
    expect(result.runtimeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.repositories).toBe(3);
    await writeFile(path.join(runtime, "cli.mjs"), "throw Error(\"must not execute corrupt runtime\");\n");
    await expect(runScopedRuntimeQualification(runtime)).rejects.toThrow("runtime checksum mismatch: cli.mjs");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 180000);

it("finds every import and require whose specifier is not one literal string", () => {
  expect(computedImports([
    'import("node:fs"); import(`bun:ffi`); require("x"); __require("y"); import("./a.mjs", { with: {} });',
    "// import(commented)",
    'const text = "import(quoted)";',
  ].join("\n"))).toEqual([]);
  expect(computedImports([
    'const ffiModule = "bun:ffi"; await import(ffiModule);',
    "import(`./${name}.mjs`);",
    'require("a" + b);',
    "__require(dep);",
    "import(pathToFileURL(configPath).href);",
  ].join("\n"))).toEqual(["ffiModule", "`./${name}.mjs`", '"a" + b', "dep", "pathToFileURL(configPath).href"]);
});

it.each([
  ["kernel", 'const ffiModule = "bun:ffi"; export const load = () => import(ffiModule);', "ffiModule"],
  ["policy", "export const load = name => require(name);", "name"],
  ["cli", "export const load = configPath => import(configPath);", "configPath"],
])("refuses a runtime whose %s bundle loads through a computed specifier", async (bundle, text, specifier) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "computed-import-"));
  try {
    for (const name of ["cli-api", "cli", "kernel", "policy"]) await writeFile(path.join(out, `${name}.mjs`), name === bundle ? text : 'export const load = () => import("node:fs");');
    await expect(refuseComputedImports(out)).rejects.toThrow(`product.computed_import: ${bundle}.mjs loads ${specifier} through a computed specifier`);
    await writeFile(path.join(out, `${bundle}.mjs`), "export const load = configPath => import(pathToFileURL2(configPath2).href);");
    await expect(refuseComputedImports(out)).resolves.toBeUndefined();
  } finally { await rm(out, { recursive: true, force: true }); }
});
