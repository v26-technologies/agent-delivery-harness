/** Native source/setup binding for installed DATA, separate from Git execution identity. */
import { captureScopedCheckInputs } from "./checks.ts";
import { digestCanonical, sha256Hex } from "./digest.ts";
import { readWorkflowRelease, type ReviewInputReader } from "./review-inputs.ts";
import { isInstalledDataConsumerDefinition, type HarnessConfig, type ProviderRegistration } from "./config.ts";
import type { CandidateTreeInputReader } from "./portable-inputs.ts";
import type { CapturedCandidate } from "./candidate.types.ts";
import type { ScopedRuntimeObservation } from "./scoped-inputs.ts";
import type { InstalledDataResourceContext } from "./installed-data-resources.ts";
export class InstalledDataSourceError extends Error {
  readonly code = "installed_data_source_unqualified";
}

export interface InstalledDataSourceTree {
  readonly inventory: readonly string[];
  readonly read: CandidateTreeInputReader;
}
export async function captureInstalledDataBinding(
  config: HarnessConfig,
  provider: ProviderRegistration,
  candidate: Pick<CapturedCandidate, "base">,
  observation: ScopedRuntimeObservation,
  source: { readonly base: InstalledDataSourceTree; readonly candidate: InstalledDataSourceTree },
  readEvidence: ReviewInputReader,
) {
  const declaration = provider.check?.installedData;
  const profile = config.scopedExecution?.profiles.find(row => row.id === provider.check?.scope?.profile);
  if (!isInstalledDataConsumerDefinition(declaration) || !profile || !provider.check?.scope)
    throw new InstalledDataSourceError("Installed data requires a validated scoped consumer.");
  const refuse = () => new InstalledDataSourceError("Installed resource source guards are missing, changed or linked.");
  for (const tree of [source.base, source.candidate]) {
    for (const [file, expected] of Object.entries(declaration.guards)) {
      const bytes = await tree.read(file), metadata = await tree.read.metadata(file);
      if (bytes === null || sha256Hex(bytes) !== expected || !["100644", "100755"].includes(metadata.mode ?? "") || metadata.links.length)
        throw refuse();
    }
  }
  const dependencies = [];
  for (const file of [...profile.dependencyInputs].sort()) {
    const bytes = await source.candidate.read(file), metadata = await source.candidate.read.metadata(file);
    if (bytes === null || !["100644", "100755"].includes(metadata.mode ?? "") || metadata.links.length) throw refuse();
    dependencies.push({file,sha256:sha256Hex(bytes),metadata});
  }
  const context: InstalledDataResourceContext = {
    setupRecipeDigest: digestCanonical({...profile,dependencyInputs:[...profile.dependencyInputs].sort(),mutableOutputs:[...profile.mutableOutputs].sort()}),
    dependencyDigest: digestCanonical({inputs:dependencies,setup:profile.dependencies ?? null}),
    runtimeDigest: observation.runtimeDigest,
    releaseDigest: digestCanonical(await readWorkflowRelease(readEvidence)),
    policyDigest: digestCanonical(config.obligations.filter(row => row.providers.includes(provider.id)).map(row => ({...row,providers:[provider.id]}))),
  };
  const environment = {...observation.flags};
  for (const [name, credential] of Object.entries(observation.credentials)) if (credential.present) environment[name] = "<credential-present>";
  const captures = [];
  for (const tree of [source.base, source.candidate]) {
    const captured = await captureScopedCheckInputs(declaration.source,{listFiles:async()=>tree.inventory,readFile:tree.read,readMetadata:tree.read.metadata,
      command:provider.check.command,timeoutMs:provider.check.timeoutMs,runtimeDigest:context.runtimeDigest,dependencyDigest:context.dependencyDigest,
      policyDigest:context.policyDigest,releaseDigest:context.releaseDigest,environment,
      credentialIdentity:name=>observation.credentials[name]?.identity ?? null});
    if (!captured.reusable || captured.files.some(file => (file.metadata?.links.length ?? 0) !== 0)) throw refuse();
    captures.push(captured.inputDigest);
  }
  return {
    declaration,
    context,
    declarationDigest:digestCanonical(declaration),
    sourceApplicabilityDigest:digestCanonical({base:candidate.base,source:captures,profile:context.setupRecipeDigest}),
  };
}
