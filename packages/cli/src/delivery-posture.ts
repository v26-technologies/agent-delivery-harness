/**
 * What `verify`, `gate`, `record` and `resume` do with the declared posture.
 *
 * Each calls this once its arguments have parsed and before anything else. Under
 * `focused` the command returns the one outcome this builds, having read no
 * delivery record and run no obligation, and that outcome is the whole record.
 * It journals no completion: `gate ok` in a run would read as a gate that passed.
 * Under `gate` the command carries on, with output as it would be had nothing
 * been declared. The one exception is a malformed declaration: a repository said
 * something and it didn't take, so its code and reason go to stderr, leaving
 * what a command writes to stdout as it is.
 */
import { resolveDeliveryPosture } from "@agent-delivery-harness/kernel";
import { CliInterruption, type CommandContext, type CommandResult } from "./boundary.ts";
import { oneLine } from "./run-surface.ts";

export async function focusedOutcome(context: CommandContext): Promise<Extract<CommandResult, { kind: "ok" }> | undefined> {
  const resolved = await resolveDeliveryPosture({
    rootDir: context.rootDir,
    baseRef: context.config.baseRef,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (context.signal?.aborted) throw new CliInterruption();
  if (resolved.posture === "focused") {
    return {
      kind: "ok",
      unobserved: true,
      summary: [
        "outcome: focused",
        `posture: ${resolved.posture}`,
        `reason: ${oneLine(resolved.reason, 512)}`,
        `source: ${oneLine(resolved.source, 256)}`,
        `base tip: ${resolved.baseTipSha ?? "(none)"}`,
      ].join("\n"),
    };
  }
  if (resolved.code === "posture_malformed") context.writeError(`${resolved.code}: ${oneLine(resolved.reason, 512)}`);
  return undefined;
}
