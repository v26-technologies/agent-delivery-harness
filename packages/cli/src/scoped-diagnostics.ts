import path from "node:path";
import { digestCanonical, resolveRecordStorage, type ExecOutcome, type HarnessConfig, type ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
import { AttemptStore } from "./scoped-attempts.ts";
import { CheckSnapshotError } from "./check-snapshot.ts";
import { projectScopedAttempt } from "./scoped-observations.ts";

const phases = ["snapshot-setup", "pre-command-verification", "command", "post-command-verification", "output-capture", "complete"] as const;
const failureCodes = ["check_snapshot_interrupted", "check_snapshot_timeout", "check_snapshot_unavailable", "check_snapshot_escape", "check_snapshot_drift", "check_snapshot_cleanup_failed", "check_dependency_source_overlap", "check_dependency_failed", "check_command_failed", "check_output_missing", "check_attempt_superseded", "check_artifact_unavailable", "check_evidence_rejected", "check_cancelled"] as const;
const executionCodes = ["ENOENT", "EACCES", "EPERM", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "SIGKILL", "SIGTERM", "execution_failed"] as const;
export type ScopedDiagnosticPhase = typeof phases[number];
export type ScopedDiagnosticFailureCode = typeof failureCodes[number];
export type ScopedDiagnosticExecutionCode = typeof executionCodes[number];
export type ScopedDiagnosticCommand =
  | { readonly exitCode: number | null; readonly outputTail: string; readonly truncated: boolean }
  | { readonly unavailable: "not-started" | "not-completed" };
export interface ScopedDependencyDiagnostic {
  readonly durationMs: number;
  readonly executionErrorCode?: ScopedDiagnosticExecutionCode;
  readonly command: ScopedDiagnosticCommand;
}
const setupPhases = ["materialization", "baseline-inventory", "dependencies", "post-dependency-inventory", "warm-base-wait", "clone", "pre-command-verification"] as const;
/** How this attempt got the tree its command ran in, and what that cost up to the command.
 * `executed`: this attempt ran the setup (a tree it built, or the warm base it then cloned);
 * `reused`: the setup had already run (a clone of a warm base another check built, or the
 * worker's tree retained from its previous check). `clone` names the copy-on-write method, or says
 * why each worker built its own tree: cloning is unavailable here, or the setup wrote its own path
 * into the tree (`path-bound`), or there is one worker (`not-used`). */
export interface ScopedSetupDiagnostic {
  readonly action: "executed" | "reused";
  readonly snapshot: "built" | "cloned" | "retained";
  readonly clone: "clonefile" | "reflink" | "unavailable" | "path-bound" | "not-used";
  /** `index`: Git's index and untracked listing; `inventory`: every immutable byte hashed. */
  readonly verification: "index" | "inventory";
  readonly phases: readonly { readonly phase: typeof setupPhases[number]; readonly durationMs: number }[];
}
export interface RecordedScopedAttemptDiagnostic {
  readonly availability: "available";
  readonly phase: ScopedDiagnosticPhase;
  readonly failure: { readonly code: ScopedDiagnosticFailureCode; readonly executionErrorCode?: ScopedDiagnosticExecutionCode }
    | { readonly unavailable: "not-failed" | "unclassified" };
  readonly command: ScopedDiagnosticCommand;
  /** Present only when this attempt actually ran dependency setup; never borrowed from a reused snapshot. */
  readonly dependency?: ScopedDependencyDiagnostic;
  /** Present once this attempt began getting its tree, so a failed setup keeps its phases; absent on attempts recorded before setup was measured. */
  readonly setup?: ScopedSetupDiagnostic;
}
export type ScopedAttemptDiagnostic = RecordedScopedAttemptDiagnostic
  | { readonly availability: "unavailable"; readonly reason: "legacy" | "running" };
export interface ScopedCheckDiagnostics {
  readonly version: "scoped-check-diagnostics/1";
  readonly providers: readonly {
    readonly providerId: string;
    readonly attempts: readonly (ScopedCheckAttempt & { readonly durationMs?: number; readonly diagnostic: ScopedAttemptDiagnostic })[];
  }[];
  readonly unavailableAttemptIds: readonly string[];
}

export function scopedDiagnosticFailure(error: unknown, executionErrorCode?: string): RecordedScopedAttemptDiagnostic["failure"] {
  if (!(error instanceof CheckSnapshotError) || !(failureCodes as readonly string[]).includes(error.code)) return { unavailable: "unclassified" };
  return { code: error.code as ScopedDiagnosticFailureCode,
    ...((executionCodes as readonly string[]).includes(executionErrorCode ?? "") ? { executionErrorCode: executionErrorCode as ScopedDiagnosticExecutionCode } : {}) };
}
/** Shortest credential prefix masked where later output interrupts it. Any prefix
 * ending the text is masked; mid-text, a shorter run is indistinguishable from
 * ordinary output sharing a credential's leading characters. */
export const INTERRUPTED_CREDENTIAL_PREFIX = 8;
/** Masks every occurrence of each credential, overlapping ones included, and the
 * credential prefixes a writer that exits, is killed or is clipped mid-write
 * leaves behind: at the end of the text, or interrupted by whatever writes next
 * to the same stream (a wrapping shell's own output). Apply it to each captured
 * stream before joining or bounding them. */
export function redactScopedOutput(text: string, secrets: readonly string[]): string {
  // Ascending start order makes a union of overlapping spans one append-or-extend step.
  const union = (spans: [number, number][], [start, end]: [number, number]) => {
    const last = spans.at(-1);
    if (last && last[1] >= start) last[1] = Math.max(last[1], end); else spans.push([start, end]);
    return spans;
  };
  // A byte clip inside a multi-byte character decodes to U+FFFD after the prefix it cut. Counted
  // backwards: an anchored /\uFFFD+$/ backtracks quadratically over a run that does not end the text.
  let tail = text.length;
  while (tail > 0 && text.charCodeAt(tail - 1) === 0xfffd) tail--;
  const spans: [number, number][] = [];
  for (const secret of new Set(secrets.filter(Boolean))) {
    // Knuth-Morris-Pratt: linear in the output however self-similar the credential.
    const border = [0];
    for (let i = 1, k = 0; i < secret.length; i++) {
      while (k > 0 && secret.charCodeAt(i) !== secret.charCodeAt(k)) k = border[k - 1]!;
      border.push(k += secret.charCodeAt(i) === secret.charCodeAt(k) ? 1 : 0);
    }
    // The candidate match's start never moves backwards, so spans arrive in ascending start order.
    const own: [number, number][] = [];
    let matched = 0, atTail = 0;
    for (let i = 0; i < text.length; i++) {
      if (i === tail) atTail = matched;
      if (matched >= INTERRUPTED_CREDENTIAL_PREFIX && text.charCodeAt(i) !== secret.charCodeAt(matched)) union(own, [i - matched, i]);
      while (matched > 0 && text.charCodeAt(i) !== secret.charCodeAt(matched)) matched = border[matched - 1]!;
      if (text.charCodeAt(i) === secret.charCodeAt(matched)) matched++;
      if (matched === secret.length) { union(own, [i + 1 - matched, i + 1]); matched = border[matched - 1]!; }
    }
    if (tail === text.length) atTail = matched;
    for (const span of own) spans.push(span);
    // The matcher's state at the tail is the longest credential prefix ending the text.
    if (atTail > 0) spans.push([tail - atTail, text.length]);
  }
  const merged = spans.sort((a, b) => a[0] - b[0]).reduce(union, []);
  return merged.map(([start], i) => text.slice(i ? merged[i - 1]![1] : 0, start) + "[REDACTED]").join("") + text.slice(merged.at(-1)?.[1] ?? 0);
}
/** Each stream is redacted on its own: one can end inside a credential the join would hide mid-text. */
export function redactScopedStreams(result: Pick<ExecOutcome, "stdout" | "stderr">, secrets: readonly string[]): string {
  return `${redactScopedOutput(result.stdout, secrets)}\n${redactScopedOutput(result.stderr, secrets)}`;
}
export function scopedCommandDiagnostic(result: ExecOutcome, secrets: readonly string[]): ScopedDiagnosticCommand {
  // execFile can clip a fully emitted credential before full-value redaction.
  // The typed execution failure remains available; this partial capture is not safe to export.
  if (result.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { unavailable: "not-completed" };
  const numericExit = result.errorCode === undefined || result.errorCode === String(result.code);
  if (!numericExit && result.stdout.length + result.stderr.length === 0) return { unavailable: ["ENOENT", "EACCES", "EPERM"].includes(result.errorCode!) ? "not-started" : "not-completed" };
  const redacted = redactScopedStreams(result, secrets);
  return { exitCode: numericExit ? result.code : null, outputTail: redacted.slice(-4000), truncated: redacted.length > 4000 };
}

export function scopedDependencyDiagnostic(result: ExecOutcome, durationMs: number, secrets: readonly string[]): ScopedDependencyDiagnostic {
  return { durationMs, command: scopedCommandDiagnostic(result, secrets),
    ...((executionCodes as readonly string[]).includes(result.errorCode ?? "") ? { executionErrorCode: result.errorCode as ScopedDiagnosticExecutionCode } : {}) };
}

function projectDiagnostic(value: unknown): RecordedScopedAttemptDiagnostic {
  const corrupt = (): never => { throw new CheckSnapshotError("check_attempt_corrupt", "Selected scoped diagnostics are malformed."); };
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : corrupt();
  const row = object(value), failure = object(row["failure"]);
  if (row["availability"] !== "available" || !(phases as readonly unknown[]).includes(row["phase"])) return corrupt();
  let safeFailure: RecordedScopedAttemptDiagnostic["failure"];
  if ("unavailable" in failure) {
    if (typeof failure["unavailable"] !== "string" || !["not-failed", "unclassified"].includes(failure["unavailable"]) || "code" in failure || "executionErrorCode" in failure) return corrupt();
    safeFailure = { unavailable: failure["unavailable"] as "not-failed" | "unclassified" };
  } else {
    if (!(failureCodes as readonly unknown[]).includes(failure["code"]) || ("executionErrorCode" in failure && !(executionCodes as readonly unknown[]).includes(failure["executionErrorCode"]))) return corrupt();
    safeFailure = { code: failure["code"] as ScopedDiagnosticFailureCode, ...("executionErrorCode" in failure ? { executionErrorCode: failure["executionErrorCode"] as ScopedDiagnosticExecutionCode } : {}) };
  }
  const commandDiagnostic = (value: unknown): ScopedDiagnosticCommand => {
    const command = object(value);
    if ("unavailable" in command) {
      if (typeof command["unavailable"] !== "string" || !["not-started", "not-completed"].includes(command["unavailable"]) || "exitCode" in command || "outputTail" in command || "truncated" in command) return corrupt();
      return { unavailable: command["unavailable"] as "not-started" | "not-completed" };
    }
    if (!(command["exitCode"] === null || typeof command["exitCode"] === "number" && Number.isSafeInteger(command["exitCode"]) && command["exitCode"] >= 0) || typeof command["outputTail"] !== "string" || command["outputTail"].length > 4000 || typeof command["truncated"] !== "boolean") return corrupt();
    return { exitCode: command["exitCode"] as number | null, outputTail: command["outputTail"], truncated: command["truncated"] };
  };
  let dependency: ScopedDependencyDiagnostic | undefined;
  if ("dependency" in row) {
    const value = object(row["dependency"]);
    if (typeof value["durationMs"] !== "number" || !Number.isFinite(value["durationMs"]) || value["durationMs"] < 0 ||
        ("executionErrorCode" in value && !(executionCodes as readonly unknown[]).includes(value["executionErrorCode"]))) return corrupt();
    dependency = { durationMs: value["durationMs"], command: commandDiagnostic(value["command"]),
      ...("executionErrorCode" in value ? { executionErrorCode: value["executionErrorCode"] as ScopedDiagnosticExecutionCode } : {}) };
  }
  let setup: ScopedSetupDiagnostic | undefined;
  if ("setup" in row) {
    const value = object(row["setup"]);
    const one = <T extends string>(field: string, allowed: readonly T[]): T => (allowed as readonly unknown[]).includes(value[field]) ? value[field] as T : corrupt();
    const phasesValue = value["phases"];
    if (!Array.isArray(phasesValue) || phasesValue.length > 16) return corrupt();
    setup = { action: one("action", ["executed", "reused"]), snapshot: one("snapshot", ["built", "cloned", "retained"]),
      clone: one("clone", ["clonefile", "reflink", "unavailable", "path-bound", "not-used"]), verification: one("verification", ["index", "inventory"]),
      phases: phasesValue.map(entry => {
        const phase = object(entry);
        if (!(setupPhases as readonly unknown[]).includes(phase["phase"]) || typeof phase["durationMs"] !== "number" || !Number.isSafeInteger(phase["durationMs"]) || phase["durationMs"] < 0) return corrupt();
        return { phase: phase["phase"] as typeof setupPhases[number], durationMs: phase["durationMs"] };
      }) };
  }
  return { availability: "available", phase: row["phase"] as ScopedDiagnosticPhase, failure: safeFailure, command: commandDiagnostic(row["command"]),
    ...(dependency === undefined ? {} : { dependency }), ...(setup === undefined ? {} : { setup }) };
}

/** Read at most 100 explicit attempts. No logs from legacy payloads, no writes,
 * and no claim of applicability/admission. Unselected provider history is ignored. */
export async function readScopedCheckDiagnostics(input: {
  readonly rootDir: string;
  readonly config: Pick<HarnessConfig, "gateId" | "storageNamespace" | "providers">;
  readonly attemptIds: readonly string[];
}): Promise<ScopedCheckDiagnostics> {
  const { rootDir, config, attemptIds } = input;
  if (!Array.isArray(attemptIds) || attemptIds.length > 100 || attemptIds.some(id => typeof id !== "string" || !id.length || id.length > 128) || new Set(attemptIds).size !== attemptIds.length) throw new CheckSnapshotError("check_diagnostics_request_invalid", "Diagnostics require at most 100 unique nonempty attempt identifiers.");
  const requested = new Set(attemptIds), seen = new Set<string>();
  const providers: ScopedCheckDiagnostics["providers"][number][] = [];
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, leaf: "scoped-attempts" });
  for (const provider of config.providers.filter(p => p.check?.scope !== undefined)) {
    const rows = requested.size ? await new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: config.gateId, provider: provider.id }))).read() : [];
    if (rows.some(row => row.attempt.providerId !== provider.id)) throw new CheckSnapshotError("check_attempt_corrupt", "Scoped history belongs to a different provider.");
    const attempts: ScopedCheckDiagnostics["providers"][number]["attempts"][number][] = [];
    for (const { attempt, payload } of rows.filter(row => requested.has(row.attempt.attemptId))) {
      if (seen.has(attempt.attemptId)) throw new CheckSnapshotError("check_attempt_corrupt", "A requested attempt identifier is ambiguous.");
      seen.add(attempt.attemptId);
      const diagnostic: ScopedAttemptDiagnostic = attempt.status === "running" ? { availability: "unavailable", reason: "running" }
        : payload?.diagnostic === undefined ? { availability: "unavailable", reason: "legacy" } : projectDiagnostic(payload.diagnostic);
      attempts.push({ ...projectScopedAttempt(attempt, payload?.durationMs), diagnostic });
    }
    providers.push({ providerId: provider.id, attempts });
  }
  return { version: "scoped-check-diagnostics/1", providers, unavailableAttemptIds: attemptIds.filter(id => !seen.has(id)) };
}
