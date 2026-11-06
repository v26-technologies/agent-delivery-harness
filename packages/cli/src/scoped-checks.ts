/** Invocation-scoped execution coordinator; durable truth remains per-check evidence. */
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { deliveryRecordPathFor, recordOutputProvider, computeDeliverableIdentity, capturePhysicalSource, captureCheckBindings, captureCheckOutputSnapshots, candidateTreeEvidenceReader, candidateTreeSourceReader, createExecPort, digestCanonical, resolveRecordStorage, runGitCommand, scopedCheckIdentity, selectScopedCheckAttempt, sha256Hex, submitManifest,
  createResourceApplicabilityProjection, matchResourceApplicabilityProjection, createResourceApplicabilityBinding, reconstructResourceApplicability, discoverRecords, portableArtifactContents, isRecordFreshForCandidate, isRecordNeutralPath, type ResourceApplicabilityBinding, type InstalledDataAttemptOrigin, type InstalledDataResourceRequest, normalizeInstalledDataResourceRequests, type InstalledDataResourceContext, type InstalledDataResourceCapture,
  type CandidateBinding, type CapturedCandidate, type ProviderRegistration, type ScopedCheckPlan, type ScopedExecutionProfile, type ScopedRuntimeObservation, type RecordCandidateBinding } from "@agent-delivery-harness/kernel";
import type { CommandContext } from "./boundary.ts";
import { AttemptStore, type AttemptPayload, type StoredAttempt } from "./scoped-attempts.ts";
import { CheckSnapshotError, createCheckSnapshot, executionPath, snapshotCloneMethod, type CheckSnapshot, type CloneMethod, type SnapshotRequest } from "./check-snapshot.ts";
import { captureInstalledDataBinding, type InstalledDataSourceTree } from "./scoped-installed-data.ts";
import { captureOwnedInstalledDataResources } from "./installed-data-resources.ts";
import { redactScopedStreams, scopedCommandDiagnostic, scopedDependencyDiagnostic, scopedDiagnosticFailure, type RecordedScopedAttemptDiagnostic, type ScopedSetupDiagnostic } from "./scoped-diagnostics.ts";
export function scopedCandidate(candidate: CandidateBinding): RecordCandidateBinding {
  return { treeSha: candidate.treeSha, deliverableDigest: candidate.deliverable.digest, identityToken: candidate.deliverable.identity, baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: candidate.workspaceId };
}
async function executableIdentity(command: string, root: string, searchPath: string, cwd: string, read: Awaited<ReturnType<typeof candidateTreeEvidenceReader>>) {
  if (command.includes(path.sep) && !path.isAbsolute(command)) {
    const file = path.posix.normalize(path.posix.join(cwd, command));
    if (file === ".." || file.startsWith("../")) throw new CheckSnapshotError("check_runtime_unavailable", "A relative execution tool must stay inside the prepared tree.");
    const bytes = await read(file);
    if (bytes === null) throw new CheckSnapshotError("check_runtime_unavailable", "A relative execution tool is missing from the prepared tree.");
    return { command, sha256: sha256Hex(bytes), metadata: await read.metadata(file) };
  }
  const candidates = command.includes(path.sep) ? [path.resolve(root, command)] : searchPath.split(path.delimiter).map(p => path.join(p, command));
  for (const file of candidates) {
    try { await access(file); } catch { continue; }
    const relative = path.relative(await realpath(root), await realpath(file));
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new CheckSnapshotError("check_runtime_author_path", "Repository execution tools must use a relative command so they run from the private prepared tree.");
    return { command, sha256: sha256Hex(await readFile(file)), mode: (await stat(file)).mode & 0o111 };
  }
  throw new CheckSnapshotError("check_runtime_unavailable", "A declared execution tool cannot be resolved and bound.");
}
/** Checks whose profiles declare the same dependency setup and Git context share one installed snapshot. */
function setupKey(profile: ScopedExecutionProfile, physicalSource?: SnapshotRequest["physicalSource"]): string {
  return digestCanonical({ dependencies: profile.dependencies ?? null, dependencyInputs: [...profile.dependencyInputs].sort(), gitContext: profile.gitContext ?? "full", ...(physicalSource ? { physicalSource } : {}) });
}
/** Structural checks shared by execution and preparation without an identity. */
function scopedProviders(context: CommandContext) {
  const providers = context.config.providers.filter(p => p.check?.scope);
  if (providers.length && context.config.scopedExecution?.version !== "scoped-execution/1") throw new CheckSnapshotError("scoped_executor_required", "Scoped checks require supported private execution profiles before preparation.");
  return providers;
}
async function preparedSource(context: CommandContext, candidate: CapturedCandidate) {
  const read = await candidateTreeSourceReader(context.rootDir, candidate.treeSha);
  const listing = await runGitCommand(["git", "ls-tree", "-r", "--name-only", "-z", candidate.treeSha], { cwd: context.rootDir });
  if (listing.exitCode !== 0) throw new CheckSnapshotError("check_snapshot_unavailable", "Cannot enumerate the prepared source tree.");
  return { inventory: listing.stdout.split("\0").filter(Boolean), read };
}
function validateScopedProvider(context: CommandContext, provider: ProviderRegistration, inventory: readonly string[]) {
  const scope = provider.check!.scope!, profile = context.config.scopedExecution!.profiles.find(p => p.id === scope.profile);
  if (!profile) throw new CheckSnapshotError("scoped_executor_required", "A selected execution profile is unsupported.");
  if (profile.mutableOutputs.some(o => inventory.some(f => f === o.replace(/\/$/, "") || f.startsWith(`${o.replace(/\/$/, "")}/`)))) throw new CheckSnapshotError("check_output_overlaps_source", "Mutable outputs overlap prepared source.");
  if ((provider.check!.outputs ?? []).some(o => !profile.mutableOutputs.some(m => m.endsWith("/") ? o.startsWith(m) : o === m))) throw new CheckSnapshotError("check_output_undeclared", "Every retained output must be declared mutable in its profile.");
  return profile;
}
const shownArgument = (argument: string) => /^[\w@%+=:,./-]+$/.test(argument) ? argument : JSON.stringify(argument);
/** Runs the tasks it is given one at a time, in call order. */
function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => { const result = tail.then(task); tail = result.catch(() => undefined); return result; };
}
type AcquiredSetup = Omit<ScopedSetupDiagnostic, "verification" | "phases">;
/** One worker's view while it runs a check: the snapshots only it uses, by setup key, and where its lines go. */
interface Lane { readonly snapshots: Map<string, CheckSnapshot>; readonly write: (text: string) => void }
export class ScopedChecks {
  /** `scopedExecution.concurrency` workers, each owning its snapshots; the first is the serial lane. */
  private readonly workers: Map<string, CheckSnapshot>[];
  readonly concurrency: number;
  private readonly phaseWriters = new WeakMap<Map<string, CheckSnapshot>, (phase: string, durationMs: number) => void>();
  /** Attempt allocation is two writes, so readers of attempt history wait for it to finish. */
  private readonly locked = oneAtATime();
  /** Evidence submission captures the candidate through the author's Git index, which one writer may hold. */
  private readonly publishing = oneAtATime();
  /** Resource discovery is a pre-execution phase on the serial worker only. */
  private readonly capturing = oneAtATime();
  private captureTail: Promise<unknown> = Promise.resolve();
  private capturePhaseOpen = true;
  private cleanupStarted = false;
  /** With more than one worker: one read-only warm base per setup key, which no command runs in. Each
   * worker takes a copy-on-write clone of it; without cloning each worker builds its own, as before. */
  private readonly bases = new Map<string, Promise<CheckSnapshot>>();
  private cloning?: Promise<CloneMethod | undefined>;
  /** Profiles whose checks a tree has run and verified since it was made: their outputs may be in it. */
  private readonly ranOutputs = new WeakMap<CheckSnapshot, Set<string>>();
  private readonly executionLocks = new Map<Map<string, CheckSnapshot>, ReturnType<typeof oneAtATime>>();
  private readonly executionTails = new Map<Map<string, CheckSnapshot>, Promise<unknown>>();
  private retainedResourceBindings?: Promise<Readonly<Record<string, ResourceApplicabilityBinding>>>;
  private readonly sourceTreeCache = new Map<string, Promise<InstalledDataSourceTree>>();
  private candidateSource!: InstalledDataSourceTree;
  private sourceFrames?: Promise<{ base: InstalledDataSourceTree; candidate: InstalledDataSourceTree }>;
  private readonly installed = new Map<string, { binding: Awaited<ReturnType<typeof captureInstalledDataBinding>>; capture: InstalledDataResourceCapture; snapshot: CheckSnapshot }>();
  private readonly owned = new Map<string, Awaited<ReturnType<AttemptStore["allocate"]>>>();
  private readonly stores = new Map<string, AttemptStore>();
  private readonly identities = new Map<string, Awaited<ReturnType<typeof scopedCheckIdentity>>>();
  private readonly executionIdentities = new Map<string, Awaited<ReturnType<typeof scopedCheckIdentity>>>();
  private readonly observations = new Map<string, ScopedRuntimeObservation>();
  private readonly runId = randomUUID();
  private readonly submissions: (() => Promise<void>)[] = [];
  readonly context: CommandContext;
  readonly candidate: CapturedCandidate;
  private constructor(context: CommandContext, candidate: CapturedCandidate) {
    this.context = context; this.candidate = candidate;
    this.concurrency = context.config.scopedExecution?.concurrency ?? 1;
    this.workers = Array.from({ length: this.concurrency }, () => new Map<string, CheckSnapshot>());
  }
  private get serial(): Lane { return { snapshots: this.workers[0]!, write: text => this.context.write(text) }; }
  /** Zero mechanical preparation validates the real narrow physical frame,
   * but does not hash broad consumer inputs or observe execution tools. Gate
   * creates its own fresh session; no deferred identity is retained here. */
  static async validatePreparation(context: CommandContext, candidate: CapturedCandidate): Promise<void> {
    const providers = scopedProviders(context);
    if (!providers.length) return;
    const { inventory, read } = await preparedSource(context, candidate);
    const output = deliveryRecordPathFor(context.config, candidate.deliverable.digest);
    const ordinaryInventory = inventory.filter(file => file !== output), inventoryPaths = new Set(ordinaryInventory);
    for (const provider of providers) {
      const profile = validateScopedProvider(context, provider, inventory), scope = recordOutputProvider(provider, output).check!.scope!;
      // Metadata retains source/link/type and required-input validation without
      // reading and hashing broad regular consumer input bytes.
      const ordinarySelected = new Set([...scope.files, ...scope.tests,
        ...scope.memberships.flatMap(prefix => ordinaryInventory.filter(file => file.startsWith(prefix)))]);
      const selected = new Set([...ordinarySelected, ...profile.dependencyInputs]);
      for (const file of selected) {
        const metadata = await read.metadata(file);
        // The reader owns supported entry/link semantics, including committed
        // directory links. A null mode is exactly its absent-byte result.
        if (metadata.mode === null) {
          if (profile.dependencyInputs.includes(file)) throw new CheckSnapshotError("check_dependency_input_missing", `Required dependency input ${file} is missing from the prepared tree.`);
          if (scope.tests.includes(file)) throw new Error("Required test is absent");
        }
        if (ordinarySelected.has(file) && (metadata.mode !== null) !== inventoryPaths.has(file))
          throw new Error("Snapshot membership and metadata presence disagree");
      }
      if (provider.check!.physicalSource) {
        try { await capturePhysicalSource(provider.check!.physicalSource, read); }
        catch { throw new CheckSnapshotError("check_physical_source_invalid", "Physical source bytes, modes or required absences are unavailable or unsafe."); }
      }
    }
  }
  static async create(context: CommandContext, candidate: CapturedCandidate): Promise<ScopedChecks | undefined> {
    const providers = scopedProviders(context);
    if (!providers.length) return undefined;
    const session = new ScopedChecks(context, candidate);
    const storage = await resolveRecordStorage(context.rootDir, { storageNamespace: context.config.storageNamespace, leaf: "scoped-attempts" });
    const { inventory, read } = await preparedSource(context, candidate);
    const readEvidence = await candidateTreeEvidenceReader(context.rootDir, candidate.treeSha);
    session.candidateSource = { inventory, read };
    const validationConfig = { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral };
    const validationTrees = new Map<string, Promise<string>>();
    const validation = (treeSha: string) => {
      let digest = validationTrees.get(treeSha);
      if (!digest) { digest = computeDeliverableIdentity({ rootDir: context.rootDir, treeSha, config: validationConfig }); validationTrees.set(treeSha, digest); }
      return digest;
    };
    for (const provider of providers) {
      const scope = provider.check!.scope!, profile = validateScopedProvider(context, provider, inventory);
      const searchPath = executionPath(context.rootDir, context.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin");
      const tools = await Promise.all([[process.execPath, "."], [provider.check!.command[0], scope.cwd], ...(profile.dependencies ? [[profile.dependencies.command[0], "."]] : [])].map(([c, cwd]) => executableIdentity(c!, context.rootDir, searchPath, cwd!, read)));
      const observation: ScopedRuntimeObservation = { version: "scoped-runtime/1", runtimeDigest: digestCanonical({ platform: process.platform, arch: process.arch, tools, searchPath }),
        flags: Object.fromEntries(scope.environment.filter(e => e.kind === "flag" && context.env[e.name] !== undefined).map(e => [e.name, context.env[e.name]!])),
        credentials: Object.fromEntries(scope.environment.filter(e => e.kind === "credential").map(e => {
          const present = context.env[e.name] !== undefined, identity = present ? profile.credentialIdentities[e.name] ?? null : null;
          if (identity !== null && (identity === context.env[e.name] || identity === sha256Hex(context.env[e.name] ?? ""))) throw new CheckSnapshotError("check_credential_identity_invalid", "Credential identity must be an external nonsecret revision.");
          return [e.name, { present, identity }];
        })) };
      session.observations.set(provider.id, observation);
      const store = new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: context.config.gateId, provider: provider.id })));
      session.stores.set(provider.id, store);
      let identity = await scopedCheckIdentity(context.config, provider, inventory, read, observation, candidate, readEvidence);
      session.executionIdentities.set(provider.id, identity);
      // Preserve raw Git identity for execution. Only proven record-neutral tree
      // transport may select a prior identity, and only for reusable attempts.
      const history = await store.read();
      if (identity.reusable && profile.gitContext !== "none" && !history.some(({ attempt }) => attempt.inputDigest === identity.inputDigest && attempt.profileDigest === identity.profileDigest)) {
        for (const { attempt } of history.reverse()) {
          const origin = attempt.origin.candidate;
          if (origin.treeSha === candidate.treeSha || origin.baseRef !== candidate.base.ref || origin.baseTipSha !== candidate.base.tipSha ||
              origin.mergeBaseSha !== candidate.base.mergeBaseSha || origin.workspaceId !== candidate.workspaceId ||
              origin.identityToken !== candidate.deliverable.identity || await validation(origin.treeSha) !== await validation(candidate.treeSha)) continue;
          const transported = await scopedCheckIdentity(context.config, provider, inventory, read, observation, { ...candidate, treeSha: origin.treeSha }, readEvidence);
          if (transported.inputDigest === attempt.inputDigest && transported.profileDigest === attempt.profileDigest) { identity = transported; break; }
        }
      }
      session.identities.set(provider.id, identity);
    }
    return session;
  }
  async plan(): Promise<ScopedCheckPlan> {
    const checks: Record<string, ScopedCheckPlan["checks"][string]> = {};
    for (const [id, identity] of this.identities) checks[id] = { inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, reusable: identity.reusable, attempts: (await this.locked(() => this.stores.get(id)!.read())).map(r => r.attempt) };
    return { version: "scoped-plan/1", candidate: scopedCandidate(this.candidate), selectionDigest: digestCanonical(this.context.config.providers.filter(p => p.check?.scope).map(p => ({ id: p.id, check: p.check })).sort((a, b) => a.id.localeCompare(b.id))), checks };
  }
  private async selected(id: string): Promise<StoredAttempt | undefined> {
    const identity = this.identities.get(id)!;
    const rows = await this.locked(() => this.stores.get(id)!.read());
    const selected = selectScopedCheckAttempt(id, identity.inputDigest, identity.profileDigest, rows.map(r => r.attempt));
    return rows.find(r => r.attempt.attemptId === selected?.attemptId);
  }
  readonly readOutput = async (repoPath: string, providerId: string): Promise<Uint8Array> => {
    if (!this.identities.has(providerId)) return readFile(path.join(this.context.rootDir, repoPath));
    const selected = await this.selected(providerId);
    const output = selected?.attempt.status === "passed" ? selected.payload?.outputs.find(o => o.path === repoPath) : undefined;
    if (!output || sha256Hex(Buffer.from(output.base64, "base64")) !== output.sha256) throw new CheckSnapshotError("check_output_missing", "Retained scoped output is absent or corrupt.");
    return Buffer.from(output.base64, "base64");
  };
  /** No safe secret identity means a fresh attempt in every executing invocation. */
  async fenceNonReusable(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (!this.identities.get(id)!.reusable && !this.owned.has(id)) await this.allocate(id);
  }
  private async allocate(id: string) {
    // Historical identity transport selects retained evidence only. A fresh
    // attempt executes this candidate and must bind its actual source tree.
    const identity = this.executionIdentities.get(id)!;
    this.identities.set(id, identity);
    const attempt = await this.locked(() => this.stores.get(id)!.allocate({ version: "scoped-attempt/1", providerId: id, inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, origin: { candidate: scopedCandidate(this.candidate), runId: this.runId } }, { executionHeadSha: this.candidate.headSha }));
    this.owned.set(id, attempt); return attempt;
  }
  async explainReuse(admitted: readonly string[]): Promise<void> {
    for (const id of this.identities.keys()) {
      const selected = await this.selected(id);
      if (admitted.includes(id) && selected?.attempt.status === "passed") this.context.write(`reusing ${id}: matching inputs/profile; attempt ${selected.attempt.attemptId}`);
      for (const row of await this.stores.get(id)!.read()) if (row.attempt.status !== "passed" && row.attempt.inputDigest !== this.identities.get(id)!.inputDigest) this.context.write(`superseded ${id}: ${row.attempt.status} attempt ${row.attempt.attemptId} has different inputs`);
    }
  }
  private profileOf(id: string): ScopedExecutionProfile {
    const scope = this.context.config.providers.find(p => p.id === id)!.check!.scope!;
    return this.context.config.scopedExecution!.profiles.find(p => p.id === scope.profile)!;
  }
  /** The first declared check runs first: it is where an adopter puts a selection guard that must precede
   * every other check. The rest run cheapest first, each costing its most recent passed or failed attempt's
   * duration less that attempt's own dependency setup; never-timed checks follow timed ones and ties keep
   * declaration order. Checks then run one dependency setup at a time, in the order each setup first
   * appears, so each setup installs once. */
  private async cheapestFirst(ids: readonly string[]): Promise<string[]> {
    const cost = new Map<string, number>();
    for (const id of ids) {
      const last = (await this.stores.get(id)!.read()).filter(r => r.attempt.status === "passed" || r.attempt.status === "failed").at(-1)?.payload;
      // A check that waited on another's warm base did not pay that setup either.
      const waited = last?.diagnostic?.setup?.phases.filter(p => p.phase === "warm-base-wait").reduce((sum, p) => sum + p.durationMs, 0) ?? 0;
      cost.set(id, last?.durationMs === undefined ? Infinity : last.durationMs - (last.diagnostic?.dependency?.durationMs ?? 0) - waited);
    }
    const [first, ...rest] = ids;
    if (first === undefined) return [];
    const byCost = [first, ...rest.sort((a, b) => cost.get(a)! === cost.get(b)! ? 0 : cost.get(a)! < cost.get(b)! ? -1 : 1)];
    const keys = byCost.map(id => setupKey(this.profileOf(id), this.context.config.providers.find(p => p.id === id)?.check?.physicalSource));
    return [...new Set(keys)].flatMap(key => byCost.filter((_, index) => keys[index] === key));
  }
  /**
   * Runs ids on the session's workers, each taking the next id when it is free. Every worker keeps its own
   * snapshots, so two checks never share one at once. A worker prints a check's lines together when it
   * finishes; a single worker prints them as they come. After a check throws no new id starts, the running
   * ones finish, and the first failure in `ids` order is thrown.
   */
  private async pool(ids: readonly string[], run: (id: string, lane: Lane) => Promise<void>): Promise<void> {
    const failures = new Map<string, unknown>();
    let next = 0;
    await Promise.all(this.workers.map(async snapshots => {
      while (next < ids.length && failures.size === 0) {
        const id = ids[next++]!, lines: string[] = [];
        try { await run(id, this.concurrency === 1 ? this.serial : { snapshots, write: text => { lines.push(text); } }); }
        catch (error) { failures.set(id, error); }
        finally { for (const line of lines) this.context.write(line); }
      }
    }));
    const failed = ids.find(id => failures.has(id));
    if (failed !== undefined) throw failures.get(failed);
  }
  /** Stops at the first failure: a failed mechanical check publishes no receipt. */
  async satisfyMechanical(): Promise<void> {
    const ids = await this.cheapestFirst(this.context.config.scopedExecution!.mechanicalProviders);
    await this.fenceNonReusable(ids);
    const satisfy = async (id: string, lane: Lane) => {
      if ((await this.selected(id))?.attempt.status === "passed") { lane.write(`reusing mechanical ${id}`); return; }
      const provider = this.context.config.providers.find(p => p.id === id)!;
      await this.execute(provider, this.context.config.obligations.filter(o => o.providers.includes(id)).map(o => o.id), true, lane);
    };
    // The first declared check guards the rest, so it finishes before any other starts.
    await this.pool(ids.slice(0, 1), satisfy);
    await this.pool(ids.slice(1), satisfy);
  }
  /** Runs the gate's requested checks on the pool. A check's own failure is returned in request order and stops nothing. */
  async executeAll(requests: readonly { readonly provider: ProviderRegistration; readonly obligationIds: readonly string[] }[]): Promise<CheckSnapshotError[]> {
    const failures = new Map<string, CheckSnapshotError>();
    const run = async (id: string, lane: Lane) => {
      const request = requests.find(r => r.provider.id === id)!;
      try { await this.execute(request.provider, request.obligationIds, false, lane); }
      catch (error) { if (!(error instanceof CheckSnapshotError)) throw error; failures.set(id, error); }
    };
    const resource = requests.find(r => this.acceptsApplicability(r.provider, r.obligationIds));
    if (resource) {
      // V1 has one conditional consumer. Keep the first configured check ahead of
      // it, and execute both on the capture worker before releasing the rest to
      // the pool. Other workers never inherit that worker's installed tree.
      const serialIds = [...new Set([requests[0]!.provider.id, resource.provider.id])];
      for (const id of serialIds) await run(id, this.serial);
      await this.pool(requests.map(r => r.provider.id).filter(id => !serialIds.includes(id)), run);
    } else await this.pool(requests.map(r => r.provider.id), run);
    return requests.flatMap(r => failures.has(r.provider.id) ? [failures.get(r.provider.id)!] : []);
  }
  async submitMechanical(): Promise<void> { for (const submit of this.submissions) await submit(); this.submissions.length = 0; }
  /** One acquisition path preserves setup sharing, output ownership and worker isolation. A worker's tree
   * for a setup key is built here, cloned from the warm base, or retained from its previous check.
   * `onSetup` hears how the tree is being got before any setup runs, so a failed setup is attributed. */
  private async acquireSnapshot(profile: ScopedExecutionProfile, lane: Lane, onDependencyResult?: SnapshotRequest["onDependencyResult"], physicalSource?: SnapshotRequest["physicalSource"], onSetup: (setup: AcquiredSetup) => void = () => {}): Promise<{ snapshot: CheckSnapshot; sharedOutputs: string[]; setup: AcquiredSetup }> {
    const key = setupKey(profile, physicalSource);
    // Every scoped check's profile sharing this setup may write its own outputs in the shared tree;
    // only those profiles passed the overlap refusal in create().
    const sharedOutputs = [...new Set(this.context.config.scopedExecution!.profiles
      .filter(p => this.context.config.providers.some(q => q.check?.scope?.profile === p.id && setupKey(p, q.check.physicalSource) === key)).flatMap(p => p.mutableOutputs))];
    const method = this.concurrency === 1 ? undefined : await (this.cloning ??= snapshotCloneMethod());
    const acquired = (snapshot: CheckSnapshot, setup: AcquiredSetup) => { lane.snapshots.set(key, snapshot); onSetup(setup); return { snapshot, sharedOutputs, setup }; };
    const retained = lane.snapshots.get(key);
    if (retained) return acquired(retained, { action: "reused", snapshot: "retained", clone: this.concurrency === 1 ? "not-used" : method ?? "unavailable" });
    // A single worker retains only consecutive same-setup reuse; durable outputs no longer
    // need the private tree. A pool keeps each worker's snapshots until cleanup().
    if (this.concurrency === 1) for (const [previousKey, previous] of lane.snapshots) {
      await previous.cleanup();
      lane.snapshots.delete(previousKey);
    }
    const onPhase = (phase: string, durationMs: number) => {
      const write = this.phaseWriters.get(lane.snapshots);
      if (write) write(phase, durationMs);
      else lane.write(`snapshot ${profile.id}: bootstrap ${phase} ${Math.round(durationMs)}ms`);
    };
    const build = (dependencyResult?: SnapshotRequest["onDependencyResult"]) => createCheckSnapshot({ rootDir: this.context.rootDir, candidate: this.candidate, outputs: sharedOutputs, gitContext: profile.gitContext ?? "full", environment: { PATH: this.context.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin" }, ...(physicalSource ? { physicalSource } : {}), ...(profile.dependencies ? { dependencies: profile.dependencies } : {}), ...(this.context.signal ? { signal: this.context.signal } : {}),
      onPhase, ...(dependencyResult ? { onDependencyResult: dependencyResult } : {}) });
    let executed = false, clone: AcquiredSetup["clone"] = this.concurrency === 1 ? "not-used" : "unavailable";
    if (method) {
      let base = this.bases.get(key);
      if (!base) {
        executed = true;
        base = build(onDependencyResult);
        this.bases.set(key, base);
        // A failed setup is not shared: the next check of this key sets up again, as it would on its own worker.
        const failed = base;
        failed.catch(() => { if (this.bases.get(key) === failed) this.bases.delete(key); });
      }
      onSetup({ action: executed ? "executed" : "reused", snapshot: "cloned", clone: method });
      const waiting = performance.now();
      let warm: CheckSnapshot | undefined;
      try { warm = await base; }
      catch (error) {
        // Another check's setup failed; this worker sets up again itself, as it would have on its own.
        if (executed || !(error instanceof CheckSnapshotError) || this.context.signal?.aborted) throw error;
        lane.write(`snapshot ${profile.id}: shared setup failed (${error.code}); setting up again`);
      }
      if (!executed) onPhase("warm-base-wait", performance.now() - waiting);
      if (warm && !warm.clonable) {
        // The setup wrote the base's own path into it, so clones would still share the base through it.
        clone = "path-bound";
        lane.write(`snapshot ${profile.id}: setup wrote its own path into the tree; each worker builds its own`);
        if (executed) return acquired(warm, { action: "executed", snapshot: "built", clone });
      } else if (warm) {
        try { return acquired(await warm.clone(method, onPhase), { action: executed ? "executed" : "reused", snapshot: "cloned", clone: method }); }
        catch (error) {
          if (!(error instanceof CheckSnapshotError) || this.context.signal?.aborted) throw error;
          // The base stays for other workers; this one sets up its own tree, as without cloning.
          lane.write(`snapshot ${profile.id}: clone unavailable; ${error.code}`);
        }
      }
    }
    // A dependency result belongs to this attempt only for the first setup it ran.
    onSetup({ action: "executed", snapshot: "built", clone });
    return acquired(await build(executed ? undefined : onDependencyResult), { action: "executed", snapshot: "built", clone });
  }
  private scheduleCapture<T>(task: () => Promise<T>, executionStage = false): Promise<T> {
    if (this.cleanupStarted || (!this.capturePhaseOpen && !executionStage)) return Promise.reject(new CheckSnapshotError("installed_data_capture_closed", "Resource capture must finish before execution or cleanup begins."));
    const accepted = this.capturing(task);
    this.captureTail = accepted.catch(() => undefined);
    return accepted;
  }
  private sourceTree(sha: string): Promise<InstalledDataSourceTree> {
    if (sha === this.candidate.treeSha) return Promise.resolve(this.candidateSource);
    let tree = this.sourceTreeCache.get(sha);
    if (!tree) {
      tree = (async () => {
        const listing = await runGitCommand(["git", "ls-tree", "-r", "--name-only", "-z", sha], { cwd: this.context.rootDir });
        if (listing.exitCode !== 0) throw new CheckSnapshotError("installed_data_source_unqualified", "Cannot enumerate installed resource source inputs.");
        return { inventory: listing.stdout.split("\0").filter(Boolean), read: await candidateTreeSourceReader(this.context.rootDir, sha) };
      })();
      this.sourceTreeCache.set(sha, tree);
    }
    return tree;
  }
  private async sourceTrees() {
    return this.sourceFrames ??= (async () => ({ base: await this.sourceTree(this.candidate.base.mergeBaseSha), candidate: this.candidateSource }))();
  }
  private async captureResourceFacts(providerId: string, requests: readonly InstalledDataResourceRequest[], context: InstalledDataResourceContext, lane: Lane = this.serial) {
    const provider = this.context.config.providers.find(p => p.id === providerId);
    const profile = this.context.config.scopedExecution?.profiles.find(p => p.id === provider?.check?.scope?.profile);
    if (!provider?.check?.scope || !profile || !this.identities.has(providerId)) throw new CheckSnapshotError("scoped_executor_required", "Installed resources require an already configured scoped provider and profile.");
    const normalized = normalizeInstalledDataResourceRequests(requests);
    try {
      const { snapshot, sharedOutputs } = await this.acquireSnapshot(profile, lane, undefined, provider.check.physicalSource);
      // Prior checks have already retained their outputs. Resource observation
      // reads immutable package DATA, so remove permitted mutable products first
      // and retain the observer's strict source/dependency verification.
      for (const output of sharedOutputs) await rm(path.join(snapshot.rootDir, output), { recursive: true, force: true });
      const capture = await captureOwnedInstalledDataResources(snapshot, normalized, context, this.context.signal ? { signal: this.context.signal } : {});
      return { capture, snapshot };
    } catch (error) {
      const key = setupKey(profile, provider.check.physicalSource), damaged = lane.snapshots.get(key);
      // Keep a failed cleanup in the pool so final cleanup can retry it.
      await damaged?.cleanup();
      lane.snapshots.delete(key);
      throw error;
    }
  }
  /** Native resource facts only: caller-supplied context never seeds applicability. */
  captureInstalledData(providerId: string, requests: readonly InstalledDataResourceRequest[], context: InstalledDataResourceContext): Promise<InstalledDataResourceCapture> {
    return this.scheduleCapture(async () => (await this.captureResourceFacts(providerId, requests, context)).capture);
  }
  /** Derive authority from the configured consumer and immutable native source frames.
   * Matching resources do not make the prior full-Git check attempt current. */
  captureInstalledDataFor(providerId: string) {
    return this.scheduleCapture(() => this.captureDeclaredInstalledData(providerId));
  }
  private async captureDeclaredInstalledData(providerId: string, lane: Lane = this.serial) {
      const provider = this.context.config.providers.find(p => p.id === providerId);
      if (!provider?.check?.installedData || !this.observations.has(providerId)) throw new CheckSnapshotError("installed_data_source_unqualified", "A configured installed data consumer is required.");
      const binding = await captureInstalledDataBinding(this.context.config, provider, this.candidate, this.observations.get(providerId)!, await this.sourceTrees(), await candidateTreeEvidenceReader(this.context.rootDir, this.candidate.treeSha));
      const { capture, snapshot } = await this.captureResourceFacts(providerId, binding.declaration.requests, binding.context, lane);
      this.installed.set(providerId, { binding: structuredClone(binding), capture: structuredClone(capture), snapshot });
      // A newer running, failed or unqualified pass fences older successful history.
      const latest = (await this.locked(() => this.stores.get(providerId)!.read())).at(-1);
      const origin = latest && this.resourceOrigin(latest);
      const match = matchResourceApplicabilityProjection(latest?.payload?.resourceApplicability, { consumerId: binding.declaration.consumerId, declarationDigest: binding.declarationDigest, sourceApplicabilityDigest: binding.sourceApplicabilityDigest, capture, originAttempt: origin ?? null });
      return { capture, ...match };
  }
  /** Reuse only an already accepted same-candidate applicability observation.
   * New source candidates still require fresh native installed-resource capture. */
  private async acceptedResourceBindings() {
    return this.retainedResourceBindings ??= (async () => {
      const bindings: Record<string, ResourceApplicabilityBinding> = {};
      const wiring = await this.context.wire();
      for (const obligation of this.context.config.obligations.filter(o => o.acceptedPayloadSpecs.includes("installed-data.applicable/1"))) {
        const found = await discoverRecords(this.context.rootDir, { ...wiring.storageOptions, gateId: this.context.config.gateId, obligationId: obligation.id });
        for (const record of found.records) {
          if (record.resolution.kind !== "evidence" || !record.resolution.resourceBinding || !record.resolution.portable || !isRecordFreshForCandidate(this.context.config, record.candidateBinding, this.candidate)) continue;
          const id = record.resolution.providerId, provider = this.context.config.providers.find(p => p.id === id);
          if (!provider?.check?.installedData || !this.observations.has(id)) continue;
          try {
            if (record.candidateBinding.treeSha !== this.candidate.treeSha) {
              const diff = await runGitCommand(["git", "diff", "--name-only", "--no-renames", "-z", record.candidateBinding.treeSha, this.candidate.treeSha], { cwd: this.context.rootDir });
              if (diff.exitCode !== 0 || diff.stdout.split("\0").filter(Boolean).some(file => !isRecordNeutralPath(this.context.config, file))) continue;
            }
            const contents = portableArtifactContents(record.resolution.portable.artifacts);
            if (contents.blockers.length) continue;
            const proof = JSON.parse(contents.artifacts.get("resource-proof.json") ?? "null");
            if (digestCanonical(proof?.observation) !== digestCanonical(this.observations.get(id))) continue;
            const reconstructed = await reconstructResourceApplicability(this.context.config, provider, { ...this.candidate, treeSha: record.candidateBinding.treeSha }, proof, sha => this.sourceTree(sha), await candidateTreeEvidenceReader(this.context.rootDir, this.candidate.treeSha));
            if (digestCanonical(reconstructed.binding) === digestCanonical(record.resolution.resourceBinding)) bindings[id] = reconstructed.binding;
          } catch { /* Invalid retained authority supplies no skip; normal admission/fallback remains. */ }
        }
      }
      return bindings;
    })();
  }
  /** Current native origin precedence is rechecked on each admission/submission. */
  async resourceBindings(): Promise<Readonly<Record<string, ResourceApplicabilityBinding>>> {
    const bindings: Record<string, ResourceApplicabilityBinding> = { ...await this.acceptedResourceBindings() };
    for (const id of Object.keys(bindings)) {
      const latest = (await this.locked(() => this.stores.get(id)!.read())).at(-1);
      const origin = latest && this.resourceOrigin(latest);
      if (!origin || !latest?.payload?.resourceApplicability || digestCanonical(origin) !== bindings[id]!.originDigest) delete bindings[id];
    }
    for (const [id, current] of this.installed) {
      const latest = (await this.locked(() => this.stores.get(id)!.read())).at(-1);
      const origin = latest && this.resourceOrigin(latest), projection = latest?.payload?.resourceApplicability;
      if (!origin || !projection) continue;
      const { binding, capture } = current;
      if (!matchResourceApplicabilityProjection(projection, { consumerId: binding.declaration.consumerId, declarationDigest: binding.declarationDigest, sourceApplicabilityDigest: binding.sourceApplicabilityDigest, capture, originAttempt: origin }).applicable) continue;
      const provider = this.context.config.providers.find(p => p.id === id)!;
      bindings[id] = createResourceApplicabilityBinding({ candidateDigest: digestCanonical(scopedCandidate(this.candidate)), definitionDigest: digestCanonical(recordOutputProvider(provider, deliveryRecordPathFor(this.context.config, this.candidate.deliverable.digest)).check),
        declarationDigest: binding.declarationDigest, sourceApplicabilityDigest: binding.sourceApplicabilityDigest, capture, projection, originAttempt: origin });
    }
    return bindings;
  }
  /** Publish a current applicability outcome, with no allocation or consumer pass. */
  async publishInstalledDataApplicability(providerId: string, obligationIds: readonly string[]): Promise<void> {
    const current = this.installed.get(providerId);
    if (!current) throw new CheckSnapshotError("installed_data_source_unqualified", "Native resource capture is required before applicability publication.");
    await current.snapshot.verify({ outputs: this.profileOf(providerId).mutableOutputs });
    const binding = (await this.resourceBindings())[providerId];
    const origin = (await this.locked(() => this.stores.get(providerId)!.read())).at(-1);
    if (!binding || !origin?.payload?.resourceApplicability || digestCanonical(origin.payload.resourceApplicability.origin) !== binding.originDigest)
      throw new CheckSnapshotError("check_attempt_superseded", "Native resource origin changed before applicability publication.");
    const runId = randomUUID(), finalPassId = "applicability-1", c = this.candidate;
    const allocation = await this.context.artifacts.allocateRunRoot({ providerId, runId });
    if (!allocation.ok) throw new CheckSnapshotError("check_artifact_unavailable", "Cannot allocate resource applicability evidence.");
    const artifacts: { path: string; sha256: string; role: string }[] = [];
    const write = async (name: string, value: unknown, role: string) => { const text = JSON.stringify(value); await this.context.artifacts.writeTextFile(path.join(allocation.runRoot.path, name), text); artifacts.push({ path: name, sha256: sha256Hex(text), role }); };
    const claim = { verdict: "applicable", binding };
    await write("resource-result.json", { providerId, runId, finalPassId, ...claim }, "resource-result");
    await write("resource-proof.json", { version: "installed-data-proof/1", observation: this.observations.get(providerId), origin }, "resource-proof");
    const manifest = { spec: "delivery-evidence/1", provider: { id: providerId, runId, finalPassId }, candidate: { vcs: "git", treeSha: c.treeSha, headSha: c.headSha, deliverable: c.deliverable, base: c.base, workspaceId: c.workspaceId },
      runHistory: [{ preparedTreeSha: c.treeSha, evaluatedInPassId: finalPassId }], artifacts, attestation: { level: "self", signatures: [] }, recordedAt: new Date().toISOString(),
      claims: obligationIds.map(obligation => ({ obligation, payloadSpec: "installed-data.applicable/1", payload: claim })) };
    const manifestPath = path.join(allocation.runRoot.path, "manifest.json"); await this.context.artifacts.writeTextFile(manifestPath, JSON.stringify(manifest));
    const wiring = await this.context.wire();
    const submitted = await this.publishing(async () => submitManifest({ rootDir: this.context.rootDir, config: this.context.config, manifestPath }, {
      captureCandidate: wiring.captureCandidate, artifacts: this.context.artifacts, ...wiring.storageOptions, scopedPlan: await this.plan(), readOutput: this.readOutput, resourceBindings: await this.resourceBindings(),
    }));
    if (submitted.status !== "accepted") throw new CheckSnapshotError("check_evidence_rejected", submitted.blockers.map(b => b.code).join(", "));
    this.context.write(`applicable ${providerId}: matching native source/resources; consumer command omitted; origin ${origin.attempt.attemptId}`);
  }
  private resourceOrigin(row: StoredAttempt): InstalledDataAttemptOrigin | undefined {
    if (row.attempt.status !== "passed" || !row.executionHeadSha) return undefined;
    const a = row.attempt;
    return { providerId: a.providerId, runId: a.origin.runId, attemptId: a.attemptId, generation: a.generation, inputDigest: a.inputDigest, profileDigest: a.profileDigest,
      source: { headSha: row.executionHeadSha, treeSha: a.origin.candidate.treeSha }, status: "passed", superseded: false };
  }
  private async closeCapturePhase(): Promise<void> {
    this.capturePhaseOpen = false;
    await this.captureTail;
  }
  private acceptsApplicability(provider: ProviderRegistration, obligationIds: readonly string[]): boolean {
    return provider.check?.installedData !== undefined && obligationIds.length > 0 && obligationIds.every(id => this.context.config.obligations.find(o => o.id === id)?.acceptedPayloadSpecs.includes("installed-data.applicable/1"));
  }
  private onWorker<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
    let locked = this.executionLocks.get(lane.snapshots);
    if (!locked) { locked = oneAtATime(); this.executionLocks.set(lane.snapshots, locked); }
    const running = locked(task);
    this.executionTails.set(lane.snapshots, running.catch(() => undefined));
    return running;
  }
  execute(provider: ProviderRegistration, obligationIds: readonly string[], deferSubmission = false, lane: Lane = this.serial): Promise<void> {
    this.capturePhaseOpen = false;
    return this.onWorker(lane, async () => {
      if (!deferSubmission && this.acceptsApplicability(provider, obligationIds)) {
        await this.closeCapturePhase();
        let applicable = false;
        try {
          // Resolve at this consumer's execution stage, after preceding checks.
          // Its capture and cold command stay on one worker without changing
          // serial snapshot eviction or adding a second resource cache.
          applicable = (await this.scheduleCapture(() => this.captureDeclaredInstalledData(provider.id, lane), true)).applicable;
        } catch (error) {
          if (this.context.signal?.aborted || this.cleanupStarted) throw error;
          lane.write(`resource fallback ${provider.id}: ${error instanceof Error ? error.message : "capture unavailable"}`);
        }
        if (applicable) { await this.publishInstalledDataApplicability(provider.id, obligationIds); return; }
      }
      await this.executeInLane(provider, obligationIds, deferSubmission, lane);
    });
  }
  private async executeInLane(provider: ProviderRegistration, obligationIds: readonly string[], deferSubmission: boolean, lane: Lane): Promise<void> {
    await this.closeCapturePhase();
    const started = Date.now(), check = provider.check!, profile = this.context.config.scopedExecution!.profiles.find(p => p.id === check.scope!.profile)!;
    const attempt = this.owned.get(provider.id) ?? await this.allocate(provider.id);
    // Phases up to the command are this attempt's setup; the only verification among them is pre-command.
    const phases: { phase: ScopedSetupDiagnostic["phases"][number]["phase"]; durationMs: number }[] = [];
    let settingUp = true;
    this.phaseWriters.set(lane.snapshots, (phase, durationMs) => {
      if (settingUp) phases.push({ phase: (phase === "verification" ? "pre-command-verification" : phase) as ScopedSetupDiagnostic["phases"][number]["phase"], durationMs: Math.round(durationMs) });
      lane.write(`snapshot ${provider.id}: attempt ${attempt.attemptId}; ${phase} ${Math.round(durationMs)}ms`);
    });
    let payload: AttemptPayload = { outputs: [] }, terminal = false;
    let diagnostic: RecordedScopedAttemptDiagnostic = { availability: "available", phase: "snapshot-setup", failure: { unavailable: "not-failed" }, command: { unavailable: "not-started" } };
    let executionErrorCode: string | undefined;
    const store = this.stores.get(provider.id)!;
    const secrets = check.scope!.environment.filter(e => e.kind === "credential").map(e => this.context.env[e.name]).filter((v): v is string => !!v);
    try {
      // A reused tree is verified as its kind allows: from the index, or (a finite tree) by its inventory.
      const verificationOf = (setup: AcquiredSetup) => setup.snapshot === "built" || check.physicalSource ? "inventory" as const : "index" as const;
      const { snapshot, sharedOutputs, setup } = await this.acquireSnapshot(profile, lane,
        (result, durationMs) => { diagnostic = { ...diagnostic, dependency: scopedDependencyDiagnostic(result, durationMs, secrets) }; }, check.physicalSource,
        setup => { diagnostic = { ...diagnostic, setup: { ...setup, verification: verificationOf(setup), phases } }; });
      const verification = setup.snapshot === "built" ? "inventory" : snapshot.reusedVerification;
      diagnostic = { ...diagnostic, phase: "pre-command-verification", setup: { ...setup, verification, phases } };
      // A sibling or dependency setup cannot supply this command's result, and
      // another profile's outputs are not this profile's to read or write.
      const removed = [...check.outputs ?? [], ...sharedOutputs.filter(o => !profile.mutableOutputs.includes(o))];
      const remove = async () => { for (const output of removed) await rm(path.join(snapshot.rootDir, output), { recursive: true, force: true }); };
      if (verification === "index") {
        // Checked before removal, so a stray write to an output no check here produced is refused, not erased.
        await snapshot.verify({ outputs: profile.mutableOutputs, unchanged: { allowed: [...profile.mutableOutputs, ...this.ranOutputs.get(snapshot) ?? []] } });
        await remove();
      } else { await remove(); await snapshot.verify({ outputs: profile.mutableOutputs }); }
      settingUp = false;
      lane.write(`setup ${provider.id}: attempt ${attempt.attemptId}; ${setup.action} on a ${setup.snapshot} tree (clone ${setup.clone}), ${verification} verification; ${Date.now() - started}ms`);
      const injected = Object.fromEntries(check.scope!.environment.filter(e => this.context.env[e.name] !== undefined).map(e => [e.name, this.context.env[e.name]!]));
      lane.write(`checking ${provider.id}: attempt ${attempt.attemptId}`);
      diagnostic = { ...diagnostic, phase: "command" };
      const commandHome = path.join(snapshot.commandRoot, attempt.attemptId, "home"), commandTemp = path.join(snapshot.commandRoot, attempt.attemptId, "tmp");
      await mkdir(commandHome, { recursive: true }); await mkdir(commandTemp, { recursive: true });
      diagnostic = { ...diagnostic, command: { unavailable: "not-completed" } };
      const result = await createExecPort().run({ command: check.command[0], args: check.command.slice(1), cwd: path.join(snapshot.rootDir, check.scope!.cwd), env: { ...snapshot.environment, ...injected, HOME: commandHome, TMPDIR: commandTemp }, timeoutMs: check.timeoutMs, maxBuffer: 1024 * 1024, ...(this.context.signal ? { signal: this.context.signal } : {}) });
      executionErrorCode = result.errorCode;
      diagnostic = { ...diagnostic, command: scopedCommandDiagnostic(result, secrets) };
      payload = { outputs: [], durationMs: Date.now() - started, log: redactScopedStreams(result, secrets).slice(-4000), dependencyDigest: snapshot.dependencyDigest };
      if (result.code !== 0 || this.context.signal?.aborted) throw new CheckSnapshotError("check_command_failed", `Declared scoped check ${provider.id} did not complete successfully (exit ${result.code}).`);
      diagnostic = { ...diagnostic, phase: "post-command-verification" };
      await snapshot.verify({ outputs: profile.mutableOutputs });
      const ran = this.ranOutputs.get(snapshot) ?? new Set<string>();
      for (const output of profile.mutableOutputs) ran.add(output);
      this.ranOutputs.set(snapshot, ran);
      diagnostic = { ...diagnostic, phase: "output-capture" };
      const outputs = await captureCheckOutputSnapshots(snapshot.rootDir, check.outputs ?? []);
      if (!outputs || outputs.some(o => secrets.some(secret => Buffer.from(o.base64, "base64").includes(Buffer.from(secret))))) throw new CheckSnapshotError("check_output_missing", "A retained output is absent, corrupt, escaped or contains credential bytes.");
      payload = { ...payload, outputs, diagnostic: { ...diagnostic, phase: "complete" } };
      const installed = this.installed.get(provider.id);
      // Only the same owned snapshot that supplied the facts can seed a pass.
      if (installed?.snapshot === snapshot) payload = { ...payload, resourceScope: structuredClone(check.scope!), resourceApplicability: createResourceApplicabilityProjection({
        origin: this.resourceOrigin({ attempt: { ...attempt, status: "passed" }, executionHeadSha: this.candidate.headSha })!,
        consumerId: installed.binding.declaration.consumerId, declarationDigest: installed.binding.declarationDigest,
        sourceApplicabilityDigest: installed.binding.sourceApplicabilityDigest, capture: installed.capture,
      }) };
      await store.finish(attempt, "passed", payload); terminal = true;
      const scopedPlan = await this.plan();
      const wiring = await this.context.wire();
      const binding = (await captureCheckBindings(this.context.rootDir, this.context.config, this.candidate, { ...wiring.storageOptions, scopedPlan, readOutput: this.readOutput }))[provider.id];
      if (!binding || binding.scopedAttemptDigest !== digestCanonical({ ...attempt, status: "passed" })) throw new CheckSnapshotError("check_attempt_superseded", "A newer attempt superseded this completion before evidence publication.");
      const runId = attempt.attemptId, finalPassId = "pass-1";
      const allocation = await this.context.artifacts.allocateRunRoot({ providerId: provider.id, runId });
      if (!allocation.ok) throw new CheckSnapshotError("check_artifact_unavailable", "Cannot allocate scoped check evidence.");
      const artifacts: { path: string; sha256: string; role: string }[] = [];
      const write = async (name: string, value: unknown, role: string) => { const text = JSON.stringify(value); await this.context.artifacts.writeTextFile(path.join(allocation.runRoot.path, name), text); artifacts.push({ path: name, sha256: sha256Hex(text), role }); };
      for (const [index, output] of outputs.entries()) await write(`check-output-${index}.json`, { path: output.path, base64: output.base64 }, "check-output");
      const claim = { verdict: "green", exitCode: 0, binding };
      await write("check-result.json", { providerId: provider.id, runId, finalPassId, ...claim }, "check-result");
      await write("scoped-inputs.json", { observation: this.observations.get(provider.id), attempt: { ...attempt, status: "passed" }, durationMs: payload.durationMs, dependencyDigest: payload.dependencyDigest, ...(payload.resourceApplicability ? { resourceApplicability: payload.resourceApplicability } : {}) }, "scoped-inputs");
      const c = this.candidate;
      const manifest = { spec: "delivery-evidence/1", provider: { id: provider.id, runId, finalPassId }, candidate: { vcs: "git", treeSha: c.treeSha, headSha: c.headSha, deliverable: c.deliverable, base: c.base, workspaceId: c.workspaceId }, runHistory: [{ preparedTreeSha: c.treeSha, evaluatedInPassId: finalPassId }], artifacts, attestation: { level: "self", signatures: [] }, recordedAt: new Date().toISOString(), claims: obligationIds.map(obligation => ({ obligation, payloadSpec: "checks.passed/1", payload: claim })) };
      const manifestPath = path.join(allocation.runRoot.path, "manifest.json"); await this.context.artifacts.writeTextFile(manifestPath, JSON.stringify(manifest));
      const submit = () => this.publishing(async () => {
      const outcome = await submitManifest({ rootDir: this.context.rootDir, config: this.context.config, manifestPath }, { captureCandidate: wiring.captureCandidate, artifacts: this.context.artifacts, ...wiring.storageOptions, scopedPlan: await this.plan(), readOutput: this.readOutput, resourceBindings: await this.resourceBindings() });
      if (outcome.status !== "accepted") throw new CheckSnapshotError("check_evidence_rejected", outcome.blockers.map(b => b.code).join(", "));
      });
      if (deferSubmission) this.submissions.push(submit); else await submit();
      lane.write(`passed ${provider.id}: ${Date.now() - started}ms including snapshot setup; retained ${runId}`);
    } catch (error) {
      const status = this.context.signal?.aborted ? "interrupted" : "failed";
      if (!terminal) await store.finish(attempt, status, { ...payload, durationMs: Date.now() - started,
        diagnostic: { ...diagnostic, failure: scopedDiagnosticFailure(error, executionErrorCode) },
        ...(error instanceof CheckSnapshotError ? { log: `${payload.log ?? ""}\n${error.code}`.slice(-4000) } : {}) });
      // Setup failures report the dependency command that ran; every other failure reports the check's own.
      const ran = diagnostic.phase === "snapshot-setup" && diagnostic.dependency
        ? { argv: profile.dependencies!.command, cwd: ".", result: diagnostic.dependency.command } : { argv: check.command, cwd: check.scope!.cwd, result: diagnostic.command };
      lane.write([`${status} ${provider.id}: ${error instanceof CheckSnapshotError ? error.code : "unclassified"}; attempt ${attempt.attemptId} retained at ${store.terminalPath(attempt)}`,
        `  command (cwd ${ran.cwd}): ${ran.argv.map(shownArgument).join(" ")}`,
        ...("unavailable" in ran.result ? [`  output ${ran.result.unavailable}`]
          : [`  exit ${ran.result.exitCode ?? "unavailable"}; output tail (last 40 lines):`, ...ran.result.outputTail.trimEnd().split("\n").slice(-40).map(line => `    ${line}`)])].join("\n"));
      const damaged = lane.snapshots.get(setupKey(profile, check.physicalSource));
      lane.snapshots.delete(setupKey(profile, check.physicalSource));
      await damaged?.cleanup();
      throw error;
    }
  }
  async cleanup(): Promise<void> {
    this.cleanupStarted = true;
    await this.closeCapturePhase();
    await Promise.all(this.executionTails.values());
    for (const snapshots of this.workers) { for (const snapshot of snapshots.values()) await snapshot.cleanup(); snapshots.clear(); }
    const bases = [...this.bases.values()]; this.bases.clear();
    for (const base of bases) await (await base.catch(() => undefined))?.cleanup();
  }
}
