import { randomUUID } from "node:crypto";
import path from "node:path";
import { captureCheckBindings, captureCheckOutputSnapshots, digestCanonical, classifyCandidateDrift, computeCheckWiringFingerprint, createBlocker, createExecPort, sha256Hex, submitManifest, type Blocker, type CandidateBinding, type CheckBindingOptions, type ProviderRegistration, type SubmissionOptions } from "@agent-delivery-harness/kernel";
import type { CommandContext } from "./boundary.ts";

/** Runs one declared argv check and submits its product-constructed terminal evidence. */
export async function runDeclaredCheck(context: CommandContext, provider: ProviderRegistration, obligationIds: readonly string[], before: CandidateBinding, scoped: Pick<CheckBindingOptions, "scopedPlan" | "readOutput"> & Pick<SubmissionOptions, "resourceBindings"> = {}): Promise<readonly Blocker[]> {
  const check = provider.check!;
  const wiring = await context.wire();
  const fail = (code: string, summary: string, details?: string): readonly Blocker[] => [createBlocker({ code, source: { kind: "command", id: "delivery-harness.cli.gate" }, summary,
    ...(details === undefined ? {} : { details }), remediations: [{ id: "repair-declared-check", kind: "manual_action", summary: "Fix the declared check or its inputs, prepare the stable candidate and run gate again." }] })];
  const start = await wiring.captureCandidate();
  if (!start.ok) return start.blockers;
  if (classifyCandidateDrift(before, start.candidate).length) return fail("check_candidate_changed", "The candidate changed after review admission and before the check started.");
  const fingerprint = await computeCheckWiringFingerprint(context.rootDir, context.config, wiring.storageOptions);
  context.write(`checking ${provider.id}`);
  const result = await createExecPort().run({ command: check.command[0], args: check.command.slice(1), cwd: context.rootDir,
    env: Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    timeoutMs: check.timeoutMs, maxBuffer: 1024 * 1024, ...(context.signal === undefined ? {} : { signal: context.signal }) });
  if (result.code !== 0 || context.signal?.aborted) return fail("check_command_failed", `Declared check ${provider.id} did not complete successfully.`, `exit ${result.code}${result.errorCode === undefined ? "" : ` (${result.errorCode})`}\n${`${result.stdout}\n${result.stderr}`.slice(-4000)}`);
  const captured = await wiring.captureCandidate();
  if (!captured.ok) return captured.blockers;
  if (classifyCandidateDrift(before, captured.candidate).length || start.candidate.headSha !== captured.candidate.headSha || fingerprint !== await computeCheckWiringFingerprint(context.rootDir, context.config, wiring.storageOptions)) return fail("check_candidate_changed", "The candidate, base or wiring changed while the check ran.");
  const binding = (await captureCheckBindings(context.rootDir, context.config, captured.candidate, { ...wiring.storageOptions, ...scoped }))[provider.id];
  if (binding === undefined) return fail("check_output_missing", `Declared check ${provider.id} has a missing, unreadable, oversized or escaped output.`);
  const runId = randomUUID(), finalPassId = "pass-1";
  const allocation = await context.artifacts.allocateRunRoot({ providerId: provider.id, runId });
  if (!allocation.ok) return fail("check_artifact_unavailable", "Cannot allocate the declared check evidence root.");
  const snapshots = await captureCheckOutputSnapshots(context.rootDir, check.outputs ?? []);
  if (snapshots === undefined || digestCanonical(snapshots.map(({ path, sha256 }) => ({ path, sha256 }))) !== binding.outputsDigest) return fail("check_output_missing", "Declared outputs changed before evidence retention.");
  const outputArtifacts: { path: string; sha256: string; role: string }[] = [];
  for (const [index, output] of snapshots.entries()) {
    const contents = JSON.stringify({ path: output.path, base64: output.base64 });
    const artifactPath = `check-output-${index}.json`;
    await context.artifacts.writeTextFile(path.join(allocation.runRoot.path, artifactPath), contents);
    outputArtifacts.push({ path: artifactPath, sha256: sha256Hex(contents), role: "check-output" });
  }
  const payload = { verdict: "green", exitCode: 0, binding };
  const terminal = JSON.stringify({ providerId: provider.id, runId, finalPassId, ...payload });
  await context.artifacts.writeTextFile(path.join(allocation.runRoot.path, "check-result.json"), terminal);
  const candidate = captured.candidate;
  const manifest = { spec: "delivery-evidence/1", provider: { id: provider.id, runId, finalPassId },
    candidate: { vcs: "git", treeSha: candidate.treeSha, headSha: candidate.headSha, deliverable: candidate.deliverable, base: candidate.base, workspaceId: candidate.workspaceId },
    runHistory: [{ preparedTreeSha: candidate.treeSha, evaluatedInPassId: finalPassId }], artifacts: [{ path: "check-result.json", sha256: sha256Hex(terminal), role: "check-result" }, ...outputArtifacts],
    attestation: { level: "self", signatures: [] }, recordedAt: new Date().toISOString(), claims: obligationIds.map(obligation => ({ obligation, payloadSpec: "checks.passed/1", payload })) };
  const manifestPath = path.join(allocation.runRoot.path, "manifest.json");
  await context.artifacts.writeTextFile(manifestPath, JSON.stringify(manifest));
  const outcome = await submitManifest({ rootDir: context.rootDir, config: context.config, manifestPath }, { captureCandidate: wiring.captureCandidate, artifacts: context.artifacts, ...wiring.storageOptions, ...scoped });
  return outcome.status === "accepted" ? [] : outcome.blockers;
}
