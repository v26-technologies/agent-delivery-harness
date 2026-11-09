/**
 * Neutral provider-rail execution shared by CLI and Action boundaries.
 *
 * The envelope and state machine are the vendored `delivery-provider-rails/1`
 * contract. Its `payload`, `details`, and `result` objects remain opaque. This
 * adapter assigns one adopter-owned meaning inside `terminal.result`:
 * `manifestPath` names a delivery-evidence manifest that must be accepted by
 * the existing recorder before a successful provider attempt can become green
 * evidence. Live obligations reuse the evaluator's existing LiveProviderResult
 * shape; recorded obligations reuse SubmissionOutcome and its evidence records.
 */
import { BlockedError, createBlocker, type Blocker } from "./blockers.ts";
import { canonicalize } from "./canonical.ts";
import type { LiveProviderResult } from "./evaluator.ts";
import type { SubmissionOutcome, SubmissionRecord } from "./recorder.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fstatSync } from "node:fs";
import type { InheritedDescriptor } from "./config.ts";
import { createInterface } from "node:readline";

export const DELIVERY_PROVIDER_RAILS_VERSION = "delivery-provider-rails/1" as const;

type JsonObject = Readonly<Record<string, unknown>>;
type TerminalOutcome = "success" | "blocked" | "failed" | "cancelled" | "indeterminate";
type EventKind = "progress" | "evidence" | "blocker" | "terminal";

export interface ProviderRailNegotiate {
  readonly kind: "negotiate";
  readonly supportedVersions: readonly string[];
}

export interface ProviderRailNegotiation {
  readonly kind: "negotiation";
  readonly outcome: "supported" | "unsupported";
  readonly selectedVersion: typeof DELIVERY_PROVIDER_RAILS_VERSION | null;
  readonly supportedVersions: readonly [typeof DELIVERY_PROVIDER_RAILS_VERSION];
}

export interface ProviderRailRequest {
  readonly kind: "request";
  readonly version: typeof DELIVERY_PROVIDER_RAILS_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
}

interface ProviderRailEventBase {
  readonly version: typeof DELIVERY_PROVIDER_RAILS_VERSION;
  readonly requestId: string;
  readonly sequence: number;
  readonly summary: string;
}

export interface ProviderRailProgress extends ProviderRailEventBase {
  readonly kind: "progress";
  readonly details?: JsonObject;
}

export interface ProviderRailEvidence extends ProviderRailEventBase {
  readonly kind: "evidence";
  readonly evidenceId: string;
  readonly details?: JsonObject;
}

export interface ProviderRailBlocker extends ProviderRailEventBase {
  readonly kind: "blocker";
  readonly blockerId: string;
  readonly action?: string;
  readonly details?: JsonObject;
}

export interface ProviderRailTerminal extends ProviderRailEventBase {
  readonly kind: "terminal";
  readonly outcome: TerminalOutcome;
  readonly action?: string;
  readonly details?: JsonObject;
  readonly result?: JsonObject;
}

export interface ProviderRailCancel {
  readonly kind: "cancel";
  readonly version: typeof DELIVERY_PROVIDER_RAILS_VERSION;
  readonly requestId: string;
  readonly cancellationId: string;
  readonly reason?: string;
}

export type ProviderRailEvent = ProviderRailProgress | ProviderRailEvidence | ProviderRailBlocker | ProviderRailTerminal;
export type ProviderRailMessage = ProviderRailNegotiate | ProviderRailNegotiation | ProviderRailRequest | ProviderRailEvent | ProviderRailCancel;

export interface ProviderRailConsumption {
  readonly status: "supported" | "unsupported" | "malformed" | "success" | "blocked" | "failed" | "cancelled" | "indeterminate";
  readonly acceptedCount: number;
  readonly duplicateCount: number;
  readonly rejectedCount: number;
  readonly events: readonly ProviderRailEvent[];
  readonly terminal: ProviderRailTerminal | null;
}

export interface ConsumeProviderRailOptions {
  readonly requestId?: string;
  readonly cancellationAccepted?: boolean;
  readonly interrupted?: boolean;
  readonly afterInterruption?: readonly unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactMembers(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((member) => Object.hasOwn(value, member)) && Object.keys(value).every((member) => allowed.has(member));
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && IDENTIFIER.test(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 1024;
}

function opaque(value: unknown): value is JsonObject {
  return isObject(value);
}

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function validNegotiation(value: unknown): value is ProviderRailNegotiation {
  if (!isObject(value) || !exactMembers(value, ["kind", "outcome", "selectedVersion", "supportedVersions"])) return false;
  if (value["kind"] !== "negotiation") return false;
  if (!Array.isArray(value["supportedVersions"]) || value["supportedVersions"].length !== 1 || value["supportedVersions"][0] !== DELIVERY_PROVIDER_RAILS_VERSION) return false;
  if (value["outcome"] === "supported") return value["selectedVersion"] === DELIVERY_PROVIDER_RAILS_VERSION;
  if (value["outcome"] === "unsupported") return value["selectedVersion"] === null;
  return false;
}

function eventBase(value: Record<string, unknown>): boolean {
  return (
    value["version"] === DELIVERY_PROVIDER_RAILS_VERSION &&
    identifier(value["requestId"]) &&
    sequence(value["sequence"]) &&
    text(value["summary"])
  );
}

function validEvent(value: unknown): value is ProviderRailEvent {
  if (!isObject(value) || typeof value["kind"] !== "string") return false;
  switch (value["kind"]) {
    case "progress":
      return exactMembers(value, ["kind", "requestId", "sequence", "summary", "version"], ["details"]) && eventBase(value) && (value["details"] === undefined || opaque(value["details"]));
    case "evidence":
      return exactMembers(value, ["evidenceId", "kind", "requestId", "sequence", "summary", "version"], ["details"]) && eventBase(value) && identifier(value["evidenceId"]) && (value["details"] === undefined || opaque(value["details"]));
    case "blocker":
      return exactMembers(value, ["blockerId", "kind", "requestId", "sequence", "summary", "version"], ["action", "details"]) && eventBase(value) && identifier(value["blockerId"]) && (value["action"] === undefined || text(value["action"])) && (value["details"] === undefined || opaque(value["details"]));
    case "terminal":
      return (
        exactMembers(value, ["kind", "outcome", "requestId", "sequence", "summary", "version"], ["action", "details", "result"]) &&
        eventBase(value) &&
        ["success", "blocked", "failed", "cancelled", "indeterminate"].includes(String(value["outcome"])) &&
        (value["action"] === undefined || text(value["action"])) &&
        (value["details"] === undefined || opaque(value["details"])) &&
        (value["result"] === undefined || opaque(value["result"]))
      );
    default:
      return false;
  }
}

/**
 * Contract consumer used by both the process adapter and the shared vectors.
 * Terminal finality is checked before message shape, exactly as the contract
 * requires: late malformed or cross-attempt bytes cannot reopen an outcome.
 */
export function consumeProviderRailMessages(
  messages: readonly unknown[],
  options: ConsumeProviderRailOptions = {},
): ProviderRailConsumption {
  let negotiated = false;
  let status: ProviderRailConsumption["status"] = "malformed";
  let terminalClosed = false;
  let failedClosed = false;
  let activeRequestId = options.requestId;
  let acceptedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;
  let terminal: ProviderRailTerminal | null = null;
  const events: ProviderRailEvent[] = [];
  const seenByRequest = new Map<string, Map<number, string>>();

  const accept = (message: unknown): void => {
    if (terminalClosed || failedClosed) {
      rejectedCount += 1;
      return;
    }
    if (validNegotiation(message)) {
      negotiated = false;
      if (seenByRequest.size > 0) {
        status = "malformed";
        failedClosed = true;
        return;
      }
      if (message.outcome === "supported") {
        negotiated = true;
        status = "supported";
      } else {
        status = "unsupported";
        failedClosed = true;
      }
      return;
    }
    if (!negotiated || !validEvent(message)) {
      status = "malformed";
      failedClosed = true;
      return;
    }
    if (activeRequestId === undefined) activeRequestId = message.requestId;
    else if (message.requestId !== activeRequestId) {
      status = "malformed";
      failedClosed = true;
      return;
    }
    const encoded = canonicalize(message);
    const seen = seenByRequest.get(message.requestId) ?? new Map<number, string>();
    seenByRequest.set(message.requestId, seen);
    const prior = seen.get(message.sequence);
    if (prior !== undefined) {
      if (prior === encoded) duplicateCount += 1;
      else {
        status = "malformed";
        failedClosed = true;
      }
      return;
    }
    const expected = Math.max(0, ...seen.keys()) + 1;
    if (message.sequence !== expected) {
      status = "malformed";
      failedClosed = true;
      return;
    }
    if (
      options.cancellationAccepted === true &&
      message.kind === "terminal" &&
      message.outcome !== "cancelled" &&
      message.outcome !== "indeterminate"
    ) {
      status = "malformed";
      rejectedCount += 1;
      failedClosed = true;
      return;
    }
    seen.set(message.sequence, encoded);
    acceptedCount += 1;
    events.push(message);
    if (message.kind === "terminal") {
      status = message.outcome;
      terminal = message;
      terminalClosed = true;
    }
  };

  for (const message of messages) accept(message);
  if (options.interrupted === true && negotiated && !terminalClosed && !failedClosed) {
    status = "indeterminate";
    terminalClosed = true;
  }
  for (const message of options.afterInterruption ?? []) accept(message);

  return { status, acceptedCount, duplicateCount, rejectedCount, events, terminal };
}

export interface ProviderRailSession {
  send(message: ProviderRailMessage): Promise<void>;
  /** `null` means the provider process or transport closed. */
  receive(): Promise<unknown | null>;
  close(options?: { readonly terminationGraceMs?: number }): Promise<void>;
}

export interface OpenProviderRailProcessInput {
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The provider's declared inherited descriptors (3 and 4 only); absent is plain stdio. */
  readonly inheritDescriptors?: readonly InheritedDescriptor[];
}

/** The launcher that opened inherited descriptors names them here, each with
 * the identity of the pipe or socket it opened: "3:<dev>:<ino>,4:<dev>:<ino>".
 * Bun and Node hold descriptors 3 and 4 themselves when nothing was inherited,
 * and a setting can outlive the descriptors it named, so a descriptor passes
 * only when its own identity is the one vouched for. */
export const INHERITED_DESCRIPTORS_ENV = "DELIVERY_HARNESS_INHERITED_DESCRIPTORS";

/** A descriptor's identity when it is a pipe or socket; undefined otherwise. */
export function channelIdentity(fd: number): string | undefined {
  try {
    const stat = fstatSync(fd);
    return stat.isFIFO() || stat.isSocket() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch { return undefined; }
}

/** Stdio and environment for a rail provider: three pipes, then each
 * descriptor the provider declares whose identity the launcher vouched for.
 * Every other slot is "ignore". The provider's environment then states
 * exactly what it received, and nothing when it received nothing (V26-3314). */
export function providerRailLaunch(
  declared: readonly InheritedDescriptor[] = [],
  env: NodeJS.ProcessEnv = {},
  identify: (fd: number) => string | undefined = channelIdentity,
): { stdio: ("pipe" | "ignore" | number)[]; env: NodeJS.ProcessEnv } {
  const vouched = new Map<number, string>();
  for (const entry of (env[INHERITED_DESCRIPTORS_ENV] ?? "").split(",")) {
    const match = /^\s*([34]):(\d+:\d+)\s*$/.exec(entry);
    if (match && !vouched.has(Number(match[1]))) vouched.set(Number(match[1]), match[2]!);
  }
  const stdio: ("pipe" | "ignore" | number)[] = ["pipe", "pipe", "pipe"];
  const passed: string[] = [];
  for (let fd = 3; fd <= Math.max(2, ...declared); fd++) {
    const identity = declared.includes(fd as InheritedDescriptor) && vouched.has(fd) ? identify(fd) : undefined;
    if (identity !== undefined && identity === vouched.get(fd)) { stdio.push(fd); passed.push(`${fd}:${identity}`); }
    else stdio.push("ignore");
  }
  const { [INHERITED_DESCRIPTORS_ENV]: _vouched, ...rest } = env;
  return { stdio, env: passed.length ? { ...rest, [INHERITED_DESCRIPTORS_ENV]: passed.join(",") } : rest };
}

const DEFAULT_PROVIDER_RAIL_DEADLINE_MS = 10 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

class RailLifecycleEnded extends Error {
  readonly causeKind: "deadline" | "abort";

  constructor(causeKind: "deadline" | "abort") {
    super(causeKind === "deadline" ? "Provider lifecycle deadline expired." : "Provider lifecycle was aborted.");
    this.name = "RailLifecycleEnded";
    this.causeKind = causeKind;
  }
}

/** One total lifecycle budget shared by negotiation, writes, and event waits. */
class RailDeadline {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #parent: AbortSignal | undefined;
  readonly #onParentAbort: () => void;

  constructor(timeoutMs: number, parent?: AbortSignal) {
    this.signal = this.#controller.signal;
    this.#parent = parent;
    this.#onParentAbort = () => this.#controller.abort(new RailLifecycleEnded("abort"));
    parent?.addEventListener("abort", this.#onParentAbort, { once: true });
    if (parent?.aborted === true) this.#onParentAbort();
    this.#timer = setTimeout(
      () => this.#controller.abort(new RailLifecycleEnded("deadline")),
      Math.max(1, Math.floor(timeoutMs)),
    );
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.reason();
    const pending = operation();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.reason());
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      if (onAbort !== undefined) this.signal.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#parent?.removeEventListener("abort", this.#onParentAbort);
  }

  private reason(): RailLifecycleEnded {
    return this.signal.reason instanceof RailLifecycleEnded ? this.signal.reason : new RailLifecycleEnded("abort");
  }
}

async function settlesWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, Math.floor(milliseconds)));
  });
  try {
    return await Promise.race([operation.then(() => true, () => true), elapsed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Opens the contract over newline-delimited JSON on a provider subprocess's stdio. */
export function openProviderRailProcess(input: OpenProviderRailProcessInput): Promise<ProviderRailSession> {
  const [executable, ...args] = input.command;
  const launch = providerRailLaunch(input.inheritDescriptors, input.env);
  const child = spawn(executable, args, {
    cwd: input.cwd,
    env: launch.env,
    stdio: launch.stdio,
    shell: false,
  }) as ChildProcessWithoutNullStreams;
  // A deadline may destroy the child while a bounded stdin write is pending.
  // The write callback still reports that failure; this listener prevents the
  // stream's parallel `error` event from becoming an uncaught exception.
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  // Diagnostics stay provider-owned; drain the pipe so a noisy provider cannot
  // deadlock while the typed stdout rail is waiting for its terminal event.
  child.stderr.resume();
  const queued: unknown[] = [];
  const waiters: Array<(value: unknown | null) => void> = [];
  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const childClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | undefined;

  const deliver = (value: unknown | null): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(value);
    else if (value !== null) queued.push(value);
  };

  lines.on("line", (line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      // `null` is the session's transport-close sentinel. Preserve a provider
      // that actually emits JSON null as malformed contract input instead.
      deliver(parsed === null ? line : parsed);
    } catch {
      // Keep malformed bytes as a value the closed-envelope validator rejects.
      deliver(line);
    }
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) waiters.shift()?.(null);
    resolveClosed?.();
  };
  child.once("close", close);
  child.once("error", close);

  return Promise.resolve({
    async send(message) {
      if (closed || child.stdin.destroyed) throw new Error("Provider transport is closed.");
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error === null || error === undefined ? resolve() : reject(error)));
      });
    },
    receive() {
      const next = queued.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.resolve(null);
      return new Promise<unknown | null>((resolve) => waiters.push(resolve));
    },
    close(options = {}) {
      closing ??= (async () => {
        lines.close();
        if (!child.stdin.destroyed) child.stdin.end();
        if (closed || child.exitCode !== null || child.signalCode !== null) {
          await childClosed;
          return;
        }
        child.kill("SIGTERM");
        const grace = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
        if (!(await settlesWithin(childClosed, grace)) && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await childClosed;
      })();
      return closing;
    },
  });
}

export interface ProviderRailAttemptInput {
  readonly providerId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
  readonly requiresEvidence: boolean;
}

export interface ProviderRailAttemptOptions {
  readonly open: () => Promise<ProviderRailSession>;
  readonly publishManifest?: (manifestPath: string) => Promise<SubmissionOutcome>;
  readonly signal?: AbortSignal;
  readonly cancellationId?: string;
  readonly deadlineMs?: number;
  readonly terminationGraceMs?: number;
}

export type ProviderRailInvocationResult =
  | {
      readonly kind: "success";
      readonly status: "success";
      readonly liveResult: LiveProviderResult;
      readonly events: readonly ProviderRailEvent[];
      readonly records: readonly SubmissionRecord[];
    }
  | {
      readonly kind: "interrupted";
      readonly status: "cancelled" | "indeterminate" | "malformed";
      readonly runId: string;
      readonly blockers: readonly Blocker[];
    }
  | {
      readonly kind: "blocked";
      readonly status: Exclude<ProviderRailConsumption["status"], "supported" | "success" | "cancelled">;
      readonly runId: string;
      readonly blockers: readonly Blocker[];
    };

const RETRY_PROVIDER = {
  id: "retry-provider",
  kind: "retry" as const,
  summary: "Start a new provider attempt after checking the provider process and retained diagnostics.",
};

function detailsOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Error) return value.message;
  try {
    return canonicalize(value);
  } catch {
    return String(value);
  }
}

function railBlocker(providerId: string, status: string, summary: string, details?: unknown, action?: string): Blocker {
  return createBlocker({
    code: `provider_rail_${status}`,
    source: { kind: "provider", id: providerId },
    summary,
    ...(details === undefined ? {} : { details: detailsOf(details) }),
    remediations: [
      action === undefined
        ? RETRY_PROVIDER
        : { id: "follow-provider-action", kind: "manual_action", summary: action },
    ],
  });
}

function outcomeBlockers(providerId: string, consumption: ProviderRailConsumption): readonly Blocker[] {
  const reported = consumption.events.filter((event): event is ProviderRailBlocker => event.kind === "blocker");
  if (reported.length > 0) {
    return reported.map((event) =>
      railBlocker(
        providerId,
        "blocked",
        event.summary,
        { blockerId: event.blockerId, ...(event.details === undefined ? {} : { details: event.details }) },
        event.action,
      ),
    );
  }
  const terminal = consumption.terminal;
  return [
    railBlocker(
      providerId,
      consumption.status,
      terminal?.summary ?? `Provider ${providerId} ended ${consumption.status}.`,
      terminal?.details,
      terminal?.action,
    ),
  ];
}

function manifestPathOf(terminal: ProviderRailTerminal): string | undefined {
  const value = terminal.result?.["manifestPath"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Runs one negotiated provider attempt. A successful terminal is provisional:
 * when recorded evidence is required, the adapter publishes the returned
 * manifest through the existing recorder first and exposes green only after
 * that atomic publication reports acceptance.
 */
export async function invokeProviderRail(
  input: ProviderRailAttemptInput,
  options: ProviderRailAttemptOptions,
): Promise<ProviderRailInvocationResult> {
  const deadline = new RailDeadline(options.deadlineMs ?? DEFAULT_PROVIDER_RAIL_DEADLINE_MS, options.signal);
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  let session: ProviderRailSession | undefined;
  let requestStarted = false;
  try {
    session = await deadline.wait(options.open);
    const activeSession = session;
    await deadline.wait(() => activeSession.send({ kind: "negotiate", supportedVersions: [DELIVERY_PROVIDER_RAILS_VERSION] }));
    const negotiation = await deadline.wait(() => activeSession.receive());
    if (negotiation === null) {
      return {
        kind: "blocked",
        status: "indeterminate",
        runId: input.requestId,
        blockers: [railBlocker(input.providerId, "indeterminate", "The provider transport closed before version negotiation completed.")],
      };
    }
    const received: unknown[] = [negotiation];
    const negotiated = consumeProviderRailMessages(received, { requestId: input.requestId });
    if (negotiated.status === "unsupported") {
      return { kind: "blocked", status: "unsupported", runId: input.requestId, blockers: outcomeBlockers(input.providerId, negotiated) };
    }
    if (negotiated.status !== "supported") {
      return { kind: "blocked", status: "malformed", runId: input.requestId, blockers: outcomeBlockers(input.providerId, negotiated) };
    }

    requestStarted = true;
    await deadline.wait(() =>
      activeSession.send({
        kind: "request",
        version: DELIVERY_PROVIDER_RAILS_VERSION,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      }),
    );

    for (;;) {
      const message = await deadline.wait(() => activeSession.receive());
      if (message === null) {
        const interrupted = consumeProviderRailMessages(received, {
          requestId: input.requestId,
          interrupted: true,
        });
        return { kind: "blocked", status: "indeterminate", runId: input.requestId, blockers: outcomeBlockers(input.providerId, interrupted) };
      }
      received.push(message);
      const consumption = consumeProviderRailMessages(received, {
        requestId: input.requestId,
      });
      if (consumption.status === "supported") continue;
      if (consumption.status === "malformed") {
        return { kind: "blocked", status: "malformed", runId: input.requestId, blockers: outcomeBlockers(input.providerId, consumption) };
      }
      if (consumption.terminal === null) continue;
      // Terminal is absorbing. Once it is accepted, a later local signal must
      // not emit cancellation or replace the provider's completed outcome.
      deadline.dispose();
      if (consumption.status === "cancelled") {
        return { kind: "interrupted", status: "cancelled", runId: input.requestId, blockers: outcomeBlockers(input.providerId, consumption) };
      }
      if (consumption.status !== "success") {
        return { kind: "blocked", status: consumption.status, runId: input.requestId, blockers: outcomeBlockers(input.providerId, consumption) };
      }

      let records: readonly SubmissionRecord[] = [];
      if (input.requiresEvidence) {
        const manifestPath = manifestPathOf(consumption.terminal);
        if (manifestPath === undefined || options.publishManifest === undefined) {
          return {
            kind: "blocked",
            status: "malformed",
            runId: input.requestId,
            blockers: [railBlocker(input.providerId, "malformed", "Provider success did not identify a manifest for retained evidence publication.")],
          };
        }
        let publication: SubmissionOutcome;
        try {
          publication = await options.publishManifest(manifestPath);
        } catch (error) {
          return {
            kind: "blocked",
            status: "failed",
            runId: input.requestId,
            blockers:
              error instanceof BlockedError
                ? error.blockers
                : [railBlocker(input.providerId, "failed", "Provider evidence publication did not complete.", error)],
          };
        }
        if (publication.status !== "accepted") {
          return {
            kind: "blocked",
            status: "failed",
            runId: input.requestId,
            blockers:
              publication.blockers.length > 0
                ? publication.blockers
                : [railBlocker(input.providerId, "failed", "Provider evidence publication was not accepted.")],
          };
        }
        records = publication.records;
      }

      return {
        kind: "success",
        status: "success",
        liveResult: { providerId: input.providerId, runId: input.requestId, status: "green", findings: [] },
        events: consumption.events,
        records,
      };
    }
  } catch (error) {
    if (session !== undefined && requestStarted && error instanceof RailLifecycleEnded) {
      await settlesWithin(
        Promise.resolve().then(() =>
          session?.send({
            kind: "cancel",
            version: DELIVERY_PROVIDER_RAILS_VERSION,
            requestId: input.requestId,
            cancellationId: options.cancellationId ?? `cancel-${input.requestId}`,
            reason: error.causeKind === "deadline" ? "Consumer deadline expired" : "Consumer interrupted the provider attempt",
          }),
        ),
        terminationGraceMs,
      );
    }
    const summary =
      error instanceof RailLifecycleEnded
        ? error.causeKind === "deadline"
          ? "The provider lifecycle deadline expired without a trustworthy terminal outcome."
          : "The provider invocation was interrupted without a trustworthy terminal outcome."
        : session === undefined
          ? "The provider process could not be started."
          : "The provider transport closed without a trustworthy terminal outcome.";
    const blockers = [railBlocker(input.providerId, "indeterminate", summary, error)];
    return error instanceof RailLifecycleEnded && error.causeKind === "abort"
      ? { kind: "interrupted", status: "indeterminate", runId: input.requestId, blockers }
      : { kind: "blocked", status: "indeterminate", runId: input.requestId, blockers };
  } finally {
    deadline.dispose();
    // Transport teardown after an accepted terminal cannot rewrite that
    // terminal. The process/session is still closed on every path.
    try {
      await session?.close({ terminationGraceMs });
    } catch {
      // Best effort only; pre-terminal transport failures are mapped above.
    }
  }
}
