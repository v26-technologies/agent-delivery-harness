/** Invocation-scoped execution coordinator; durable truth remains per-check evidence. */
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { computeDeliverableIdentity, captureCheckBindings, captureCheckOutputSnapshots, candidateTreeEvidenceReader, candidateTreeSourceReader, createExecPort, digestCanonical, resolveRecordStorage, runGitCommand, scopedCheckIdentity, selectScopedCheckAttempt, sha256Hex, submitManifest,
  type CandidateBinding, type CapturedCandidate, type ProviderRegistration, type ScopedCheckPlan, type ScopedExecutionProfile, type ScopedRuntimeObservation, type RecordCandidateBinding } from "@agent-delivery-harness/kernel";
import type { CommandContext } from "./boundary.ts";
import { AttemptStore, type AttemptPayload, type StoredAttempt } from "./scoped-attempts.ts";
import { CheckSnapshotError, createCheckSnapshot, executionPath, type CheckSnapshot } from "./check-snapshot.ts";
import { redactScopedStreams, scopedCommandDiagnostic, scopedDependencyDiagnostic, scopedDiagnosticFailure, type RecordedScopedAttemptDiagnostic } from "./scoped-diagnostics.ts";
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
function setupKey(profile: ScopedExecutionProfile): string {
  return digestCanonical({ dependencies: profile.dependencies ?? null, dependencyInputs: [...profile.dependencyInputs].sort(), gitContext: profile.gitContext ?? "full" });
}
const shownArgument = (argument: string) => /^[\w@%+=:,./-]+$/.test(argument) ? argument : JSON.stringify(argument);
/** Runs the tasks it is given one at a time, in call order. */
function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => { const result = tail.then(task); tail = result.catch(() => undefined); return result; };
}
/** One worker's view while it runs a check: the snapshots only it uses, by setup key, and where its lines go. */
interface Lane { readonly snapshots: Map<string, CheckSnapshot>; readonly write: (text: string) => void }
export class ScopedChecks {
  /** `scopedExecution.concurrency` workers, each owning its snapshots; the first is the serial lane. */
  private readonly workers: Map<string, CheckSnapshot>[];
  readonly concurrency: number;
  /** Attempt allocation is two writes, so readers of attempt history wait for it to finish. */
  private readonly locked = oneAtATime();
  /** Evidence submission captures the candidate through the author's Git index, which one writer may hold. */
  private readonly publishing = oneAtATime();
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
  static async create(context: CommandContext, candidate: CapturedCandidate): Promise<ScopedChecks | undefined> {
    const providers = context.config.providers.filter(p => p.check?.scope);
    if (!providers.length) return undefined;
    if (context.config.scopedExecution?.version !== "scoped-execution/1") throw new CheckSnapshotError("scoped_executor_required", "Scoped checks require supported private execution profiles before preparation.");
    const session = new ScopedChecks(context, candidate);
    const storage = await resolveRecordStorage(context.rootDir, { storageNamespace: context.config.storageNamespace, leaf: "scoped-attempts" });
    const read = await candidateTreeSourceReader(context.rootDir, candidate.treeSha);
    const readEvidence = await candidateTreeEvidenceReader(context.rootDir, candidate.treeSha);
    const listing = await runGitCommand(["git", "ls-tree", "-r", "--name-only", "-z", candidate.treeSha], { cwd: context.rootDir });
    if (listing.exitCode !== 0) throw new CheckSnapshotError("check_snapshot_unavailable", "Cannot enumerate the prepared source tree.");
    const inventory = listing.stdout.split("\0").filter(Boolean);
    const validationConfig = { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral };
    const validationTrees = new Map<string, Promise<string>>();
    const validation = (treeSha: string) => {
      let digest = validationTrees.get(treeSha);
      if (!digest) { digest = computeDeliverableIdentity({ rootDir: context.rootDir, treeSha, config: validationConfig }); validationTrees.set(treeSha, digest); }
      return digest;
    };
    for (const provider of providers) {
      const scope = provider.check!.scope!, profile = context.config.scopedExecution.profiles.find(p => p.id === scope.profile)!;
      if (!profile) throw new CheckSnapshotError("scoped_executor_required", "A selected execution profile is unsupported.");
      if (profile.mutableOutputs.some(o => inventory.some(f => f === o.replace(/\/$/, "") || f.startsWith(`${o.replace(/\/$/, "")}/`)))) throw new CheckSnapshotError("check_output_overlaps_source", "Mutable outputs overlap prepared source.");
      if ((provider.check!.outputs ?? []).some(o => !profile.mutableOutputs.some(m => m.endsWith("/") ? o.startsWith(m) : o === m))) throw new CheckSnapshotError("check_output_undeclared", "Every retained output must be declared mutable in its profile.");
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
    const attempt = await this.locked(() => this.stores.get(id)!.allocate({ version: "scoped-attempt/1", providerId: id, inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, origin: { candidate: scopedCandidate(this.candidate), runId: this.runId } }));
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
      cost.set(id, last?.durationMs === undefined ? Infinity : last.durationMs - (last.diagnostic?.dependency?.durationMs ?? 0));
    }
    const [first, ...rest] = ids;
    if (first === undefined) return [];
    const byCost = [first, ...rest.sort((a, b) => cost.get(a)! === cost.get(b)! ? 0 : cost.get(a)! < cost.get(b)! ? -1 : 1)];
    const keys = byCost.map(id => setupKey(this.profileOf(id)));
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
    await this.pool(requests.map(r => r.provider.id), async (id, lane) => {
      const request = requests.find(r => r.provider.id === id)!;
      try { await this.execute(request.provider, request.obligationIds, false, lane); }
      catch (error) { if (!(error instanceof CheckSnapshotError)) throw error; failures.set(id, error); }
    });
    return requests.flatMap(r => failures.has(r.provider.id) ? [failures.get(r.provider.id)!] : []);
  }
  async submitMechanical(): Promise<void> { for (const submit of this.submissions) await submit(); this.submissions.length = 0; }
  async execute(provider: ProviderRegistration, obligationIds: readonly string[], deferSubmission = false, lane: Lane = this.serial): Promise<void> {
    const started = Date.now(), check = provider.check!, profile = this.context.config.scopedExecution!.profiles.find(p => p.id === check.scope!.profile)!;
    const attempt = this.owned.get(provider.id) ?? await this.allocate(provider.id);
    let payload: AttemptPayload = { outputs: [] }, terminal = false;
    let diagnostic: RecordedScopedAttemptDiagnostic = { availability: "available", phase: "snapshot-setup", failure: { unavailable: "not-failed" }, command: { unavailable: "not-started" } };
    let executionErrorCode: string | undefined;
    const store = this.stores.get(provider.id)!;
    const secrets = check.scope!.environment.filter(e => e.kind === "credential").map(e => this.context.env[e.name]).filter((v): v is string => !!v);
    try {
      const key = setupKey(profile);
      // Every scoped check's profile sharing this setup may write its own outputs in the shared tree;
      // only those profiles passed the overlap refusal in create().
      const sharedOutputs = [...new Set(this.context.config.scopedExecution!.profiles
        .filter(p => setupKey(p) === key && this.context.config.providers.some(q => q.check?.scope?.profile === p.id)).flatMap(p => p.mutableOutputs))];
      let snapshot = lane.snapshots.get(key);
      if (!snapshot) {
        // A single worker retains only consecutive same-setup reuse; durable outputs no longer
        // need the private tree. A pool keeps each worker's snapshots until cleanup().
        if (this.concurrency === 1) for (const [previousKey, previous] of lane.snapshots) {
          await previous.cleanup();
          lane.snapshots.delete(previousKey);
        }
        snapshot = await createCheckSnapshot({ rootDir: this.context.rootDir, candidate: this.candidate, outputs: sharedOutputs, gitContext: profile.gitContext ?? "full", environment: { PATH: this.context.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin" }, ...(profile.dependencies ? { dependencies: profile.dependencies } : {}), ...(this.context.signal ? { signal: this.context.signal } : {}),
          onPhase: (phase, durationMs) => lane.write(`snapshot ${provider.id}: attempt ${attempt.attemptId}; ${phase} ${Math.round(durationMs)}ms`),
          onDependencyResult: (result, durationMs) => { diagnostic = { ...diagnostic, dependency: scopedDependencyDiagnostic(result, durationMs, secrets) }; },
        });
        lane.snapshots.set(key, snapshot);
      }
      diagnostic = { ...diagnostic, phase: "pre-command-verification" };
      // A sibling or dependency setup cannot supply this command's result, and
      // another profile's outputs are not this profile's to read or write.
      for (const output of [...check.outputs ?? [], ...sharedOutputs.filter(o => !profile.mutableOutputs.includes(o))]) await rm(path.join(snapshot.rootDir, output), { recursive: true, force: true });
      await snapshot.verify({ outputs: profile.mutableOutputs });
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
      diagnostic = { ...diagnostic, phase: "output-capture" };
      const outputs = await captureCheckOutputSnapshots(snapshot.rootDir, check.outputs ?? []);
      if (!outputs || outputs.some(o => secrets.some(secret => Buffer.from(o.base64, "base64").includes(Buffer.from(secret))))) throw new CheckSnapshotError("check_output_missing", "A retained output is absent, corrupt, escaped or contains credential bytes.");
      payload = { ...payload, outputs, diagnostic: { ...diagnostic, phase: "complete" } };
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
      await write("scoped-inputs.json", { observation: this.observations.get(provider.id), attempt: { ...attempt, status: "passed" }, durationMs: payload.durationMs, dependencyDigest: payload.dependencyDigest }, "scoped-inputs");
      const c = this.candidate;
      const manifest = { spec: "delivery-evidence/1", provider: { id: provider.id, runId, finalPassId }, candidate: { vcs: "git", treeSha: c.treeSha, headSha: c.headSha, deliverable: c.deliverable, base: c.base, workspaceId: c.workspaceId }, runHistory: [{ preparedTreeSha: c.treeSha, evaluatedInPassId: finalPassId }], artifacts, attestation: { level: "self", signatures: [] }, recordedAt: new Date().toISOString(), claims: obligationIds.map(obligation => ({ obligation, payloadSpec: "checks.passed/1", payload: claim })) };
      const manifestPath = path.join(allocation.runRoot.path, "manifest.json"); await this.context.artifacts.writeTextFile(manifestPath, JSON.stringify(manifest));
      const submit = () => this.publishing(async () => {
      const outcome = await submitManifest({ rootDir: this.context.rootDir, config: this.context.config, manifestPath }, { captureCandidate: wiring.captureCandidate, artifacts: this.context.artifacts, ...wiring.storageOptions, scopedPlan: await this.plan(), readOutput: this.readOutput });
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
      const damaged = lane.snapshots.get(setupKey(profile));
      lane.snapshots.delete(setupKey(profile));
      await damaged?.cleanup();
      throw error;
    }
  }
  async cleanup(): Promise<void> {
    for (const snapshots of this.workers) { for (const snapshot of snapshots.values()) await snapshot.cleanup(); snapshots.clear(); }
  }
}
