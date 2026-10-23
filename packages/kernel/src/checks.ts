/** Current observations for deterministic checks; admission still owns the decision. */
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CandidateBinding } from "./candidate.types.ts";
import { isScopedCheckDefinition, type HarnessConfig, type ScopedCheckDefinition } from "./config.ts";
import { digestCanonical, sha256Hex } from "./digest.ts";
import { computeDeliverableIdentity } from "./identity.ts";
import { computePreparationFingerprint, type PreparationOptions } from "./preparation.ts";
import { BlockedError, createBlocker } from "./blockers.ts";
import { readWorkflowRelease, type ReviewInputReader } from "./review-inputs.ts";
import type { CheckBinding, ScopedCheckPlan } from "./records.types.ts";
import { selectScopedCheckAttempt } from "./evaluator.ts";
import { recordOutputConfiguration } from "./record-output.ts";

export interface ScopedInputCapturePorts {
  /** Enumerate and read the same pinned snapshot, never the authoring checkout. */
  readonly listFiles: () => Promise<readonly string[]>;
  readonly readFile: (repoPath: string) => Promise<Uint8Array | null>;
  /** Prepared Git metadata matters for executable helpers and inspected links. */
  readonly readMetadata?: (repoPath: string) => Promise<import("./portable-inputs.ts").CandidateTreeInputMetadata>;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly runtimeDigest: string;
  readonly dependencyDigest: string;
  readonly policyDigest: string;
  readonly releaseDigest: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** An externally supplied nonsecret account/revision ID, never a credential hash. */
  readonly credentialIdentity: (name: string) => string | null;
}

export interface ScopedInputCapture {
  readonly version: "scoped-inputs/1";
  readonly inputDigest: string;
  readonly reusable: boolean;
  readonly files: readonly { readonly path: string; readonly sha256: string | null; readonly metadata?: import("./portable-inputs.ts").CandidateTreeInputMetadata }[];
  readonly memberships: readonly { readonly prefix: string; readonly paths: readonly string[] }[];
  readonly environment: readonly { readonly name: string; readonly kind: "flag" | "credential"; readonly present: boolean; readonly value?: string; readonly identity?: string | null }[];
}

/** Hash only declared inputs. Candidate and selection identity belong to the current plan. */
export async function captureScopedCheckInputs(definition: ScopedCheckDefinition, ports: ScopedInputCapturePorts): Promise<ScopedInputCapture> {
  if (!isScopedCheckDefinition(definition)) throw new Error("Unsupported or malformed scoped check definition");
  for (const digest of [ports.runtimeDigest, ports.dependencyDigest, ports.policyDigest, ports.releaseDigest]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Scoped inputs require runtime, dependency, policy and release digests");
  }
  if (ports.command.length === 0 || ports.command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !Number.isSafeInteger(ports.timeoutMs) || ports.timeoutMs < 1) throw new Error("Invalid scoped execution command");
  const inventory = [...await ports.listFiles()].sort();
  if (new Set(inventory).size !== inventory.length || inventory.some(p => !p || p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.split("/").some(s => s === ".." || s === "." || s === ""))) throw new Error("Invalid snapshot inventory");
  const memberships = [...definition.memberships].sort().map(prefix => ({ prefix, paths: inventory.filter(p => p.startsWith(prefix)) }));
  const selected = [...new Set([...definition.files, ...definition.tests, ...memberships.flatMap(m => m.paths)])].sort();
  const files: ScopedInputCapture["files"][number][] = new Array(selected.length);
  let cursor = 0;
  let failure: { index: number; error: unknown } | undefined;
  function retainFailure(index: number, error: unknown) {
    if (failure === undefined || index < failure.index) failure = { index, error };
  }
  async function worker() {
    while (failure === undefined) {
      const index = cursor++;
      if (index >= selected.length) return;
      const file = selected[index]!;
      try {
        const bytes = await ports.readFile(file);
        if (definition.tests.includes(file) && bytes === null) throw new Error("Required test is absent");
        if ((bytes !== null) !== inventory.includes(file)) throw new Error("Snapshot membership and bytes disagree");
        files[index] = { path: file, sha256: bytes === null ? null : sha256Hex(bytes), ...(ports.readMetadata ? { metadata: await ports.readMetadata(file) } : {}) };
      } catch (error) {
        // Stop scheduling, but drain every started read. Earlier sorted inputs
        // may still fail; retain the same first error a serial capture returns.
        retainFailure(index, error);
      }
    }
  }
  // Indexed results preserve identity bytes despite out-of-order completion.
  // Ports have no cancellation contract: settle in-flight work before rejecting.
  await Promise.all(Array.from({ length: Math.min(8, selected.length) }, worker));
  if (failure !== undefined) throw failure.error;
  const environment: ScopedInputCapture["environment"] = [...definition.environment].sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const value = ports.environment[entry.name];
    const present = value !== undefined;
    if (entry.kind === "flag") return { ...entry, present, value: value ?? "" };
    const identity = present && value !== "" ? ports.credentialIdentity(entry.name) : null;
    if (identity !== null && (identity === value || identity === sha256Hex(value ?? ""))) throw new Error("Credential identity must be a nonsecret external revision, never credential bytes or their hash");
    return { ...entry, present, identity };
  });
  const reusable = environment.every(e => e.kind !== "credential" || !e.present || (typeof e.identity === "string" && e.identity.length > 0));
  const inputs = { definition: { ...definition, files: [...definition.files].sort(), memberships: [...definition.memberships].sort(), tests: [...definition.tests].sort(), environment: [...definition.environment].sort((a, b) => a.name.localeCompare(b.name)) }, files, memberships, environment,
    command: ports.command, timeoutMs: ports.timeoutMs, runtimeDigest: ports.runtimeDigest, dependencyDigest: ports.dependencyDigest, policyDigest: ports.policyDigest, releaseDigest: ports.releaseDigest };
  return { version: "scoped-inputs/1", inputDigest: digestCanonical(inputs), reusable, files, memberships, environment };
}

export async function captureCheckOutputSnapshots(rootDir: string, outputs: readonly string[], readOutput?: (repoPath: string) => Promise<Uint8Array>): Promise<readonly { path: string; sha256: string; base64: string }[] | undefined> {
  const root = await realpath(rootDir);
  const result: { path: string; sha256: string; base64: string }[] = [];
  for (const output of outputs) {
    try {
      if (readOutput !== undefined) {
        const bytes = await readOutput(output);
        if (bytes.length > 1024 * 1024) return undefined;
        result.push({ path: output, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString("base64") });
        continue;
      }
      const target = await realpath(path.resolve(root, output));
      const relative = path.relative(root, target);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return undefined;
      const handle = await open(target, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1024 * 1024) return undefined;
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > 1024 * 1024) return undefined;
        const bytes = buffer.subarray(0, offset);
        result.push({ path: output, sha256: sha256Hex(bytes), base64: bytes.toString("base64") });
      } finally { await handle.close(); }
    } catch { return undefined; }
  }
  return result;
}

export async function captureCheckOutputs(rootDir: string, outputs: readonly string[], readOutput?: (repoPath: string) => Promise<Uint8Array>): Promise<readonly { path: string; sha256: string }[] | undefined> {
  return (await captureCheckOutputSnapshots(rootDir, outputs, readOutput))?.map(({ path, sha256 }) => ({ path, sha256 }));
}

export interface CheckBindingOptions extends PreparationOptions {
  readonly readOutput?: (repoPath: string, providerId: string) => Promise<Uint8Array>;
  readonly readReleaseInputs?: ReviewInputReader;
  /** Executor supplies a plan rebuilt from the pinned current candidate/base. */
  readonly scopedPlan?: ScopedCheckPlan;
}

export async function computeCheckWiringFingerprint(rootDir: string, config: HarnessConfig, options: CheckBindingOptions = {}): Promise<string> {
  const read = options.readReleaseInputs ?? (async (repoPath: string) => {
    try { return await readFile(path.join(rootDir, repoPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  let release: Readonly<Record<string, unknown>> | null;
  try { release = await readWorkflowRelease(read); }
  catch (error) {
    throw new BlockedError([createBlocker({ code: "check_release_unreadable", source: { kind: "preparation", id: config.gateId },
      summary: "The installed workflow release identity cannot be read for validation.", details: error instanceof Error ? error.message : String(error),
      remediations: [{ id: "repair-check-release", kind: "manual_action", summary: "Restore a valid installed release and prepare again." }] })]);
  }
  return digestCanonical({ preparation: await computePreparationFingerprint(rootDir, config, options), release });
}

export async function captureCheckBindings(rootDir: string, config: HarnessConfig, candidate: CandidateBinding, options: CheckBindingOptions = {}): Promise<Readonly<Record<string, CheckBinding>>> {
  const providers = recordOutputConfiguration(config, candidate.deliverable.digest).providers.filter(provider => provider.check !== undefined);
  if (providers.length === 0) return {};
  const scopedProviders = providers.filter(p => p.check?.scope !== undefined);
  if (scopedProviders.length > 0) {
    const plan = options.scopedPlan;
    const current = { treeSha: candidate.treeSha, deliverableDigest: candidate.deliverable.digest, identityToken: candidate.deliverable.identity, baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: candidate.workspaceId };
    if (plan?.version !== "scoped-plan/1" || digestCanonical(plan.candidate) !== digestCanonical(current) ||
      plan.selectionDigest !== digestCanonical(config.providers.filter(p => p.check?.scope).map(p => ({ id: p.id, check: p.check })).sort((a, b) => a.id.localeCompare(b.id))) ||
      Object.keys(plan.checks).sort().join("\0") !== scopedProviders.map(p => p.id).sort().join("\0")) {
      throw new BlockedError([createBlocker({ code: "scoped_check_plan_required", source: { kind: "preparation", id: config.gateId }, summary: "Scoped checks require a supported executor and a complete plan rebuilt for the current candidate and base.", remediations: [{ id: "provide-scoped-plan", kind: "manual_action", summary: "Use a scoped-capable executor to capture the current plan before execution." }] })]);
    }
  }
  const validationDigest = await computeDeliverableIdentity({ rootDir, treeSha: candidate.treeSha,
    config: { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral } });
  const policyDigest = digestCanonical(config);
  const wiringFingerprint = await computeCheckWiringFingerprint(rootDir, config, options);
  const bindings: Record<string, CheckBinding> = {};
  for (const provider of providers) {
    const outputs = await captureCheckOutputs(rootDir, provider.check!.outputs ?? [], options.readOutput === undefined ? undefined : repoPath => options.readOutput!(repoPath, provider.id));
    if (provider.check!.scope !== undefined) {
      const input = options.scopedPlan!.checks[provider.id]!;
      const attempt = selectScopedCheckAttempt(provider.id, input.inputDigest, input.profileDigest, input.attempts);
      if (outputs === undefined || attempt?.status !== "passed") continue;
      if (!input.reusable && digestCanonical(attempt.origin.candidate) !== digestCanonical(options.scopedPlan!.candidate)) continue;
      bindings[provider.id] = { definitionDigest: digestCanonical(provider.check), validationDigest: input.inputDigest, policyDigest: digestCanonical(config.obligations.filter(o => o.providers.includes(provider.id)).map(o => ({ ...o, providers: [provider.id] }))),
        wiringFingerprint: input.profileDigest, outputsDigest: digestCanonical(outputs), scopedInputDigest: input.inputDigest, scopedAttemptDigest: digestCanonical(attempt), scopedProfileDigest: input.profileDigest };
      continue;
    }
    if (outputs !== undefined) bindings[provider.id] = { definitionDigest: digestCanonical(provider.check), validationDigest, policyDigest, wiringFingerprint, outputsDigest: digestCanonical(outputs) };
  }
  return bindings;
}
