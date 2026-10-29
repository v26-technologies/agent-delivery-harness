/** Best-effort CLI observations. No caller uses these results for admission. */
import { randomUUID } from "node:crypto";
import type { CaptureCandidate, RunEventKind, RunPreparationObservation, WaiverPrompt } from "@agent-delivery-harness/kernel";
import { buildRunEvent, resolveRunSurface } from "./run-surface.ts";

export interface CommandObservation {
  readonly needsCandidate: boolean;
  start(candidateTreeSha: string): Promise<void>;
  prompt(prompt: WaiverPrompt): WaiverPrompt;
  finish(exitCode: number, durationMs: number, digest?: string, preparation?: RunPreparationObservation): Promise<void>;
}
const absent: CommandObservation = { needsCandidate: false, start: async () => {}, prompt: prompt => prompt, finish: async () => {} };
function outcome(code: number) { return code === 0 ? "ok" : code === 2 ? "usage" : code === 130 ? "interrupted" : "policy"; }

/** Observe the first successful command capture; never reuse or replace a result. */
export function observeCandidateCaptures(capture: CaptureCandidate, observation: CommandObservation): CaptureCandidate {
  let start: Promise<void> | undefined;
  return async () => {
    const result = await capture();
    if (result.ok) {
      start ??= Promise.resolve().then(() => observation.start(result.candidate.treeSha))
        .catch(() => { /* Progress reporting never changes capture or command outcomes. */ });
      await start;
    }
    return result;
  };
}

/** Pin the current run once, so a pointer change cannot split an invocation. */
export async function beginCommandObservation(cwd: string, command: string): Promise<CommandObservation> {
  try {
    const resolved = await resolveRunSurface(cwd);
    if (!resolved.ok) return absent;
    const { store, commonDir, worktreeKey } = resolved.surface;
    const current = await store.current(worktreeKey);
    if (!current.ok || current.runId === undefined) return absent;
    const runId = current.runId;
    const history = await store.read(runId);
    if (!history.ok) return absent;
    // Capability is selected before emission. Never upgrade an existing writer.
    const version = history.events[0]?.version ?? "run-event/1";
    const attemptId = `command-${randomUUID()}`;
    const activityId = attemptId;
    let candidateTreeSha: string | undefined;
    async function emit(kind: RunEventKind, payload: Record<string, unknown>) {
      try {
        await store.append(runId, buildRunEvent({runId,commonDir,kind,role:"cli",version,
          ...(version === "run-event/2" ? {eventId:randomUUID()} : {}),payload}));
      } catch { /* Observations never change the command's result. */ }
    }
    const binding = () => ({activityId,attemptId,candidateTreeSha});
    async function activity(state: string, nextStep: string) {
      if (version !== "run-event/2" || candidateTreeSha === undefined) return;
      await emit("activity.observed", {...binding(),state,owner:"delivery-harness.cli",phase:command,nextStep});
    }
    return {
      needsCandidate: version === "run-event/2",
      async start(tree) {
        candidateTreeSha = tree;
        await activity("running", "Await command outcome; intermediate progress is unavailable unless explicitly observed.");
      },
      prompt(prompt) {
        return async (decision, obligations) => {
          if (version !== "run-event/2" || candidateTreeSha === undefined) return prompt(decision, obligations);
          const waitId = `wait-${randomUUID()}`;
          const scope = "This command invocation and the waiver decision's candidate and obligations only; this observation grants no authority.";
          await activity("waiting", "Respond to the native waiver prompt.");
          await emit("wait.started", {...binding(),waitId,owner:"operator",waitingOn:"human",reason:"The executing command opened its native waiver prompt.",nextAction:"Answer the native prompt.",scope});
          try {
            const answer = await prompt(decision, obligations);
            await emit("wait.resolved", {...binding(),waitId,resolution:answer === false ? "Native prompt declined." : "Native prompt answered; approval remains subject to the gate.",scope});
            return answer;
          } catch (error) {
            await emit("wait.resolved", {...binding(),waitId,resolution:"Native prompt ended without a decision.",scope});
            throw error;
          } finally {
            await activity("running", "Await command outcome.");
          }
        };
      },
      async finish(code, durationMs, digest, preparation) {
        await activity(code === 0 ? "completed" : code === 130 ? "interrupted" : "failed", `Command returned ${outcome(code)} (exit ${code}); continue the declared delivery workflow.`);
        await emit("command.completed", {command,outcome:outcome(code),durationMs,
          ...(code === 0 && digest !== undefined ? {digest} : {}),
          ...(version === "run-event/2" && command === "prepare" && code === 0 && preparation !== undefined ? {preparation} : {})});
      },
    };
  } catch { return absent; }
}
