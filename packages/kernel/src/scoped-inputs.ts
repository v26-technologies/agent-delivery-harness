/** Recomputable source identity shared by the executor and portable verifier. */
import { captureScopedCheckInputs } from "./checks.ts";
import { digestCanonical, sha256Hex } from "./digest.ts";
import { deliveryRecordPathFor, type HarnessConfig, type ProviderRegistration } from "./config.ts";
import { recordOutputProvider } from "./record-output.ts";
import { readWorkflowRelease, type ReviewInputReader } from "./review-inputs.ts";
import type { CandidateTreeInputReader } from "./portable-inputs.ts";
import type { CapturedCandidate } from "./candidate.types.ts";
import { BlockedError, createBlocker } from "./blockers.ts";
const invalid = (code: string, summary: string) => new BlockedError([createBlocker({ code, source: { kind: "command", id: "delivery-harness.scoped-inputs" }, summary,
  remediations: [{ id: "repair-scoped-inputs", kind: "manual_action", summary: "Restore the declared dependency inputs or correct the execution profile, then prepare again." }] })]);
export interface ScopedRuntimeObservation {
  readonly version: "scoped-runtime/1";
  readonly runtimeDigest: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, { readonly present: boolean; readonly identity: string | null }>>;
}
export async function scopedCheckIdentity(config: HarnessConfig, provider: ProviderRegistration, inventory: readonly string[], read: CandidateTreeInputReader, observation: ScopedRuntimeObservation, candidate: Pick<CapturedCandidate, "base" | "headSha" | "treeSha" | "deliverable">, readEvidence: ReviewInputReader = read) {
  const output = deliveryRecordPathFor(config, candidate.deliverable.digest);
  const scope = recordOutputProvider(provider, output).check?.scope;
  const profile = config.scopedExecution?.profiles.find(p => p.id === scope?.profile);
  if (!scope || !profile || observation.version !== "scoped-runtime/1" || !/^[a-f0-9]{64}$/.test(observation.runtimeDigest)) throw invalid("check_identity_invalid", "Unsupported scoped execution identity.");
  const flags = scope.environment.filter(e => e.kind === "flag").map(e => e.name);
  const credentials = scope.environment.filter(e => e.kind === "credential").map(e => e.name);
  if (Object.keys(observation.flags).some(k => !flags.includes(k) || typeof observation.flags[k] !== "string") || Object.keys(observation.credentials).sort().join("\0") !== credentials.sort().join("\0")) throw invalid("check_identity_invalid", "Invalid scoped environment observation.");
  const environment: Record<string, string> = { ...observation.flags };
  for (const name of credentials) {
    const entry = observation.credentials[name]!;
    if (typeof entry.present !== "boolean" || entry.identity !== (entry.present ? profile.credentialIdentities[name] ?? null : null)) throw invalid("check_identity_invalid", "Invalid credential identity.");
    if (entry.present) environment[name] = "<credential-present>";
  }
  const dependencyInputs = [];
  for (const file of [...profile.dependencyInputs].sort()) {
    const bytes = await read(file);
    if (bytes === null) throw invalid("check_dependency_input_missing", `Required dependency input ${file} is missing from the prepared tree.`);
    dependencyInputs.push({ file, sha256: sha256Hex(bytes), metadata: await read.metadata(file) });
  }
  const dependencyDigest = digestCanonical({ inputs: dependencyInputs, setup: profile.dependencies ?? null });
  const releaseDigest = digestCanonical(await readWorkflowRelease(readEvidence));
  const policyDigest = digestCanonical(config.obligations.filter(o => o.providers.includes(provider.id)).map(o => ({ ...o, providers: [provider.id] })));
  const relevantProfile = { ...profile,
    mutableOutputs: profile.mutableOutputs.filter(m => provider.check!.outputs?.some(o => m.endsWith("/") ? o.startsWith(m) : o === m)),
    credentialIdentities: Object.fromEntries(credentials.filter(name => profile.credentialIdentities[name] !== undefined).map(name => [name, profile.credentialIdentities[name]])) };
  // The executor injects Git base context, so even unchanged source can execute
  // differently after the base moves. Recompute this from the selected candidate.
  const runtimeDigest = digestCanonical({ runtime: observation.runtimeDigest, base: candidate.base, ...(profile.gitContext === "none" ? {} : { headSha: candidate.headSha, treeSha: candidate.treeSha }) });
  const profileDigest = digestCanonical({ profile: relevantProfile, runtimeDigest, dependencyDigest, releaseDigest, policyDigest });
  const capture = await captureScopedCheckInputs(scope, { listFiles: async () => inventory.filter(file => file !== output), readFile: read, readMetadata: read.metadata, command: provider.check!.command, timeoutMs: provider.check!.timeoutMs,
    runtimeDigest, dependencyDigest, releaseDigest, policyDigest, environment, credentialIdentity: name => observation.credentials[name]?.identity ?? null });
  return { ...capture, profileDigest };
}
