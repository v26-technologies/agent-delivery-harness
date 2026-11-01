/** Durable per-check history; allocation order, never completion time, owns precedence. */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestCanonical, validateResourceApplicabilityProjection, type ResourceApplicabilityProjection, type ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
import { CheckSnapshotError } from "./check-snapshot.ts";
import type { RecordedScopedAttemptDiagnostic } from "./scoped-diagnostics.ts";
export interface AttemptPayload {
  readonly outputs: readonly { readonly path: string; readonly base64: string; readonly sha256: string }[];
  readonly durationMs?: number;
  readonly dependencyDigest?: string;
  readonly log?: string;
  readonly diagnostic?: RecordedScopedAttemptDiagnostic;
  /** Native successful origin binding is checked before retention and on every load. */
  readonly resourceApplicability?: ResourceApplicabilityProjection;
}
export interface StoredAttempt { readonly attempt: ScopedCheckAttempt; readonly payload?: AttemptPayload; readonly executionHeadSha?: string }
const corrupt = () => new CheckSnapshotError("check_attempt_corrupt", "Scoped check attempt history is missing, corrupt or inconsistent.");
const gitSha = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
/** Shape validation alone is not authority: bind to the native running allocation. */
function validateResourceOrigin(row: StoredAttempt): void {
  if (row.executionHeadSha !== undefined && !gitSha(row.executionHeadSha)) throw corrupt();
  const resource = row.payload?.resourceApplicability;
  if (resource === undefined) return;
  if (row.attempt.status !== "passed" || !row.executionHeadSha) throw corrupt();
  try {
    const projection = validateResourceApplicabilityProjection(resource);
    const attempt = row.attempt;
    const origin = { providerId: attempt.providerId, runId: attempt.origin.runId, attemptId: attempt.attemptId,
      generation: attempt.generation, inputDigest: attempt.inputDigest, profileDigest: attempt.profileDigest,
      source: { headSha: row.executionHeadSha, treeSha: attempt.origin.candidate.treeSha }, status: "passed", superseded: false };
    if (digestCanonical(projection.origin) !== digestCanonical(origin)) throw corrupt();
  } catch { throw corrupt(); }
}
export class AttemptStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  private async generations(): Promise<number[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (names.some(n => !/^[1-9][0-9]*$/.test(n) || !Number.isSafeInteger(Number(n)))) throw corrupt();
    return names.map(Number).sort((a, b) => a - b);
  }
  async allocate(input: Omit<ScopedCheckAttempt, "attemptId" | "generation" | "status">, options: { readonly executionHeadSha?: string } = {}): Promise<ScopedCheckAttempt> {
    if (options.executionHeadSha !== undefined && !gitSha(options.executionHeadSha)) throw corrupt();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let generation = Math.max(0, ...await this.generations()) + 1;
    for (;;) {
      const dir = path.join(this.root, String(generation));
      try { await mkdir(dir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { generation++; continue; } throw error; }
      const attempt: ScopedCheckAttempt = { ...input, generation, attemptId: randomUUID(), status: "running" };
      await this.publish(path.join(dir, "running.json"), { attempt, ...(options.executionHeadSha !== undefined ? { executionHeadSha: options.executionHeadSha } : {}) });
      return attempt;
    }
  }
  private async publish(target: string, entry: StoredAttempt): Promise<void> {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ digest: digestCanonical(entry), entry }), { flag: "wx", mode: 0o600 });
      // Linking a complete private file publishes atomically without replacing an
      // already-published terminal result from this or a competing invocation.
      await link(temp, target);
    } finally { await unlink(temp).catch(() => undefined); }
  }
  async finish(attempt: ScopedCheckAttempt, status: "passed" | "failed" | "interrupted", payload: AttemptPayload): Promise<void> {
    const rows = await this.read();
    const running = rows.find(row => row.attempt.generation === attempt.generation);
    if (running?.attempt.status !== "running" || digestCanonical(running.attempt) !== digestCanonical(attempt)) throw corrupt();
    const terminal: StoredAttempt = { attempt: { ...attempt, status }, payload,
      ...(running.executionHeadSha !== undefined ? { executionHeadSha: running.executionHeadSha } : {}) };
    validateResourceOrigin(terminal);
    await this.publish(this.terminalPath(attempt), terminal);
  }
  terminalPath(attempt: ScopedCheckAttempt): string { return path.join(this.root, String(attempt.generation), "terminal.json"); }
  private async load(file: string): Promise<StoredAttempt> {
    const raw = JSON.parse(await readFile(file, "utf8")) as { digest?: string; entry?: StoredAttempt };
    const row = raw.entry;
    const attempt = row?.attempt;
    const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
    const candidate = attempt?.origin?.candidate;
    if (!row || !attempt || raw.digest !== digestCanonical(row) || attempt.version !== "scoped-attempt/1" ||
        !nonempty(attempt.attemptId) || !nonempty(attempt.providerId) || !nonempty(attempt.origin?.runId) ||
        !Number.isSafeInteger(attempt.generation) || attempt.generation < 1 ||
        !["running", "passed", "failed", "interrupted"].includes(attempt.status) ||
        ![attempt.inputDigest, attempt.profileDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
        !candidate || ![candidate.treeSha, candidate.deliverableDigest, candidate.identityToken, candidate.baseRef,
          candidate.baseTipSha, candidate.mergeBaseSha, candidate.workspaceId].every(nonempty)) throw corrupt();
    if (row.payload?.durationMs !== undefined && (typeof row.payload.durationMs !== "number" || !Number.isFinite(row.payload.durationMs) || row.payload.durationMs < 0)) throw corrupt();
    validateResourceOrigin(row);
    return row;
  }
  async read(): Promise<StoredAttempt[]> {
    try {
      const rows: StoredAttempt[] = [];
      for (const generation of await this.generations()) {
        const dir = path.join(this.root, String(generation));
        const start = await this.load(path.join(dir, "running.json"));
        if (start.attempt.status !== "running" || start.attempt.generation !== generation) throw corrupt();
        let terminal: StoredAttempt | undefined;
        try { terminal = await this.load(path.join(dir, "terminal.json")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (terminal && (terminal.executionHeadSha !== start.executionHeadSha || terminal.attempt.status === "running" || digestCanonical({ ...terminal.attempt, status: "running" }) !== digestCanonical(start.attempt))) throw corrupt();
        rows.push(terminal ?? start);
      }
      return rows;
    } catch { throw corrupt(); }
  }
}
