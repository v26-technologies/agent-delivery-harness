/**
 * What `verify`, `gate`, `record` and `resume` do with the declared posture.
 *
 * Each calls this once its arguments have parsed and before anything else. Under
 * `focused` the command returns the one outcome this builds, having read no
 * delivery record and run no obligation, and that outcome is the whole record.
 * It journals no completion: `gate ok` in a run would read as a gate that passed.
 * Under `gate` the command carries on, with output as it would be had nothing
 * been declared. There are two exceptions, each of which writes its code and
 * reason to stderr, leaving what a command writes to stdout as it is: a malformed
 * declaration, where a repository said something and it didn't take, and a
 * command run from a directory that is not its repository's root, which is the
 * caller's to fix rather than the base's.
 */
import { deliveryPostureRefusedOutsideRoot, resolveDeliveryPosture } from "@agent-delivery-harness/kernel";
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
  if (resolved.code === "posture_malformed" || deliveryPostureRefusedOutsideRoot(resolved)) context.writeError(`${resolved.code}: ${oneLine(resolved.reason, 512)}`);
  return undefined;
}
